// 插件端本地类型
//
// 纪律：
// - @omt/shared 经相对路径 import（宿主加载链上 bare 包说明符不可解析——M6 实证，
//   src/tui/feed.ts 头注同款结论；bare 仅 node: 内置不受限）。
// - @opencode/plugin 的运行时值由根 index.ts 顶层 import 后下传，本目录
//   零 bare import；类型在此用本地 interface 保守描述，P0 真机校准后修订。

import type { HealthInfo, ServiceFile } from "../../shared/src/types.ts";

/** 宿主插件运行时（Plugin.define 的窄化形状；运行时值由根 index.ts 下传） */
export interface PluginRuntime {
  define(def: PluginDefinition): unknown;
}

/** 插件定义 */
export interface PluginDefinition {
  id: string;
  setup(ctx: unknown): Cleanup | void | Promise<Cleanup | void>;
}

export type Cleanup = () => void;

// ---------------------------------------------------------------------------
// 发现-创建流程（server.ts）

/** spawn 产物窄化（ChildProcess 的子集——测试可造假，真实 spawn 天然满足） */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  unref(): void;
}

/** detached + stdio ignore + unref——自成进程组，opencode 退出/热重载不影响服务端。
 *  env 显式传递：deps.env（含注入的 XDG 重定向）必须到达子进程，服务端与其读写同一 state 目录 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: "ignore"; detached: true; env: NodeJS.ProcessEnv },
) => SpawnedProcess;

export interface EnsureServerResult {
  /** false = 发现并复用既有健康实例；true = 本次拉起 */
  spawned: boolean;
  svc: ServiceFile;
  health: HealthInfo;
}

// ---------------------------------------------------------------------------
// 运行时解析（runtime.ts）

/** 探测链产物：可直接交给 SpawnFn 的命令形状（kind 用于诊断与 P2 工具呈现） */
export type RuntimeResolution =
  | { kind: "bin"; command: string; args: string[]; cwd: string }
  | { kind: "source"; command: string; args: string[]; cwd: string }
  | { kind: "bundle"; command: string; args: string[]; cwd: string };
