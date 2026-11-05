// http 层单测：鉴权/路由/错误形状（SERVER-PLAN 阶段 B，仅 health）
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { createMonitorHttpServer } from "../src/http.ts";
import type { HealthInfo } from "@omt/shared";

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
