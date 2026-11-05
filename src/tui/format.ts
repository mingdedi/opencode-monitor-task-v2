// 侧边栏面板行模型（纯函数）：把 FeedSnapshot + 当前 session 折算成 42 列宽的
// 行数组，渲染层零逻辑。视觉语言继承 v1 panel/format.ts 实证资产（图标集/三行
// 制/折叠），按 v2 契约扩展：TaskState 新增 orphaned/parked（PLAN §2.4）、
// description 字段优先展示、idle 裁决倒计时（idle_deadline，PLAN §2.7）、终态
// 5 分钟展示窗（PLAN §3.5——服务端负责回收，TUI 纯展示）、session 视角过滤。
import type { PublicInfo, TaskState } from "../../packages/shared/src/types.ts"

/** 宿主侧边栏内容区固定 42 列（v1 实测）。 */
export const PANEL_WIDTH = 42
/** 展示的任务数上限，超出折叠为 "+N more…"（v1 同款）。 */
export const MAX_SHOWN = 6
/** 终态展示窗：updated_at 距今超过 5 分钟不再显示（PLAN §3.5）。 */
export const TERMINAL_TTL_MS = 300_000

export type Tone = "head" | "live" | "dim" | "warn"

export interface Line {
  readonly text: string
  readonly tone: Tone
}

const ICONS: Record<TaskState, string> = {
  starting: "◐",
  running: "●",
  idle: "○",
  completed: "✔",
  failed: "✘",
  stopped: "■",
  orphaned: "⊘",
  parked: "⚑",
}

export function stateIcon(state: TaskState): string {
  return ICONS[state] ?? "·"
}

/** mon_ab12cd34 -> mon_ab12 */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** 45s / 12m / 1h03m / 2h14m——列预算内的紧凑时长。 */
export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, "0")}m`
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s
}

/** 活态集合（idle 是裁决暂停态，进程仍活——v1 语义继承）。 */
export function isLive(t: PublicInfo): boolean {
  return t.state === "running" || t.state === "starting" || t.state === "idle"
}

/** 终态头行标签：退出码优先（stopped 也有信号信息量），语义状态兜底。 */
function exitLabel(t: PublicInfo): string {
  return t.exit_info ? `exit ${t.exit_info.code}` : t.state
}

function headOf(t: PublicInfo, now: number): string {
  if (t.state === "idle" && t.idle_deadline !== null) {
    // 裁决倒计时是行动信号（keepalive/stop，PLAN §2.7），比运行时长更重要。
    return `${stateIcon(t.state)} ${shortId(t.id)} arb ${fmtDuration(t.idle_deadline)}`
  }
  if (isLive(t)) {
    return `${stateIcon(t.state)} ${shortId(t.id)} ${fmtDuration(now - t.started_at)}`
  }
  return `${stateIcon(t.state)} ${shortId(t.id)} ${truncate(exitLabel(t), PANEL_WIDTH - 4 - shortId(t.id).length)}`
}

function monitorLines(t: PublicInfo, now: number): Line[] {
  // description 人类可读，优先于 command 原文（v2 新字段）。
  const subject = t.description && t.description.length > 0 ? t.description : t.command
  const counts = [`scan ${t.lines_scanned}`, `hit ${t.lines_matched}`, `sent ${t.events_sent}`]
  if (t.events_dropped > 0) counts.push(`drop ${t.events_dropped}`)
  if (isLive(t) && t.pid !== null) counts.push(`pid ${t.pid}`)
  return [
    { text: headOf(t, now), tone: "live" },
    { text: `  ${truncate(subject, PANEL_WIDTH - 2)}`, tone: "dim" },
    { text: `  ${truncate(counts.join(" · "), PANEL_WIDTH - 2)}`, tone: "dim" },
  ]
}

/** renderLines 的输入（feed 快照 + 面板 scope）。 */
export interface PanelState {
  /** 服务端连通状态（feed.ts 的 FeedStatus 形状，此处只用到 kind/detail） */
  readonly status:
    | { readonly kind: "online" }
    | { readonly kind: "offline"; readonly reason: "no-service-file" | "pid-dead" }
    | { readonly kind: "unreachable"; readonly detail: string }
  /** 服务端返回的全量任务（未按 session 过滤） */
  readonly tasks: PublicInfo[]
  /** 当前面板所属 session；null = 无 session 视角 → 折叠空态 */
  readonly sessionID: string | null
  readonly now: number
}

/** 完整行模型。空数组 = 什么都不渲染（v1 折叠空态语义）。 */
export function renderLines(state: PanelState): Line[] {
  if (state.status.kind !== "online") {
    if (state.status.kind === "unreachable") {
      // pid 活但不响应：诊断信息必须可见——"不哑跑"哲学在展示层的落点。
      return [
        { text: "MONITORS · server unreachable", tone: "warn" },
        { text: `  ${truncate(state.status.detail, PANEL_WIDTH - 2)}`, tone: "dim" },
      ]
    }
    // offline（无 service.json 或 pid 已死）：按需拉起语义（PLAN §2.1/§3.5）
    return [
      { text: "MONITORS · server offline", tone: "warn" },
      { text: "  auto-starts on next tool call", tone: "dim" },
    ]
  }

  // session 视角过滤（PLAN §3.5）；无视角 = 折叠空态，不猜默认 session。
  if (state.sessionID === null) return []

  const mine = state.tasks.filter((t) => t.session_id === state.sessionID)
  const fresh = mine.filter((t) => isLive(t) || state.now - t.updated_at <= TERMINAL_TTL_MS)
  // 活态在前（重点信息），终态按服务端序殿后——折叠预算优先留给活任务。
  const ordered = [
    ...fresh.filter(isLive),
    ...fresh.filter((t) => !isLive(t)),
  ]

  const lines: Line[] = []
  if (ordered.length > 0) {
    const live = ordered.filter(isLive).length
    const done = ordered.length - live
    const headParts = ["MONITORS", `${live} running`]
    if (done > 0) headParts.push(`${done} done`)
    lines.push({ text: headParts.join(" · "), tone: "head" })
    for (const t of ordered.slice(0, MAX_SHOWN)) lines.push(...monitorLines(t, state.now))
    const rest = ordered.length - Math.min(ordered.length, MAX_SHOWN)
    if (rest > 0) lines.push({ text: `  +${rest} more…`, tone: "dim" })
  }

  // 其他 session 活跃摘要（一行，不展开细节——跨 session 细节属于信息串染防线）。
  const others = state.tasks.filter((t) => t.session_id !== state.sessionID && isLive(t))
  if (others.length > 0) {
    const sessions = new Set(others.map((t) => t.session_id)).size
    lines.push({
      text: `  +${others.length} running in ${sessions} other session${sessions > 1 ? "s" : ""}`,
      tone: "dim",
    })
  }
  return lines
}
