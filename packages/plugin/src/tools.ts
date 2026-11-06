// MCP 三工具定义（PLUGIN-PLAN §二/§五-P2）：monitor_server / monitor / monitor_manage。
// 全部是服务端 HTTP API 的薄封装，插件自身除发现-创建流程外零业务逻辑（§二原则）。
//
// 测试纪律（§六）：execute 为宿主无关纯入参——(input, ToolContext 受控子集) + deps 注入
// （ensureServer / makeClient / env），plugin 注册形状（ctx.tool.transform）只出现在
// registerTools 的防御式探测里，留给 P0/P3 真机。
//
// 错误呈现（§三-4）：
// - 可预期失败（参数校验/防呆/服务端 4xx/发现-创建诊断）→ 结构化错误文本（error: + hint:），
//   模型可见可继续；
// - 意意外异常 → 直接抛出（宿主转 Tool.Error）；
// - 发现-创建失败绝不静默：ensureServer 的诊断（pid/service.json/server.log）原样透出。

import { realpathSync } from "node:fs";
import { MonitorApiError, MonitorClient } from "../../shared/src/client.ts";
import { readOpencodeService } from "../../shared/src/ocservice.ts";
import { LIMITS, type HealthInfo, type PublicInfo, type ServiceFile } from "../../shared/src/types.ts";
import { validateCreateInput } from "../../shared/src/validate.ts";
import { ensureServer, type EnsureServerDeps } from "./server.ts";
import type { EnsureServerResult } from "./types.ts";

/** 工具输出（官方形状保守子集，§一-6：{ content: string }——P0 真机校准） */
export interface ToolOutput {
  content: string;
}

/** execute context 的受控子集（宿主形状 P0-③/⑤ 校准，防御式窄化——缺省即降级，绝不炸） */
export interface ToolContext {
  /** 宿主权威的当前 session id（§三-1 默认化锚点；缺席时 monitor 要求显式 session_id） */
  sessionID?: string;
  /** Session 停止信号——穿透到 fetch（§四纪律 5） */
  signal?: AbortSignal;
  /** 宿主工作区根（§四纪律 4 工作区校验锚点；缺席跳过校验，服务端仍有绝对路径校验兜底） */
  directory?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（enum/minimum/maximum 让模型自校验，§一-3） */
  input: Record<string, unknown>;
  execute(input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolDeps extends EnsureServerDeps {
  /** 发现-创建注入（默认真实 ensureServer；测试注入固定产物——server.test.ts 已覆盖其六分支） */
  ensureServer?: (deps: EnsureServerDeps) => Promise<EnsureServerResult>;
  /** client 工厂（测试注入；默认按 service.json 现值新建——绝不缓存，§四纪律 1） */
  makeClient?: (svc: ServiceFile, signal: AbortSignal | undefined) => MonitorClient;
  /** 诊断日志（默认无操作；index.ts 接 DEBUG 日志） */
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// 公共件

const fail = (msg: string, hint?: string): ToolOutput => ({
  content: hint ? `error: ${msg}\nhint: ${hint}` : `error: ${msg}`,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 每次工具调用的统一开场（§四纪律 1/2）：现读发现-创建 → 新建 client。
 *  ensureServer 的诊断 Error 与服务端 API 错误都转结构化文本；其余异常放行上抛。 */
async function connect(
  deps: ToolDeps,
  ctx: ToolContext,
): Promise<{ client: MonitorClient; ensured: EnsureServerResult } | ToolOutput> {
  let ensured: EnsureServerResult;
  try {
    ensured = await (deps.ensureServer ?? ensureServer)(deps);
  } catch (err) {
    return fail(
      `monitor server discovery/startup failed: ${err instanceof Error ? err.message : String(err)}`,
      "the message above carries pid / service.json / server.log paths — inspect them for the cause (daemon log is opt-in: start the server with --debug / DEBUG=1 to capture it)",
    );
  }
  const client =
    deps.makeClient?.(ensured.svc, ctx.signal) ??
    new MonitorClient(ensured.svc.url, ensured.svc.password, { signal: ctx.signal });
  return { client, ensured };
}

/** 工具主体执行的统一错误围栏：已知可预期错误 → 结构化文本；未知异常上抛（§三-4） */
async function guarded(body: () => Promise<ToolOutput>): Promise<ToolOutput> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof MonitorApiError) {
      // 按 body.code 特化 hint（SESSION_NOT_FOUND 的 404 与任务 404 语义不同——
      // 前者是通知目的地不存在，后者才是任务 id 过期；真机测试发现的映射错位）
      const hint =
        err.body?.code === "SESSION_NOT_FOUND"
          ? "the destination session must exist and be reachable on the target opencode instance — call monitor_server to inspect instances, or pass the correct session_id"
          : err.status === 404
            ? "task id may be stale — call monitor_manage with action=list for current tasks"
            : "server semantics: the error body above is authoritative (terminal-state refusals included)";
      return fail(`server ${err.status}: ${err.body?.error ?? err.message}`, hint);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// monitor_server（§二：health + 按需 spawn；模型选实例的数据源）

function formatInstances(h: HealthInfo): string {
  const rows = h.opencode_instances.map(
    (i) => `  port ${i.port}  ${i.url}  version=${i.version ?? "?"}  alive=${i.pid_alive} reachable=${i.reachable}`,
  );
  return rows.length > 0 ? rows.join("\n") : "  (none — is a shared opencode service running?)";
}

export function monitorServerTool(deps: ToolDeps): ToolSpec {
  return {
    name: "monitor_server",
    description:
      "Discover or auto-start the monitor-task server. Reports health, task counts, and the opencode " +
      "instance whitelist (ports/urls) — the data source for picking opencode_port when delivering " +
      "notifications to another opencode instance. Other monitor tools auto-start the server too; " +
      "use this one explicitly for diagnostics.",
    input: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, ctx) {
      const c = await connect(deps, ctx);
      if ("content" in c) return c;
      const { health: h, spawned } = c.ensured;
      return {
        content:
          `monitor server ${spawned ? "started" : "reused"} at ${c.ensured.svc.url} ` +
          `(version ${h.version}, uptime ${h.uptime_s}s, spawned=${spawned})\n` +
          `tasks: ${h.tasks_alive} alive / ${h.tasks_total} total\n` +
          `reattach: ${h.reattach === null ? "not completed yet" : `${h.reattach.claimed} claimed, ${h.reattach.failed} failed`}\n` +
          `opencode instances (notification destinations):\n${formatInstances(h)}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// monitor（§二：任务下达；§三-1 session_id/opencode_port 默认化 + 显式优先）

/** 默认 opencode 实例端口：现读默认共享服务的 service.json（绝不缓存） */
function defaultOpencodePort(deps: ToolDeps): number | null {
  try {
    const url = new URL(readOpencodeService(deps.env ?? process.env).url);
    const port = Number(url.port);
    return port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** 工作区校验（§四纪律 4——唯一插件端校验，防呆语义非安全边界）：
 *  input.directory 显式传入时，realpath 必须落在宿主工作区内；锚点缺席（宿主未提供
 *  location）跳过，服务端的绝对路径 + 存在性校验兜底。 */
function directoryWithinWorkspace(inputDir: string, workspaceRoot: string | undefined): string | null {
  if (!workspaceRoot) return null;
  let dir: string;
  let root: string;
  try {
    dir = realpathSync(inputDir);
    root = realpathSync(workspaceRoot);
  } catch (err) {
    return `cannot resolve directory (must exist): ${err instanceof Error ? err.message : String(err)}`;
  }
  if (dir !== root && !dir.startsWith(root + "/")) {
    return `directory ${inputDir} resolves outside the current workspace ${workspaceRoot}`;
  }
  return null;
}

export function monitorTool(deps: ToolDeps): ToolSpec {
  return {
    name: "monitor",
    description:
      "Start a shell task monitored by the monitor-task server. You get woken via a synthetic " +
      "notification when the output matches pattern (if given) or when the task exits/idles. " +
      "Notification destination defaults to the current session and opencode instance " +
      "(host-authoritative) — pass session_id/opencode_port explicitly only for cross-instance " +
      "delivery (server whitelist-checks both; check monitor_server for the instance list).",
    input: {
      type: "object",
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description:
            "shell command to run; trailing & stripped, lone & rejected, $(...)/backticks/<(...)/>(...) rejected",
        },
        session_id: {
          type: "string",
          description: "destination session id; default: current session (cross-session delivery only)",
        },
        opencode_port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "destination opencode service port; default: this instance's port (cross-instance only)",
        },
        description: { type: "string", maxLength: LIMITS.descriptionMaxChars, description: "label in notifications" },
        pattern: { type: "string", description: "regex wake filter — wake only on matching output lines" },
        wake_mode: { enum: ["all", "pattern"], description: "default: pattern when pattern is given" },
        delivery: { enum: ["queue", "steer"], description: "busy-session delivery; default queue" },
        coalesce_ms: {
          type: "integer",
          minimum: 0,
          maximum: LIMITS.maxCoalesceMs,
          description: "burst coalescing window, 0 disables; default 500",
        },
        max_events: {
          type: "integer",
          minimum: 1,
          maximum: LIMITS.maxMaxEvents,
          description: "notification cap — task is stopped at cap; default 50, adjustable while running",
        },
        idle_timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: LIMITS.maxIdleTimeoutMs,
          description: "silent-task adjudication window; default 300000",
        },
        directory: {
          type: "string",
          description: "absolute working directory; must stay inside the current workspace; default: workspace root",
        },
      },
      additionalProperties: false,
    },
    async execute(raw, ctx) {
      if (!isRecord(raw)) return fail("monitor input must be a JSON object");
      // 默认化（§三-1）：宿主权威优先缺省、显式传值优先——消除模型手抄 session id 的幻觉错误
      const sessionId =
        typeof raw["session_id"] === "string" && raw["session_id"] !== ""
          ? raw["session_id"]
          : (ctx.sessionID ?? undefined);
      if (sessionId === undefined) {
        return fail(
          "session_id required: the host context did not provide the current session id and none was passed",
          "pass session_id explicitly (the id of the session that should receive wake-up notifications)",
        );
      }
      const port = Number.isInteger(raw["opencode_port"]) ? (raw["opencode_port"] as number) : defaultOpencodePort(deps);
      if (port === null) {
        return fail(
          "opencode_port required: no healthy default opencode service.json found (or it carries no port)",
          "call monitor_server to inspect opencode_instances, then pass opencode_port explicitly",
        );
      }

      // 插件端防呆（§四纪律 4）：shared 校验器与服务端同规则，快速失败友好错误
      const v = validateCreateInput({ ...raw, session_id: sessionId, opencode_port: port });
      if (!v.ok) {
        return fail(
          `invalid monitor input: ${v.violations.map((x) => `${x.field}: ${x.message}`).join("; ")}`,
          "fix the listed fields and retry",
        );
      }
      if (v.value.directory !== undefined) {
        const ws = directoryWithinWorkspace(v.value.directory, ctx.directory);
        if (ws !== null) return fail(`invalid monitor input: directory: ${ws}`, "use a directory inside the current workspace");
      }

      return guarded(async () => {
        const c = await connect(deps, ctx);
        if ("content" in c) return c;
        deps.log?.(`monitor: create (session ${sessionId.slice(0, 8)}…, port ${port})`);
        const info = await c.client.createTask(v.value);
        return { content: `monitor started (id ${info.id}, state ${info.state})\n${JSON.stringify(info, null, 2)}` };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// monitor_manage（§二：任务管理全生命周期；§三-2 补 delete）

const ACTIONS = ["list", "status", "stop", "keepalive", "update", "read_log", "delete"] as const;
type ManageAction = (typeof ACTIONS)[number];

const NEEDS_ID: readonly ManageAction[] = ["status", "stop", "keepalive", "update", "read_log", "delete"];

function formatList(tasks: PublicInfo[]): string {
  if (tasks.length === 0) return "no monitored tasks (for this filter)";
  const rows = tasks.map(
    (t) =>
      `  ${t.id}  ${t.state}${t.description ? `  ${t.description}` : ""}  ` +
      `events ${t.events_sent}/${t.max_events}${t.pattern ? `  pattern ${t.pattern}` : ""}`,
  );
  return `${tasks.length} task(s):\n${rows.join("\n")}`;
}

export function monitorManageTool(deps: ToolDeps): ToolSpec {
  return {
    name: "monitor_manage",
    description:
      "Manage monitored tasks. Actions: list (optional session_id filter), status, stop (graceful), " +
      "keepalive (extend idle adjudication), update (max_events), read_log (tail), delete (terminal only). " +
      "keepalive/update are refused on terminal tasks (server semantics pass through).",
    input: {
      type: "object",
      required: ["action"],
      properties: {
        action: { enum: [...ACTIONS] },
        monitor_id: { type: "string", description: "task id — required for all actions except list" },
        session_id: { type: "string", description: "list filter: only tasks of this session" },
        max_events: {
          type: "integer",
          minimum: 1,
          maximum: LIMITS.maxMaxEvents,
          description: "update: new notification cap",
        },
        tail_lines: {
          type: "integer",
          minimum: 1,
          maximum: LIMITS.logTailMaxLines,
          description: `read_log: tail line count, default ${LIMITS.logTailDefaultLines}, max ${LIMITS.logTailMaxLines}`,
        },
      },
      additionalProperties: false,
    },
    async execute(raw, ctx) {
      if (!isRecord(raw)) return fail("monitor_manage input must be a JSON object");
      const action = raw["action"] as ManageAction;
      if (!ACTIONS.includes(action)) {
        return fail(`invalid action ${JSON.stringify(action)}`, `action must be one of: ${ACTIONS.join(", ")}`);
      }
      const id = typeof raw["monitor_id"] === "string" ? raw["monitor_id"] : undefined;
      if (NEEDS_ID.includes(action) && (id === undefined || id === "")) {
        return fail(`monitor_id required for action=${action}`, "call action=list first to see task ids");
      }
      // read_log 防呆：tail 提前失败（默认 20，上限对齐 logTailMaxLines——服务端双层防护的第二层在字节界）
      let tail: number = LIMITS.logTailDefaultLines;
      if (raw["tail_lines"] !== undefined) {
        if (!Number.isInteger(raw["tail_lines"]) || (raw["tail_lines"] as number) < 1 || (raw["tail_lines"] as number) > LIMITS.logTailMaxLines) {
          return fail(`tail_lines must be an integer in [1, ${LIMITS.logTailMaxLines}]`);
        }
        tail = raw["tail_lines"] as number;
      }

      return guarded(async () => {
        const c = await connect(deps, ctx);
        if ("content" in c) return c;
        const client = c.client;
        switch (action) {
          case "list": {
            const sid = typeof raw["session_id"] === "string" && raw["session_id"] !== "" ? raw["session_id"] : undefined;
            return { content: formatList(await client.listTasks(sid)) };
          }
          case "status":
            return { content: JSON.stringify(await client.getTask(id!), null, 2) };
          case "stop": {
            const info = await client.stopTask(id!);
            return { content: `stop requested (state ${info.state})\n${JSON.stringify(info, null, 2)}` };
          }
          case "keepalive": {
            const info = await client.keepalive(id!);
            return { content: `keepalive acknowledged\n${JSON.stringify(info, null, 2)}` };
          }
          case "update": {
            if (!Number.isInteger(raw["max_events"])) {
              return fail("max_events required for action=update", `integer 1-${LIMITS.maxMaxEvents}`);
            }
            const info = await client.updateTask(id!, { max_events: raw["max_events"] as number });
            return { content: `updated\n${JSON.stringify(info, null, 2)}` };
          }
          case "read_log":
            return { content: await client.readLog(id!, tail) };
          case "delete":
            await client.deleteTask(id!);
            return { content: `deleted task ${id}` };
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 注册接线（宿主形状唯一出现处——防御式探测，P0 真机校准）

/** editor.add 的保守形状（§一-3；宿主类型经此本地描述） */
export interface ToolEditor {
  add(spec: { name: string; description: string; input: Record<string, unknown>; execute: (input: unknown, ctx: unknown) => Promise<ToolOutput> }): unknown;
}

/** transform 返回的注册句柄（§一-3：reg.dispose() 撤销注册） */
export interface ToolRegistration {
  dispose(): void;
}

/**
 * 向宿主注册三工具。ctx.tool.transform 缺席（宿主无该路径——P0 未验证形状）时返回 null
 * 并留痕跳过：注册失败的最坏结果是"无工具"，绝不拖垮宿主（§1.3-5 豁免区边界）。
 *
 * execute 的宿主 ctx 防御式窄化为 ToolContext：sessionID / signal 直取；
 * 工作区锚点双源探测（executeCtx.location.directory ?? setupCtx.location.directory）。
 */
export async function registerTools(
  setupCtx: unknown,
  deps: ToolDeps = {},
): Promise<ToolRegistration | null> {
  const tool = (setupCtx as { tool?: { transform?: unknown } } | null | undefined)?.tool?.transform;
  if (typeof tool !== "function") return null;
  const setupDir = (setupCtx as { location?: { directory?: unknown } } | null)?.location?.directory;
  const specs = [monitorServerTool(deps), monitorTool(deps), monitorManageTool(deps)];
  const transform = tool as (fn: (editor: ToolEditor) => void) => Promise<unknown>;
  const reg: unknown = await transform((editor) => {
    for (const s of specs) {
      editor.add({
        name: s.name,
        description: s.description,
        input: s.input,
        execute: (input, hostCtx) =>
          s.execute(input, {
            sessionID: strField(hostCtx, "sessionID"),
            signal: signalField(hostCtx),
            directory: locationDirectory(hostCtx) ?? (typeof setupDir === "string" ? setupDir : undefined),
          }),
      });
    }
  });
  if (reg === null || reg === undefined) return null;
  return reg as ToolRegistration;
}

function strField(obj: unknown, key: string): string | undefined {
  const v = (obj as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "string" ? v : undefined;
}

function locationDirectory(obj: unknown): string | undefined {
  const loc = (obj as { location?: { directory?: unknown } } | null | undefined)?.location;
  return typeof loc?.directory === "string" ? loc.directory : undefined;
}

function signalField(obj: unknown): AbortSignal | undefined {
  const v = (obj as { signal?: unknown } | null | undefined)?.signal;
  return v instanceof AbortSignal ? v : undefined;
}
