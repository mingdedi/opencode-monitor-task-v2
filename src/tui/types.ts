// OpenCode V2 TUI 插件上下文的最小结构类型（v2.2.5 实测形状，v1 panel/types.ts 资产继承）。
//
// §1.3-5 豁免区：侧边栏是官方无契约、无文档、无替代机制的展示层，源码级对接是
// 唯一途径。因此这里不引 @opencode/plugin 的类型包，而是本地声明本面板实际触摸
// 的最小接口面——宿主形状漂移时改动被限制在此文件，且每个访问点都防御式探测。
// 类型依据：anomalyco/opencode v2.2.5 packages/plugin/src/tui/context.ts
// （Context.ui.slot / Context.storage.memory / Context.theme.text / SlotMap["sidebar.content"]）。

/** storage.memory：热重载存活的内存态 reactive store（新旧插件代际共享同一活 store） */
export interface TuiMemoryStore<Value extends object> {
  readonly initial: Value
}

export interface TuiStorage {
  memory<Value extends object>(
    key: string,
    options: TuiMemoryStore<Value>,
  ): readonly [Value, (mutation: (draft: Value) => void) => void]
}

/**
 * sidebar.content 槽位认领（SlotClaim 的 append 变体）。
 * v2.2.5 起槽位自带 input：render 收到 { sessionID }——比 v1 时代逆向
 * ui.tabs/ui.router 两级信号链更直接，session 视角过滤（PLAN §3.5）的数据锚点。
 */
export interface TuiSlotClaim {
  readonly append: "sidebar.content"
  readonly render: (input: unknown) => unknown
}

/** 宿主主题 token。base/muted 之外的颜色不确定，面板不依赖（v1 同款克制）。 */
export interface TuiTheme {
  readonly text: {
    readonly base?: string
    readonly muted?: string
  }
}

export interface TuiContext {
  readonly storage: TuiStorage
  readonly theme: TuiTheme
  readonly app: { readonly version: string }
  readonly ui: {
    readonly slot: (claim: TuiSlotClaim) => () => void
  }
}

/** jsx-runtime 对，由真正的入口文件（根 tui.ts）顶层 import 后下传——见 index.ts 头注。 */
export interface HostJsx {
  readonly jsx: (tag: string, props: Record<string, unknown>) => unknown
  readonly jsxs: (tag: string, props: Record<string, unknown>) => unknown
}

export interface TuiPluginDefinition {
  readonly id: string
  readonly setup: (
    context: unknown,
  ) => Promise<void | (() => void)> | void | (() => void)
}
