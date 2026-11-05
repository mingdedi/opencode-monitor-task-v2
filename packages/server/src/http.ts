// HTTP 层（PLAN §2.2 / §6.1）：node:http 自建路由/鉴权/JSON，无框架依赖。
// 阶段 B 仅 GET /api/health；任务端点（POST /api/tasks 等）D/F 阶段在此扩展。
// 鉴权：Basic auth username 固定 "monitor"（PLAN §2.2），未授权一律 401 JSON。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ApiError, HealthInfo } from "@omt/shared";

export interface MonitorHttpOptions {
  password: string;
  /** health 数据源（main.ts 注入，含 uptime/实例表等运行时状态） */
  health: () => HealthInfo | Promise<HealthInfo>;
}

function send(res: ServerResponse, status: number, body: ApiError | HealthInfo): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function authOk(expected: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const got = Buffer.from(header.slice(6), "base64"); // 坏 base64 容错解码 → 长度不等即拒
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
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
