// 宿主注入的插件运行时模块的 ambient 声明（src/tui/env.d.ts 同款模式）。
// 本仓库零运行时依赖（PLAN §6.1）：@opencode/plugin 只在 opencode 宿主进程内可解析，
// typecheck 不为此引入与宿主版本绑定的 devDependencies——本地声明足够（v1 实证模式）。
// 形状为官方文档（2026-11-05 拉取，PLUGIN-PLAN §一-1）的保守子集，P0 真机校准后修订。
//
// 注意：此文件必须保持全局 script（无顶层 import）——顶层 import 会把它变成 module，
// declare module 块的作用域将仅限本文件。
declare module "@opencode/plugin" {
  // setup 返回 cleanup（unload 时执行）；ctx 不透明——P0-③ 实测校准前保守为 unknown。
  export interface PluginDefinition {
    id: string
    setup(ctx: unknown): void | (() => void) | Promise<void | (() => void)>
  }
  // Plugin.define 组装插件定义；返回值不透明（宿主消费，插件从不自省）。
  export const Plugin: {
    define(def: PluginDefinition): unknown
  }
}
