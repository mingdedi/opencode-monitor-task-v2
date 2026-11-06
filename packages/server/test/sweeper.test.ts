// sweeper 单测：TTL 终态清理、坏 meta exit 佐证、保守不删、
// parked/活态不清、清后 registry 移除。clock 经 meta.updated_at / 文件 mtime 构造，
// 不注入时间（TTL 用远未来/远过去时间戳表达）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { LIMITS, type PathEnv } from "@omt/shared";
import { initTaskDir, taskFilePaths, writeMeta, type TaskMeta } from "../src/taskstore.ts";
import { sweepOnce } from "../src/sweeper.ts";

let root: string;
let env: PathEnv;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "omt-sweeper-"));
  env = { XDG_STATE_HOME: `${root}/state`, XDG_DATA_HOME: `${root}/data` };
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const logs: string[] = [];
const removedIds: string[] = [];
const registry = {
  remove: (id: string): boolean => {
    removedIds.push(id);
    return true;
  },
};

function baseMeta(id: string, state: TaskMeta["state"], updatedAt: number): TaskMeta {
  return {
    schema: 1,
    id,
    command: "true",
    description: null,
    session_id: "ses_sweep",
    opencode_port: 1,
    pid: null,
    pgid: null,
    proc_start_time: null,
    started_at: updatedAt,
    directory: root,
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
    state,
    exit_info: null,
    grace_deadline: null,
    claimed_by: 0,
    updated_at: updatedAt,
  };
}

function makeTask(id: string, state: TaskMeta["state"], updatedAt: number, withExit = false): void {
  const paths = initTaskDir(env, id);
  writeMeta(env, baseMeta(id, state, updatedAt));
  if (withExit) writeFileSync(paths.exit, "0\n", { mode: 0o600 });
}

const AGO = Date.now() - LIMITS.taskTtlMs - 60_000; // TTL 已过
const RECENT = Date.now() - 1_000; // TTL 未到

test("终态 TTL：过期清 + registry 移除；未到保留；活态/parked 永不清", () => {
  makeTask("mon_swold00001", "completed", AGO);
  makeTask("mon_swwait0002", "stopped", RECENT);
  makeTask("mon_swalive0003", "running", AGO); // 活态即使 meta 很旧也不清
  makeTask("mon_swpark00004", "parked", AGO); // parked 不清（人工处置）
  makeTask("mon_swidle00005", "idle", AGO);

  const r = sweepOnce(env, registry, (m) => logs.push(m));
  assert.equal(r.removed, 1);
  assert.equal(r.keptUnverifiable, 0);
  assert.ok(removedIds.includes("mon_swold00001"));
  assert.ok(!existsSync(taskFilePaths(env, "mon_swold00001").dir), "expired terminal dir removed");
  for (const keep of ["mon_swwait0002", "mon_swalive0003", "mon_swpark00004", "mon_swidle00005"]) {
    assert.ok(existsSync(taskFilePaths(env, keep).dir), `${keep} must be kept`);
  }
});

test("坏 meta：有 exit 佐证按 exit mtime 同 TTL 清；无佐证保守不删", () => {
  // 坏 meta + 老 exit（mtime 拨到 TTL 外）
  const oldExit = initTaskDir(env, "mon_swbadold06");
  writeFileSync(oldExit.meta, "{ broken", { mode: 0o600 });
  writeFileSync(oldExit.exit, "0\n", { mode: 0o600 });
  const past = new Date(Date.now() - LIMITS.taskTtlMs - 60_000);
  utimesSync(oldExit.exit, past, past);
  // 坏 meta + 新 exit（TTL 内）
  const newExit = initTaskDir(env, "mon_swbadnew07");
  writeFileSync(newExit.meta, "{ broken", { mode: 0o600 });
  writeFileSync(newExit.exit, "0\n", { mode: 0o600 });
  // 坏 meta + 无 exit：永不清
  const noExit = initTaskDir(env, "mon_swnoexit08");
  writeFileSync(noExit.meta, "{ broken", { mode: 0o600 });

  const r = sweepOnce(env, registry, (m) => logs.push(m));
  assert.equal(r.removed, 1); // 坏 meta + 老 exit 佐证（其余坏 meta 均保留）
  assert.equal(r.keptUnverifiable, 1);
  assert.ok(!existsSync(oldExit.dir), "bad meta with stale exit witness removed");
  assert.ok(existsSync(newExit.dir), "bad meta with fresh exit kept");
  assert.ok(existsSync(noExit.dir), "bad meta without exit kept forever");
});
