// HTTP 层：node:http 自建路由/鉴权/JSON，无框架依赖。
// 端点：POST /api/tasks（创建）、GET /api/tasks（列表，?session_id= 过滤）、
//       GET /api/tasks/:id（详情）——业务经 tasks 注入，本层只做路由/鉴权/JSON/状态映射。
//       PATCH /api/tasks/:id（max_events）、POST :id/stop、POST :id/keepalive、
//       DELETE /api/tasks/:id（204）、GET :id/log?tail=N、
//       POST /api/shutdown（可选 kill_tasks，默认 false——任务进程照常存活）。
// 鉴权：Basic auth username 固定 "monitor"，未授权一律 401 JSON。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { LIMITS, type ApiError, type HealthInfo, type PublicInfo } from "@omt/shared";

/** 任务端点统一出参：status + body（http 层不做业务判断；204 时 body 为 null——
 *  DELETE 成功无响应体） */
export interface TaskEndpointOutcome {
  status: number;
  body: PublicInfo | ApiError | PublicInfo[] | string | null;
}

export interface TasksApi {
  create: (body: unknown) => Promise<TaskEndpointOutcome>;
  list: (sessionId: string | undefined) => TaskEndpointOutcome;
  get: (id: string) => TaskEndpointOutcome;
  patch: (id: string, body: unknown) => Promise<TaskEndpointOutcome>;
  stop: (id: string) => Promise<TaskEndpointOutcome>;
  keepalive: (id: string) => TaskEndpointOutcome;
  remove: (id: string) => TaskEndpointOutcome;
  readLog: (id: string, tail: string | undefined) => TaskEndpointOutcome;
}

export interface MonitorHttpOptions {
  password: string;
  /** health 数据源（main.ts 注入，含 uptime/实例表等运行时状态） */
  health: () => HealthInfo | Promise<HealthInfo>;
  /** 任务端点main.ts 注入；缺省时任务路由 404——http.test 独立测试用） */
  tasks?: TasksApi;
  /** 关停端点：kill_tasks=true 时先击杀全部活任务进程组再退出。
   *  返回被杀数；缺省时 /api/shutdown 404（http.test 独立测试用） */
  shutdown?: (killTasks: boolean) => Promise<{ killed: number }>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    // 204 无响应体（DELETE 成功；RFC 语义——带 body 的 204 会被部分客户端截断报错）
    res.writeHead(204).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function authOk(expected: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const got = Buffer.from(header.slice(6), "base64"); // 坏 base64 容错解码 → 长度不等即拒
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/** 读请求体（上限 LIMITS.httpBodyMaxBytes；超限 false） */
async function readBody(req: IncomingMessage): Promise<{ ok: true; data: Buffer } | { ok: false }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > LIMITS.httpBodyMaxBytes) return { ok: false };
    chunks.push(b);
  }
  return { ok: true, data: Buffer.concat(chunks) };
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: MonitorHttpOptions): Promise<void> {
  if (!authOk(Buffer.from(`monitor:${opts.password}`), req.headers.authorization)) {
    send(res, 401, { error: "unauthorized", code: "UNAUTHORIZED" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/health") {
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed", code: "METHOD" });
      return;
    }
    send(res, 200, await opts.health());
    return;
  }
  if (url.pathname === "/api/shutdown" && opts.shutdown) {
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed", code: "METHOD" });
      return;
    }
    // body 可空；非空须为 JSON 对象 { kill_tasks?: boolean }（其余字段忽略——防呆不严打）。
    // 无条件读 body：chunked 编码无 content-length，空 body 读出 0 字节自然跳过解析
    let killTasks = false;
    const body = await readBody(req);
    if (!body.ok) {
      send(res, 413, { error: "request body too large", code: "BODY_TOO_LARGE" });
      return;
    }
    const raw = body.data.toString("utf8");
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        send(res, 400, { error: "request body is not valid JSON", code: "INVALID_JSON" });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        send(res, 400, { error: "body must be a JSON object", code: "INVALID_INPUT" });
        return;
      }
      const kt = (parsed as Record<string, unknown>)["kill_tasks"];
      if (kt !== undefined && typeof kt !== "boolean") {
        send(res, 400, { error: "kill_tasks must be a boolean", code: "INVALID_INPUT" });
        return;
      }
      killTasks = kt === true;
    }
    const r = await opts.shutdown(killTasks);
    send(res, 200, { ok: true, killed: r.killed });
    return;
  }
  if (url.pathname === "/api/tasks" && opts.tasks) {
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body.ok) {
        send(res, 413, { error: "request body too large", code: "BODY_TOO_LARGE" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.data.toString("utf8"));
      } catch {
        send(res, 400, { error: "request body is not valid JSON", code: "INVALID_JSON" });
        return;
      }
      const r = await opts.tasks.create(parsed);
      send(res, r.status, r.body);
      return;
    }
    if (req.method === "GET") {
      const r = opts.tasks.list(url.searchParams.get("session_id") ?? undefined);
      send(res, r.status, r.body);
      return;
    }
    send(res, 405, { error: "method not allowed", code: "METHOD" });
    return;
  }
  const m = /^\/api\/tasks\/(mon_[a-z0-9]+)$/.exec(url.pathname);
  if (m && opts.tasks) {
    const id = m[1]!;
    if (req.method === "GET") {
      const r = opts.tasks.get(id);
      send(res, r.status, r.body);
      return;
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (!body.ok) {
        send(res, 413, { error: "request body too large", code: "BODY_TOO_LARGE" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.data.toString("utf8"));
      } catch {
        send(res, 400, { error: "request body is not valid JSON", code: "INVALID_JSON" });
        return;
      }
      const r = await opts.tasks.patch(id, parsed);
      send(res, r.status, r.body);
      return;
    }
    if (req.method === "DELETE") {
      const r = await opts.tasks.remove(id);
      send(res, r.status, r.body);
      return;
    }
    send(res, 405, { error: "method not allowed", code: "METHOD" });
    return;
  }
  const sub = /^\/api\/tasks\/(mon_[a-z0-9]+)\/(stop|keepalive|log)$/.exec(url.pathname);
  if (sub && opts.tasks) {
    const id = sub[1]!;
    const action = sub[2]!;
    if (action === "stop") {
      if (req.method !== "POST") {
        send(res, 405, { error: "method not allowed", code: "METHOD" });
        return;
      }
      const r = await opts.tasks.stop(id);
      send(res, r.status, r.body);
      return;
    }
    if (action === "keepalive") {
      if (req.method !== "POST") {
        send(res, 405, { error: "method not allowed", code: "METHOD" });
        return;
      }
      const r = opts.tasks.keepalive(id);
      send(res, r.status, r.body);
      return;
    }
    // log
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed", code: "METHOD" });
      return;
    }
    const r = opts.tasks.readLog(id, url.searchParams.get("tail") ?? undefined);
    send(res, r.status, r.body);
    return;
  }
  send(res, 404, { error: `no route: ${req.method ?? "?"} ${url.pathname}`, code: "NO_ROUTE" });
}

export function createMonitorHttpServer(opts: MonitorHttpOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, opts).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: "internal error", detail: String(err) });
      else res.end();
    });
  });
}
