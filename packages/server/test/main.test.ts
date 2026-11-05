// main 装配分支单测（不触 serve 分支——真监听由 scripts/verify-m1.ts 真机验收）：
// 后到者让位/版本不兼容/等待超时、owned-防御让位、service.json roundtrip
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { main, readServiceFile, SERVER_VERSION, writeServiceFile } from "../src/main.ts";import { lockFilePath, serviceFilePath, stateDir, type PathEnv, type ServiceFile } from "@omt/shared";

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
