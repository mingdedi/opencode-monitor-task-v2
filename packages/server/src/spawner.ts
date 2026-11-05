// 任务进程管理（PLAN §2.3 / §6.1；SERVER-PLAN 阶段 C——M2 前置）
// 职责 = 进程管理三件套（v1 实证资产，原样继承）+ spawn + 击杀：
//   1. (pid, /proc/<pid>/stat starttime) 双因子身份——pid 复用防御
//   2. kill(pid, 0) 探活 + /proc state 字母纠错（Z 僵尸按死，防 PID 1 不收割环境误判）
//   3. EXIT-trap wrapper 记录退出码（仅 SIGKILL 无法穿透 → 无文件 → 上层判 "unknown"）
//   + spawnTask：bash -c wrapper、detached 自成进程组、stdio 落任务日志 fd、父侧放手
//   + killTree：SIGTERM 进程组 → killGraceMs → SIGKILL（PLAN §2.2）
// 不做：日志消费（tail）、状态机（monitor）、持久化（taskstore）。
//
// /proc 解析纪律：comm 字段可含空格与括号，一律从最后一个 ')' 之后取字段
// （SERVER-PLAN §一 spawner 要点）。锁内简化版 lockIsPidAlive 在 main.ts，二者同源
// （阶段 B 锁注记：任务进程的双因子版在此）。

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { LIMITS } from "@omt/shared";
import type { TaskFilePaths } from "./taskstore.ts";

// ---------------------------------------------------------------------------
// /proc/<pid>/stat 解析

/** stat 行 comm 之后的字段数组（fields[0] = 字段3 state；starttime = 字段22 → fields[19]） */
export function statAfterComm(statLine: string): string[] {
  return statLine.slice(statLine.lastIndexOf(")") + 2).split(" ");
}

/** /proc/<pid>/stat 的 starttime（字段 22）；不可得返回 null（非 Linux / 进程已消失） */
export function readProcStartTime(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const v = Number(statAfterComm(readFileSync(`/proc/${pid}/stat`, "utf8"))[19]);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 三件套之二：探活 + 僵尸纠错

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM：进程存在但归属他人——保守视为活；ESRCH：不存在，按死
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    return statAfterComm(readFileSync(`/proc/${pid}/stat`, "utf8"))[0] !== "Z";
  } catch {
    return true; // 无 /proc（非 Linux）：信任 kill 0
  }
}

/** 三件套之一：(pid, starttime) 双因子身份判定——starttime 变化 = pid 被复用 = 按死。
 *  startTime 为 null（非 Linux / spawn 后竞态未读到）时降级单因子。 */
export interface ProcIdentity {
  pid: number;
  startTime: number | null;
}

export function isTaskProcessAlive(identity: ProcIdentity): boolean {
  if (!isPidAlive(identity.pid)) return false;
  if (identity.startTime === null) return true; // 单因子降级
  const current = readProcStartTime(identity.pid);
  return current !== null && current === identity.startTime;
}

/** exit 文件原始内容 → 退出码语义；无文件或空内容（SIGKILL / exec 丢弃 trap / 写入截断）→ "unknown" */
export function exitCodeFromRaw(raw: string | null): string {
  return raw !== null && raw !== "" ? raw : "unknown";
}

// ---------------------------------------------------------------------------
// 三件套之三：EXIT-trap wrapper 与 detached spawn（PLAN §2.3 文件即管道）

/** wrapper 脚本：EXIT trap 按 128+signo 约定归一为 signal:N 后写 exit 文件；
 *  文件路径经 env（OMT_EXIT_FILE）传递——零引号注入面。命令原样作为脚本体。
 *  信号 trap 必要性（实测）：bash 自身死于 pending SIGTERM 时 laststatus 丢失为 0，
 *  组 TERM 会被误记 "exit 0"——显式转 exit 128+N 保证"被信号杀"在 exit 文件可区分。
 *  chmod 600（真机权限审计暴露）：printf > 创建跟随服务端 umask（644）——exit 文件
 *  属 0600 契约（PLAN §4 任务目录私有），显式收紧。 */
export function wrapperScript(command: string): string {
  return [
    `trap 'rc=$?; if [ "$rc" -ge 128 ]; then printf "signal:%s\\n" "$((rc-128))" >"$OMT_EXIT_FILE"; else printf "%s\\n" "$rc" >"$OMT_EXIT_FILE"; fi; chmod 600 "$OMT_EXIT_FILE"' EXIT`,
    `trap 'exit 129' HUP`,
    `trap 'exit 130' INT`,
    `trap 'exit 143' TERM`,
    command,
  ].join("\n");
}

export interface SpawnedTask {
  pid: number;
  /** detached 自成进程组：pgid === wrapper pid */
  pgid: number;
  /** /proc starttime（双因子第二因子）；非 Linux 或 spawn 后竞态未读到为 null */
  procStartTime: number | null;
}

export interface SpawnOptions {
  cwd: string;
  /** 任务环境变量（默认继承服务端进程环境）；OMT_EXIT_FILE 由本函数强制注入 */
  env?: NodeJS.ProcessEnv;
}

export function spawnTask(paths: TaskFilePaths, command: string, opts: SpawnOptions): SpawnedTask {
  const logFd = openSync(paths.log, "a", 0o600); // append：reattach 续写同一管道（G 阶段续读）
  try {
    const child = spawn("bash", ["-c", wrapperScript(command)], {
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), OMT_EXIT_FILE: paths.exit },
      detached: true, // 自成进程组——服务端退出/崩溃不牵连任务（P1 根治的结构前提）
      stdio: ["ignore", logFd, logFd], // stdout+stderr 合并落任务日志
    });
    // 先挂 error 监听再做 pid 检查：ENOENT/EAGAIN 等失败是异步 emit('error')（uv_spawn
    // 同步阶段只置 pid=undefined），若 throw 前未挂监听，uncaughtException 会崩掉服务端
    // （实测 Node 24）。no-op 吞掉事件：失败事实已由紧随的 pid 检查同步报给调用方。
    child.on("error", () => {});
    if (child.pid === undefined) throw new Error("spawn returned no pid");
    child.unref(); // 父侧放手
    return { pid: child.pid, pgid: child.pid, procStartTime: readProcStartTime(child.pid) };
  } finally {
    closeSync(logFd); // 子进程已继承 fd，父侧即关（文件即管道：服务端可离场）
  }
}

// ---------------------------------------------------------------------------
// killTree：TERM → killGraceMs → KILL（PLAN §2.2 stop 语义）

function signalGroup(pgid: number, sig: NodeJS.Signals | 0): "ok" | "gone" {
  try {
    process.kill(-pgid, sig);
    return "ok";
  } catch (err) {
    // EPERM：组内有存活进程但归属他人——保守视为在；ESRCH：组已消失
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "ok" : "gone";
  }
}

export interface KillDeps {
  /** 等待注入（单测加速） */
  sleep?: (ms: number) => Promise<void>;
  /** TERM 后组存活探测注入（单测） */
  groupExists?: (pgid: number) => boolean;
}

/** 温和优先击杀进程组。返回实际档位："term"（TERM 足够 / 组已不在）| "kill"（升级 KILL） */
export async function killTree(pgid: number, deps: KillDeps = {}): Promise<"term" | "kill"> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const groupExists = deps.groupExists ?? ((g: number) => signalGroup(g, 0) !== "gone");
  if (signalGroup(pgid, "SIGTERM") === "gone") return "term"; // 组已不在：无需动武
  await sleep(LIMITS.killGraceMs);
  if (!groupExists(pgid)) return "term"; // 温和达成
  signalGroup(pgid, "SIGKILL");
  return "kill";
}
