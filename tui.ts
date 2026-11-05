// Host-injection entry for the TUI runtime（PLAN §3.5 双入口约束，v1 实证资产）。
//
// 宿主只对它实际扫描的入口文件解析 bare @opentui/* 说明符——import 链上的其他
// 文件一律 "Cannot find package"（v1 在 v2.0.11/v2.2.5 实测锁定，详见
// src/tui/index.ts 头注）。因此 jsx-runtime 对在本文件顶层 import，再下传给
// src/tui/（那里保持零 bare specifier）。服务端进程永不加载本文件（它走
// packages/server 独立进程；未来插件 server 入口为根 index.ts 的 "." 导出）。
import * as jsxrt from "@opentui/solid/jsx-runtime"
import { defineTuiPlugin } from "./src/tui/index.ts"

export default defineTuiPlugin({
  jsx: jsxrt.jsx,
  jsxs: jsxrt.jsxs ?? jsxrt.jsx,
})
