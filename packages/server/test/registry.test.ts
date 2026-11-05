// TaskRegistry 簿记单测（SERVER-PLAN 阶段 D 薄版）：add/get/list 过滤/alive 计数
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicInfo } from "@omt/shared";
import { TaskRegistry, isAliveState, type TaskView } from "../src/registry.ts";

function stub(id: string, sessionId: string, state: PublicInfo["state"], startedAt: number): TaskView {
  return {
    id,
    toPublicInfo: () =>
      ({
        id,
        description: null,
        state,
        session_id: sessionId,
        opencode_port: 1,
        directory: "/tmp",
        command: "x",
        pattern: null,
        wake_mode: "all",
        delivery: "queue",
        coalesce_ms: 500,
        max_events: 50,
        idle_timeout_ms: 300000,
        idle_deadline: null,
        grace_deadline: null,
        started_at: startedAt,
        pid: 123,
        lines_scanned: 0,
        lines_matched: 0,
        events_sent: 0,
        events_dropped: 0,
        exit_info: null,
        log_bytes: 0,
        last_offset: 0,
        updated_at: startedAt,
      }) satisfies PublicInfo,
  };
}

test("isAliveState：starting/running/idle 活；终态与 parked 死", () => {
  assert.equal(isAliveState("starting"), true);
  assert.equal(isAliveState("running"), true);
  assert.equal(isAliveState("idle"), true);
  assert.equal(isAliveState("completed"), false);
  assert.equal(isAliveState("failed"), false);
  assert.equal(isAliveState("stopped"), false);
  assert.equal(isAliveState("orphaned"), false);
  assert.equal(isAliveState("parked"), false);
});

test("add/get/size：簿记", () => {
  const r = new TaskRegistry();
  const a = stub("mon_aaa", "ses_1", "running", 1);
  r.add(a);
  assert.equal(r.get("mon_aaa"), a);
  assert.equal(r.get("mon_zzz"), undefined);
  assert.equal(r.size, 1);
});

test("aliveCount：只数存活态", () => {
  const r = new TaskRegistry();
  r.add(stub("mon_a", "ses_1", "running", 1));
  r.add(stub("mon_b", "ses_1", "idle", 2));
  r.add(stub("mon_c", "ses_1", "completed", 3));
  assert.equal(r.aliveCount(), 2);
});

test("listInfos：按 session 过滤 + started_at 排序；无过滤全量", () => {
  const r = new TaskRegistry();
  r.add(stub("mon_b", "ses_1", "running", 20));
  r.add(stub("mon_a", "ses_2", "running", 10));
  r.add(stub("mon_c", "ses_1", "completed", 30));
  assert.deepEqual(
    r.listInfos("ses_1").map((i) => i.id),
    ["mon_b", "mon_c"],
  );
  assert.deepEqual(
    r.listInfos().map((i) => i.id),
    ["mon_a", "mon_b", "mon_c"],
  );
  assert.deepEqual(r.listInfos("ses_none"), []);
});
