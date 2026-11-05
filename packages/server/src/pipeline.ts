// 输出管线纯函数（PLAN §2.5 / §6.1；SERVER-PLAN 阶段 D 最小版）
// 阶段 D：splitLines（\r\n|\r|\n 分行）+ cleanLine（ANSI 剥离/trim/截断/空行丢弃）——
//         直通模式：清洗后的非空行即命中（无 pattern 过滤）。
// 阶段 E 在此扩展：matcher / Coalescer / TokenBucket / 64KB 无换行软换行。
// 全部纯函数（v1 实证资产语义），无 clock/依赖注入面。

import { LIMITS } from "@omt/shared";

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
