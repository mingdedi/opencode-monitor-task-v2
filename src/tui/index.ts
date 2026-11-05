// TUI 插件入口（双入口插件的 TUI 运行时，PLAN §6.1）。
//
// 重要纪律：本模块（以及 src/tui/ 全部文件）顶层禁止 bare-specifier import
//（@opentui/*、@opencode/*、solid-js）。v1 实测（v2.0.11/v2.2.5）：宿主只对它
// 实际扫描的入口文件（根 tui.ts）解析 bare @opentui/* 说明符——import 链上的
// 其他文件一律 "Cannot find package"。v2.2.5 起宿主的 runtime-plugin-support
// 机制可能改写此行为，但入口 shim 传参路径在两种机制下都成立，故保持 v1 形状：
//
//   根 tui.ts（THE 入口）→ 顶层 import @opentui/solid/jsx-runtime
//   └─ defineTuiPlugin(host) → 把 jsx/jsxs 对下传给面板
//
// node: 前缀的内置模块不受此限。其余宿主 API 全部防御式探测，失败降级为
// 日志记录的跳过——面板失效的最坏结果是"无面板"，绝不拖垮 TUI（§1.3-5 豁免区边界）。
import { createDebugLog } from "./feed.ts"
import { createPanel } from "./view.ts"
import type { HostJsx, TuiContext, TuiPluginDefinition } from "./types.ts"

/**
 * 构建 TUI 插件定义。
 *
 * @param host jsx-runtime 对，由真正的入口文件（根 tui.ts）顶层 import 后传入。
 * 缺席时（本文件被当作入口直接加载的宿主）setup 内动态 import 兜底，再失败则
 * 记日志跳过——面板缺席不影响监控核心链路。
 */
export function defineTuiPlugin(host?: HostJsx): TuiPluginDefinition {
  return {
    id: "opencode-monitor-task",
    async setup(context) {
      const log = createDebugLog()
      try {
        // 探测：TUI 上下文带 storage.memory；server 进程扫描插件时不带——静默退场
        //（server 侧只认 index.ts 的 "." 导出，但防御无代价，v1 同款）。
        const ctx = context as unknown
        if (
          ctx === null ||
          typeof ctx !== "object" ||
          typeof (ctx as { storage?: { memory?: unknown } }).storage?.memory !== "function"
        ) {
          log("skip: no TUI storage (server-side scan)")
          return () => {}
        }
        log(`tui start (${(ctx as { app?: { version?: string } }).app?.version ?? "?"})`)

        let rt: HostJsx | undefined = host
        if (!rt) {
          try {
            const m = await import("@opentui/solid/jsx-runtime")
            rt = { jsx: m.jsx, jsxs: m.jsxs ?? m.jsx }
            log("jsx runtime: dynamic import fallback")
          } catch (err) {
            log(`no jsx runtime (host param absent, dynamic import failed): ${String(err).slice(0, 120)}`)
            return () => {}
          }
        }

        const tui = ctx as TuiContext
        const panel = createPanel(tui, { jsx: rt.jsx, jsxs: rt.jsxs })
        // v2.2.5 起槽位自带 { sessionID } input——session 视角过滤的锚点
        //（PLAN §3.5；取代 v1 的 ui.tabs/ui.router 逆向信号链）。
        const off = tui.ui.slot({
          append: "sidebar.content",
          render: (input: unknown) => panel.el(sessionIdOf(input)),
        })
        log("claimed sidebar.content")
        return () => {
          off()
          panel.dispose()
          log("tui cleanup")
        }
      } catch (err) {
        log(`setup error ${String(err).slice(0, 160)}`)
        return () => {}
      }
    },
  }
}

/** 防御式解析槽位 input 的 sessionID：非字符串 → null（折叠空态，不猜）。 */
function sessionIdOf(input: unknown): string | null {
  if (input !== null && typeof input === "object") {
    const sid = (input as { sessionID?: unknown }).sessionID
    if (typeof sid === "string" && sid !== "") return sid
  }
  return null
}

// 默认导出保持 "./tui" 包导出可加载（宿主在此文件解析说明符时自行兜底）。
export default defineTuiPlugin()
