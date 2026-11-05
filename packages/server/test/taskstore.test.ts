// taskstore 单测：原子写/私有目录/TaskMeta roundtrip/布局守卫（SERVER-PLAN 阶段 B）
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import {
  ensurePrivateDir,
  initTaskDir,
  listTaskIds,
  readExitFile,
  readMeta,
  taskFilePaths,
  writeFileAtomic,
  writeMeta,
  type TaskMeta,
} from "../src/taskstore.ts";
import type { PathEnv } from "@omt/shared";

let root: string;
let env: PathEnv;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "omt-taskstore-"));
  env = { XDG_STATE_HOME: `${root}/state`, XDG_DATA_HOME: `${root}/data` };
  ensurePrivateDir(`${root}/state`); // writeFileAtomic 不建父目录（保持原子写纯粹）
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("writeFileAtomic: 内容正确、600 权限、无 tmp 残留", () => {
  const p = path.join(root, "state", "file.json");
  writeFileAtomic(p, '{"a":1}\n');
  assert.equal(readFileSync(p, "utf8"), '{"a":1}\n');
  assert.equal(statSync(p).mode & 0o777, 0o600);
  const leftovers = readdirSync(path.dirname(p)).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
  // 覆写同样原子
  writeFileAtomic(p, '{"a":2}\n');
  assert.equal(readFileSync(p, "utf8"), '{"a":2}\n');
});

test("writeFileAtomic: 同路径并发写不互相踩 tmp 名", () => {
  const p = path.join(root, "state", "seq.json");
  for (let i = 0; i < 20; i++) writeFileAtomic(p, String(i));
  assert.ok(Number.isInteger(Number(readFileSync(p, "utf8"))));
});

test("ensurePrivateDir: 已存在目录也收敛到 0700", () => {
  const p = path.join(root, "state", "sub");
  mkdirSync(p, { recursive: true, mode: 0o755 });
  ensurePrivateDir(p);
  assert.equal(statSync(p).mode & 0o777, 0o700);
});

test("taskFilePaths: 布局四件套 + 非法 id 拒绝（路径穿越防御）", () => {
  const p = taskFilePaths(env, "mon_abc123");
  assert.equal(p.meta, `${root}/data/opencode-monitor-task/tasks/mon_abc123/meta.json`);
  assert.equal(p.log.endsWith("/mon_abc123/log"), true);
  assert.equal(p.exit.endsWith("/mon_abc123/exit"), true);
  assert.equal(p.pending.endsWith("/mon_abc123/pending.json"), true);
  assert.throws(() => taskFilePaths(env, "../evil"));
  assert.throws(() => taskFilePaths(env, "mon_UPPER")); // 大写不在 [a-z0-9]
  assert.throws(() => taskFilePaths(env, "mon/slash"));
  assert.throws(() => taskFilePaths(env, ""));
});

test("initTaskDir: 目录 0700；writeMeta/readMeta 全字段 roundtrip", () => {
  initTaskDir(env, "mon_t1");
  const dirStat = statSync(taskFilePaths(env, "mon_t1").dir);
  assert.equal(dirStat.mode & 0o777, 0o700);

  const meta: TaskMeta = {
    schema: 1,
    id: "mon_t1",
    command: "sleep 1",
    description: "测试任务",
    session_id: "ses_abc",
    opencode_port: 49374,
    pid: 123,
    pgid: 123,
    proc_start_time: 999,
    started_at: 1699000000000,
    directory: "/abs/path",
    pattern: "ERROR",
    wake_mode: "pattern",
    delivery: "queue",
    coalesce_ms: 500,
    max_events: 50,
    idle_timeout_ms: 300000,
    last_offset: 42,
    lines_scanned: 10,
    lines_matched: 3,
    events_sent: 2,
    events_dropped: 1,
    state: "running",
    exit_info: null,
    grace_deadline: null,
    claimed_by: 4242,
    updated_at: 1699000001000,
  };
  writeMeta(env, meta);
  assert.deepEqual(readMeta(env, "mon_t1"), meta);
  assert.equal(statSync(taskFilePaths(env, "mon_t1").meta).mode & 0o777, 0o600);
});

test("readMeta: 不存在返回 null；坏 JSON 抛错（供 G 阶段保守路径区分）", () => {
  assert.equal(readMeta(env, "mon_nope"), null);
  initTaskDir(env, "mon_bad");
  writeFileSync(taskFilePaths(env, "mon_bad").meta, "{ broken");
  assert.throws(() => readMeta(env, "mon_bad"));
});

test("readExitFile: 无文件 null / 有内容 trim", () => {
  assert.equal(readExitFile(env, "mon_none"), null);
  initTaskDir(env, "mon_e");
  writeFileSync(taskFilePaths(env, "mon_e").exit, "signal:15\n");
  assert.equal(readExitFile(env, "mon_e"), "signal:15");
});

test("listTaskIds: 只列合法任务目录并排序；tasks/ 不存在时空", () => {
  assert.deepEqual(listTaskIds(env), ["mon_bad", "mon_e", "mon_t1"]);
  mkdirSync(path.join(root, "data", "opencode-monitor-task", "tasks", "not-a-task"));
  assert.deepEqual(listTaskIds(env), ["mon_bad", "mon_e", "mon_t1"]);
  assert.deepEqual(listTaskIds({ XDG_DATA_HOME: `${root}/nowhere` }), []);
});

// ---------------------------------------------------------------------------
// 阶段 G：pending 读写 + StoredTaskView

test("pending：append FIFO 上限丢最旧并返回计数；空数组写删文件", async () => {
  const { appendPending, readPending, writePending, initTaskDir, taskFilePaths } = await import("../src/taskstore.ts");
  const id = "mon_tspend0001";
  initTaskDir(env, id);
  const mk = (n: number) => ({
    idem: `m${n}`,
    kind: "lifecycle" as const,
    delivery: "queue" as const,
    text: `t${n}`,
    session_id: "s",
    opencode_port: 1,
    queued_at: n,
  });
  // 上限 5：追加 7 条 → 丢最旧 2
  let evicted = 0;
  for (let i = 1; i <= 7; i++) {
    evicted += appendPending(env, id, mk(i), 5);
  }
  assert.equal(evicted, 2);
  const entries = readPending(env, id);
  assert.equal(entries.length, 5);
  assert.equal(entries[0]!.idem, "m3"); // m1/m2 被挤掉
  assert.equal(entries[4]!.idem, "m7");
  // 覆写为空 → 文件删除
  writePending(env, id, []);
  assert.equal(readPending(env, id).length, 0);
  assert.ok(!(await import("node:fs")).existsSync(taskFilePaths(env, id).pending), "empty pending removes file");
  // append 到不存在的文件：等价从零开始
  assert.equal(appendPending(env, id, mk(9), 5), 0);
  assert.equal(readPending(env, id).length, 1);
});

test("StoredTaskView：meta 直出 PublicInfo（log 现读；log 缺失按 0）", async () => {
  const fs = await import("node:fs");
  const { StoredTaskView, initTaskDir, writeMeta, taskFilePaths } = await import("../src/taskstore.ts");
  const id = "mon_tsview0002";
  const paths = initTaskDir(env, id);
  fs.writeFileSync(paths.log, "hello\nworld\n", { mode: 0o600 });
  const { readMeta } = await import("../src/taskstore.ts");
  writeMeta(env, { ...baseMetaFixture(id), lines_scanned: 7, events_sent: 2, state: "completed" });
  const meta = readMeta(env, id)!;
  const info = new StoredTaskView(meta, paths.log).toPublicInfo();
  assert.equal(info.id, id);
  assert.equal(info.state, "completed");
  assert.equal(info.lines_scanned, 7);
  assert.equal(info.events_sent, 2);
  assert.equal(info.log_bytes, 12);
  assert.equal(info.idle_deadline, null);
  // log 丢失（parked 典型）：log_bytes 0 不抛
  fs.rmSync(paths.log);
  const info2 = new StoredTaskView(meta, paths.log).toPublicInfo();
  assert.equal(info2.log_bytes, 0);
});

/** 最小合法 meta 夹具（state/updated_at 可覆盖） */
function baseMetaFixture(id: string): import("../src/taskstore.ts").TaskMeta {
  return {
    schema: 1,
    id,
    command: "true",
    description: null,
    session_id: "ses_ts",
    opencode_port: 1,
    pid: 123,
    pgid: 123,
    proc_start_time: null,
    started_at: 1,
    directory: "/tmp",
    pattern: null,
    wake_mode: "all",
    delivery: "queue",
    coalesce_ms: 0,
    max_events: 50,
    idle_timeout_ms: 300_000,
    last_offset: 0,
    lines_scanned: 0,
    lines_matched: 0,
    events_sent: 0,
    events_dropped: 0,
    state: "completed",
    exit_info: null,
    grace_deadline: null,
    claimed_by: 0,
    updated_at: 42,
  };
}
