// 插件 server part 组装（PLUGIN-PLAN §四）：Plugin.define 包装 + P2 工具挂载点。
//
// 纪律（§一-5/§六）：本模块零 bare specifier——@opencode/plugin 的运行时值由根 index.ts
// 顶层 import 后作为参数下传（tui.ts 下传 jsx/jsxs 同款模式）；类型用本地 interface
// 保守描述，P0 真机校准。@omt/shared 经相对路径 import（M6 实证：宿主加载链上 bare
// 包说明符不可解析）。
// unload 不触碰任务与服务端（§四纪律 1：cleanup 仅撤销插件自身注册物——P1 阶段无注册物）。

import { appendFileSync, mkdirSync } from "node:fs";
import { envFromProcess, stateDir } from "../../shared/src/paths.ts";
import type { PluginDefinition, PluginRuntime } from "./types.ts";

/** DEBUG=1 时往 state 目录 plugin.log 追加一行（与 server.log 并列；失败不影响插件） */
function debugLog(msg: string): void {
  if (process.env["DEBUG"] !== "1") return;
  try {
    const dir = stateDir(envFromProcess());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(`${dir}/plugin.log`, `[${new Date().toISOString()} pid${process.pid}] ${msg}\n`);
  } catch {
    // 日志失败不能影响插件
  }
}

/**
 * 构建插件 server part 定义。
 *
 * @param plugin 宿主插件运行时（Plugin.define），由真正入口（根 index.ts）顶层 import 后
 *   传入。缺席时直接返回裸定义——宿主按 default export 消费，不依赖 Plugin.define 存在
 *   （防御式：P0 之前形状未经真机校准）。
 */
export function definePlugin(plugin?: PluginRuntime): unknown {
  const def: PluginDefinition = {
    id: "opencode-monitor-task",
    async setup(_ctx) {
      // P2 挂载点：三 MCP 工具（monitor_server / monitor / monitor_manage）经
      // ctx.tool.transform 注册，cleanup 仅 registration.dispose()（PLUGIN-PLAN §四/§五-P2）。
      // P1 阶段 setup 无副作用——加载即留痕（DEBUG=1），不拉起服务端（按需拉起是唯一
      // 生命周期，PLAN §2.1）。
      debugLog("server part setup (P1: no tools registered yet)");
      return () => {
        debugLog("server part cleanup");
      };
    },
  };
  return plugin?.define(def) ?? def;
}
