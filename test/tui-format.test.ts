import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fmtDuration,
  MAX_SHOWN,
  PANEL_WIDTH,
  renderLines,
  shortId,
  TERMINAL_TTL_MS,
  truncate,
} from "../src/tui/format.ts";
import type { PanelState } from "../src/tui/format.ts";
import type { PublicInfo } from "../packages/shared/src/types.ts";

const T0 = 1_800_000_000_000; // epoch ms（v2 契约：started_at/updated_at 均为 epoch ms）

function task(over: Partial<PublicInfo> = {}): PublicInfo {
  return {
    id: "mon_ab12cd34",
    description: null,
    state: "running",
    session_id: "ses_cur",
    opencode_port: 49374,
    directory: "/abs",
    command: "python train.py",
    pattern: null,
    wake_mode: "all",
    delivery: "queue",
    coalesce_ms: 500,
    max_events: 50,
    idle_timeout_ms: 300000,
    idle_deadline: null,
    grace_deadline: null,
    started_at: T0 - 12 * 60_000,
    pid: 4242,
    lines_scanned: 61,
    lines_matched: 0,
    events_sent: 11,
    events_dropped: 0,
    exit_info: null,
    log_bytes: 4096,
    last_offset: 4096,
    updated_at: T0,
    ...over,
  };
}

function state(over: Partial<PanelState> = {}, tasks: PublicInfo[] = [task()]): PanelState {
  return {
    status: { kind: "online" },
    tasks,
    sessionID: "ses_cur",
    now: T0,
    ...over,
  };
}

test("fmtDuration buckets", () => {
  assert.equal(fmtDuration(0), "0s");
  assert.equal(fmtDuration(45_000), "45s");
  assert.equal(fmtDuration(60_000), "1m");
  assert.equal(fmtDuration(720_000), "12m");
  assert.equal(fmtDuration(3_780_000), "1h03m");
  assert.equal(fmtDuration(8_040_000), "2h14m");
});

test("shortId / truncate", () => {
  assert.equal(shortId("mon_ab12cd34"), "mon_ab12");
  assert.equal(shortId("mon_ab"), "mon_ab");
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});

test("offline renders warn head plus auto-start hint", () => {
  const lines = renderLines(state({ status: { kind: "offline", reason: "pid-dead" }, tasks: [] }));
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.tone, "warn");
  assert.equal(lines[0]!.text, "MONITORS · server offline");
  assert.equal(lines[1]!.tone, "dim");
  assert.equal(lines[1]!.text, "  auto-starts on next tool call");
});

test("no-service-file offline renders the same two lines", () => {
  const lines = renderLines(state({ status: { kind: "offline", reason: "no-service-file" }, tasks: [] }));
  assert.equal(lines[0]!.text, "MONITORS · server offline");
});

test("unreachable surfaces diagnostics (never silent)", () => {
  const lines = renderLines(
    state({ status: { kind: "unreachable", detail: "http 401 (pid 999 alive)" }, tasks: [] }),
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.text, "MONITORS · server unreachable");
  assert.match(lines[1]!.text, /401/);
  assert.match(lines[1]!.text, /pid 999 alive/);
});

test("online with nothing to show collapses to zero lines", () => {
  assert.deepEqual(renderLines(state({}, [])), []);
});

test("null session collapses to zero lines (no guessing a default session)", () => {
  assert.deepEqual(renderLines(state({ sessionID: null })), []);
});

test("running task: head/subject/counts with pid, width respected", () => {
  const lines = renderLines(state({}, [task({ lines_matched: 11 })]));
  assert.equal(lines.length, 4);
  assert.equal(lines[0]!.text, "MONITORS · 1 running");
  assert.equal(lines[1]!.text, "● mon_ab12 12m");
  assert.equal(lines[2]!.text, "  python train.py");
  assert.equal(lines[3]!.text, "  scan 61 · hit 11 · sent 11 · pid 4242");
  for (const l of lines) {
    assert.ok(l.text.length <= PANEL_WIDTH, `line too wide (${l.text.length}): ${l.text}`);
  }
});

test("description preferred over command when present", () => {
  const lines = renderLines(state({}, [task({ description: "watch rebuild" })]));
  assert.equal(lines[2]!.text, "  watch rebuild");
});

test("idle task shows adjudication countdown instead of elapsed", () => {
  const lines = renderLines(
    state({}, [task({ state: "idle", idle_deadline: 138_000, grace_deadline: T0 + 138_000 })]),
  );
  assert.equal(lines[1]!.text, "○ mon_ab12 arb 2m");
});

test("failed task shows exit code, never pid", () => {
  const lines = renderLines(
    state({}, [
      task({ state: "failed", pid: null, exit_info: { code: "1", reason: "exited" }, updated_at: T0 }),
    ]),
  );
  assert.equal(lines[0]!.text, "MONITORS · 0 running · 1 done");
  assert.equal(lines[1]!.text, "✘ mon_ab12 exit 1");
  assert.ok(!lines[3]!.text.includes("pid"), "terminal tasks do not show pid");
});

test("signal exit codes render inline", () => {
  const lines = renderLines(
    state({}, [
      task({ state: "stopped", pid: null, exit_info: { code: "signal:15", reason: "killed" } }),
    ]),
  );
  assert.equal(lines[1]!.text, "■ mon_ab12 exit signal:15");
});

test("orphaned and parked carry their state labels", () => {
  const lines = renderLines(
    state(
      {},
      [
        task({ state: "orphaned", pid: null, exit_info: null }),
        task({ state: "parked", pid: 999, updated_at: T0 }),
      ],
    ),
  );
  assert.equal(lines[1]!.text, "⊘ mon_ab12 orphaned");
  assert.equal(lines[4]!.text, "⚑ mon_ab12 parked");
});

test("terminal tasks older than the 5min display window are dropped", () => {
  const stale = task({ state: "completed", pid: null, exit_info: { code: "0", reason: "exited" } });
  const fresh = { ...stale, id: "mon_ff00cd34", updated_at: T0 - TERMINAL_TTL_MS + 60_000 };
  const lines = renderLines(state({}, [{ ...stale, updated_at: T0 - TERMINAL_TTL_MS - 1 }, fresh]));
  assert.equal(lines.length, 4); // head + 3 rows, only the fresh one
  assert.ok(!lines.some((l) => l.text.includes("mon_ab12")), "stale terminal task hidden");
  assert.ok(lines.some((l) => l.text.includes("mon_ff00")));
});

test("live tasks sort ahead of terminal ones regardless of arrival order", () => {
  const lines = renderLines(
    state(
      {},
      [
        task({ state: "completed", pid: null, exit_info: { code: "0", reason: "exited" } }),
        task({ id: "mon_ee11cd34", state: "running" }),
      ],
    ),
  );
  assert.ok(lines[1]!.text.startsWith("●"));
  assert.ok(lines[4]!.text.startsWith("✔"));
});

test("folding beyond MAX_SHOWN", () => {
  const many = Array.from({ length: 9 }, (_, i) => task({ id: `mon_${i}0000000` }));
  const lines = renderLines(state({}, many));
  const fold = lines.find((l) => l.text.startsWith("  +"));
  assert.ok(fold, "fold row present");
  assert.equal(fold!.text, `  +${9 - MAX_SHOWN} more…`);
});

test("long subjects and counts are truncated to panel width", () => {
  const long = "x".repeat(200);
  for (const l of renderLines(state({}, [task({ command: long })]))) {
    assert.ok(l.text.length <= PANEL_WIDTH, `line too wide: ${l.text.length}`);
  }
});

test("dropped events surface in the counts line", () => {
  const lines = renderLines(state({}, [task({ events_dropped: 2 })]));
  assert.match(lines[3]!.text, /drop 2/);
});

test("other-session summary appended, even when this session is empty", () => {
  const other = task({ session_id: "ses_other", id: "mon_1111aaaa" });
  const lines = renderLines(state({ tasks: [other] }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.text, "  +1 running in 1 other session");

  const two = [task({ session_id: "ses_a" }), task({ session_id: "ses_b" })];
  const plural = renderLines(state({ tasks: two }));
  assert.equal(plural.at(-1)!.text, "  +2 running in 2 other sessions");
  for (const l of plural) {
    assert.ok(l.text.length <= PANEL_WIDTH, `line too wide: ${l.text}`);
  }
});
