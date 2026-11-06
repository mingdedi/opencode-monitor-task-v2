// 三工具单测
// 全部注入 ensureServer/makeClient/env——无网络、无真机、无服务端进程。
// 插件注册形状（ctx.tool.transform）不在本文件：tools.ts 的 registerTools 留给 P0/P3 真机。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { MonitorApiError, MonitorClient } from "../../shared/src/client.ts";
import type { HealthInfo, PublicInfo, ServiceFile } from "../../shared/src/types.ts";
import { monitorManageTool, monitorServerTool, monitorTool, type ToolContext, type ToolDeps } from "../src/tools.ts";
import type { EnsureServerResult } from "../src/types.ts";

let xdgRoot: string;

before(() => {
  xdgRoot = mkdtempSync(path.join(tmpdir(), "omt-tools-"));
});
after(() => {
  rmSync(xdgRoot, { recursive: true, force: true });
});

// ---- 造假件 ----

const SVC: ServiceFile = {
  id: "svc-id",
  version: "0.1.0",
  url: "http://127.0.0.1:45678",
  pid: 111,
  password: "pw",
  started_at: 1,
};

const HEALTH: HealthInfo = {
  id: "svc-id",
  version: "0.1.0",
  uptime_s: 42,
  tasks_alive: 2,
  tasks_total: 3,
  reattach: null,
  opencode_instances: [{ port: 43211, url: "http://127.0.0.1:43211", version: "2.2.5", pid_alive: true, reachable: true }],
  log_bytes: 10,
};

const INFO: PublicInfo = {
  id: "task-1",
  description: "build",
  state: "running",
  session_id: "ses_abc",
  opencode_port: 43211,
  directory: "/ws",
  command: "npm run build",
  pattern: "ERROR",
  wake_mode: "pattern",
  delivery: "queue",
  coalesce_ms: 500,
  max_events: 50,
  idle_timeout_ms: 300000,
  started_at: 1,
  idle_deadline: null,
  grace_deadline: null,
  pid: 222,
  lines_scanned: 10,
  lines_matched: 1,
  events_sent: 1,
  events_dropped: 0,
  exit_info: null,
  log_bytes: 100,
  last_offset: 100,
  updated_at: 2,
};

/** 假 client 工厂 + deps 装配：记录每次构造（signal 透传断言）与全部方法调用 */
interface MakeClientHarness {
  deps: ToolDeps;
  calls: Array<{ method: string; args: unknown[] }>;
  signals: Array<AbortSignal | undefined>;
  /** 设置下一次方法调用的结果（默认成功 INFO / [INFO] / 日志文本） */
  next: { result: "ok" | "err"; err?: MonitorApiError; log?: string };
}
function makeHarness(envOpts: { opencodeService?: boolean } = {}): MakeClientHarness {
  const run = `run-${Math.random().toString(36).slice(2, 8)}`;
  const env: NodeJS.ProcessEnv = {
    HOME: `${xdgRoot}/${run}`,
    XDG_STATE_HOME: `${xdgRoot}/${run}/state`,
    XDG_DATA_HOME: `${xdgRoot}/${run}/data`,
  };
  mkdirSync(`${xdgRoot}/${run}/state`, { recursive: true });
  if (envOpts.opencodeService) {
    // 默认 opencode 共享服务的 service.json（opencode_port 默认化数据源）
    mkdirSync(`${xdgRoot}/${run}/state/opencode`, { recursive: true });
    writeFileSync(
      `${xdgRoot}/${run}/state/opencode/service.json`,
      JSON.stringify({ url: "http://127.0.0.1:43211", password: "opw" }),
    );
  }
  const calls: MakeClientHarness["calls"] = [];
  const signals: MakeClientHarness["signals"] = [];
  const next: MakeClientHarness["next"] = { result: "ok" };
  const client = {
    health: async () => HEALTH,
    createTask: async (input: unknown) => {
      calls.push({ method: "createTask", args: [input] });
      if (next.result === "err") throw next.err!;
      return INFO;
    },
    listTasks: async (sid?: string) => {
      calls.push({ method: "listTasks", args: [sid] });
      if (next.result === "err") throw next.err!;
      return [INFO];
    },
    getTask: async (id: string) => {
      calls.push({ method: "getTask", args: [id] });
      if (next.result === "err") throw next.err!;
      return INFO;
    },
    updateTask: async (id: string, patch: { max_events: number }) => {
      calls.push({ method: "updateTask", args: [id, patch] });
      if (next.result === "err") throw next.err!;
      return INFO;
    },
    stopTask: async (id: string) => {
      calls.push({ method: "stopTask", args: [id] });
      if (next.result === "err") throw next.err!;
      return INFO;
    },
    keepalive: async (id: string) => {
      calls.push({ method: "keepalive", args: [id] });
      if (next.result === "err") throw next.err!;
      return INFO;
    },
    deleteTask: async (id: string) => {
      calls.push({ method: "deleteTask", args: [id] });
      if (next.result === "err") throw next.err!;
    },
    readLog: async (id: string, tail: number) => {
      calls.push({ method: "readLog", args: [id, tail] });
      if (next.result === "err") throw next.err!;
      return next.log ?? "log-line-1\nlog-line-2";
    },
  };
  const deps: ToolDeps = {
    env,
    rootDir: "/proj/omt",
    makeClient: (svc, signal) => {
      assert.equal(svc.url, SVC.url); // 来自 ensureServer 结果的现值
      signals.push(signal);
      return client as unknown as MonitorClient;
    },
  };
  return { deps, calls, signals, next };
}

/** 补上 ensureServer 注入位（固定复用产物——发现-创建的六分支已在 server.test.ts 覆盖） */
function withEnsureServer(h: MakeClientHarness, spawned = false): ToolDeps {
  const ensured: EnsureServerResult = { spawned, svc: SVC, health: HEALTH };
  return { ...h.deps, ensureServer: async () => ensured };
}

const CTX: ToolContext = { sessionID: "ses_abc", directory: "/ws" };

// ---- monitor_server ----

test("monitor_server：health 全量呈现 + spawned 标记 + 实例白名单", async () => {
  const h = makeHarness();
  const out = await monitorServerTool(withEnsureServer(h, true)).execute({}, CTX);
  assert.match(out.content, /monitor server started at http:\/\/127\.0\.0\.1:45678/);
  assert.match(out.content, /spawned=true/);
  assert.match(out.content, /2 alive \/ 3 total/);
  assert.match(out.content, /port 43211.*reachable=true/);
});

test("monitor_server：发现-创建失败 → 结构化诊断文本（绝不静默）", async () => {
  const h = makeHarness();
  const deps: ToolDeps = {
    ...h.deps,
    ensureServer: async () => {
      throw new Error('no usable node runtime ... host PATH="" (fix: install Node.js >= 20)');
    },
  };
  const out = await monitorServerTool(deps).execute({}, CTX);
  assert.match(out.content, /^error: monitor server discovery\/startup failed: no usable node runtime/);
  assert.match(out.content, /hint: the message above carries pid/);
});

// ---- monitor：默认化 / 显式优先 / 防呆 ----

test("monitor 默认化：session_id ← ctx.sessionID、opencode_port ← 默认 service.json 端口", async () => {
  const h = makeHarness({ opencodeService: true });
  const out = await monitorTool(withEnsureServer(h)).execute({ command: "npm run build" }, CTX);
  assert.match(out.content, /monitor started \(id task-1, state running\)/);
  const body = h.calls[0]!.args[0] as Record<string, unknown>;
  assert.equal(body["session_id"], "ses_abc");
  assert.equal(body["opencode_port"], 43211);
  // validateCreateInput 解析后的默认值透传（wake_mode 隐式 pattern 等）
  assert.equal(body["wake_mode"], "all");
  assert.equal(body["max_events"], 50);
});

test("monitor 显式优先：显式 session_id/opencode_port 覆盖默认", async () => {
  const h = makeHarness({ opencodeService: true });
  await monitorTool(withEnsureServer(h)).execute(
    { command: "make", session_id: "ses_other", opencode_port: 9999 },
    CTX,
  );
  const body = h.calls[0]!.args[0] as Record<string, unknown>;
  assert.equal(body["session_id"], "ses_other");
  assert.equal(body["opencode_port"], 9999);
});

test("monitor 无 sessionID 可默认且未显式传 → 结构化错误 + hint", async () => {
  const h = makeHarness({ opencodeService: true });
  const out = await monitorTool(withEnsureServer(h)).execute({ command: "true" }, { directory: "/ws" });
  assert.match(out.content, /error: session_id required/);
  assert.deepEqual(h.calls, []); // 防呆提前失败，不触达服务端
});

test("monitor 默认端口解析失败（无 opencode service.json）→ 引导 monitor_server", async () => {
  const h = makeHarness(); // 未造 opencode service.json
  const out = await monitorTool(withEnsureServer(h)).execute({ command: "true" }, CTX);
  assert.match(out.content, /error: opencode_port required/);
  assert.match(out.content, /hint: call monitor_server/);
});

test("monitor 命令防呆：$(...) 拒绝，提前失败不触达服务端", async () => {
  const h = makeHarness({ opencodeService: true });
  const out = await monitorTool(withEnsureServer(h)).execute({ command: "echo $(whoami)" }, CTX);
  assert.match(out.content, /error: invalid monitor input: command:/);
  assert.deepEqual(h.calls, []);
});

test("monitor 工作区校验：directory 越出工作区 → 提前失败；边界内放行", async () => {
  const h = makeHarness({ opencodeService: true });
  const ws = `${xdgRoot}/ws-case`;
  mkdirSync(`${ws}/sub`, { recursive: true });
  const deps = withEnsureServer(h);
  const out = await monitorTool(deps).execute({ command: "true", directory: "/etc" }, { ...CTX, directory: ws });
  assert.match(out.content, /error: invalid monitor input: directory:.*outside the current workspace/);
  assert.deepEqual(h.calls, []);
  const ok = await monitorTool(deps).execute({ command: "true", directory: `${ws}/sub` }, { ...CTX, directory: ws });
  assert.match(ok.content, /monitor started/);
});

test("monitor 工作区锚点缺席（宿主未提供 location）→ 跳过校验，服务端兜底", async () => {
  const h = makeHarness({ opencodeService: true });
  const out = await monitorTool(withEnsureServer(h)).execute({ command: "true", directory: "/etc" }, { sessionID: "ses_abc" });
  assert.match(out.content, /monitor started/); // 无锚点不拦（防呆语义，非安全边界）
});

test("monitor signal 透传：ctx.signal 到达 client 工厂", async () => {
  const h = makeHarness({ opencodeService: true });
  const sig = new AbortController().signal;
  await monitorTool(withEnsureServer(h)).execute({ command: "true" }, { ...CTX, signal: sig });
  assert.equal(h.signals[h.signals.length - 1], sig);
});

// ---- monitor_manage：action 转发 / read_log 边界 / 错误映射 ----

test("monitor_manage list：无过滤 → listTasks(undefined)；有 session 过滤透传", async () => {
  const h = makeHarness();
  const tool = monitorManageTool(withEnsureServer(h));
  await tool.execute({ action: "list" }, CTX);
  assert.deepEqual(h.calls[0]!.args, [undefined]);
  await tool.execute({ action: "list", session_id: "ses_other" }, CTX);
  assert.deepEqual(h.calls[1]!.args, ["ses_other"]);
});

test("monitor_manage status/stop/keepalive/update/delete：参数逐 action 转发", async () => {
  const h = makeHarness();
  const tool = monitorManageTool(withEnsureServer(h));
  await tool.execute({ action: "status", monitor_id: "t1" }, CTX);
  assert.deepEqual(h.calls[0]!.method, "getTask");
  await tool.execute({ action: "stop", monitor_id: "t1" }, CTX);
  assert.deepEqual(h.calls[1]!.method, "stopTask");
  await tool.execute({ action: "keepalive", monitor_id: "t1" }, CTX);
  assert.deepEqual(h.calls[2]!.method, "keepalive");
  await tool.execute({ action: "update", monitor_id: "t1", max_events: 99 }, CTX);
  assert.deepEqual(h.calls[3]!.args, ["t1", { max_events: 99 }]);
  const out = await tool.execute({ action: "delete", monitor_id: "t1" }, CTX);
  assert.deepEqual(h.calls[4]!.method, "deleteTask");
  assert.match(out.content, /deleted task t1/);
});

test("monitor_manage read_log：默认 20、显式 100、超限 1001 提前失败", async () => {
  const h = makeHarness();
  const tool = monitorManageTool(withEnsureServer(h));
  await tool.execute({ action: "read_log", monitor_id: "t1" }, CTX);
  assert.deepEqual(h.calls[0]!.args, ["t1", 20]);
  await tool.execute({ action: "read_log", monitor_id: "t1", tail_lines: 100 }, CTX);
  assert.deepEqual(h.calls[1]!.args, ["t1", 100]);
  const out = await tool.execute({ action: "read_log", monitor_id: "t1", tail_lines: 1001 }, CTX);
  assert.match(out.content, /error: tail_lines must be an integer in \[1, 1000\]/);
  assert.equal(h.calls.length, 2); // 超限未触达服务端
});

test("monitor_manage 防呆：未知 action / 缺 monitor_id / update 缺 max_events", async () => {
  const h = makeHarness();
  const tool = monitorManageTool(withEnsureServer(h));
  assert.match((await tool.execute({ action: "explode" }, CTX)).content, /error: invalid action/);
  assert.match((await tool.execute({ action: "stop" }, CTX)).content, /error: monitor_id required for action=stop/);
  assert.match((await tool.execute({ action: "update", monitor_id: "t1" }, CTX)).content, /error: max_events required/);
  assert.deepEqual(h.calls, []);
});

test("monitor_manage 错误映射：404 → 结构化文本 + list 提示；SESSION_NOT_FOUND 特化 hint；4xx 终态拒绝透传", async () => {
  const h = makeHarness();
  const tool = monitorManageTool(withEnsureServer(h));
  h.next.result = "err";
  h.next.err = new MonitorApiError(404, { error: "task t1 not found", code: "TASK_NOT_FOUND" });
  const out = await tool.execute({ action: "status", monitor_id: "t1" }, CTX);
  assert.match(out.content, /error: server 404: task t1 not found/);
  assert.match(out.content, /hint: .*action=list/);
  h.next.err = new MonitorApiError(409, { error: "task t1 is running; stop it first", code: "TASK_NOT_TERMINAL" });
  const out2 = await tool.execute({ action: "delete", monitor_id: "t1" }, CTX);
  assert.match(out2.content, /error: server 409: task t1 is running/);
});

test("monitor 错误映射：SESSION_NOT_FOUND（404）→ 目的地语义 hint，不再误导 action=list", async () => {
  const h = makeHarness({ opencodeService: true });
  h.next.result = "err";
  h.next.err = new MonitorApiError(404, {
    error: "session ses_x not found on port 49374 (404, or liveness check failed)",
    code: "SESSION_NOT_FOUND",
  });
  const out = await monitorTool(withEnsureServer(h)).execute({ command: "true" }, CTX);
  assert.match(out.content, /error: server 404: session ses_x not found/);
  assert.match(out.content, /hint: the destination session must exist/);
  assert.doesNotMatch(out.content, /action=list/); // 旧 bug：session 404 给任务 id 过期的提示
});

test("monitor_manage list 空态与行摘要", async () => {
  const h = makeHarness();
  const out = await monitorManageTool(withEnsureServer(h)).execute({ action: "list" }, CTX);
  assert.match(out.content, /1 task\(s\):/);
  assert.match(out.content, /task-1\s+running\s+build/);
  assert.match(out.content, /events 1\/50/);
});

// ---- 工作区校验的符号链接逃逸（realpath 语义） ----

test("monitor 工作区校验：符号链接逃逸（ws 内链接指向外部）→ 拦截", async () => {
  const h = makeHarness({ opencodeService: true });
  const ws = `${xdgRoot}/ws-link-case`;
  const outside = `${xdgRoot}/outside`;
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, `${ws}/escape`);
  const out = await monitorTool(withEnsureServer(h)).execute(
    { command: "true", directory: `${ws}/escape` },
    { ...CTX, directory: ws },
  );
  assert.match(out.content, /outside the current workspace/);
});
