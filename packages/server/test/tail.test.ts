// LogTail 单测（SERVER-PLAN 阶段 D）：真文件 append + 轮询读；
// 多字节边界（StringDecoder）、partial 行跨 poll 保留、行安全 offset 语义
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { LIMITS } from "@omt/shared";
import { LogTail } from "../src/tail.ts";

let root: string;
let logPath: string;
let seq = 0;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "omt-tail-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function newLog(): string {
  logPath = path.join(root, `log-${seq++}`);
  writeFileSync(logPath, "", { mode: 0o600 });
  return logPath;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("增量读：append 后下一 poll 出行，未 append 时空轮", async () => {
  const t = new LogTail(newLog());
  assert.deepEqual(t.poll(), { lines: [], bytesConsumed: 0 }); // 空（EOF）
  appendFileSync(logPath, "hello\n");
  assert.deepEqual(t.poll(), { lines: ["hello"], bytesConsumed: 6 });
  assert.deepEqual(t.poll(), { lines: [], bytesConsumed: 0 }); // 无新数据
  t.close();
});

test("partial 行：跨 poll 保留残余，成行后整行交付", async () => {
  const t = new LogTail(newLog());
  appendFileSync(logPath, "abc");
  const r1 = t.poll();
  assert.deepEqual(r1.lines, []);
  assert.equal(r1.bytesConsumed, 3);
  assert.equal(t.pendingBytes(), 3); // 行安全 offset 应回退这 3 字节
  appendFileSync(logPath, "def\n");
  const r2 = t.poll();
  assert.deepEqual(r2.lines, ["abcdef"]);
  assert.equal(t.pendingBytes(), 0);
  t.close();
});

test("多字节边界：半个 UTF-8 字符跨 append，不产残字符", async () => {
  const t = new LogTail(newLog());
  const ch = "中"; // U+4E2D，3 字节
  const buf = Buffer.from(ch, "utf8");
  appendFileSync(logPath, buf.subarray(0, 2)); // 只写前 2 字节
  assert.deepEqual(t.poll().lines, []);
  appendFileSync(logPath, Buffer.concat([buf.subarray(2), Buffer.from("\n")]));
  assert.deepEqual(t.poll().lines, [ch]);
  t.close();
});

test("清洗集成：cleanLine 在 tail 层完成（ANSI/空行不出门）", async () => {
  const t = new LogTail(newLog());
  appendFileSync(logPath, "\x1b[32mok\x1b[0m\n\n   \nplain\n");
  assert.deepEqual(t.poll().lines, ["ok", "plain"]);
  t.close();
});

test("行安全 offset：last_offset 语义（总读字节 - pendingBytes）", async () => {
  const t = new LogTail(newLog());
  appendFileSync(logPath, "line1\npart"); // 6 + 4 = 10 字节，行安全点 = 6
  const r = t.poll();
  assert.equal(r.bytesConsumed, 10);
  assert.equal(10 - t.pendingBytes(), 6);
  t.close();
  // 从行安全点重开（G 阶段 reattach 语义）：不丢不重不拼残行
  const t2 = new LogTail(logPath, 6);
  appendFileSync(logPath, "ial2\n");
  assert.deepEqual(t2.poll().lines, ["partial2"]);
  t2.close();
});

test("大 chunk：超过单次读缓冲（64KB）循环读尽；无换行长行按 v1 语义截断 2000 字符", async () => {
  const t = new LogTail(newLog());
  const big = `${"y".repeat(70_000)}\n`;
  appendFileSync(logPath, big);
  const r = t.poll();
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0]!.startsWith("y".repeat(LIMITS.lineMaxChars)), "cleanLine 单行截断语义");
  assert.ok(r.lines[0]!.endsWith("…[truncated]"), "截断标记（v1 资产）");
  assert.equal(r.bytesConsumed, Buffer.byteLength(big));
  t.close();
});

test("flushPending：无换行残余强制成行（v1 attached flushBuffer 资产——临终输出不丢）", async () => {
  const t = new LogTail(newLog());
  appendFileSync(logPath, "line1\npartial-no-newline");
  const r = t.poll();
  assert.deepEqual(r.lines, ["line1"]); // 残余不成行
  assert.ok(t.pendingBytes() > 0);
  assert.deepEqual(t.flushPending(), ["partial-no-newline"]); // 强制成行
  assert.equal(t.pendingBytes(), 0); // 清空（last_offset 前进到文件末）
  assert.deepEqual(t.flushPending(), []); // 幂等：空残余无行
  t.close();
});

test("64KB 软换行（SERVER-PLAN 阶段 E）：未成行残余超阈值强制成行，pending 清空", async () => {
  const t = new LogTail(newLog());
  // 一次写入 64KB+1 无换行 → 软换行立即触发（poll 内判定）
  appendFileSync(logPath, "z".repeat(LIMITS.softWrapBytes + 1));
  const r1 = t.poll();
  assert.equal(r1.lines.length, 1, "残余超限强制成行");
  assert.ok(r1.lines[0]!.startsWith("z".repeat(LIMITS.lineMaxChars)), "软换行行同样过 cleanLine 截断");
  assert.ok(r1.lines[0]!.endsWith("…[truncated]"), "截断标记（v1 资产）");
  assert.equal(t.pendingBytes(), 0, "软换行后 pending 清空（该段已消费）");
  t.close();
});

test("64KB 软换行边界：恰 64KB 不触发，后续字节仍未成行", async () => {
  const t = new LogTail(newLog());
  appendFileSync(logPath, "a".repeat(LIMITS.softWrapBytes));
  const r1 = t.poll();
  assert.deepEqual(r1.lines, [], "恰 64KB 不软换行");
  assert.equal(t.pendingBytes(), LIMITS.softWrapBytes);
  appendFileSync(logPath, "b\n"); // 追加后成行：软换行段 + 新字符合成一行
  const r2 = t.poll();
  const expected = "a".repeat(LIMITS.softWrapBytes) + "b";
  assert.equal(r2.lines.length, 1);
  assert.ok(r2.lines[0]!.startsWith(expected.slice(0, LIMITS.lineMaxChars)), "前 2000 字符保留");
  assert.ok(r2.lines[0]!.endsWith("…[truncated]"), "截断标记（v1 资产）");
  t.close();
});

test("软换行 offset 语义：强制成行后 pendingBytes=0，last_offset 前进到文件尾", async () => {
  const t = new LogTail(newLog());
  const blob = "q".repeat(LIMITS.softWrapBytes + 100);
  appendFileSync(logPath, blob);
  const r = t.poll();
  assert.equal(r.bytesConsumed, blob.length);
  assert.equal(r.bytesConsumed - t.pendingBytes(), blob.length, "行安全点 = 文件尾（软换行段已交付）");
  t.close();
});
