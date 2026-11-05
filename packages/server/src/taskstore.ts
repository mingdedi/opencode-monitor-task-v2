// 任务持久化层（PLAN §2.3 / §6.1）：tasks/<id>/{meta.json, log, exit, pending.json}
// 兼载服务端持久化基础设施：原子写（v1 资产 tmp+rename+tmpSeq）与 0700 私有目录（PLAN §4）
// ——main.ts 的 service.json 写入复用这两件工具。
// 阶段 B 基础版：无 TTL 清理（G 阶段 sweeper）、pending.json 仅落位路径（D+ deliver 使用）。

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { envFromProcess, taskDir, tasksDir, type PathEnv } from "@omt/shared";
import type { Delivery, ExitInfo, TaskState, WakeMode } from "@omt/shared";

// ---------------------------------------------------------------------------
// 持久化基础设施

let tmpSeq = 0;

/** 原子写：tmp + rename（v1 资产）；tmpSeq 后缀防同进程并发撞名 */
export function writeFileAtomic(path: string, data: string, mode: 0o600 | 0o400 = 0o600): void {
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** 0700 私有目录（PLAN §4：state/data 两根目录）；已存在时显式 chmod（mkdir mode 不追溯生效） */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

// ---------------------------------------------------------------------------
// 任务目录布局与 meta（PLAN §2.3，跨重启真相源，schema 版本化）

export interface TaskMeta {
  schema: 1;
  id: string;
  command: string;
  description: string | null;
  /** 通知目的地 session */
  session_id: string;
  /** 通知目的地 opencode 实例端口（注册表索引键；password 永不落盘） */
  opencode_port: number;
  pid: number | null;
  pgid: number | null;
  /** /proc/<pid>/stat starttime——pid 复用防御（spawner 阶段 C 写入） */
  proc_start_time: number | null;
  started_at: number;
  directory: string;
  pattern: string | null;
  wake_mode: WakeMode;
  delivery: Delivery;
  coalesce_ms: number;
  max_events: number;
  idle_timeout_ms: number;
  /** log 已消费字节 = 断点续读点 */
  last_offset: number;
  lines_scanned: number;
  lines_matched: number;
  events_sent: number;
  events_dropped: number;
  state: TaskState;
  exit_info: ExitInfo | null;
  /** idle 两段式裁决（PLAN §2.7）：idle 态 = 宽限期截止 epoch ms（宽限 = 一个完整
   *  idle_timeout_ms 窗口，SERVER-PLAN §三-5）；非 idle 恒 null。G 阶段 reattach
   *  按"无观察者不计时，重挂后从零武装"（PLAN §2.9-4）——恢复时不沿用旧值 */
  grace_deadline: number | null;
  /** 当前看护进程 pid——双认领防御 */
  claimed_by: number;
  updated_at: number;
}

const TASK_ID_RE = /^mon_[a-z0-9]+$/;

export interface TaskFilePaths {
  dir: string;
  meta: string;
  /** stdout+stderr 原始合并流（服务端是可离场的 tail 读者） */
  log: string;
  /** wrapper EXIT-trap 写入的退出码 */
  exit: string;
  /** 投递失败落盘通知（PLAN §2.8.2），D+ 阶段 deliver 使用 */
  pending: string;
}

export function taskFilePaths(env: PathEnv, id: string): TaskFilePaths {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid task id: ${id}`);
  const dir = taskDir(env, id);
  return { dir, meta: `${dir}/meta.json`, log: `${dir}/log`, exit: `${dir}/exit`, pending: `${dir}/pending.json` };
}

/** 建任务目录（tasks/ 与任务目录均 0700） */
export function initTaskDir(env: PathEnv, id: string): TaskFilePaths {
  const p = taskFilePaths(env, id);
  ensurePrivateDir(tasksDir(env));
  ensurePrivateDir(p.dir);
  return p;
}

export function writeMeta(env: PathEnv, meta: TaskMeta): void {
  writeFileAtomic(taskFilePaths(env, meta.id).meta, `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * 读 meta；不存在返回 null；存在但坏 JSON 抛错（G 阶段 reattach 据此走"坏 meta 保守不删"路径）
 */
export function readMeta(env: PathEnv, id: string): TaskMeta | null {
  const p = taskFilePaths(env, id);
  if (!existsSync(p.meta)) return null;
  return JSON.parse(readFileSync(p.meta, "utf8")) as TaskMeta;
}

/** wrapper EXIT-trap 写入的原始退出码内容（"0" / "1" / "signal:15" / "exit unknown"） */
export function readExitFile(env: PathEnv, id: string): string | null {
  try {
    return readFileSync(taskFilePaths(env, id).exit, "utf8").trim();
  } catch {
    return null;
  }
}

/** 扫 tasks/ 下全部任务目录 id（reattach 起点，PLAN §2.9-1） */
export function listTaskIds(env: PathEnv = envFromProcess()): string[] {
  try {
    return readdirSync(tasksDir(env), { withFileTypes: true })
      .filter((e) => e.isDirectory() && TASK_ID_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // tasks/ 不存在
  }
}
