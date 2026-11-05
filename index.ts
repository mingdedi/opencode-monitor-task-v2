// Host-injection entry for the plugin server runtime（与 tui.ts 对称的 server part 入口，
// PLUGIN-PLAN §一-2/§四：宿主对无 exports 的插件目录按根目录文件名发现各 part——
// server part 入口 = 根 index.ts，tui part = 根 tui.ts）。
//
// 宿主只对它实际扫描的入口文件解析 bare @opencode/* 说明符（v1/M6 实证，tui.ts 头注
// 同款）——Plugin 运行时值在本文件顶层 import，再作为参数下传 packages/plugin/src/
//（那里零 bare specifier）。MCP 三工具（P2）经此入口接入：definePlugin 内 setup 是挂载点。
import { Plugin } from "@opencode/plugin"

import { definePlugin } from "./packages/plugin/src/index.ts"

export default definePlugin(Plugin)
