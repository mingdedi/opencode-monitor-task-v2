// 面板数据源：服务发现 + HTTP 轮询 + offline 状态机。
//
// 数据源直连服务端 HTTP（MonitorClient.listTasks，SDK 即契约）
// ——心跳机制退役，health/请求成败即心跳。
// 每轮 tick 都重读 service.json，
// url 或 password 变化即重建 client，服务端重启对面板是透明的自愈过程。
//
// offline 判定链：
//   service.json 不存在        → offline(no-service-file)：服务端从未启动
//   listTasks 网络失败 + pid 死 → offline(pid-dead)：stale service.json，等待下次
//                                工具调用按需拉起（TUI 绝不自己 spawn 服务端）
//   listTasks 失败 + pid 活     → unreachable：活进程不响应/鉴权拒绝，诊断信息
//                                必须上屏
import { MonitorApiError, MonitorClient } from "../../packages/shared/src/client.ts"
import { envFromProcess, serviceFilePath, stateDir } from "../../packages/shared/src/paths.ts"
import type { PublicInfo, ServiceFile } from "../../packages/shared/src/types.ts"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"

export type FeedStatus =
  | { readonly kind: "online" }
  | { readonly kind: "offline"; readonly reason: "no-service-file" | "pid-dead" }
  | { readonly kind: "unreachable"; readonly detail: string }

export interface FeedSnapshot {
  readonly status: FeedStatus
  /** 服务端全量任务（未按 session 过滤——session 过滤是渲染层职责） */
  readonly tasks: PublicInfo[]
  /** 最后一次成功拉取的 epoch ms；从未成功为 null */
  readonly fetchedAt: number | null
}

export interface FeedDeps {
  now(): number
  /** 读 monitor-task 侧 service.json；不存在/损坏 → null */
  readServiceFile(): ServiceFile | null
  fetchImpl: typeof fetch
  /** pid 探活（(pid, 0) 信号 0 探测；测试注入） */
  isPidAlive(pid: number): boolean
  /** online 轮询间隔（默认 2s——服务端 tail tick 250ms，人眼刷新足够） */
  onlineMs?: number
  /** offline 轮询间隔（默认 5s——等待工具调用拉起期间放慢节奏） */
  offlineMs?: number
  /** 快照推送（view 层把它桥进宿主 reactive store） */
  onSnapshot(snap: FeedSnapshot): void
}

export interface Feed {
  /** 执行一轮发现-轮询；进行中重复调用复用同一 promise（不叠加请求） */
  tick(): Promise<void>
  start(): void
  stop(): void
}

/** service.json 形状校验（宽松——缺关键字段/非法 pid 视同不存在；pid<=0 会让
 * 信号 0 探测打到进程组 0，语义错乱）。 */
function parseServiceFile(raw: string): ServiceFile | null {
  try {
    const v = JSON.parse(raw) as Partial<ServiceFile>
    if (
      typeof v.url === "string" &&
      typeof v.password === "string" &&
      typeof v.pid === "number" &&
      v.pid > 0
    ) {
      return { id: v.id ?? "", version: v.version ?? "", url: v.url, pid: v.pid, password: v.password, started_at: v.started_at ?? 0 }
    }
  } catch {
    /* 损坏文件视同不存在 */
  }
  return null
}

/** 生产默认实现：读 $XDG_STATE_HOME/opencode-monitor-task/service.json。 */
export function readServiceFileFromXdg(): ServiceFile | null {
  try {
    return parseServiceFile(readFileSync(serviceFilePath(envFromProcess()), "utf8"))
  } catch {
    return null
  }
}

/** process.kill(pid, 0) 探活：ESRCH = 死；EPERM = 存在但非我们进程组，按活处理。 */
export function isPidAliveViaSignal(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/** 网络错误短语化（上屏诊断用，不泄漏堆栈）。undici 的 fetch 网络错误 message
 * 只有 "fetch failed"，具体原因（ECONNREFUSED 等）在 cause 链里——挖一层。 */
function describeError(err: unknown): string {
  const brief = (e: unknown): string => {
    if (e instanceof Error) return e.message.slice(0, 80)
    return String(e).slice(0, 80)
  }
  const msg = brief(err)
  if (msg === "fetch failed") {
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined && cause !== null) return `${msg}: ${brief(cause)}`
  }
  return msg
}

export function createFeed(deps: FeedDeps): Feed {
  const onlineMs = deps.onlineMs ?? 2_000
  const offlineMs = deps.offlineMs ?? 5_000
  let client: MonitorClient | null = null
  let clientKey = "" // url + password 指纹，变化即重建（服务端重启自愈）
  let lastStatus: FeedStatus = { kind: "offline", reason: "no-service-file" }
  let inflight: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let stopped = false

  const emit = (status: FeedStatus, tasks: PublicInfo[], fetchedAt: number | null) => {
    lastStatus = status
    deps.onSnapshot({ status, tasks, fetchedAt })
  }

  const tick = async (): Promise<void> => {
    const svc = deps.readServiceFile()
    // 消费点防御：pid<=0 会让信号 0 探测打到进程组 0（语义错乱），视同无服务文件。
    // 放这里而非只靠 parseServiceFile——注入式 readServiceFile 也被覆盖。
    if (!svc || typeof svc.pid !== "number" || svc.pid <= 0) {
      client = null
      emit({ kind: "offline", reason: "no-service-file" }, [], null)
      return
    }
    const key = `${svc.url}\n${svc.password}`
    if (!client || key !== clientKey) {
      client = new MonitorClient(svc.url, svc.password, { fetchImpl: deps.fetchImpl })
      clientKey = key
    }
    let tasks: PublicInfo[]
    try {
      tasks = await client.listTasks()
    } catch (err) {
      // 失败分类：先看进程死活，再细分 HTTP 层错误。每轮重读 service.json
      // 意味着服务端重启（新 url/password）在下一轮 tick 自然自愈。
      if (!deps.isPidAlive(svc.pid)) {
        client = null // stale service.json，下轮必然重建
        emit({ kind: "offline", reason: "pid-dead" }, [], null)
        return
      }
      const detail =
        err instanceof MonitorApiError ? `http ${err.status} (pid ${svc.pid} alive)` : `${describeError(err)} (pid ${svc.pid} alive)`
      emit({ kind: "unreachable", detail }, [], null)
      return
    }
    emit({ kind: "online" }, tasks, deps.now())
  }

  return {
    tick: () => {
      if (inflight) return inflight
      inflight = tick()
        .catch(() => {
          /* tick 内部已全捕获；此处防御意外（不哑跑但也不炸面板） */
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },
    start: () => {
      if (stopped || started) return
      started = true
      const loop = async () => {
        if (stopped) return
        await tick().catch(() => {})
        if (stopped) return
        timer = setTimeout(loop, lastStatus.kind === "online" ? onlineMs : offlineMs)
      }
      void loop()
    },
    stop: () => {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

/** TUI 诊断日志：DEBUG=1 时落 state 目录。 */
export function createDebugLog() {
  const enabled = process.env["DEBUG"] === "1"
  return (msg: string): void => {
    if (!enabled) return
    try {
      const dir = stateDir(envFromProcess())
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(`${dir}/tui.log`, `${new Date().toISOString()} ${msg}\n`)
    } catch {
      /* 诊断日志尽力而为 */
    }
  }
}
