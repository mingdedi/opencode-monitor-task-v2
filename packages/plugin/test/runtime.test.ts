// resolveRuntime 探测链单测
// 全部注入 exists/exec/env——无真机、无网络、无文件系统副作用
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { MIN_NODE_MAJOR, parseNodeMajor, resolveRuntime, type RuntimeDeps } from "../src/runtime.ts";

const ROOT = "/proj/omt";
const bundleEntry = path.join(ROOT, "dist", "server.mjs");
const sourceEntry = path.join(ROOT, "packages", "server", "src", "main.ts");

/** 源码形态布局（sourceEntry 存在、bundle 不存在） */
const sourceOnly: RuntimeDeps["exists"] = (p) => p === sourceEntry;
const bundleOnly: RuntimeDeps["exists"] = (p) => p === bundleEntry || p === sourceEntry;

const okExec =
  (version: string, calls: string[] = []) =>
  (cmd: string): { ok: true; stdout: string } => {
    calls.push(cmd);
    return { ok: true, stdout: `${version}\n` };
  };

test("parseNodeMajor：v22.11.0 → 22；裸 20 → 20；垃圾 → null", () => {
  assert.equal(parseNodeMajor("v22.11.0"), 22);
  assert.equal(parseNodeMajor("20"), 20);
  assert.equal(parseNodeMajor("not a version"), null);
});

test("① OMT_SERVER_BIN 逃生口：全信任直接返回，不做 node 探测", () => {
  const calls: string[] = [];
  const r = resolveRuntime(ROOT, {
    env: { OMT_SERVER_BIN: "/opt/omt/server.mjs --flag", PATH: "/usr/bin" },
    exists: sourceOnly,
    exec: okExec("v22.0.0", calls),
  });
  assert.deepEqual(r, { kind: "bin", command: "/opt/omt/server.mjs", args: ["--flag"], cwd: ROOT });
  assert.deepEqual(calls, []); // 全信任：--version 探测一次都不发生
});

test("② OMT_NODE 逃生口：优先于 PATH node（探测只打 OMT_NODE）", () => {
  const calls: string[] = [];
  const r = resolveRuntime(ROOT, {
    env: { OMT_NODE: "/opt/node22/bin/node", PATH: "/usr/bin" },
    exists: sourceOnly,
    exec: okExec("v22.11.0", calls),
  });
  assert.deepEqual(r, {
    kind: "source",
    command: "/opt/node22/bin/node",
    args: ["--import", "tsx", sourceEntry],
    cwd: ROOT,
  });
  assert.deepEqual(calls, ["/opt/node22/bin/node"]); // PATH "node" 未被尝试
});

test("③ 形态切换：bundle 优先（dist/server.mjs 存在时不再走 tsx 源码形态）", () => {
  const r = resolveRuntime(ROOT, { env: { PATH: "/usr/bin" }, exists: bundleOnly, exec: okExec("v20.0.0") });
  assert.deepEqual(r, { kind: "bundle", command: "node", args: [bundleEntry], cwd: ROOT });
});

test("③ node 版本裁决：PATH node < 20 → 拒绝并诊断；OMT_NODE 坏 → 回落 PATH", () => {
  // PATH node v18：拒绝（消息含实际版本与要求）
  assert.throws(
    () =>
      resolveRuntime(ROOT, {
        env: { PATH: "/usr/bin" },
        exists: sourceOnly,
        exec: () => ({ ok: true, stdout: "v18.19.1\n" }),
      }),
    (err: Error) => err.message.includes("v18") && err.message.includes(`v${MIN_NODE_MAJOR}`),
  );
  // OMT_NODE 不可执行 + PATH node 健康 → 回落 PATH（OMT_NODE 失败留痕于 tried，但自然回退）
  const calls: string[] = [];
  const r = resolveRuntime(ROOT, {
    env: { OMT_NODE: "/broken/node", PATH: "/usr/bin" },
    exists: sourceOnly,
    exec: (cmd) => {
      calls.push(cmd);
      return cmd === "/broken/node"
        ? { ok: false, stdout: "", error: "ENOENT" }
        : { ok: true, stdout: "v22.11.0\n" };
    },
  });
  assert.deepEqual(calls, ["/broken/node", "node"]);
  assert.equal(r.command, "node");
});

test("④ 全失败诊断：含逐条尝试、宿主 PATH 原文与修复指引——绝不静默", () => {
  const PATH = "/home/u/.local/share/fnm/aliases/default/bin";
  assert.throws(
    () =>
      resolveRuntime(ROOT, {
        env: { OMT_NODE: "/gone/node", PATH },
        exists: sourceOnly,
        exec: () => ({ ok: false, stdout: "", error: "ENOENT" }),
      }),
    (err: Error) =>
      err.message.includes("/gone/node") &&
      err.message.includes(PATH) && // PATH 原文（fnm/nvm 场景唯一可远程定位的信息）
      err.message.includes("OMT_NODE") && // 修复指引提及逃生口
      err.message.includes("OMT_SERVER_BIN"),
  );
});

test("④ 无服务端入口：bundle/源码都不存在 → 明确报缺哪个文件", () => {
  assert.throws(
    () => resolveRuntime(ROOT, { env: { PATH: "/usr/bin" }, exists: () => false, exec: okExec("v22.0.0") }),
    (err: Error) => err.message.includes(bundleEntry) && err.message.includes(sourceEntry),
  );
});
