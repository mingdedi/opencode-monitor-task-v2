// §1.3 官方契约封装层——服务端对 opencode 的一切交互唯一入口（PLAN §1.3 / §2.8）
// 分层纪律（M0 实测结论，docs/CONTRACT.md）：
//   · @opencode-ai/sdk（唯一运行时依赖，v2 client）覆盖其已生成方法：
//     GET /api/session/:id（verifySessionAlive）
//   · SDK 滞后未生成的端点按 §1.2.1 契约手写薄封装：GET /api/info、POST synthetic、
//     GET inbox（SDK v2 client 无此三方法；SDK 补齐后在本文件一处切换）
//   · 实测语义：delivery 必须显式传（省略时服务端默认 steer——lifecycle 恒 queue 依赖此纪律）；
//     404 判据 = status 404 或 _tag==="SessionNotFoundError"；409 按可重试；幂等 id 真去重
// 凭证纪律（§2.8.1）：password 每次使用前从对应 service.json 现读，零缓存、永不落盘；
//   注册表内容即白名单——传入端口必须命中表内条目 url，且 pid 活 + /api/info 通过，
//   三层校验后才开始执行（模型幻觉端口 / 任意本地服务 fail fast 拒绝）。

// v2 client 从子路径导入（包根入口是 v1 风格客户端，无 v2 命名空间）
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  opencodeAuthHeader,
  opencodeServicePath,
  readOpencodeService,
  type HealthInfo,
  type OpencodeService,
  type PathEnv,
} from "@omt/shared";
import type { Delivery } from "@omt/shared";
import { isPidAlive } from "./spawner.ts";

// ---------------------------------------------------------------------------
// 实例注册表（防串联白名单，PLAN §2.8.1）

export interface OpencodeRegistry {
  /** 白名单 = 各路径 service.json 的 url；默认共享服务条目 + --opencode-state 追加 */
  servicePaths: string[];
}

export function buildRegistry(env: PathEnv, extraPaths: string[] = []): OpencodeRegistry {
  return { servicePaths: [...new Set([opencodeServicePath(env), ...extraPaths])] };
}

/** argv 解析 --opencode-state <service.json 路径>（可多次出现；缺值/下一 token 是 flag 时忽略该选项） */
export function parseOpencodeStateArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--opencode-state") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        out.push(v);
        i++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 依赖注入（单测 fetch-mock / 探活注入，无网络）

export interface OcDeps {
  fetchImpl?: typeof fetch;
  /** 单请求超时（默认 1000ms，与发现流程探测节奏一致） */
  timeoutMs?: number;
  /** pid 探活注入（单测） */
  isAlive?: (pid: number) => boolean;
}

const DEFAULT_TIMEOUT_MS = 1000;

async function ocFetch(url: string, init: RequestInit, deps: OcDeps): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  return await doFetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
}

// ---------------------------------------------------------------------------
// GET /api/info（SDK 未生成，按 spec 手写）——实例可达性与版本

export interface InstanceCheck {
  ok: boolean;
  version: string | null;
  detail?: string;
}

export async function verifyInstance(svc: OpencodeService, deps: OcDeps = {}): Promise<InstanceCheck> {
  try {
    const res = await ocFetch(`${svc.url}/api/info`, { headers: { authorization: opencodeAuthHeader(svc) } }, deps);
    if (res.status === 200) {
      const body = (await res.json()) as { version?: string };
      return { ok: true, version: typeof body.version === "string" ? body.version : null };
    }
    return { ok: false, version: null, detail: `GET /api/info -> ${res.status}` };
  } catch (err) {
    return { ok: false, version: null, detail: String(err) };
  }
}

export type InstanceStatus = HealthInfo["opencode_instances"][number];

/** 注册表全条目实测（health 的 opencode_instances 数据源；每次现读 service.json，绝不缓存） */
export async function probeInstances(
  registry: OpencodeRegistry,
  env: PathEnv,
  deps: OcDeps = {},
): Promise<InstanceStatus[]> {
  const isAlive = deps.isAlive ?? isPidAlive;
  const results = await Promise.all(
    registry.servicePaths.map(async (p) => {
      let svc: OpencodeService;
      try {
        svc = readOpencodeService(env, p); // 缺失/坏 JSON → 该路径不可用作白名单（standalone 天然出局）
      } catch {
        return null;
      }
      let port: number;
      try {
        const u = new URL(svc.url);
        port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
      } catch {
        return null;
      }
      if (!Number.isInteger(port) || port <= 0) return null;
      const check = await verifyInstance(svc, deps);
      return {
        port,
        url: svc.url,
        version: check.ok ? check.version : null,
        pid_alive: typeof svc.pid === "number" ? isAlive(svc.pid) : false,
        reachable: check.ok,
      } satisfies InstanceStatus;
    }),
  );
  return results.filter((r): r is InstanceStatus => r !== null);
}

// ---------------------------------------------------------------------------
// 白名单解析（任务创建 fail fast 与投递前共用，PLAN §2.8.1/§2.8.2）

export type TargetRejectionCode = "PORT_NOT_IN_REGISTRY" | "PID_DEAD" | "UNREACHABLE";

export type TargetResolution =
  | { ok: true; svc: OpencodeService; servicePath: string }
  | { ok: false; code: TargetRejectionCode; reason: string };

/** 端口命中表内条目 → 该条目 pid 活 → GET /api/info 200（Basic auth 验证 password），
 *  三者全过才放行；任一失败 fail fast 拒绝并带原因。 */
export async function resolveTarget(
  registry: OpencodeRegistry,
  port: number,
  env: PathEnv,
  deps: OcDeps = {},
): Promise<TargetResolution> {
  const isAlive = deps.isAlive ?? isPidAlive;
  for (const p of registry.servicePaths) {
    let svc: OpencodeService;
    try {
      svc = readOpencodeService(env, p); // 现读：opencode 重启后 url/password 都会变（§1.2）
    } catch {
      continue; // 该路径当前不可用：不命中，继续找下一条
    }
    let entryPort: number;
    try {
      const u = new URL(svc.url);
      entryPort = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
    } catch {
      continue;
    }
    if (entryPort !== port) continue;
    // 命中唯一候选：逐级校验（多路径同端口不可能——随机端口唯一，首个命中即裁决）
    if (typeof svc.pid !== "number" || !isAlive(svc.pid)) {
      return {
        ok: false,
        code: "PID_DEAD",
        reason: `instance service.json (${p}) pid ${svc.pid ?? "?"} not alive — stale entry, opencode restarted?`,
      };
    }
    const check = await verifyInstance(svc, deps);
    if (!check.ok) {
      return {
        ok: false,
        code: "UNREACHABLE",
        reason: `instance at ${svc.url} failed /api/info: ${check.detail ?? "unreachable"} — password rotated or service down?`,
      };
    }
    return { ok: true, svc, servicePath: p };
  }
  return {
    ok: false,
    code: "PORT_NOT_IN_REGISTRY",
    reason: `port ${port} matches no registered opencode instance (registry: ${registry.servicePaths.join(", ")})`,
  };
}

// ---------------------------------------------------------------------------
// GET /api/session/:id（SDK 已生成）——session 存活校验

export async function verifySessionAlive(
  svc: OpencodeService,
  sessionId: string,
  deps: OcDeps = {},
): Promise<boolean> {
  try {
    const client = createOpencodeClient({
      baseUrl: svc.url,
      headers: { authorization: opencodeAuthHeader(svc) },
      fetch: deps.fetchImpl,
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    // client.v2.* = /api 前缀命名空间（M0 矩阵：v2 client 与 server 2.2.5 路径一致）；
    // 顶层 client.session 走无 /api 前缀路径，勿用
    const res = await client.v2.session.get({ sessionID: sessionId });
    return res.response.status === 200;
  } catch {
    return false; // 网络/超时/异常：保守判不存在（fail fast 语义，PLAN §3.3）
  }
}

// ---------------------------------------------------------------------------
// POST /api/session/:id/synthetic（SDK 未生成，按 §1.2.1 契约手写）

export type SyntheticFailure = "session-not-found" | "unauthorized" | "invalid" | "retryable";

export interface SyntheticResult {
  ok: boolean;
  failure?: SyntheticFailure;
  detail?: string;
  /** 服务端生成的消息 id（幂等重放时回显首次 id——重试复用同 id 天然去重） */
  messageId?: string;
}

export interface SyntheticParams {
  sessionId: string;
  text: string;
  /** 必填显式传递：省略时服务端默认 steer（CONTRACT.md 实测）——lifecycle 恒 queue 依赖此纪律 */
  delivery: Delivery;
  /** 幂等 id：重试必须复用同 id */
  id?: string;
  /** false = 仅入收件箱不触发执行（§1.2.1） */
  resume?: boolean;
}

export async function sendSynthetic(
  svc: OpencodeService,
  params: SyntheticParams,
  deps: OcDeps = {},
): Promise<SyntheticResult> {
  const body: Record<string, unknown> = { text: params.text, delivery: params.delivery };
  if (params.id !== undefined) body["id"] = params.id;
  if (params.resume !== undefined) body["resume"] = params.resume;
  let res: Response;
  try {
    res = await ocFetch(
      `${svc.url}/api/session/${encodeURIComponent(params.sessionId)}/synthetic`,
      {
        method: "POST",
        headers: { authorization: opencodeAuthHeader(svc), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      deps,
    );
  } catch (err) {
    return { ok: false, failure: "retryable", detail: `network: ${String(err)}` };
  }
  if (res.status === 200) {
    const parsed = (await res.json().catch(() => null)) as { data?: { id?: string } } | null;
    return { ok: true, messageId: parsed?.data?.id };
  }
  const text = await res.text().catch(() => "");
  let tag = "";
  try {
    tag = String((JSON.parse(text) as { _tag?: string })._tag ?? "");
  } catch {
    // 非 JSON 错误体
  }
  if (res.status === 404 || tag === "SessionNotFoundError") {
    return { ok: false, failure: "session-not-found", detail: `404 ${text.slice(0, 120)}` };
  }
  if (res.status === 401) {
    return { ok: false, failure: "unauthorized", detail: "401 — opencode password rotated?" };
  }
  if (res.status === 400) {
    // payload 契约由 test/contract.test.ts 守门；走到这里说明调用方 bug，不可重试
    return { ok: false, failure: "invalid", detail: `400 ${text.slice(0, 120)}` };
  }
  // 409 实测未观测到、按可重试（CONTRACT.md）；5xx/其余同
  return { ok: false, failure: "retryable", detail: `${res.status} ${text.slice(0, 120)}` };
}

// ---------------------------------------------------------------------------
// GET /api/session/:id/inbox（SDK 未生成，手写）——持久收件箱（诊断 / 重投核对）

export async function listInbox(
  svc: OpencodeService,
  sessionId: string,
  deps: OcDeps = {},
): Promise<Array<Record<string, unknown>>> {
  const res = await ocFetch(
    `${svc.url}/api/session/${encodeURIComponent(sessionId)}/inbox`,
    { headers: { authorization: opencodeAuthHeader(svc) } },
    deps,
  );
  if (!res.ok) throw new Error(`GET inbox -> ${res.status}`);
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return body.data ?? [];
}
