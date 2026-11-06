// main 装配分支单测（不触 serve 分支——真监听由 scripts/verify-m1.ts 真机验收）：
// 后到者让位/版本不兼容/等待超时、owned-防御让位、service.json roundtrip
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { main, readServiceFile, recoveryThenSweep, removalOutcome, SERVER_VERSION, writeServiceFile } from "../src/main.ts";import { lockFilePath, serverLogPath, serviceFilePath, stateDir, type PathEnv, type PublicInfo, type ServiceFile } from "@omt/shared";

let root: string;
let env: NodeJS.ProcessEnv;
let paths: PathEnv;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "omt-main-"));
  env = { ...process.env, XDG_STATE_HOME: `${root}/state`, XDG_DATA_HOME: `${root}/data` };
  paths = { XDG_STATE_HOME: `${root}/state`, XDG_DATA_HOME: `${root}/data` };
  mkdirSync(stateDir(paths), { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function presetLock(pid: number): void {
  writeFileSync(lockFilePath(paths), String(pid), { mode: 0o600 });
}

function presetService(partial: Partial<ServiceFile>): ServiceFile {
  const svc: ServiceFile = {
    id: "11111111-1114-4111-8111-111111111111",
    version: SERVER_VERSION,
    url: "http://127.0.0.1:59999",
    pid: 59999,
    password: "pw",
    started_at: 0,
    ...partial,
  };
  writeServiceFile(paths, svc);
  return svc;
}

test("in-use + 持锁者健康（版本兼容）→ 后到者退出码 0，不删他人的锁与 service.json", async () => {
  presetLock(59999);
  presetService({});
  const r = await main([], env, {
    isAlive: () => true,
    probe: async () => ({ ok: true, version: SERVER_VERSION }),
  });
  assert.equal(r.code, 0);
  assert.equal(existsSync(lockFilePath(paths)), true); // 锁归持锁者
  assert.equal(existsSync(serviceFilePath(paths)), true);
});

test("in-use + 版本不兼容（major.minor 异）→ 拒绝双开，退出码 1", async () => {
  presetLock(59999);
  presetService({ version: "9.9.9" });
  const r = await main([], env, {
    isAlive: () => true,
    probe: async () => ({ ok: true, version: "9.9.9" }),
  });
  assert.equal(r.code, 1);
});

test("in-use + probe ok 但 version 缺失 → 同样拒绝复用，退出码 1（与 owned-防御语义统一）", async () => {
  presetLock(59999);
  presetService({});
  const r = await main([], env, {
    isAlive: () => true,
    probe: async () => ({ ok: true }), // 无 version：对端不可信
  });
  assert.equal(r.code, 1);
});

test("in-use + 持锁者始终不健康 → 等待超时退出码 1（不盲目双开）", async () => {
  presetLock(59999);
  presetService({});
  const r = await main([], env, {
    isAlive: () => true,
    probe: async () => ({ ok: false }),
    waitHolderMs: 50,
  });
  assert.equal(r.code, 1);
});

test("in-use + service.json 坏 JSON → 视为未就绪，超时退出码 1", async () => {
  presetLock(59999);
  writeFileSync(serviceFilePath(paths), "{ broken");
  const r = await main([], env, { isAlive: () => true, probe: async () => ({ ok: true }), waitHolderMs: 50 });
  assert.equal(r.code, 1);
});

test("owned + 已有健康实例在服务（锁与实例脱钩异常态）→ 让位退出 0 并释放自己抢到的锁", async () => {
  // 无预置锁：main 自己抢到；预置一个"健康实例"的 service.json
  presetService({});
  const r = await main([], env, {
    probe: async () => ({ ok: true, version: SERVER_VERSION }),
  });
  assert.equal(r.code, 0);
  assert.equal(existsSync(lockFilePath(paths)), false); // 自己抢的锁自己清
  assert.equal(existsSync(serviceFilePath(paths)), true); // 别人的 service.json 不动
});

// 日志开关。
// 走 in-use 健康让位分支——该路径必经 log("starting")/log("lock in-use")，是
// "开关是否写文件"的最短可测路径（serve 分支由 verify-m1 真机覆盖）。
// 旧实现（log 无条件追加）下"默认不产生 server.log"断言必失败——必失败纪律。
for (const c of [
  { name: "默认（无 --debug 无 DEBUG=1）→ server.log 不创建", argv: [] as string[], debugEnv: "", expectLog: false },
  { name: "--debug 参数 → server.log 写入关键事件行", argv: ["--debug"], debugEnv: "", expectLog: true },
  { name: "DEBUG=1 env → 与 --debug 等价", argv: [], debugEnv: "1", expectLog: true },
] as const) {
  test(`日志开关：${c.name}`, async () => {
    rmSync(serverLogPath(paths), { force: true });
    // 独立 env：显式排除宿主 DEBUG 污染（process.env 展开可能携带 DEBUG=1）
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: paths.XDG_STATE_HOME, XDG_DATA_HOME: paths.XDG_DATA_HOME };
    delete cleanEnv["DEBUG"];
    if (c.debugEnv !== "") cleanEnv["DEBUG"] = c.debugEnv;
    presetLock(59999);
    presetService({});
    const r = await main([...c.argv], cleanEnv, {
      isAlive: () => true,
      probe: async () => ({ ok: true, version: SERVER_VERSION }),
    });
    assert.equal(r.code, 0);
    const logExists = existsSync(serverLogPath(paths));
    assert.equal(logExists, c.expectLog, `server.log exists=${logExists}`);
    if (c.expectLog) {
      const text = readFileSync(serverLogPath(paths), "utf-8");
      assert.match(text, /starting version=/, "关键事件行应在场");
    }
  });
}

// 注：owned + 已有实例"版本不兼容"→ 不让位继续服务的分支，serve 路径会真监听挂起，
// 不在单测做——由 scripts/verify-m1.ts 真机语义覆盖（发现方对不兼容活实例直接报错不 spawn）。

test("writeServiceFile/readServiceFile roundtrip：600 权限、字段逐项", async () => {
  const svc: ServiceFile = {
    id: "22222222-2224-4222-8222-222222222222",
    version: "0.1.0",
    url: "http://127.0.0.1:41234",
    pid: 41234,
    password: "secretpw",
    started_at: 1699000000000,
  };
  writeServiceFile(paths, svc);
  const back = readServiceFile(paths);
  assert.deepEqual(back, svc);
  assert.equal((readFileSync(serviceFilePath(paths), "utf8").match(/secretpw/g) ?? []).length, 1);
});

test("readServiceFile：不存在 null；坏 JSON 抛错（发现方清理路径判据）", () => {
  rmSync(`${root}/state`, { recursive: true, force: true });
  assert.equal(readServiceFile(paths), null);
  mkdirSync(stateDir(paths), { recursive: true });
  writeFileSync(serviceFilePath(paths), "not json");
  assert.throws(() => readServiceFile(paths));
});

// ---------------------------------------------------------------------------
// 启动期恢复时序与 DELETE 裁决（Review 修复回归）

test("recoveryThenSweep：sweeper 启动必扫须待首轮 pending 重投完成（含失败放行）", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const p = recoveryThenSweep(
    async () => {
      events.push("retry-start");
      await gate;
      events.push("retry-end");
    },
    () => events.push("sweep-start"),
  );
  await new Promise<void>((r) => setTimeout(r, 20));
  // 旧时序（sweeper 启动即必扫、重投要等 60s 周期）：此刻 sweep-start 已出现——
  // 长停机重启场景下它会先按 TTL 删掉带 pending.json 的目录，结局通知一次未试即丢失
  assert.deepEqual(events, ["retry-start"], `sweeper must not start before pending retry settles: ${events}`);
  release();
  await p;
  assert.deepEqual(events, ["retry-start", "retry-end", "sweep-start"]);
  // 重投逃逸异常同样放行清理，且返回的 promise 不得 reject（void 调用纪律）
  const events2: string[] = [];
  await recoveryThenSweep(
    async () => {
      throw new Error("boom");
    },
    () => events2.push("sweep-start"),
  );
  assert.deepEqual(events2, ["sweep-start"]);
});

function pubInfo(over: Partial<PublicInfo>): PublicInfo {
  return {
    id: "mon_x",
    description: null,
    state: "running",
    session_id: "ses_x",
    opencode_port: 1,
    directory: "/tmp",
    command: "c",
    pattern: null,
    wake_mode: "all",
    delivery: "queue",
    coalesce_ms: 0,
    max_events: 1,
    idle_timeout_ms: 1000,
    idle_deadline: null,
    grace_deadline: null,
    started_at: 0,
    pid: null,
    lines_scanned: 0,
    lines_matched: 0,
    events_sent: 0,
    events_dropped: 0,
    exit_info: null,
    log_bytes: 0,
    last_offset: 0,
    updated_at: 0,
    ...over,
  };
}

test("removalOutcome：store 侧终态可删（与 GET 合并视图一致）、未在册活态 409、无视图 404", () => {
  // registry 在册终态 → 204（原语义保持）
  assert.equal(removalOutcome("mon_x", pubInfo({ state: "completed" }), null).status, 204);
  // registry 在册活态 → 409 提示先 stop（原语义保持）
  const alive = removalOutcome("mon_x", pubInfo({ state: "running" }), null);
  assert.equal(alive.status, 409);
  assert.equal((alive.body as { code?: string }).code, "TASK_NOT_TERMINAL");
  // store 侧终态（registry 已驱逐、目录在 TTL 窗口内）→ 204——旧实现 registry-only
  // 查询返回 404，与同一任务 GET 200 的合并视图自相矛盾
  assert.equal(removalOutcome("mon_x", null, pubInfo({ state: "stopped" })).status, 204);
  // store 侧活态（reattach 未跑的崩溃残留）→ 409：无人看护，删目录会留无主进程继续跑
  const residual = removalOutcome("mon_x", null, pubInfo({ state: "running" }));
  assert.equal(residual.status, 409);
  assert.ok(String((residual.body as { error?: string }).error).includes("not claimed"), "hint for unclaimed dir");
  // 两侧都无 → 404
  assert.equal(removalOutcome("mon_x", null, null).status, 404);
});
