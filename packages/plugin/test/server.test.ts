// ensureServer 发现-创建流程单测（六分支：复用/坏文件/stale/
// 活而不响应（含版本不兼容）/spawn 失败/就绪超时）。
// 全部注入 fetch/spawn/isAlive/resolve + XDG 指向临时目录——无网络、无真机、<2s。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import { ensureServer } from "../src/server.ts";
import { envFromProcess, serverLogPath, serviceFilePath, stateDir } from "../../shared/src/paths.ts";
import type { HealthInfo, ServiceFile } from "../../shared/src/types.ts";
import type { RuntimeResolution, SpawnedProcess } from "../src/types.ts";

// 与 packages/plugin/package.json 对齐（versionCompatible：major.minor）——动态读取：
// 版本升级时假件自动跟随（M8 曾因统一 2.0.0 与硬编码 0.1.0 错位而 4 分支齐红）
const COMPAT_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

let xdgRoot: string;
const env = (): NodeJS.ProcessEnv => {
  const r = `${xdgRoot}/run-${Math.random().toString(36).slice(2, 8)}`;
  return { XDG_STATE_HOME: `${r}/state`, XDG_DATA_HOME: `${r}/data` };
};
const sfPath = (e: NodeJS.ProcessEnv): string => serviceFilePath(envFromProcess(e));

before(() => {
  xdgRoot = mkdtempSync(path.join(tmpdir(), "omt-plugin-"));
});
after(() => {
  rmSync(xdgRoot, { recursive: true, force: true });
});

// ---- 造假件 ----

const health = (version = COMPAT_VERSION): HealthInfo => ({
  id: "svc-id",
  version,
  uptime_s: 3,
  tasks_alive: 0,
  tasks_total: 0,
  reattach: null,
  opencode_instances: [],
  log_bytes: 0,
});

const svc = (over: Partial<ServiceFile> = {}): ServiceFile => ({
  id: "svc-id",
  version: COMPAT_VERSION,
  url: "http://127.0.0.1:45678",
  pid: 424242,
  password: "pw-0123456789abcdef",
  started_at: 1,
  ...over,
});

/** 可控 fetch：返回值队列或恒定错误 */
function fakeFetch(result: { health: HealthInfo } | { error: Error }): typeof fetch {
  return (async () => {
    if ("error" in result) throw result.error;
    return { ok: true, status: 200, json: async () => result.health } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** 假 spawn：记录调用；onSpawn 模拟服务端子进程落 service.json（spawn 后同步写） */
function fakeSpawner(onSpawn?: (e: NodeJS.ProcessEnv) => void) {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const impl = (
    command: string,
    args: string[],
    options: { cwd: string; stdio: "ignore"; detached: true; env: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, args, options });
    onSpawn?.(envRef!);
    return { pid: 54321, exitCode: null, signalCode: null, unref() {} } satisfies SpawnedProcess;
  };
  return { calls, impl };
}

// envRef：fakeSpawner 的 onSpawn 需要"当前用例的 env"——由 makeCase 统一接线
let envRef: NodeJS.ProcessEnv | null = null;

const FIXED_RT: RuntimeResolution = {
  kind: "source",
  command: "/usr/bin/node",
  args: ["--import", "tsx", "/proj/omt/packages/server/src/main.ts"],
  cwd: "/proj/omt",
};

interface Case {
  e: NodeJS.ProcessEnv;
  sf: string;
  log: string;
}

function makeCase(): Case {
  const e = env();
  envRef = e;
  mkdirSync(stateDir(envFromProcess(e)), { recursive: true });
  return { e, sf: sfPath(e), log: serverLogPath(envFromProcess(e)) };
}

function baseDeps(c: Case) {
  return {
    env: c.e,
    rootDir: "/proj/omt",
    resolve: () => FIXED_RT,
    isAlive: () => true,
    pollIntervalMs: 5,
    readyTimeoutMs: 250,
  };
}

// ---- 六分支 ----

test("① 复用：健康且版本兼容 → spawned=false，不 spawn 不清理", async () => {
  const c = makeCase();
  writeFileSync(c.sf, JSON.stringify(svc()));
  const sp = fakeSpawner();
  const r = await ensureServer({
    ...baseDeps(c),
    fetchImpl: fakeFetch({ health: health() }),
    spawnImpl: sp.impl,
  });
  assert.equal(r.spawned, false);
  assert.equal(r.svc.id, "svc-id");
  assert.deepEqual(sp.calls, []); // 复用路径绝不 spawn
});

test("② 坏 service.json：清理后拉起，新实例就绪 → spawned=true", async () => {
  const c = makeCase();
  writeFileSync(c.sf, "{ this is not json");
  const fresh = svc({ id: "fresh-id", pid: 54321, password: "pw-fresh-fresh-fresh" });
  const sp = fakeSpawner((e) => {
    writeFileSync(sfPath(e), JSON.stringify(fresh)); // 模拟子进程就绪落盘
  });
  const r = await ensureServer({
    ...baseDeps(c),
    fetchImpl: fakeFetch({ health: health() }),
    spawnImpl: sp.impl,
  });
  assert.equal(r.spawned, true);
  assert.equal(r.svc.id, "fresh-id");
  assert.equal(sp.calls.length, 1);
  assert.deepEqual(sp.calls[0]!.options, { cwd: "/proj/omt", stdio: "ignore", detached: true, env: c.e });
  assert.equal(sp.calls[0]!.command, "/usr/bin/node"); // 命令来自 resolveRuntime，非 process.execPath
});

test("③ stale：pid 死 + 不可达 → 清理重建 → spawned=true", async () => {
  const c = makeCase();
  writeFileSync(c.sf, JSON.stringify(svc({ pid: 999999 })));
  const fresh = svc({ id: "fresh-id", pid: 54321 });
  let spawnedYet = false; // 时序型 fetch：拉起前（stale 记录）不可达，拉起后（fresh）就绪
  const sp = fakeSpawner((e) => {
    spawnedYet = true;
    writeFileSync(sfPath(e), JSON.stringify(fresh));
  });
  const fetchImpl = (async () => {
    if (!spawnedYet) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, json: async () => health() } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await ensureServer({
    ...baseDeps(c),
    fetchImpl,
    spawnImpl: sp.impl,
    isAlive: () => false, // pid 已死
  });
  assert.equal(r.spawned, true);
  assert.equal(r.svc.id, "fresh-id");
});

test("④ 活而不响应：pid 活 + health 不可达 → 拒绝双开，诊断含 pid 与文件路径", async () => {
  const c = makeCase();
  writeFileSync(c.sf, JSON.stringify(svc({ pid: 424242 })));
  const sp = fakeSpawner();
  await assert.rejects(
    ensureServer({
      ...baseDeps(c),
      fetchImpl: fakeFetch({ error: new Error("ECONNREFUSED") }),
      spawnImpl: sp.impl,
    }),
    (err: Error) =>
      err.message.includes("refusing to double-spawn") &&
      err.message.includes("424242") &&
      err.message.includes(c.sf) &&
      err.message.includes(c.log),
  );
  assert.deepEqual(sp.calls, []); // 拒绝路径不 spawn
  assert.equal(JSON.parse(readFileSync(c.sf, "utf8")).pid, 424242); // 不清活实例的 service.json
});

test("④' 版本不兼容但 pid 活：同样拒绝双开，诊断带对端版本", async () => {
  const c = makeCase();
  writeFileSync(c.sf, JSON.stringify(svc({ pid: 424242 })));
  await assert.rejects(
    ensureServer({
      ...baseDeps(c),
      fetchImpl: fakeFetch({ health: health("9.9.0") }),
      spawnImpl: fakeSpawner().impl,
    }),
    (err: Error) => err.message.includes("9.9.0") && err.message.includes("refusing to double-spawn"),
  );
});

test("⑤ spawn 失败：子进程立即退出 → 报退出码诊断", async () => {
  const c = makeCase();
  const dead = { pid: 54321, exitCode: 1, signalCode: null, unref() {} } satisfies SpawnedProcess;
  let caught: unknown;
  await assert.rejects(
    ensureServer({
      ...baseDeps(c),
      fetchImpl: fakeFetch({ health: health() }),
      spawnImpl: () => dead,
    }),
    (e: Error) => {
      caught = e;
      return true;
    },
  );
  assert.match(String(caught), /exited during startup \(code=1 signal=null\)/);
  assert.match(String(caught), new RegExp(c.log.replaceAll("/", "\\/")));
});

test("⑥ 就绪超时：子进程活但 service.json 不出现 → 超时诊断含 pid 与日志路径", async () => {
  const c = makeCase();
  let caught: unknown;
  await assert.rejects(
    ensureServer({
      ...baseDeps(c),
      fetchImpl: fakeFetch({ health: health() }),
      spawnImpl: () => ({ pid: 54321, exitCode: null, signalCode: null, unref() {} }),
      readyTimeoutMs: 60,
      pollIntervalMs: 5,
    }),
    (e: Error) => {
      caught = e;
      return true;
    },
  );
  assert.match(String(caught), /did not become healthy within 60ms/);
  assert.match(String(caught), /pid=54321/);
  assert.match(String(caught), /check log for startup errors/);
});

test("⑦ rootDir 默认 = 模块位置推导的 monorepo 根（非 cwd——宿主进程内 cwd 是 HOME，真机冷启动 bug 的回归锚）", async () => {
  const c = makeCase();
  const seenRoots: string[] = [];
  const fresh = svc({ id: "fresh-id" });
  const sp = fakeSpawner((e) => {
    writeFileSync(sfPath(e), JSON.stringify(fresh));
  });
  await ensureServer({
    env: c.e,
    fetchImpl: fakeFetch({ health: health() }),
    spawnImpl: sp.impl,
    isAlive: () => false,
    pollIntervalMs: 5,
    // 故意不注入 rootDir：默认路径必须自证
    resolve: (rootDir) => {
      seenRoots.push(rootDir);
      return { kind: "source", command: "node", args: ["--import", "tsx", "packages/server/src/main.ts"], cwd: rootDir };
    },
  });
  assert.equal(seenRoots.length, 1);
  // 断言"模块位置推导"语义本身（上推三级 = monorepo 根），而非字面目录名——
  // clone 到任意别名目录同样成立（CI 目录名恒为 repo 名，旧正则锚定在本地别名
  // clone 下必红）。回归锚语义不变：旧实现（process.cwd()）在宿主冷启动 cwd=HOME
  // 场景推导出错误根，此处等值断言同样能抓住
  const expectedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  assert.equal(seenRoots[0], expectedRoot);
});
