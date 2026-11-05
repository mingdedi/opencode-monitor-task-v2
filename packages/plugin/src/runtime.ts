// 服务端运行时解析（PLUGIN-PLAN §三-5 探测链，单点切换源码/bundle 两形态）
//
// 背景（2026-11-05 实测）：opencode 2.2.5 CLI 为 bun compile 单文件二进制——插件代码
// 运行于宿主进程内，process.execPath = opencode.exe（非 node），verify-m1 式的
// spawn(execPath, ["--import", "tsx", ...]) 在插件环境下不可行；且"装了 opencode"⇏
// "有 node"（brew/curl 安装路径不依赖 node）。故命令解析全部经此模块。
//
// 探测链：
//   ① 环境逃生口 OMT_SERVER_BIN（完整服务端命令，诊断与 CI 用——全信任不做探测）
//      / OMT_NODE（node 可执行路径——仍验版本，配置错误的明确诊断优于莫名的 spawn 失败）
//   ② 平台二进制 <rootDir>/dist/bin/server-<platform>：M8 发布启用后在此探测（预留位；
//      启用前源码/bundle 两形态已覆盖开发与发布场景）
//   ③ 形态探测（dist/server.mjs → bundle；packages/server/src/main.ts → source）
//      + node 解析（OMT_NODE 优先，回落 PATH "node"；--version 可执行且 major ≥ 20）
//   ④ 全失败 → 结构化诊断：逐条尝试结果 + 宿主 PATH 原文（fnm/nvm multishell 场景唯一
//      可远程定位的信息）+ 安装指引——绝不静默（§三-4）

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeResolution } from "./types.ts";

/** node 最低 major（README Requirements：Node.js ≥ 20） */
export const MIN_NODE_MAJOR = 20;

export interface RuntimeDeps {
  /** env 来源（默认 process.env：PATH / OMT_NODE / OMT_SERVER_BIN） */
  env?: NodeJS.ProcessEnv;
  /** 文件存在探测（默认 existsSync；测试注入） */
  exists?: (p: string) => boolean;
  /** 命令执行探测（默认 spawnSync 包装；测试注入） */
  exec?: (command: string, args: readonly string[]) => { ok: boolean; stdout: string; error?: string };
}

/** 默认 exec：一次性同步执行拿 --version（探测用途，非长命进程） */
function execVersion(
  command: string,
  args: readonly string[],
): { ok: boolean; stdout: string; error?: string } {
  const r = spawnSync(command, [...args], { encoding: "utf8", timeout: 3000 });
  if (r.error) return { ok: false, stdout: "", error: r.error.message };
  if (r.status !== 0) return { ok: false, stdout: r.stdout ?? "", error: `exit ${r.status}` };
  return { ok: true, stdout: r.stdout ?? "" };
}

/** "v22.11.0" → 22；无法解析返回 null（导出供单测） */
export function parseNodeMajor(versionOutput: string): number | null {
  const m = /^v?(\d+)/.exec(versionOutput.trim());
  return m ? Number(m[1]) : null;
}

export function resolveRuntime(rootDir: string, deps: RuntimeDeps = {}): RuntimeResolution {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const exec = deps.exec ?? execVersion;

  // ① OMT_SERVER_BIN：完整服务端命令——全信任。按空白切分（首段 command、其余 args）；
  //    逃生口保持极简，不支持引号转义
  const bin = env["OMT_SERVER_BIN"]?.trim();
  if (bin) {
    const [command, ...args] = bin.split(/\s+/);
    if (command) return { kind: "bin", command, args, cwd: rootDir };
  }

  // ③ 形态探测：bundle 优先（发布形态），回落源码（开发形态）
  const bundleEntry = path.join(rootDir, "dist", "server.mjs");
  const sourceEntry = path.join(rootDir, "packages", "server", "src", "main.ts");
  let kind: "bundle" | "source";
  let serverArgs: string[];
  if (exists(bundleEntry)) {
    kind = "bundle";
    serverArgs = [bundleEntry];
  } else if (exists(sourceEntry)) {
    kind = "source";
    serverArgs = ["--import", "tsx", sourceEntry];
  } else {
    throw new Error(
      `monitor server runtime not found under ${rootDir}: expected ${bundleEntry} (bundle) or ${sourceEntry} (source); ` +
        `set OMT_SERVER_BIN to point at a server command explicitly`,
    );
  }

  // ③' node 解析：OMT_NODE 优先（失败回落 PATH，不短路——用户配错时的自然回退），
  //    版本 major ≥ 20（README Requirements）
  const tried: string[] = [];
  for (const candidate of [env["OMT_NODE"]?.trim(), "node"]) {
    if (!candidate) continue;
    const r = exec(candidate, ["--version"]);
    if (!r.ok) {
      tried.push(`${candidate}: ${r.error ?? "not executable"}`);
      continue;
    }
    const major = parseNodeMajor(r.stdout);
    if (major === null) {
      tried.push(`${candidate}: unparseable version output ${JSON.stringify(r.stdout.trim())}`);
      continue;
    }
    if (major < MIN_NODE_MAJOR) {
      tried.push(`${candidate}: v${major} < required v${MIN_NODE_MAJOR}`);
      continue;
    }
    return { kind, command: candidate, args: serverArgs, cwd: rootDir };
  }

  // ④ 全失败：结构化诊断（绝不静默）——PATH 原文是 fnm/nvm 场景唯一可远程定位的信息
  throw new Error(
    `no usable node runtime (need >= v${MIN_NODE_MAJOR}) for monitor server` +
      (tried.length > 0 ? `; tried: ${tried.join("; ")}` : "; no node candidate found") +
      `; host PATH=${JSON.stringify(env["PATH"] ?? "")}` +
      `; fix: install Node.js >= ${MIN_NODE_MAJOR}, or set OMT_NODE to a node binary, or OMT_SERVER_BIN to a full server command`,
  );
}
