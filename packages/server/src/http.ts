// HTTP 层（PLAN §2.2 / §6.1）：node:http 自建路由/鉴权/JSON，无框架依赖。
// 阶段 D：+ POST /api/tasks（创建）、GET /api/tasks（列表，?session_id= 过滤）、
//         GET /api/tasks/:id（详情）——业务经 tasks 注入，本层只做路由/鉴权/JSON/状态映射。
// 阶段 F：+ PATCH/stop/keepalive/DELETE/log；阶段 G：+ /api/shutdown。
// 鉴权：Basic auth username 固定 "monitor"（PLAN §2.2），未授权一律 401 JSON。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { LIMITS, type ApiError, type HealthInfo, type PublicInfo } from "@omt/shared";

/** 任务端点统一出参：status + body（http 层不做业务判断） */
export interface TaskEndpointOutcome {
  status: number;
  body: PublicInfo | ApiError | PublicInfo[];
}

export interface TasksApi {
  create: (body: unknown) => Promise<TaskEndpointOutcome>;
  list: (sessionId: string | undefined) => TaskEndpointOutcome;
  get: (id: string) => TaskEndpointOutcome;
}

export interface MonitorHttpOptions {
  password: string;
  /** health 数据源（main.ts 注入，含 uptime/实例表等运行时状态） */
  health: () => HealthInfo | Promise<HealthInfo>;
  /** 任务端点（阶段 D 起 main.ts 注入；缺省时任务路由 404——http.test 独立测试用） */
  tasks?: TasksApi;
}

function send(res: ServerResponse, status: number, body: unknown): void {
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
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed", code: "METHOD" });
      return;
    }
    const r = opts.tasks.get(m[1]!);
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
