// 单实例锁单测：O_EXCL 抢占/死锁抢占/坏锁/真进程探活（SERVER-PLAN 阶段 B 验收 ②③ 的原语层）
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, before, after } from "node:test";
import { acquireLock, lockIsPidAlive } from "../src/main.ts";

let root: string;
const lockPath = () => path.join(root, "lock");

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "omt-lock-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("首抢：owned，锁内容为 pid，权限 600，无 tmp 残留（write-then-link）", () => {
  const r = acquireLock(lockPath(), { pid: 4242 });
  assert.deepEqual(r, { kind: "owned" });
  assert.equal(readFileSync(lockPath(), "utf8"), "4242");
  assert.equal(statSync(lockPath()).mode & 0o777, 0o600);
  const leftovers = readdirSync(root).filter((f) => f.includes(".tmp."));
  assert.deepEqual(leftovers, []);
});

test("EEXIST + 持锁者活（注入）→ in-use，不动锁", () => {
  writeFileSync(lockPath(), "7777", { mode: 0o600 });
  const r = acquireLock(lockPath(), { isAlive: () => true });
  assert.deepEqual(r, { kind: "in-use", holderPid: 7777 });
  assert.equal(readFileSync(lockPath(), "utf8"), "7777"); // 后到者不删活锁
});

test("EEXIST + 持锁者死（注入）→ 抢占重试 owned，锁换主", () => {
  writeFileSync(lockPath(), "7777", { mode: 0o600 });
  const r = acquireLock(lockPath(), { pid: 8888, isAlive: () => false });
  assert.deepEqual(r, { kind: "owned" });
  assert.equal(readFileSync(lockPath(), "utf8"), "8888");
});

test("坏锁内容 → 按死持锁者抢占", () => {
  writeFileSync(lockPath(), "not-a-pid", { mode: 0o600 });
  const r = acquireLock(lockPath(), { pid: 9999, isAlive: () => true }); // isAlive 不应被调用
  assert.deepEqual(r, { kind: "owned" });
  assert.equal(readFileSync(lockPath(), "utf8"), "9999");
});

test("空锁文件 → 抢占", () => {
  writeFileSync(lockPath(), "", { mode: 0o600 });
  const r = acquireLock(lockPath(), { pid: 1111, isAlive: () => true });
  assert.deepEqual(r, { kind: "owned" });
});

test("lockIsPidAlive：本进程活；已回收的短命进程死", () => {
  assert.equal(lockIsPidAlive(process.pid), true);
  const child = spawnSync("true", [], { stdio: "ignore" }); // 同步等它退出并回收
  assert.equal(child.status, 0);
  assert.equal(lockIsPidAlive(child.pid!), false);
});

test("lockIsPidAlive：pid 1 恒活——EPERM（归属他人）按活处理，不再误判为死", () => {
  // 普通用户：kill(1,0) 抛 EPERM → 必须返回 true；root/容器：kill 成功 → 也返回 true
  assert.equal(lockIsPidAlive(1), true);
});
