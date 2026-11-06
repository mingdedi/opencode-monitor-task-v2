// TaskRegistry 簿记单测：add/get/list 过滤/alive 计数
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

// ---------------------------------------------------------------------------
// session 上限计数 / remove / 终态驱逐

test("aliveCountForSession：只数该 session 的存活态（idle 也算活）", () => {
  const r = new TaskRegistry();
  r.add(stub("mon_a", "ses_1", "running", 1));
  r.add(stub("mon_b", "ses_1", "idle", 2));
  r.add(stub("mon_c", "ses_1", "completed", 3));
  r.add(stub("mon_d", "ses_2", "running", 4));
  r.add(stub("mon_e", "ses_2", "parked", 5));
  assert.equal(r.aliveCountForSession("ses_1"), 2);
  assert.equal(r.aliveCountForSession("ses_2"), 1, "parked 不算存活");
  assert.equal(r.aliveCountForSession("ses_none"), 0);
});

test("remove：删除在册条目；未知 id 返回 false", () => {
  const r = new TaskRegistry();
  r.add(stub("mon_a", "ses_1", "completed", 1));
  assert.equal(r.remove("mon_a"), true);
  assert.equal(r.get("mon_a"), undefined);
  assert.equal(r.size, 0);
  assert.equal(r.remove("mon_a"), false);
});

test("终态驱逐：超 registryMaxTerminal 时 add 触发，驱逐最旧终态；存活条目永不驱逐", () => {
  const r = new TaskRegistry();
  // 占位一个存活任务（驱逐绝不波及）
  r.add(stub("mon_alive", "ses_1", "running", 0));
  // 200 个终态装满（started_at 递增）
  for (let i = 1; i <= 200; i++) r.add(stub(`mon_t${String(i).padStart(3, "0")}`, "ses_1", "completed", i));
  assert.equal(r.size, 201);
  // 第 201 个终态进入 → 驱逐最旧（mon_t001），总量回到 201（200 终态 + 1 存活）
  r.add(stub("mon_t201x", "ses_1", "failed", 999));
  assert.equal(r.size, 201);
  assert.equal(r.get("mon_t001"), undefined, "最旧终态被驱逐");
  assert.equal(r.get("mon_t002") !== undefined, true);
  assert.equal(r.get("mon_alive") !== undefined, true, "存活条目不受驱逐影响");
  assert.equal(r.get("mon_t201x") !== undefined, true);
  // 驱逐只动内存：目录/TaskStore 归 sweeper——此处仅 registry 语义
});
