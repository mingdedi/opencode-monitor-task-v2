// pipeline 纯函数单测（SERVER-PLAN 阶段 D）：splitLines 分行语义 + cleanLine 清洗语义
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "@omt/shared";
import { cleanLine, splitLines, stripAnsi } from "../src/pipeline.ts";

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

test("cleanLine：超长行截断到 2000 字符", () => {
  const long = "x".repeat(LIMITS.lineMaxChars + 500);
  const cleaned = cleanLine(long);
  assert.equal(cleaned!.length, LIMITS.lineMaxChars);
});
