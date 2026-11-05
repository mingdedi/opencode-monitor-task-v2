// http 层单测：鉴权/路由/错误形状（SERVER-PLAN 阶段 B，仅 health + 阶段 D 任务端点）
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { createMonitorHttpServer, type TasksApi } from "../src/http.ts";
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

test("query string 不影响路由（D/F 阶段 ?session_id= 铺路）", async () => {
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
// 任务端点（阶段 D）：路由/鉴权/状态映射/body 防护——业务经注入 stub

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
        headers: { authorization: auth(PASSWORD) },
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
      headers: { authorization: auth(PASSWORD) },
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
      headers: { authorization: auth(PASSWORD) },
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

test("DELETE /api/tasks/:id：终态删除 → 204 无响应体（阶段 F）", async () => {
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
      headers: { authorization: auth(PASSWORD) },
      body: JSON.stringify({ max_events: 10 }),
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as PublicInfo).id, "mon_stub0001");
    const bad = await fetch(base + "/api/tasks/mon_stub0001", {
      method: "PATCH",
      headers: { authorization: auth(PASSWORD) },
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

test("未注入 tasks（阶段 B 形态）：任务路由仍 404 NO_ROUTE（向后兼容）", async () => {
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
