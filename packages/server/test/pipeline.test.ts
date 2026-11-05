// pipeline 纯函数单测（SERVER-PLAN 阶段 D + 阶段 E）：splitLines / cleanLine /
// Matcher pattern 语义 / TokenBucket / Coalescer / formatCoalesced
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "@omt/shared";
import { Coalescer, Matcher, TokenBucket, cleanLine, formatCoalesced, makeMatcher, splitLines, stripAnsi } from "../src/pipeline.ts";

// ---------------------------------------------------------------------------
// splitLines

test("splitLines：\\n 分行，尾部无换行留 rest", () => {
  const r = splitLines("", "hello\nworld");
  assert.deepEqual(r.lines, ["hello"]);
  assert.equal(r.rest, "world");
});

test("splitLines：\\r\\n 与 \\r 都成行（进度条 \\r 刷新兼容，v1 语义）", () => {
  const r = splitLines("", "a\r\nb\rc\n");
  assert.deepEqual(r.lines, ["a", "b", "c"]);
  assert.equal(r.rest, "");
});

test("splitLines：pending 前缀与 chunk 拼接（跨读半行）", () => {
  const r = splitLines("ab", "c\nd\n");
  assert.deepEqual(r.lines, ["abc", "d"]);
  assert.equal(r.rest, "");
});

test("splitLines：空输入 → 无行无残余", () => {
  const r = splitLines("", "");
  assert.deepEqual(r.lines, []);
  assert.equal(r.rest, "");
});

test("splitLines：仅换行符 → 两个空行（交 cleanLine 丢弃）", () => {
  const r = splitLines("", "\n\n");
  assert.deepEqual(r.lines, ["", ""]);
  assert.equal(r.rest, "");
});

// ---------------------------------------------------------------------------
// cleanLine

test("cleanLine：ANSI CSI 剥离（颜色/光标序列）", () => {
  assert.equal(cleanLine("\x1b[31mERROR\x1b[0m boom"), "ERROR boom");
  assert.equal(cleanLine("\x1b[2Kprogress 50%"), "progress 50%");
});

test("cleanLine：ANSI OSC 剥离（窗口标题等，BEL 与 ESC\\ 两种终结）", () => {
  assert.equal(cleanLine("\x1b]0;title\x07real"), "real");
  assert.equal(cleanLine("\x1b]2;title\x1b\\real"), "real");
});

test("cleanLine：trim + 空行（含 ANSI 剥离后变空）→ null", () => {
  assert.equal(cleanLine("  spaced  "), "spaced");
  assert.equal(cleanLine(""), null);
  assert.equal(cleanLine("   "), null);
  assert.equal(cleanLine("\x1b[0m \x1b[2K"), null);
});

test("cleanLine：超长行截断带 …[truncated] 标记（v1 资产继承——agent 可感知截断）", () => {
  const long = "x".repeat(LIMITS.lineMaxChars + 500);
  const cleaned = cleanLine(long)!;
  assert.ok(cleaned.startsWith("x".repeat(LIMITS.lineMaxChars)), "前 2000 字符保留");
  assert.ok(cleaned.endsWith("…[truncated]"), "截断标记可见");
  // 不超长：无标记
  assert.equal(cleanLine("short"), "short");
});

test("cleanLine：单字符 ESC 序列剥离（v1 ANSI_SINGLE 资产继承——final byte 范围 @-Z\\^-_）", () => {
  assert.equal(cleanLine("before\x1bMafter"), "beforeafter"); // RI 反向换行（M ∈ @-Z）
  assert.equal(cleanLine("\x1bAup\x1bBdown"), "updown"); // CUU/CUD
  // \x1b7（DECSC，"7" 不在 @-Z 字母区间）不在 ANSI_SINGLE 范围——由 CONTROLS
  // 兜底剥掉 ESC 本身，数字字面量保留（v1 同款行为，非缺陷）
  assert.equal(cleanLine("\x1b7save"), "7save");
});

test("cleanLine：C0/C1 控制字符剥离（v1 CONTROLS 资产继承）——二进制噪音不进通知正文", () => {
  assert.equal(cleanLine("a\x00b\x07c\x0bd\x7fe\x9bf"), "abcdef");
  // 全控制字符行 → 剥净后为空 → null
  assert.equal(cleanLine("\x07\x07"), null);
});

// ---------------------------------------------------------------------------
// Matcher（SERVER-PLAN 阶段 E：pattern 过滤语义，v1 emitLine 资产）

test("makeMatcher：无 pattern / 空串 → null（直通全命中）", () => {
  assert.equal(makeMatcher(null, "pattern"), null);
  assert.equal(makeMatcher("", "all"), null);
});

test("Matcher pattern 模式：命中 pass+matched，未命中丢弃", () => {
  const m = makeMatcher("ERROR", "pattern")!;
  assert.deepEqual(m.judge("ERROR boom"), { pass: true, matched: true });
  assert.deepEqual(m.judge("info ok"), { pass: false, matched: false });
});

test("Matcher all 模式 + pattern：只统计不过滤——未命中放行但不计 matched（PLAN §3.3）", () => {
  const m = makeMatcher("ERROR", "all")!;
  assert.deepEqual(m.judge("ERROR boom"), { pass: true, matched: true });
  assert.deepEqual(m.judge("info ok"), { pass: true, matched: false });
});

test("Matcher：正则语义生效（锚点/字符类），非 global（test 无 lastIndex 状态）", () => {
  const m = makeMatcher("^\\[build\\]", "pattern")!;
  assert.equal(m.judge("[build] step 3").pass, true);
  assert.equal(m.judge("see [build] done").pass, false);
  const g = new Matcher("a", "pattern"); // 非 global：反复 test 稳定
  for (let i = 0; i < 3; i++) assert.equal(g.judge("aaa").pass, true);
});

// ---------------------------------------------------------------------------
// TokenBucket（v1 throttle.ts 资产：突发 5 + 1/s 惰性补充）

test("TokenBucket：突发 5 枚即取尽，第 6 枚拒绝", () => {
  let t = 0;
  const b = new TokenBucket({ now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(b.tryTake(), true, `take ${i + 1}`);
  assert.equal(b.tryTake(), false);
});

test("TokenBucket：惰性补充——静置 1s 恰补 1 枚，2s 补 2 枚，封顶不过容量", () => {
  let t = 0;
  const b = new TokenBucket({ now: () => t });
  for (let i = 0; i < 5; i++) b.tryTake();
  t = 1000;
  assert.equal(b.tryTake(), true); // 补 1 → 1，取走 → 0
  assert.equal(b.tryTake(), false); // 不足
  t = 3000; // 再静置 2s：0 + 2 = 2
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
  t = 100_000; // 长静置：封顶容量 5
  let got = 0;
  for (let i = 0; i < 6; i++) if (b.tryTake()) got++;
  assert.equal(got, 5);
});

// ---------------------------------------------------------------------------
// Coalescer + formatCoalesced（PLAN §2.5；v1 queueCoalesce/flushCoalesce 资产）

test("Coalescer：首行开窗 tumbling，到期判定，flush 取走并关窗", () => {
  const c = new Coalescer(500);
  assert.equal(c.due(0), false); // 空窗恒 false
  c.add("l1", 100);
  assert.equal(c.due(500), false); // 100 + 500 = 600 > 500
  assert.equal(c.due(600), true);
  const b = c.flush()!;
  assert.deepEqual(b, { lines: ["l1"], evicted: 0 });
  assert.equal(c.due(600), false); // 关窗
  assert.equal(c.flush(), null); // 空窗 null
  c.add("l2", 700); // 重新开窗
  assert.equal(c.size, 1);
});

test("Coalescer：pending 上限丢最旧（1000），evicted 计数入 flush", () => {
  const c = new Coalescer(500, 3); // 上限 3 便于测试
  c.add("a", 0);
  c.add("b", 1);
  c.add("c", 2);
  c.add("d", 3); // 丢 a
  c.add("e", 4); // 丢 b
  const batch = c.flush()!;
  assert.deepEqual(batch.lines, ["c", "d", "e"]);
  assert.equal(batch.evicted, 2);
});

test("formatCoalesced：单行/多行头部计数、10 行×200 字符截断、suppressed 计数（v1 语义逐条）", () => {
  assert.equal(formatCoalesced({ lines: ["only"], evicted: 0 }), "[1 line coalesced]\nonly");
  const two = formatCoalesced({ lines: ["a", "b"], evicted: 0 });
  assert.ok(two.startsWith("[2 lines coalesced]\na\nb"), two);
  // 12 行：前 10 展示 + 2 suppressed
  const lines12 = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);
  const out12 = formatCoalesced({ lines: lines12, evicted: 0 });
  assert.ok(out12.startsWith("[12 lines coalesced]"), out12);
  assert.ok(out12.includes("L10"));
  assert.ok(!out12.includes("L11\n"));
  assert.ok(out12.endsWith("(… 2 more lines suppressed)"), out12);
  // 单行超 200 字符：截断加省略号（v1 COALESCE_SHOWN_WIDTH）
  const long = "x".repeat(LIMITS.coalesceLineChars + 50);
  const outLong = formatCoalesced({ lines: [long], evicted: 0 });
  assert.ok(outLong.includes("x".repeat(LIMITS.coalesceLineChars) + "…"), outLong);
  // evicted 并入总数与 suppressed（v2 可观测增强：丢最旧不静默）
  const outEv = formatCoalesced({ lines: ["a", "b"], evicted: 3 });
  assert.ok(outEv.startsWith("[5 lines coalesced]"), outEv);
  assert.ok(outEv.endsWith("(… 3 more lines suppressed)"), outEv);
});
