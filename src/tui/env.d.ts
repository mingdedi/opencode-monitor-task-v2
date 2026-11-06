// 宿主注入的 TUI 运行时模块的 ambient 声明。
// 本仓库零运行时依赖：@opentui/solid/jsx-runtime 只在 OpenCode TUI
// 进程内可解析（宿主把它重定向到自身单例，见 src/tui/index.ts 头注），typecheck
// 不应为此引入与宿主版本绑定的 devDependencies——本地声明足够。
//
// 注意：此文件必须保持全局 script（无顶层 import）——顶层 import 会把它变成
// module，declare module 块的作用域将仅限本文件。
declare module "@opentui/solid/jsx-runtime" {
  // 元素句柄不透明：面板只把它们原样交回宿主，从不自省。
  export type Element = unknown
  export const jsx: (tag: string, props: Record<string, unknown>) => Element
  export const jsxs: typeof jsx
}
