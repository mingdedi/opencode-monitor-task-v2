// verify/sim 脚本共用的服务端形态解析。
//
// 与 packages/plugin/src/runtime.ts 的形态探测同构（dist/server.mjs 存在 → bundle 形态
// `node <bundle>`；否则源码形态 `node --import tsx <main.ts>`），但脚本自身以 node 启动，
// 无需 OMT_* 逃生口与 PATH 探测——process.execPath 即 node。构建产物存在性是唯一开关：
// 跑 `npm run build` 后全套脚本自动切换到 bundle 判据，删 dist/ 即回源码形态——
// 同一判据双形态复验正是 M8 风险 7 的缓解措施。

import { existsSync } from "node:fs";
import path from "node:path";

export interface ServerEntry {
  /** node 可执行（脚本进程同源） */
  command: string;
  /** 服务端入口参数（不含脚本各自的附加 args，如 --opencode-state） */
  baseArgs: string[];
  /** 当前形态（诊断输出用） */
  form: "bundle" | "source";
}

/** dist/server.mjs 存在 → bundle；否则源码 tsx 直跑（开发形态）。
 *  baseArgs 恒带 --debug：服务端日志默认关闭，而 verify-m4/m5/m8
 *  与 storm-sim 的判据依赖 server.log 留痕（reattach 认领、无命令全文审计）——
 *  脚本侧统一显式开启，一处改动全套脚本生效。 */
export function resolveServerEntry(
  root: string,
  exists: (p: string) => boolean = existsSync,
): ServerEntry {
  const bundle = path.join(root, "dist", "server.mjs");
  if (exists(bundle)) return { command: process.execPath, baseArgs: [bundle, "--debug"], form: "bundle" };
  const source = path.join(root, "packages", "server", "src", "main.ts");
  return { command: process.execPath, baseArgs: ["--import", "tsx", source, "--debug"], form: "source" };
}
