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
