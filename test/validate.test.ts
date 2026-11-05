import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommand, validateCreateInput, versionCompatible } from "../packages/shared/src/validate.ts";

// ---------------------------------------------------------------------------
// 发现流程版本兼容判定（SERVER-PLAN §三-3：major.minor 相等即复用）

test("versionCompatible: major.minor equal → compatible (patch differs)", () => {
  assert.equal(versionCompatible("0.1.0", "0.1.9"), true);
  assert.equal(versionCompatible("2.2.5", "2.2.0"), true);
});

test("versionCompatible: minor or major differs → incompatible", () => {
  assert.equal(versionCompatible("0.1.0", "0.2.0"), false);
  assert.equal(versionCompatible("0.1.0", "1.1.0"), false);
});

test("versionCompatible: malformed running version → incompatible (fail safe)", () => {
  assert.equal(versionCompatible("0.1.0", "garbage"), false);
});

// ---------------------------------------------------------------------------
// 命令校验（v1 规则，PLAN §3.3）

test("trailing & is stripped", () => {
  const r = checkCommand("sleep 10 &");
  assert.equal(r.ok, true);
  assert.equal(r.command, "sleep 10");
});

test("trailing & with whitespace is stripped", () => {
  const r = checkCommand("  make build  &  ");
  assert.equal(r.ok, true);
  assert.equal(r.command, "make build");
});

test("ampersand inside quotes survives, not stripped", () => {
  const r = checkCommand('echo "a & b"');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'echo "a & b"');
});

test("trailing quoted ampersand is not stripped", () => {
  const r = checkCommand('echo "x&"');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'echo "x&"');
});

test("&& allowed", () => {
  const r = checkCommand("npm test && npm run build");
  assert.equal(r.ok, true);
});

test("bare & mid-command rejected", () => {
  const r = checkCommand("sleep 10 & echo hi");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /background/);
});

test("double trailing && rejected (incomplete)", () => {
  const r = checkCommand("sleep 10 &&");
  assert.equal(r.ok, false);
});

test("2>&1 allowed", () => {
  const r = checkCommand("make 2>&1");
  assert.equal(r.ok, true);
});

test(">&2 allowed", () => {
  const r = checkCommand("echo warn >&2");
  assert.equal(r.ok, true);
});

test("&> redirect allowed", () => {
  const r = checkCommand("python train.py &> out.txt");
  assert.equal(r.ok, true);
});

test("$(...) rejected", () => {
  assert.equal(checkCommand("echo $(whoami)").ok, false);
});

test("$(...) in double quotes rejected (still expands)", () => {
  assert.equal(checkCommand('echo "$(whoami)"').ok, false);
});

test("$(...) in single quotes allowed (literal)", () => {
  assert.equal(checkCommand("echo '$(whoami)'").ok, true);
});

test("backtick rejected", () => {
  assert.equal(checkCommand("echo `whoami`").ok, false);
});

test("backtick in double quotes rejected", () => {
  assert.equal(checkCommand('echo "`whoami`"').ok, false);
});

test("backtick in single quotes allowed", () => {
  assert.equal(checkCommand("echo '`whoami`'").ok, true);
});

test("escaped backtick allowed", () => {
  assert.equal(checkCommand("echo \\`whoami\\`").ok, true);
});

test("<(...) process substitution rejected", () => {
  assert.equal(checkCommand("diff <(ls a) <(ls b)").ok, false);
});

test(">(...) process substitution rejected", () => {
  assert.equal(checkCommand("tee >(gzip > x.gz)").ok, false);
});

test("<(...) in double quotes allowed (literal)", () => {
  assert.equal(checkCommand('echo "<(not subst)"').ok, true);
});

test("empty command rejected", () => {
  assert.equal(checkCommand("   ").ok, false);
});

test("degenerate '&' rejected after stripping", () => {
  const r = checkCommand("&");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /empty/);
});

test("plain pipe and redirect fine", () => {
  assert.equal(checkCommand("kubectl logs -f pod | grep ERROR > err.txt").ok, true);
});

// ---------------------------------------------------------------------------
// CreateTaskInput 校验

const valid = {
  command: "sleep 60",
  opencode_port: 41000,
  session_id: "ses_test",
};

test("minimal valid input gets defaults", () => {
  const r = validateCreateInput(valid);
  assert.equal(r.ok, true);
  assert.equal(r.value?.wake_mode, "all");
  assert.equal(r.value?.delivery, "queue");
  assert.equal(r.value?.coalesce_ms, 500);
  assert.equal(r.value?.max_events, 50);
  assert.equal(r.value?.idle_timeout_ms, 300_000);
});

test("trailing & is stripped in validated value", () => {
  const r = validateCreateInput({ ...valid, command: "sleep 60 &" });
  assert.equal(r.ok, true);
  assert.equal(r.value?.command, "sleep 60");
});

test("degenerate '&' rejected at input validation", () => {
  const r = validateCreateInput({ ...valid, command: "&" });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0]?.field, "command");
});

test("pattern implies wake_mode=pattern", () => {
  const r = validateCreateInput({ ...valid, pattern: "ERROR" });
  assert.equal(r.value?.wake_mode, "pattern");
});

test("empty pattern normalized to undefined (wake_mode stays all)", () => {
  const r = validateCreateInput({ ...valid, pattern: "" });
  assert.equal(r.ok, true);
  assert.equal(r.value?.pattern, undefined);
  assert.equal(r.value?.wake_mode, "all");
});

test("explicit wake_mode=all with pattern kept (只统计不过滤)", () => {
  const r = validateCreateInput({ ...valid, pattern: "ERROR", wake_mode: "all" });
  assert.equal(r.value?.wake_mode, "all");
});

test("invalid regex rejected with engine message", () => {
  const r = validateCreateInput({ ...valid, pattern: "([unclosed" });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0]?.field, "pattern");
  assert.match(r.violations[0]?.message ?? "", /invalid regex/);
});

test("bad command surfaces field violation", () => {
  const r = validateCreateInput({ ...valid, command: "foo & bar" });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0]?.field, "command");
});

test("range violations collected", () => {
  const r = validateCreateInput({
    ...valid,
    coalesce_ms: 61_000,
    max_events: 0,
    idle_timeout_ms: 3_600_001,
  });
  assert.equal(r.ok, false);
  const fields = r.violations.map((x) => x.field).sort();
  assert.deepEqual(fields, ["coalesce_ms", "idle_timeout_ms", "max_events"]);
});

test("missing required fields rejected", () => {
  const r = validateCreateInput({ command: "ls" });
  const fields = r.violations.map((x) => x.field).sort();
  assert.deepEqual(fields, ["opencode_port", "session_id"]);
});

test("relative directory rejected", () => {
  const r = validateCreateInput({ ...valid, directory: "relative/path" });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0]?.field, "directory");
});

test("description length capped at 80", () => {
  const r = validateCreateInput({ ...valid, description: "x".repeat(81) });
  assert.equal(r.ok, false);
});
