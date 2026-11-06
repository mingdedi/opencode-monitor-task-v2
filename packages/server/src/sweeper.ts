// 终态清理——独立定时器（启动必扫 + 每 10min），
// 与 tail/tick 关注点分离。
//
// 清理集合与判据：
//   - meta 终态（completed/failed/stopped/orphaned）：updated_at（终态落盘时刻）
//     + taskTtlMs 过期 → 清目录 + registry 移除
//   - 坏 meta + exit 文件佐证：按 exit mtime（≈终态时刻）同 TTL 清
//   - 坏 meta 且无 exit：保守不删
//   - parked：不清（异常态记录，人工 DELETE 处置；其进程可能仍活）
//   - 活态（starting/running/idle）：不清
// registry 驱逐（内存 200 上限）只动内存——本模块才是目录的真相清理者。

import { rmSync, statSync } from "node:fs";
import { LIMITS, tasksDir, type PathEnv } from "@omt/shared";
import { listTaskIds, readExitFile, readMeta, type TaskMeta } from "./taskstore.ts";

/** registry 最小面（解耦：sweeper 不 import registry 模块） */
export interface SweepRegistry {
  remove(id: string): boolean;
}

export interface SweepResult {
  /** 清理目录数 */
  removed: number;
  /** 坏 meta 无 exit 佐证（保守保留）数 */
  keptUnverifiable: number;
}

/** 单趟扫描（纯同步 IO；目录数有限，毫秒级——无需异步化） */
export function sweepOnce(env: PathEnv, registry: SweepRegistry, log: (msg: string) => void): SweepResult {
  const now = Date.now();
  const result: SweepResult = { removed: 0, keptUnverifiable: 0 };
  for (const id of listTaskIds(env)) {
    let meta: TaskMeta | null = null;
    try {
      meta = readMeta(env, id);
    } catch {
      // 坏 meta：exit 佐证 → exit mtime 同 TTL；无佐证保守不删
      const exitRaw = readExitFile(env, id);
      if (exitRaw === null) {
        result.keptUnverifiable++;
        continue;
      }
      if (expiredByExitMtime(env, id, now)) {
        removeTaskDir(env, id, registry, log, result, `bad meta, exit file witnesses "${exitRaw}"`);
      }
      continue;
    }
    if (meta === null) continue; // 目录在 meta 无：reattach 已计数留痕，此处不动
    if (meta.state === "parked") continue; // 异常态：人工处置（DELETE）
    if (meta.state === "running" || meta.state === "idle" || meta.state === "starting") continue; // 活态
    if (now - meta.updated_at >= LIMITS.taskTtlMs) {
      removeTaskDir(env, id, registry, log, result, `terminal ${meta.state}`);
    }
  }
  return result;
}

function expiredByExitMtime(env: PathEnv, id: string, now: number): boolean {
  try {
    return now - statSync(`${tasksDir(env)}/${id}/exit`).mtimeMs >= LIMITS.taskTtlMs;
  } catch {
    return false; // exit 又不见了：保守保留
  }
}

function removeTaskDir(
  env: PathEnv,
  id: string,
  registry: SweepRegistry,
  log: (msg: string) => void,
  result: SweepResult,
  why: string,
): void {
  try {
    rmSync(`${tasksDir(env)}/${id}`, { recursive: true, force: true });
    registry.remove(id);
    result.removed++;
    log(`sweeper: removed task ${id} (${why}, TTL ${LIMITS.taskTtlMs}ms)`);
  } catch (err) {
    log(`sweeper: cannot remove task ${id} (${String(err).slice(0, 80)})`);
  }
}

/** 周期清理器（main.ts 装配：启动必扫 + 每 sweepIntervalMs） */
export function startSweeper(env: PathEnv, registry: SweepRegistry, log: (msg: string) => void): NodeJS.Timeout {
  const run = (): void => {
    try {
      sweepOnce(env, registry, log);
    } catch (err) {
      log(`sweeper: sweep error (${String(err).slice(0, 80)})`);
    }
  };
  run(); // 启动必扫
  return setInterval(run, LIMITS.sweepIntervalMs);
}
