// 输出管线纯函数与纯类（PLAN §2.5 / §6.1；SERVER-PLAN 阶段 D 最小版 + 阶段 E 全套）
// 阶段 D：splitLines（\r\n|\r|\n 分行）+ cleanLine（ANSI 剥离/trim/截断/空行丢弃）。
// 阶段 E：makeMatcher（pattern 过滤语义）+ TokenBucket（突发 5 + 1/s 惰性补充）+
//         Coalescer（tumbling window，pending 上限丢最旧）+ formatCoalesced（合并正文）。
// 全部纯函数/类（v1 实证资产语义），clock 全注入式，无副作用依赖。
// 64KB 无换行软换行在 tail.ts（未成行残余归 tail 的 pending 语义管）。

import { LIMITS, type WakeMode } from "@omt/shared";

// ---------------------------------------------------------------------------
// 分行

const LINE_SPLIT = /\r\n|\r|\n/;

/** pending（跨读未成行残余）+ 新 chunk → 完整行 + 新残余。
 *  \r 单独成行兼容进度条类输出（v1 语义：每次 \r 刷新即新行）。 */
export function splitLines(pending: string, chunk: string): { lines: string[]; rest: string } {
  if (pending === "" && chunk === "") return { lines: [], rest: "" };
  const parts = (pending + chunk).split(LINE_SPLIT);
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

// ---------------------------------------------------------------------------
// 清洗（v1 资产：ANSI CSI/OSC 剥离、trim、单行截断 2000 字符、空行丢弃）

const ANSI_CSI = /\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI_CSI, "").replace(ANSI_OSC, "");
}

/** 清洗单行；清洗后为空返回 null（丢弃） */
export function cleanLine(line: string): string | null {
  const s = stripAnsi(line).trim();
  if (s === "") return null;
  return s.length > LIMITS.lineMaxChars ? s.slice(0, LIMITS.lineMaxChars) : s;
}

// ---------------------------------------------------------------------------
// pattern 过滤（PLAN §2.5 / §3.3；v1 emitLine 语义）

export interface MatchResult {
  /** 该行是否继续走投递管线（false = 被过滤丢弃，计入 lines_scanned） */
  pass: boolean;
  /** 该行是否计入 lines_matched（只统计不过滤的 wake_mode=all 模式下，
   *  未命中行 pass=true 但 matched=false——PLAN §3.3 "只统计不过滤"） */
  matched: boolean;
}

export const MATCH_HIT: MatchResult = { pass: true, matched: true };
export const MATCH_MISS: MatchResult = { pass: false, matched: false };
export const MATCH_PASS_UNMATCHED: MatchResult = { pass: true, matched: false };

/** 过滤器策略：null = 无 pattern（直通，全部行命中）；Matcher = pattern 语义裁决。
 *  非 global RegExp（test 无 lastIndex 状态，v1 同款）。 */
export class Matcher {
  private readonly re: RegExp;
  private readonly mode: WakeMode;

  constructor(pattern: string, mode: WakeMode) {
    this.re = new RegExp(pattern);
    this.mode = mode;
  }

  judge(line: string): MatchResult {
    const hit = this.re.test(line);
    if (hit) return MATCH_HIT;
    // 未命中：pattern 模式丢弃；all 模式放行但不计 matched（只统计不过滤）
    return this.mode === "pattern" ? MATCH_MISS : MATCH_PASS_UNMATCHED;
  }
}

/** 任务参数 → Matcher | null（无 pattern 或空串 → null，直通全部命中） */
export function makeMatcher(pattern: string | null, wakeMode: WakeMode): Matcher | null {
  if (pattern === null || pattern === "") return null;
  return new Matcher(pattern, wakeMode);
}

// ---------------------------------------------------------------------------
// 令牌桶（v1 throttle.ts 资产：容量 5、每秒补 1、惰性补充、超限丢弃不缓存）

export interface TokenBucketOptions {
  capacity?: number;
  refillPerSecond?: number;
  now?: () => number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefill: number;

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = options.capacity ?? LIMITS.tokenBucketBurst;
    this.refillPerSecond = options.refillPerSecond ?? LIMITS.tokenBucketRatePerSec;
    this.now = options.now ?? (() => Date.now());
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /** 取一枚令牌；false = 该事件必须丢弃（调用方计数，不缓存） */
  tryTake(): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// coalesce（PLAN §2.5：tumbling window 500ms；到期由 monitor 的单一 tick 检查驱动，
// 不自持定时器——SERVER-PLAN §一"单一 250ms tick 驱动 … coalesce 到期"裁定）

export class Coalescer {
  private readonly windowMs: number;
  private readonly pendingMax: number;
  private pending: string[] = [];
  private windowStart: number | null = null;
  /** 窗口内因 pending 上限被丢最旧的行数（flush 时并入 suppressed 计数，可观测） */
  private evicted = 0;

  constructor(windowMs: number, pendingMax: number = LIMITS.coalescePendingMax) {
    if (windowMs <= 0) throw new Error(`Coalescer windowMs must be > 0, got ${windowMs}`);
    this.windowMs = windowMs;
    this.pendingMax = pendingMax;
  }

  /** 行入窗。首行开窗（tumbling：flush 后下一行重新开窗）；
   *  pending 上限丢最旧（v1 资产：防内存膨胀，丢的是最旧、窗口继续） */
  add(line: string, now: number): void {
    if (this.pending.length >= this.pendingMax) {
      this.pending.shift();
      this.evicted++;
    }
    this.pending.push(line);
    if (this.windowStart === null) this.windowStart = now;
  }

  /** 窗口是否到期（空窗恒 false） */
  due(now: number): boolean {
    return this.windowStart !== null && now - this.windowStart >= this.windowMs;
  }

  /** 取走窗口内全部行（含 evicted 计数），窗口关闭；空窗返回 null */
  flush(): { lines: string[]; evicted: number } | null {
    if (this.pending.length === 0 && this.evicted === 0) {
      this.windowStart = null;
      return null;
    }
    const out = { lines: this.pending, evicted: this.evicted };
    this.pending = [];
    this.evicted = 0;
    this.windowStart = null;
    return out;
  }

  get size(): number {
    return this.pending.length;
  }
}

/** 合并批正文（v1 flushCoalesce 资产语义逐条）：
 *  头部 `[N lines coalesced]`；前 10 行每行截 200 字符（超长缀 …）；
 *  其余计数标注 `(… N more lines suppressed)`；evicted（pending 上限丢最旧）并入。 */
export function formatCoalesced(batch: { lines: string[]; evicted: number }): string {
  const lines = batch.lines;
  const shown = lines.slice(0, LIMITS.coalesceMaxLines).map((l) =>
    l.length > LIMITS.coalesceLineChars ? l.slice(0, LIMITS.coalesceLineChars) + "…" : l,
  );
  const suppressed = lines.length - shown.length + batch.evicted;
  const parts = [`[${lines.length + batch.evicted} line${lines.length + batch.evicted > 1 ? "s" : ""} coalesced]`, ...shown];
  if (suppressed > 0) parts.push(`(… ${suppressed} more lines suppressed)`);
  return parts.join("\n");
}
