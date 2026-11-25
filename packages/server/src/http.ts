// HTTP 层：node:http 自建路由/鉴权/JSON，无框架依赖。
// 端点：GET /（自托管看板，ui 注入时；与 API 同端口同鉴权）、
//       POST /api/tasks（创建）、GET /api/tasks（列表，?session_id= 过滤）、
//       GET /api/tasks/:id（详情）——业务经 tasks 注入，本层只做路由/鉴权/JSON/状态映射。
//       PATCH /api/tasks/:id（max_events）、POST :id/stop、POST :id/keepalive、
//       DELETE /api/tasks/:id（204）、GET :id/log?tail=N、
//       POST /api/shutdown（可选 kill_tasks，默认 false——任务进程照常存活）。
// 鉴权：Basic auth username 固定 "monitor"，未授权一律 401 JSON + WWW-Authenticate
//       （浏览器原生登录框）。password 候选 = daemon 自身密码 + altPasswords() 现读值
//       （注册 opencode 实例的当前密码——浏览器登录可复用 `opencode service get password`，
//       opencode 重启轮换后下一请求即生效；插件发现通道仍用 daemon service.json 密码，不受影响）。
//       altPasswords 懒读：仅当 Basic 头存在且 daemon 密码未命中时才读文件——
//       未鉴权请求零文件 I/O（放大围栏）。
// CSRF 围栏：Basic auth 凭证是 ambient 的（浏览器缓存后跨站请求也自动携带，无
//       SameSite 约束；Chrome LNA 不拦顶层表单导航）——因此：
//       ① POST/PATCH 携带 Content-Type 时必须 application/json，否则 415
//          （表单 CSRF 只能发 form 系类型，空表单也带——全灭；第一方客户端均发
//          JSON 头或省略头，零破坏）；
//       ② Sec-Fetch-Site: cross-site 的状态变更方法（POST/PATCH/DELETE）一律 403
//          （现代浏览器恒发该头；纵深）。
// 响应头：JSON 与看板一律 nosniff；看板 CSP 的 script-src 用内联脚本 sha256 hash
//       （资产静态，createServer 时一次计算）——CSP 是 esc() 之外的第二道闸。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
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
  /** 附加有效密码（懒读：仅 Basic 头存在且 daemon 密码未命中时调用；main.ts 注入
   *  注册 opencode 实例的 service.json 密码现读）。与 daemon 自身密码并列任一命中
   *  即放行——"一把密钥"体验：浏览器登录用 `opencode service get password` 即可。
   *  注意：命中即 API 全权（含创建任务执行命令）——main.ts 可以 --no-alt-passwords
   *  关闭等价。缺省空集（http.test 独立测试用） */
  altPasswords?: () => string[];
  /** health 数据源（main.ts 注入，含 uptime/实例表等运行时状态） */
  health: () => HealthInfo | Promise<HealthInfo>;
  /** 任务端点main.ts 注入；缺省时任务路由 404——http.test 独立测试用） */
  tasks?: TasksApi;
  /** 关停端点：kill_tasks=true 时先击杀全部活任务进程组再退出。
   *  返回被杀数；缺省时 /api/shutdown 404（http.test 独立测试用） */
  shutdown?: (killTasks: boolean) => Promise<{ killed: number }>;
  /** 自托管看板 HTML（单文件资产，esbuild 内嵌 bundle）；缺省时 GET / → 404
   *  （http.test 独立测试用）。与 API 同端口同鉴权——浏览器开 daemon url 即用 */
  ui?: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    // 204 无响应体（DELETE 成功；RFC 语义——带 body 的 204 会被部分客户端截断报错）
    res.writeHead(204, { "x-content-type-options": "nosniff" }).end();
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function authOk(expected: Buffer[], header: string | undefined): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const got = Buffer.from(header.slice(6), "base64"); // 坏 base64 容错解码 → 长度不等即拒
  // 全候选遍历不提前返回：命中与否耗时同形（timingSafeEqual 逐候选）
  let ok = false;
  for (const exp of expected) {
    if (got.length === exp.length && timingSafeEqual(got, exp)) ok = true;
  }
  return ok;
}

/** 看板响应头：仅同源 API 连接；no-store（鉴权内容不缓存）。
 *  script-src 用内联脚本块的 sha256 hash 而非 'unsafe-inline'——资产是静态单文件，
 *  hash 让 CSP 成为 esc() 之外的第二道 XSS 闸（注入的脚本不在 hash 白名单内）。
 *  无脚本块 → script-src 'none'。样式保留内联白名单（style 属性逐个 hash 不现实，
 *  且 default-src 'none' 已断外部加载）。内联事件处理器（onclick 等）不被 hash
 *  覆盖——ui.html 门禁禁止 markup 出现 on* 属性，事件一律 addEventListener。
 *  导出供 test/ui-asset.test.ts 对真实资产做 hash 漂移门禁。 */
export function uiSecurityHeaders(ui: string): Record<string, string> {
  const hashes = [...ui.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash("sha256").update(m[1]!, "utf8").digest("base64")}'`,
  );
  const scriptSrc = hashes.length > 0 ? hashes.join(" ") : "'none'";
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; frame-ancestors 'self'; base-uri 'none'`,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
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

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MonitorHttpOptions,
  uiHeaders: Record<string, string> | null,
): Promise<void> {
  // daemon 自身密码先行；仅当 Basic 头存在且未命中时懒读 altPasswords——
  // 未鉴权/无头请求零文件 I/O；轮换即时生效语义不变（命中路径每请求现读）
  const header = req.headers.authorization;
  let ok = authOk([Buffer.from(`monitor:${opts.password}`)], header);
  if (!ok && header?.startsWith("Basic ")) {
    const alts = opts.altPasswords?.() ?? [];
    if (alts.length > 0) ok = authOk(alts.map((pw) => Buffer.from(`monitor:${pw}`)), header);
  }
  if (!ok) {
    // WWW-Authenticate：浏览器据此弹原生登录框（username monitor；密码 = daemon 密码
    // 或任一注册 opencode 实例的当前密码）；非浏览器客户端忽略该头，行为不变
    res.setHeader("WWW-Authenticate", 'Basic realm="opencode-monitor-task"');
    send(res, 401, { error: "unauthorized", code: "UNAUTHORIZED" });
    return;
  }
  // CSRF 围栏（Basic auth 凭证 ambient——跨站自动携带）：
  // ① POST/PATCH 携带 Content-Type 必须 application/json（参数如 charset 容忍）。
  //    表单只能发 form 系类型（空表单也带 application/x-www-form-urlencoded）→ 全拒；
  //    无头请求（curl -X POST / fetch 无 body）放行——第一方客户端均发 JSON 头或省略
  const method = req.method ?? "GET";
  if (method === "POST" || method === "PATCH") {
    const ct = req.headers["content-type"];
    if (ct !== undefined && ct.split(";")[0]!.trim().toLowerCase() !== "application/json") {
      send(res, 415, { error: "content-type must be application/json", code: "UNSUPPORTED_MEDIA_TYPE" });
      return;
    }
  }
  // ② 浏览器 Sec-Fetch-Site 纵深：跨站状态变更一律拒（GET 只读不受限，跨源读本已被 CORS 拦）
  if ((method === "POST" || method === "PATCH" || method === "DELETE") && req.headers["sec-fetch-site"] === "cross-site") {
    send(res, 403, { error: "cross-site state-changing request rejected", code: "CROSS_SITE_REJECTED" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/" && uiHeaders !== null) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "method not allowed", code: "METHOD" });
      return;
    }
    res.writeHead(200, uiHeaders);
    res.end(req.method === "HEAD" ? undefined : opts.ui);
    return;
  }
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
  // hash CSP 一次计算（资产静态）——每请求零加密开销
  const uiHeaders = opts.ui !== undefined ? uiSecurityHeaders(opts.ui) : null;
  return createServer((req, res) => {
    void handle(req, res, opts, uiHeaders).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: "internal error", detail: String(err) });
      else res.end();
    });
  });
}
