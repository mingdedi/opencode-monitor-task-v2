// 面板运行时：feed 快照 → 宿主 reactive store → 行模型渲染（v1 panel/view.ts 模式继承）。
//
// 响应式契约（v1 实证）：宿主把 slot render 包在 solid 渲染上下文里，在 render
// 路径中读取 storage.memory 返回的 store 即建立订阅——store 更新触发重渲染。
// 因此本文件的纪律：store 只在 feed tick 回调（渲染路径外）写入，render 路径
// 纯读取 + 纯函数派生，绝不回写。
import { createFeed, createDebugLog, isPidAliveViaSignal, readServiceFileFromXdg, type FeedSnapshot } from "./feed.ts"
import { renderLines, type Line } from "./format.ts"
import type { HostJsx, TuiContext } from "./types.ts"

export interface PanelHandle {
  /** 每次渲染调用；sessionID 来自 sidebar.content 槽位 input（null = 空态） */
  el: (sessionID: string | null) => unknown
  dispose: () => void
}

export interface PanelOptions extends HostJsx {
  /** 测试注入：覆盖默认传输/发现/时钟 */
  fetchImpl?: typeof fetch
  readServiceFile?: () => ReturnType<typeof readServiceFileFromXdg>
  now?: () => number
}

/** 首帧兜底快照：feed 尚未完成第一次 tick 时避免渲染路径读 null。 */
const EMPTY_SNAPSHOT: FeedSnapshot = {
  status: { kind: "offline", reason: "no-service-file" },
  tasks: [],
  fetchedAt: null,
}

export function createPanel(context: TuiContext, opts: PanelOptions): PanelHandle {
  const log = createDebugLog()

  const [store, updateStore] = context.storage.memory("opencode-monitor-task", {
    initial: { snapshot: EMPTY_SNAPSHOT as FeedSnapshot },
  })

  const feed = createFeed({
    now: opts.now ?? Date.now,
    readServiceFile: opts.readServiceFile ?? readServiceFileFromXdg,
    fetchImpl: opts.fetchImpl ?? fetch,
    isPidAlive: isPidAliveViaSignal,
    onSnapshot: (snapshot) => {
      updateStore((draft) => {
        draft.snapshot = snapshot
      })
    },
  })
  feed.start()
  log(`panel started, polling via MonitorClient.listTasks`)

  const renderLine = (line: Line): unknown => {
    const props: Record<string, unknown> = { children: line.text }
    // dim 行降调；head/live/warn 保持默认前景色（v1 克制配色：宿主 theme 只信 base/muted）。
    // theme token 是宿主的响应式 getter——每次渲染现读，主题热切换即时生效。
    if (line.tone === "dim") {
      const muted = context.theme.text.muted
      if (muted !== undefined) props["fg"] = muted
    }
    return opts.jsx("text", props)
  }

  const el = (sessionID: string | null): unknown => {
    try {
      const snap = store.snapshot ?? EMPTY_SNAPSHOT
      const lines = renderLines({
        status: snap.status,
        tasks: snap.tasks,
        sessionID,
        now: (opts.now ?? Date.now)(),
      })
      if (lines.length === 0) return opts.jsx("text", { children: "" })
      return opts.jsxs("box", {
        flexDirection: "column",
        children: lines.map(renderLine),
      })
    } catch (err) {
      // 渲染失败绝不炸面板：空 text 占位（宿主 ErrorBoundary 之外的第二道防线）
      log(`render error ${String(err).slice(0, 120)}`)
      return opts.jsx("text", { children: "" })
    }
  }

  return {
    el,
    dispose: () => {
      feed.stop()
      log("panel disposed")
    },
  }
}
