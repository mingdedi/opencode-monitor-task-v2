// 参数与上限单点定义，双端共享
export const LIMITS = {
  /** 每 session_id 存活任务上限 */
  sessionMaxAliveTasks: 16,
  /** registry 内存终态上限，驱逐最旧 */
  registryMaxTerminal: 200,
  /** TaskStore 终态目录 TTL */
  taskTtlMs: 3_600_000,
  /** 单行通知截断长度 */
  lineMaxChars: 2000,
  /** coalesce 窗口内携带的最大行数 */
  coalesceMaxLines: 10,
  /** coalesce 窗口内单行预览长度 */
  coalesceLineChars: 200,
  /** coalesce pending 行上限，防内存膨胀 */
  coalescePendingMax: 1000,
  /** 令牌桶突发容量 */
  tokenBucketBurst: 5,
  /** 令牌桶每秒补充速率 */
  tokenBucketRatePerSec: 1,
  /** tail 轮询间隔 */
  tailIntervalMs: 250,
  /** 无换行软换行阈值 */
  softWrapBytes: 65_536,
  /** 摘要尾部预览行数 */
  previewLines: 5,
  /** 合并窗口默认值，0 关闭 */
  defaultCoalesceMs: 500,
  /** 通知上限默认值 */
  defaultMaxEvents: 50,
  /** 静默裁决窗口默认值 */
  defaultIdleTimeoutMs: 300_000,
  /** sweeper 周期 */
  sweepIntervalMs: 600_000,
  /** pending 通知重投周期 */
  pendingRetryMs: 60_000,
  /** 单任务 pending 落盘条目上限，防磁盘膨胀（丢最旧计 dropped） */
  pendingMaxEntries: 100,
  /** stop 时 TERM→KILL 宽限 */
  killGraceMs: 200,
  /** description 最大长度 */
  descriptionMaxChars: 80,
  /** coalesce_ms 上界（含） */
  maxCoalesceMs: 60_000,
  /** max_events 上界（含） */
  maxMaxEvents: 10_000,
  /** idle_timeout_ms 上界（含） */
  maxIdleTimeoutMs: 3_600_000,
  /** GET /api/tasks/:id/log 默认携带行数 */
  logTailDefaultLines: 20,
  /** log tail= 上界（防滥用；单次响应体积上限量级） */
  logTailMaxLines: 1000,
  /** log tail 单次读取的字节上界（有界读——log 无轮转无上界，整读会阻塞事件循环
   *  且内存尖峰可拖垮全部任务看护）；超长行场景下返回行数可能少于请求 */
  logTailMaxBytes: 4 * 1024 * 1024,
  /** 服务端 HTTP 请求体上限（防滥用；任务参数远小于此） */
  httpBodyMaxBytes: 262_144,
} as const;

export type WakeMode = "all" | "pattern";
export type Delivery = "queue" | "steer";

/** 任务状态机 */
export type TaskState =
  | "starting"
  | "running"
  | "idle"
  | "completed" // exit 0
  | "failed" // 非零或信号
  | "stopped" // 人为 / 超限 / 裁决到期
  | "orphaned" // 通知目的地 session 死亡
  | "parked"; // reattach 认领失败，等待认领

export interface ExitInfo {
  /** "0" | "1" | ... | "signal:15" | "unknown"（SIGKILL 无法穿透 wrapper） */
  code: string;
  /** 服务端补充语义：exited / killed / lost / unknown */
  reason: string;
}

/** 对外任务视图（含 session_id / opencode_port / state） */
export interface PublicInfo {
  id: string;
  description: string | null;
  state: TaskState;
  session_id: string;
  opencode_port: number;
  directory: string;
  command: string;
  pattern: string | null;
  wake_mode: WakeMode;
  delivery: Delivery;
  coalesce_ms: number;
  max_events: number;
  idle_timeout_ms: number;
  /** idle 态剩余静默裁决毫秒数；非 idle 为 null */
  idle_deadline: number | null;
  /** 裁决宽限期截止 epoch ms；未在宽限期为 null */
  grace_deadline: number | null;
  started_at: number;
  pid: number | null;
  lines_scanned: number;
  lines_matched: number;
  events_sent: number;
  events_dropped: number;
  exit_info: ExitInfo | null;
  log_bytes: number;
  last_offset: number;
  updated_at: number;
}

/** POST /api/tasks 请求体 */
export interface CreateTaskInput {
  command: string;
  opencode_port: number;
  session_id: string;
  description?: string;
  pattern?: string;
  wake_mode?: WakeMode;
  delivery?: Delivery;
  coalesce_ms?: number;
  max_events?: number;
  idle_timeout_ms?: number;
  /** 绝对路径；插件端负责工作区校验，服务端校验绝对路径且存在 */
  directory?: string;
}

/** GET /api/health 响应 */
export interface HealthInfo {
  id: string;
  version: string;
  uptime_s: number;
  tasks_alive: number;
  tasks_total: number;
  /** reattach 显式化：认领结果（P1 根治） */
  reattach: {
    claimed: number;
    finalized: number;
    failed: number;
    at: number;
  } | null;
  opencode_instances: Array<{
    port: number;
    url: string;
    version: string | null;
    pid_alive: boolean;
    reachable: boolean;
  }>;
  log_bytes: number;
}

/** 服务端自身 service.json schema */
export interface ServiceFile {
  id: string;
  version: string;
  url: string;
  pid: number;
  password: string;
  started_at: number;
}

/** API 错误响应体 */
export interface ApiError {
  error: string;
  code?: string;
  detail?: unknown;
}
