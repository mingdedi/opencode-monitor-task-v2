// http 层单测：鉴权/路由/错误形状
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { createMonitorHttpServer, uiSecurityHeaders, type TasksApi } from "../src/http.ts";
import type { ApiError, HealthInfo, PublicInfo } from "@omt/shared";

const PASSWORD = "test-password-123";
let base = "";
let server: ReturnType<typeof createMonitorHttpServer>;

const healthStub: HealthInfo = {
  id: "srv_test",
  version: "0.1.0",
  uptime_s: 1,
  tasks_alive: 0,
  tasks_total: 0,
  reattach: null,
  opencode_instances: [],
  log_bytes: 0,
};

before(async () => {
  server = createMonitorHttpServer({ password: PASSWORD, health: () => ({ ...healthStub, uptime_s: 2 }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  server.closeAllConnections();
});

const auth = (pw: string) => "Basic " + Buffer.from(`monitor:${pw}`).toString("base64");

async function get(p: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + p, { headers });
}

test("无 auth → 401 JSON", async () => {
  const res = await get("/api/health");
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: string }).error, "unauthorized");
});

test("错误 password → 401；畸形 Authorization 头 → 401", async () => {
  assert.equal((await get("/api/health", { authorization: auth("wrong") })).status, 401);
  assert.equal((await get("/api/health", { authorization: "Bearer xyz" })).status, 401);
  assert.equal((await get("/api/health", { authorization: "Basic %%%" })).status, 401);
  assert.equal((await get("/api/health", { authorization: "Basic " + Buffer.from("opencode:x").toString("base64") })).status, 401);
});

test("正确 auth → 200 + health 形状（HealthInfo 字段齐备）", async () => {
  const res = await get("/api/health", { authorization: auth(PASSWORD) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as HealthInfo;
  assert.equal(body.id, "srv_test");
  assert.equal(body.version, "0.1.0");
  assert.equal(body.uptime_s, 2);
  assert.deepEqual(body.reattach, null);
  assert.deepEqual(body.opencode_instances, []);
});

test("未知路径 → 404；POST /api/health → 405", async () => {
  assert.equal((await get("/api/nope", { authorization: auth(PASSWORD) })).status, 404);
  const res = await fetch(base + "/api/health", { method: "POST", headers: { authorization: auth(PASSWORD) } });
  assert.equal(res.status, 405);
});

test("query string 不影响路由（?session_id= 铺路）", async () => {
  const res = await get("/api/health?x=1", { authorization: auth(PASSWORD) });
  assert.equal(res.status, 200);
});

test("health 抛错 → 500 JSON（不裸崩连接）", async () => {
  const srv = createMonitorHttpServer({
    password: PASSWORD,
    health: () => {
      throw new Error("boom");
    },
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const u = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const res = await fetch(u + "/api/health", { headers: { authorization: auth(PASSWORD) } });
  assert.equal(res.status, 500);
  assert.equal(((await res.json()) as { error: string }).error, "internal error");
  srv.close();
  srv.closeAllConnections();
});

// ---------------------------------------------------------------------------
// 任务端点：路由/鉴权/状态映射/body 防护——业务经注入 stub

const stubInfo: PublicInfo = {
  id: "mon_stub0001",
  description: null,
  state: "running",
  session_id: "ses_stub",
  opencode_port: 1,
  directory: "/tmp",
  command: "echo stub",
  pattern: null,
  wake_mode: "all",
  delivery: "queue",
  coalesce_ms: 500,
  max_events: 50,
  idle_timeout_ms: 300000,
  idle_deadline: null,
  grace_deadline: null,
  started_at: 1,
  pid: 123,
  lines_scanned: 0,
  lines_matched: 0,
  events_sent: 0,
  events_dropped: 0,
  exit_info: null,
  log_bytes: 0,
  last_offset: 0,
  updated_at: 1,
};

async function withTaskServer(opts: Partial<TasksApi>, fn: (base: string) => Promise<void>): Promise<void> {
  const srv = createMonitorHttpServer({
    password: PASSWORD,
    health: () => ({ ...healthStub }),
    tasks: {
      create: opts.create ?? (async () => ({ status: 201, body: stubInfo })),
      list: opts.list ?? ((sid) => ({ status: 200, body: sid ? [stubInfo] : [stubInfo, stubInfo] })),
      get: opts.get ?? ((id) => (id === "mon_stub0001" ? { status: 200, body: stubInfo } : { status: 404, body: { error: "nope", code: "TASK_NOT_FOUND" } })),
      patch: opts.patch ?? (async () => ({ status: 200, body: stubInfo })),
      stop: opts.stop ?? (async () => ({ status: 200, body: stubInfo })),
      keepalive: opts.keepalive ?? (() => ({ status: 200, body: stubInfo })),
      remove: opts.remove ?? (() => ({ status: 204, body: null })),
      readLog: opts.readLog ?? (() => ({ status: 200, body: "line1\nline2" })),
    },
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  } finally {
    srv.close();
    srv.closeAllConnections();
  }
}

test("POST /api/tasks：create 出参透传（201 + body 原样）", async () => {
  await withTaskServer({}, async (base) => {
    const res = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { authorization: auth(PASSWORD), "content-type": "application/json" },
      body: JSON.stringify({ command: "echo x", opencode_port: 1, session_id: "ses_stub" }),
    });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as PublicInfo).id, "mon_stub0001");
  });
});

test("POST /api/tasks：业务拒绝状态透传（400 原样映射）", async () => {
  await withTaskServer(
    {
      create: async () => ({ status: 400, body: { error: "bad", code: "PORT_NOT_IN_REGISTRY" } }),
    },
    async (base) => {
      const res = await fetch(base + "/api/tasks", {
        method: "POST",
        headers: { authorization: auth(PASSWORD), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as ApiError).code, "PORT_NOT_IN_REGISTRY");
    },
  );
});

test("POST /api/tasks：坏 JSON → 400 INVALID_JSON；空 body 同样 400", async () => {
  await withTaskServer({}, async (base) => {
    const res = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { authorization: auth(PASSWORD), "content-type": "application/json" },
      body: "not-json{",
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as ApiError).code, "INVALID_JSON");
    const res2 = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { authorization: auth(PASSWORD) },
    });
    assert.equal(res2.status, 400);
  });
});

test("POST /api/tasks：body 超 256KB → 413", async () => {
  await withTaskServer({}, async (base) => {
    const res = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { authorization: auth(PASSWORD), "content-type": "application/json" },
      body: "x".repeat(300_000),
    });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as ApiError).code, "BODY_TOO_LARGE");
  });
});

test("GET /api/tasks：列表透传 + ?session_id= 传参", async () => {
  await withTaskServer({}, async (base) => {
    const all = await fetch(base + "/api/tasks", { headers: { authorization: auth(PASSWORD) } });
    assert.equal(all.status, 200);
    assert.equal(((await all.json()) as PublicInfo[]).length, 2);
    const one = await fetch(base + "/api/tasks?session_id=ses_stub", { headers: { authorization: auth(PASSWORD) } });
    assert.equal(((await one.json()) as PublicInfo[]).length, 1);
  });
});

test("GET /api/tasks/:id：命中 200；未知 404 透传；非法 id 形状直接 404", async () => {
  await withTaskServer({}, async (base) => {
    const ok = await fetch(base + "/api/tasks/mon_stub0001", { headers: { authorization: auth(PASSWORD) } });
    assert.equal(ok.status, 200);
    const missing = await fetch(base + "/api/tasks/mon_nope9999", { headers: { authorization: auth(PASSWORD) } });
    assert.equal(missing.status, 404);
    const malformed = await fetch(base + "/api/tasks/../../etc", { headers: { authorization: auth(PASSWORD) } });
    assert.equal(malformed.status, 404);
  });
});

test("DELETE /api/tasks/:id：终态删除 → 204 无响应体", async () => {
  await withTaskServer(
    {
      remove: (id) => (id === "mon_stub0001" ? { status: 204, body: null } : { status: 404, body: { error: "nope", code: "TASK_NOT_FOUND" } }),
    },
    async (base) => {
      const res = await fetch(base + "/api/tasks/mon_stub0001", {
        method: "DELETE",
        headers: { authorization: auth(PASSWORD) },
      });
      assert.equal(res.status, 204);
      assert.equal(res.body, null); // 204 恒无 body
      const missing = await fetch(base + "/api/tasks/mon_nope9999", {
        method: "DELETE",
        headers: { authorization: auth(PASSWORD) },
      });
      assert.equal(missing.status, 404);
    },
  );
});

test("POST /api/tasks/:id/stop 与 /keepalive：出参透传（200/业务状态）", async () => {
  await withTaskServer(
    {
      stop: async (id) => (id === "mon_stub0001" ? { status: 200, body: stubInfo } : { status: 404, body: { error: "nope", code: "TASK_NOT_FOUND" } }),
      keepalive: (id) => (id === "mon_stub0001" ? { status: 409, body: { error: "terminal", code: "TASK_TERMINAL" } } : { status: 404, body: { error: "nope", code: "TASK_NOT_FOUND" } }),
    },
    async (base) => {
      const stop = await fetch(base + "/api/tasks/mon_stub0001/stop", { method: "POST", headers: { authorization: auth(PASSWORD) } });
      assert.equal(stop.status, 200);
      assert.equal(((await stop.json()) as PublicInfo).id, "mon_stub0001");
      const ka = await fetch(base + "/api/tasks/mon_stub0001/keepalive", { method: "POST", headers: { authorization: auth(PASSWORD) } });
      assert.equal(ka.status, 409);
      assert.equal(((await ka.json()) as ApiError).code, "TASK_TERMINAL");
    },
  );
});

test("PATCH /api/tasks/:id：body JSON 解析 + 出参透传；坏 JSON → 400", async () => {
  await withTaskServer({}, async (base) => {
    const ok = await fetch(base + "/api/tasks/mon_stub0001", {
      method: "PATCH",
      headers: { authorization: auth(PASSWORD), "content-type": "application/json" },
      body: JSON.stringify({ max_events: 10 }),
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as PublicInfo).id, "mon_stub0001");
    const bad = await fetch(base + "/api/tasks/mon_stub0001", {
      method: "PATCH",
      headers: { authorization: auth(PASSWORD), "content-type": "application/json" },
      body: "not-json{",
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as ApiError).code, "INVALID_JSON");
  });
});

test("GET /api/tasks/:id/log：tail 参数透传；裸文本 JSON 响应；405 语义", async () => {
  await withTaskServer(
    {
      readLog: (id, tail) => (id === "mon_stub0001" ? { status: 200, body: `tail=${tail ?? "unset"}` } : { status: 404, body: { error: "nope", code: "TASK_NOT_FOUND" } }),
    },
    async (base) => {
      const def = await fetch(base + "/api/tasks/mon_stub0001/log", { headers: { authorization: auth(PASSWORD) } });
      assert.equal(def.status, 200);
      assert.equal((await def.json()), "tail=unset");
      const five = await fetch(base + "/api/tasks/mon_stub0001/log?tail=5", { headers: { authorization: auth(PASSWORD) } });
      assert.equal(await five.json(), "tail=5");
      // 子路径方法约束：stop 端点不吃 GET
      const wrongMethod = await fetch(base + "/api/tasks/mon_stub0001/stop", { headers: { authorization: auth(PASSWORD) } });
      assert.equal(wrongMethod.status, 405);
      // PUT 到任务详情：不支持的方法
      const put = await fetch(base + "/api/tasks/mon_stub0001", {
        method: "PUT",
        headers: { authorization: auth(PASSWORD) },
      });
      assert.equal(put.status, 405);
    },
  );
});

test("未注入 tasks：任务路由仍 404 NO_ROUTE（向后兼容）", async () => {
  const srv = createMonitorHttpServer({ password: PASSWORD, health: () => ({ ...healthStub }) });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/tasks`, {
    headers: { authorization: auth(PASSWORD) },
  });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as ApiError).code, "NO_ROUTE");
  srv.close();
  srv.closeAllConnections();
});

// ---------------------------------------------------------------------------
// POST /api/shutdown

test("shutdown：空 body 默认不杀任务；kill_tasks 透传；坏参数 400；GET 405", async () => {
  const calls: boolean[] = [];
  const srv = createMonitorHttpServer({
    password: PASSWORD,
    health: () => ({ ...healthStub }),
    shutdown: async (killTasks) => {
      calls.push(killTasks);
      return { killed: killTasks ? 3 : 0 };
    },
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const h = { authorization: auth(PASSWORD), "content-type": "application/json" };

  // 空 body（无 content-length 的 POST）：kill_tasks 默认 false
  const r1 = await fetch(b + "/api/shutdown", { method: "POST", headers: h });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true, killed: 0 });

  // 显式 JSON body
  const r2 = await fetch(b + "/api/shutdown", { method: "POST", headers: h, body: JSON.stringify({ kill_tasks: true }) });
  assert.deepEqual(await r2.json(), { ok: true, killed: 3 });

  // kill_tasks 非 boolean → 400
  const r3 = await fetch(b + "/api/shutdown", { method: "POST", headers: h, body: JSON.stringify({ kill_tasks: "yes" }) });
  assert.equal(r3.status, 400);
  assert.equal(((await r3.json()) as ApiError).code, "INVALID_INPUT");

  // 坏 JSON → 400
  const r4 = await fetch(b + "/api/shutdown", { method: "POST", headers: h, body: "{oops" });
  assert.equal(r4.status, 400);
  assert.equal(((await r4.json()) as ApiError).code, "INVALID_JSON");

  // 非 object body（数组）→ 400
  const r5 = await fetch(b + "/api/shutdown", { method: "POST", headers: h, body: "[]" });
  assert.equal(r5.status, 400);

  // GET → 405
  const r6 = await fetch(b + "/api/shutdown", { headers: h });
  assert.equal(r6.status, 405);

  assert.deepEqual(calls, [false, true]); // 只有两次合法调用到达
  srv.close();
  srv.closeAllConnections();
});

test("shutdown 未注入 → 404 NO_ROUTE（向后兼容）", async () => {
  const srv = createMonitorHttpServer({ password: PASSWORD, health: () => ({ ...healthStub }) });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/shutdown`, {
    method: "POST",
    headers: { authorization: auth(PASSWORD) },
  });
  assert.equal(res.status, 404);
  srv.close();
  srv.closeAllConnections();
});

// ---------------------------------------------------------------------------
// 看板（GET /）与鉴权扩展：WWW-Authenticate + altPasswords（opencode 密码复用）

test("401 恒带 WWW-Authenticate（浏览器原生登录框触发器）", async () => {
  const res = await get("/api/health");
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Basic realm="opencode-monitor-task"$/);
});

test("altPasswords：任一候选命中即放行；现读轮换即时生效；错误密码仍拒", async () => {
  let current = "oc-password-v1";
  const srv = createMonitorHttpServer({
    password: PASSWORD,
    altPasswords: () => [current],
    health: () => ({ ...healthStub }),
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  // opencode 密码与 daemon 自身密码并列有效
  assert.equal((await fetch(b + "/api/health", { headers: { authorization: auth("oc-password-v1") } })).status, 200);
  assert.equal((await fetch(b + "/api/health", { headers: { authorization: auth(PASSWORD) } })).status, 200);
  assert.equal((await fetch(b + "/api/health", { headers: { authorization: auth("wrong") } })).status, 401);

  // 现读语义：provider 返回值变化（opencode 重启轮换）后下一请求即生效，旧值失效
  current = "oc-password-v2";
  assert.equal((await fetch(b + "/api/health", { headers: { authorization: auth("oc-password-v2") } })).status, 200);
  assert.equal((await fetch(b + "/api/health", { headers: { authorization: auth("oc-password-v1") } })).status, 401);

  srv.close();
  srv.closeAllConnections();
});

const UI_STUB = "<!doctype html><html><head><title>omt-ui</title></head><body>dashboard</body></html>";

test("GET /：ui 注入 → 200 text/html + 安全头；HEAD 无 body；POST 405", async () => {
  const srv = createMonitorHttpServer({ password: PASSWORD, health: () => ({ ...healthStub }), ui: UI_STUB });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const h = { authorization: auth(PASSWORD) };

  const res = await fetch(b + "/", { headers: h });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(await res.text(), UI_STUB);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(res.headers.get("content-security-policy") ?? "", /connect-src 'self'/);

  const head = await fetch(b + "/", { method: "HEAD", headers: h });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const post = await fetch(b + "/", { method: "POST", headers: h });
  assert.equal(post.status, 405);

  // 看板与 API 同鉴权：无 auth / 错密码 → 401 + WWW-Authenticate
  const noAuth = await fetch(b + "/");
  assert.equal(noAuth.status, 401);
  assert.ok(noAuth.headers.get("www-authenticate"));

  srv.close();
  srv.closeAllConnections();
});

test("GET /：altPasswords 对看板同样生效（opencode 密码登录页面）", async () => {
  const srv = createMonitorHttpServer({
    password: PASSWORD,
    altPasswords: () => ["oc-pw"],
    health: () => ({ ...healthStub }),
    ui: UI_STUB,
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  assert.equal((await fetch(b + "/", { headers: { authorization: auth("oc-pw") } })).status, 200);
  srv.close();
  srv.closeAllConnections();
});

test("GET /：ui 未注入 → 404 NO_ROUTE（向后兼容）", async () => {
  const res = await get("/", { authorization: auth(PASSWORD) });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as ApiError).code, "NO_ROUTE");
});

// ---------------------------------------------------------------------------
// CSRF 围栏（安全审查 F1）：Basic auth 凭证 ambient——浏览器缓存后跨站自动携带，
// 表单可构造合法 JSON body。围栏：POST/PATCH 带 Content-Type 必须 application/json；
// Sec-Fetch-Site: cross-site 的状态变更方法一律 403。

test("CSRF：POST/PATCH 携带 form 系 Content-Type → 415（含空 body 表单）", async () => {
  await withTaskServer({}, async (base) => {
    const h = { authorization: auth(PASSWORD) };
    // text/plain + 表单可构造的 JSON（name/value 拼接，= 落在字符串值内）
    const r1 = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { ...h, "content-type": "text/plain" },
      body: '{"command":"echo csrf","opencode_port":1,"session_id":"ses_x","x":"="}',
    });
    assert.equal(r1.status, 415);
    assert.equal(((await r1.json()) as ApiError).code, "UNSUPPORTED_MEDIA_TYPE");
    // 空 body 的表单 POST 也带 form 系类型——同样拒（shutdown 空 body 语义不被绕过）
    const r2 = await fetch(base + "/api/tasks/mon_stub0001/stop", {
      method: "POST",
      headers: { ...h, "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(r2.status, 415);
    const r3 = await fetch(base + "/api/tasks/mon_stub0001", {
      method: "PATCH",
      headers: { ...h, "content-type": "multipart/form-data; boundary=x" },
      body: "x",
    });
    assert.equal(r3.status, 415);
    // application/json 带参数放行；无 Content-Type 头放行（curl -X POST 兼容）
    const r4 = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { ...h, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ command: "echo x", opencode_port: 1, session_id: "ses_stub" }),
    });
    assert.equal(r4.status, 201);
    const r5 = await fetch(base + "/api/tasks/mon_stub0001/stop", { method: "POST", headers: h });
    assert.equal(r5.status, 200);
  });
});

test("CSRF：shutdown 表单系类型拒绝（空 body/构造 body 皆 415），业务零调用", async () => {
  const calls: boolean[] = [];
  const srv = createMonitorHttpServer({
    password: PASSWORD,
    health: () => ({ ...healthStub }),
    shutdown: async (killTasks) => {
      calls.push(killTasks);
      return { killed: 0 };
    },
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const h = { authorization: auth(PASSWORD) };
  const r1 = await fetch(b + "/api/shutdown", {
    method: "POST",
    headers: { ...h, "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(r1.status, 415);
  const r2 = await fetch(b + "/api/shutdown", {
    method: "POST",
    headers: { ...h, "content-type": "text/plain" },
    body: '{"kill_tasks":true,"x":"="}',
  });
  assert.equal(r2.status, 415);
  assert.deepEqual(calls, []);
  srv.close();
  srv.closeAllConnections();
});

test("CSRF：Sec-Fetch-Site cross-site 状态变更 → 403；same-origin/无头放行；GET 不受限", async () => {
  await withTaskServer({}, async (base) => {
    const h = { authorization: auth(PASSWORD) };
    const xs = { ...h, "sec-fetch-site": "cross-site", "content-type": "application/json" };
    assert.equal((await fetch(base + "/api/tasks", { method: "POST", headers: xs, body: "{}" })).status, 403);
    assert.equal((await fetch(base + "/api/tasks/mon_stub0001", { method: "PATCH", headers: xs, body: "{}" })).status, 403);
    assert.equal((await fetch(base + "/api/tasks/mon_stub0001", { method: "DELETE", headers: xs })).status, 403);
    assert.equal((await fetch(base + "/api/tasks/mon_stub0001/stop", { method: "POST", headers: xs })).status, 403);
    // GET 只读不受限（跨源读本已被 CORS 拦）
    assert.equal((await fetch(base + "/api/tasks", { headers: xs })).status, 200);
    // same-origin（看板自身）与无头（非浏览器客户端）放行
    assert.equal((await fetch(base + "/api/tasks/mon_stub0001/stop", { method: "POST", headers: { ...h, "sec-fetch-site": "same-origin" } })).status, 200);
    assert.equal((await fetch(base + "/api/tasks/mon_stub0001/stop", { method: "POST", headers: h })).status, 200);
  });
});

test("nosniff：JSON 响应（200/401/404/204）恒带 x-content-type-options", async () => {
  assert.equal((await get("/api/health")).headers.get("x-content-type-options"), "nosniff"); // 401
  assert.equal((await get("/api/health", { authorization: auth(PASSWORD) })).headers.get("x-content-type-options"), "nosniff");
  assert.equal((await get("/api/nope", { authorization: auth(PASSWORD) })).headers.get("x-content-type-options"), "nosniff");
  await withTaskServer({}, async (base) => {
    const del = await fetch(base + "/api/tasks/mon_stub0001", { method: "DELETE", headers: { authorization: auth(PASSWORD) } });
    assert.equal(del.headers.get("x-content-type-options"), "nosniff"); // 204
  });
});

test("altPasswords 懒读：无 Authorization/daemon 密码命中 → 零调用；Basic 未命中才现读", async () => {
  let reads = 0;
  const srv = createMonitorHttpServer({
    password: PASSWORD,
    altPasswords: () => {
      reads++;
      return ["oc-pw"];
    },
    health: () => ({ ...healthStub }),
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  assert.equal((await fetch(b + "/api/health")).status, 401); // 无头
  assert.equal(reads, 0);
  assert.equal((await fetch(b + "/api/health", { headers: { authorization: "Bearer xyz" } })).status, 401); // 非 Basic
  assert.equal(reads, 0);
  assert.equal((await fetch(b + "/api/health", { headers: { authorization: auth(PASSWORD) } })).status, 200); // daemon 命中短路
  assert.equal(reads, 0);
  assert.equal((await fetch(b + "/api/health", { headers: { authorization: auth("wrong") } })).status, 401); // Basic 未命中 → 现读
  assert.equal(reads, 1);
  assert.equal((await fetch(b + "/api/health", { headers: { authorization: auth("oc-pw") } })).status, 200); // alt 命中
  assert.equal(reads, 2);
  srv.close();
  srv.closeAllConnections();
});

test("hash CSP：script-src 为脚本块 sha256（非 unsafe-inline）；无脚本 → 'none'", () => {
  const script = '\nconsole.log("hi");\n';
  const ui = `<!doctype html><html><body><script>${script}</script></body></html>`;
  const h = uiSecurityHeaders(ui);
  const hash = createHash("sha256").update(script, "utf8").digest("base64");
  assert.ok(h["content-security-policy"]!.includes(`script-src 'sha256-${hash}'`));
  assert.ok(!h["content-security-policy"]!.includes("script-src 'unsafe-inline'"));
  // 其余安全头不变
  assert.ok(h["content-security-policy"]!.includes("default-src 'none'"));
  assert.ok(h["content-security-policy"]!.includes("connect-src 'self'"));
  assert.equal(h["cache-control"], "no-store");
  assert.equal(h["x-content-type-options"], "nosniff");
  // 无脚本块 → script-src 'none'
  assert.ok(uiSecurityHeaders("<!doctype html><html><body>x</body></html>")["content-security-policy"]!.includes("script-src 'none'"));
});
