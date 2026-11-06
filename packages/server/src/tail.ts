// 日志 tail
// 关注点分离：只 tail——持久 fd + readSync 轮询读增量（不用 fs.watch，
// NFS/容器安全），StringDecoder 处理多字节边界，产出 cleanLine 后的行流；
// 不判死活（monitor 职责）、不做投递（deliver 职责）。
//
// last_offset 语义：暴露 pendingBytes()，
// 调用方记 last_offset = 已读字节 - 未成行残余字节，即"最后一个换行符后"的行安全
// 断点——reattach 从该处续读不丢不重、不拼残行。
//
// 64KB 软换行：永不换行的输出流（进度条类是 \r
// 已成行；此处针对连 \r 都没有的极端流）在未成行残余超过 64KB 时强制成行——
// 防单行无限膨胀。软换行后 pending 清空、offset 前进（该段已消费）。

import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { LIMITS } from "@omt/shared";
import { cleanLine, splitLines } from "./pipeline.ts";

export interface TailResult {
  /** cleanLine 后的非空行（直通模式即全部命中） */
  lines: string[];
  /** 本次 readSync 的总字节（含未成行残余与 decoder 内部多字节残段） */
  bytesConsumed: number;
}

export class LogTail {
  private fd: number;
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private readonly buf = Buffer.alloc(64 * 1024);

  /** startOffset：断点续读起点（新任务为 0）；构造时一次性跳读 */
  constructor(logPath: string, startOffset = 0) {
    this.fd = openSync(logPath, "r");
    let toSkip = startOffset;
    while (toSkip > 0) {
      const n = readSync(this.fd, this.buf, 0, Math.min(toSkip, this.buf.length), null);
      if (n <= 0) break; // 文件短于 offset（不应发生，保守止步）
      toSkip -= n;
    }
  }

  /** 读尽当前可用增量（到 EOF），分行清洗后返回 */
  poll(): TailResult {
    let decoded = "";
    let bytes = 0;
    for (;;) {
      const n = readSync(this.fd, this.buf, 0, this.buf.length, null);
      if (n <= 0) break;
      bytes += n;
      decoded += this.decoder.write(this.buf.subarray(0, n));
      if (n < this.buf.length) break; // 普通文件短读即 EOF，省一次系统调用
    }
    if (bytes === 0) return { lines: [], bytesConsumed: 0 };
    const { lines: rawLines, rest } = splitLines(this.pending, decoded);
    this.pending = rest;
    // 64KB 无换行软换行：残余超阈值强制成行（；cleanLine 再截 2000——
    // 目的是防膨胀不是保全内容）
    let softWrapped: string | null = null;
    if (Buffer.byteLength(this.pending) > LIMITS.softWrapBytes) {
      softWrapped = this.pending;
      this.pending = "";
    }
    const lines: string[] = [];
    for (const raw of rawLines) {
      const cleaned = cleanLine(raw);
      if (cleaned !== null) lines.push(cleaned);
    }
    if (softWrapped !== null) {
      const cleaned = cleanLine(softWrapped);
      if (cleaned !== null) lines.push(cleaned);
    }
    return { lines, bytesConsumed: bytes };
  }

  /** 未成行残余的 UTF-8 字节数（last_offset 行安全回退量）。
   *  注：decoder 内部的多字节残段不计入——它属于下一行前缀，重读无害且必要。 */
  pendingBytes(): number {
    return Buffer.byteLength(this.pending);
  }

  /** 强制未成行残余成行：
   *  进程死亡/停止收尾路径调用——无换行的临终输出（printf 无 \n、被杀进程的
   *  半行缓冲）不得丢失。字节已在前次 poll 的 bytesConsumed 计入，此处只成行；
   *  调用后 pendingBytes()=0（last_offset 前进到文件尾）。幂等：空残余返回 []。 */
  flushPending(): string[] {
    if (this.pending === "") return [];
    const rest = this.pending;
    this.pending = "";
    const cleaned = cleanLine(rest);
    return cleaned !== null ? [cleaned] : [];
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      // best-effort
    }
  }
}
