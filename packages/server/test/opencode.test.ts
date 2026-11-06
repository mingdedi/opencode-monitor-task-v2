// opencode 封装层单测：fetch 全注入，无网络无真实 opencode
// 覆盖：注册表白名单拒绝、凭证现读（零缓存）、verifyInstance/verifySession、
//       synthetic payload 逐字段（delivery 显式）与失败分类（CONTRACT.md 实测判据）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { test, before, after } from "node:test";
import type { OpencodeService, PathEnv } from "@omt/shared";
import {
  buildRegistry,
  listInbox,
  parseOpencodeStateArgs,
  probeInstances,
  resolveTarget,
  sendSynthetic,
  verifyInstance,
  verifySessionAlive,
} from "../src/opencode.ts";

let root: string;
let env: PathEnv;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "omt-oc-"));
  env = { XDG_STATE_HOME: `${root}/state`, XDG_DATA_HOME: `${root}/data` };
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mock fetch：统一处理手写（url+init）与 SDK（Request 实例）两种调用形状

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface Route {
  test: (c: Call) => boolean;
  respond: () => Response | Promise<Response>;
}

function mockFetch(routes: Route[]): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    let body: unknown;
    if (!["GET", "HEAD"].includes(req.method)) {
      const text = await req.clone().text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const c: Call = { url: req.url, method: req.method, headers: Object.fromEntries(req.headers.entries()), body };
    calls.push(c);
    for (const r of routes) {
      if (r.test(c)) return await r.respond();
    }
    return new Response(JSON.stringify({ error: "no mock route" }), { status: 599 });
  };
  return { calls, fetch: fn as unknown as typeof fetch };
}

const json = (status: number, body: unknown): (() => Response) => () => new Response(JSON.stringify(body), { status });

// service.json fixture（凭证现读的写入点）

function writeService(url: string, password: string, pid = 4321): string {
  const dir = path.join(root, "svcs");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `service-${password}.json`);
  writeFileSync(p, JSON.stringify({ url, pid, password }));
  return p;
}

const svc = (url: string, password: string, pid = 4321): OpencodeService => ({ url, pid, password });

// ---------------------------------------------------------------------------
// 注册表参数解析

test("parseOpencodeStateArgs：多条目/缺值忽略/与其他参数共存", () => {
  assert.deepEqual(parseOpencodeStateArgs(["--opencode-state", "/a"]), ["/a"]);
  assert.deepEqual(
    parseOpencodeStateArgs(["--opencode-state", "/a", "--shutdown-all", "--opencode-state", "/b"]),
    ["/a", "/b"],
  );
  assert.deepEqual(parseOpencodeStateArgs(["--opencode-state"]), []);
  assert.deepEqual(parseOpencodeStateArgs(["--shutdown-all"]), []);
  // 下一 token 是 flag（漏写路径的误用）：不把 flag 当值吞掉（review 修复回归）
  assert.deepEqual(parseOpencodeStateArgs(["--opencode-state", "--shutdown-all"]), []);
});

test("buildRegistry：默认共享服务条目 + extra 去重", () => {
  const reg = buildRegistry(env, ["/extra/a", "/extra/a"]);
  assert.deepEqual(reg.servicePaths, [reg.servicePaths[0]!, "/extra/a"]); // 默认 + 折叠后的 extra
  const reg2 = buildRegistry(env, [reg.servicePaths[0]!]); // extra 与默认同路径 → 单条
  assert.deepEqual(reg2.servicePaths, [reg.servicePaths[0]!]);
});

// ---------------------------------------------------------------------------
// verifyInstance（GET /api/info 手写封装）

test("verifyInstance：200 带 version → ok；401/500/网络异常 → 不 ok", async () => {
  const ok = mockFetch([{ test: (c) => c.url.endsWith("/api/info"), respond: json(200, { version: "2.2.5" }) }]);
  assert.deepEqual(await verifyInstance(svc("http://127.0.0.1:1", "pw"), { fetchImpl: ok.fetch }), {
    ok: true,
    version: "2.2.5",
  });
  assert.equal(ok.calls[0]!.headers["authorization"], "Basic " + Buffer.from("opencode:pw").toString("base64"));

  const unauthorized = mockFetch([{ test: (c) => c.url.endsWith("/api/info"), respond: json(401, {}) }]);
  const r401 = await verifyInstance(svc("http://127.0.0.1:1", "pw"), { fetchImpl: unauthorized.fetch });
  assert.equal(r401.ok, false);
  assert.equal(r401.version, null);

  const broken = mockFetch([
    { test: (c) => c.url.endsWith("/api/info"), respond: () => Promise.reject(new Error("ECONNREFUSED")) },
  ]);
  const rNet = await verifyInstance(svc("http://127.0.0.1:1", "pw"), { fetchImpl: broken.fetch });
  assert.equal(rNet.ok, false);
  assert.ok(rNet.detail?.includes("ECONNREFUSED"));
});

// ---------------------------------------------------------------------------
// probeInstances（health 实例表数据源）

test("probeInstances：好条目实测 version/reachable；坏路径跳过；不可达条目 reachable=false", async () => {
  const good = writeService("http://127.0.0.1:43210", "pw-good");
  const badPath = path.join(root, "svcs", "nonexistent.json");
  const down = writeService("http://127.0.0.1:43211", "pw-down");
  const reg = buildRegistry(env, [good, badPath, down]);
  const { fetch } = mockFetch([
    { test: (c) => c.url.startsWith("http://127.0.0.1:43210/api/info"), respond: json(200, { version: "2.2.5" }) },
    { test: (c) => c.url.startsWith("http://127.0.0.1:43211/api/info"), respond: json(401, {}) },
  ]);
  const list = await probeInstances(reg, env, { fetchImpl: fetch, isAlive: () => true });
  assert.equal(list.length, 2); // 坏路径不产条目
  const g = list.find((i) => i.port === 43210)!;
  assert.deepEqual({ version: g.version, reachable: g.reachable, pid_alive: g.pid_alive, url: g.url }, {
    version: "2.2.5",
    reachable: true,
    pid_alive: true,
    url: "http://127.0.0.1:43210",
  });
  const d = list.find((i) => i.port === 43211)!;
  assert.equal(d.reachable, false);
  assert.equal(d.version, null);
});

// ---------------------------------------------------------------------------
// resolveTarget（白名单三层校验）

test("resolveTarget：端口不命中任何条目 → PORT_NOT_IN_REGISTRY（模型幻觉端口 fail fast）", async () => {
  const p = writeService("http://127.0.0.1:43210", "pw");
  const reg = buildRegistry(env, [p]);
  const r = await resolveTarget(reg, 43212, env, { fetchImpl: mockFetch([]).fetch, isAlive: () => true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PORT_NOT_IN_REGISTRY");
});

test("resolveTarget：命中但 pid 死（stale service.json）→ PID_DEAD", async () => {
  const p = writeService("http://127.0.0.1:43210", "pw");
  const reg = buildRegistry(env, [p]);
  const r = await resolveTarget(reg, 43210, env, { fetchImpl: mockFetch([]).fetch, isAlive: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PID_DEAD");
});

test("resolveTarget：命中且 pid 活但 /api/info 失败 → UNREACHABLE", async () => {
  const p = writeService("http://127.0.0.1:43210", "pw");
  const reg = buildRegistry(env, [p]);
  const { fetch } = mockFetch([{ test: (c) => c.url.endsWith("/api/info"), respond: json(503, {}) }]);
  const r = await resolveTarget(reg, 43210, env, { fetchImpl: fetch, isAlive: () => true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "UNREACHABLE");
  assert.ok(r.reason.includes("/api/info"));
});

test("resolveTarget：三层全过 → ok 且凭证来自现读条目", async () => {
  const p = writeService("http://127.0.0.1:43210", "pw-live");
  const reg = buildRegistry(env, [p]);
  const { fetch } = mockFetch([{ test: (c) => c.url.endsWith("/api/info"), respond: json(200, { version: "2.2.5" }) }]);
  const r = await resolveTarget(reg, 43210, env, { fetchImpl: fetch, isAlive: () => true });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.svc.password, "pw-live");
    assert.equal(r.servicePath, p);
  }
});

test("凭证现读：service.json 换 password 后，下一次调用即用新凭证", async () => {
  const p = writeService("http://127.0.0.1:43210", "pw-old");
  const reg = buildRegistry(env, [p]);
  const { calls, fetch } = mockFetch([
    { test: (c) => c.url.endsWith("/api/info"), respond: json(200, { version: "2.2.5" }) },
  ]);
  await resolveTarget(reg, 43210, env, { fetchImpl: fetch, isAlive: () => true });
  assert.equal(calls[0]!.headers["authorization"], "Basic " + Buffer.from("opencode:pw-old").toString("base64"));
  // opencode 重启 → service.json 重写（url/password 都变）
  const p2 = path.join(root, "svcs", "service-rotated.json");
  writeFileSync(p2, JSON.stringify({ url: "http://127.0.0.1:43210", pid: 4321, password: "pw-new" }));
  const reg2 = buildRegistry(env, [p2]);
  await resolveTarget(reg2, 43210, env, { fetchImpl: fetch, isAlive: () => true });
  assert.equal(calls[1]!.headers["authorization"], "Basic " + Buffer.from("opencode:pw-new").toString("base64"));
});

// ---------------------------------------------------------------------------
// verifySessionAlive（SDK v2 client：GET /api/session/:id）

test("verifySessionAlive：200 → true；404/网络异常 → false（SDK 走注入 fetch）", async () => {
  const ok = mockFetch([{ test: (c) => c.url.includes("/api/session/ses_ok"), respond: json(200, { id: "ses_ok" }) }]);
  assert.equal(await verifySessionAlive(svc("http://127.0.0.1:1", "pw"), "ses_ok", { fetchImpl: ok.fetch }), true);
  assert.equal(ok.calls[0]!.url, "http://127.0.0.1:1/api/session/ses_ok", "SDK v2 命名空间须走 /api 前缀");

  const nf = mockFetch([{ test: (c) => c.url.includes("/api/session/"), respond: json(404, {}) }]);
  assert.equal(await verifySessionAlive(svc("http://127.0.0.1:1", "pw"), "ses_x", { fetchImpl: nf.fetch }), false);

  const net = mockFetch([{ test: () => true, respond: () => Promise.reject(new Error("ECONNREFUSED")) }]);
  assert.equal(await verifySessionAlive(svc("http://127.0.0.1:1", "pw"), "ses_x", { fetchImpl: net.fetch }), false);
});

test("verifySessionAlive：挂死连接按 timeoutMs 中止（SDK config.signal 传播真实验证，非 mock）", async () => {
  // 接受 TCP 连接但永不响应的本地 server：若 hey-api 不传播 config.signal，
  // fetch 将挂死到 Node 默认 headers 超时（分钟级），测试即超时失败——本测试即为守门
  const srv = createServer(() => {});
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    const t0 = Date.now();
    const alive = await verifySessionAlive(svc(`http://127.0.0.1:${port}`, "pw"), "ses_x", { timeoutMs: 150 });
    const dt = Date.now() - t0;
    assert.equal(alive, false);
    assert.ok(dt < 2000, `elapsed=${dt}ms — abort 未生效，signal 未传播到 SDK fetch`);
  } finally {
    srv.close(); // abort 后 fetch 已销毁连接；close 挂起连接由进程退出兜底
  }
});

// ---------------------------------------------------------------------------
// sendSynthetic（POST /api/session/:id/synthetic 手写封装）

const SYN_PATH = "/api/session/ses_t1/synthetic";

test("sendSynthetic：payload 逐字段——text 必带、delivery 显式、可选字段未传不出现", async () => {
  const { calls, fetch } = mockFetch([
    { test: (c) => c.url.includes(SYN_PATH), respond: json(200, { data: { id: "msg_1" } }) },
  ]);
  const r = await sendSynthetic(svc("http://127.0.0.1:1", "pw"), {
    sessionId: "ses_t1",
    text: "hello",
    delivery: "queue",
  }, { fetchImpl: fetch });
  assert.deepEqual(r, { ok: true, messageId: "msg_1" });
  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith(SYN_PATH));
  // delivery 必须显式出现（CONTRACT.md：省略时服务端默认 steer——lifecycle 恒 queue 的坑）
  assert.deepEqual(c.body, { text: "hello", delivery: "queue" });
  assert.equal(c.headers["authorization"], "Basic " + Buffer.from("opencode:pw").toString("base64"));
  assert.equal(c.headers["content-type"], "application/json");
});

test("sendSynthetic：id/resume 透传", async () => {
  const { calls, fetch } = mockFetch([
    { test: (c) => c.url.includes(SYN_PATH), respond: json(200, { data: { id: "msg_same" } }) },
  ]);
  await sendSynthetic(
    svc("http://127.0.0.1:1", "pw"),
    { sessionId: "ses_t1", text: "x", delivery: "steer", id: "msg_retry_1", resume: false },
    { fetchImpl: fetch },
  );
  assert.deepEqual(calls[0]!.body, { text: "x", delivery: "steer", id: "msg_retry_1", resume: false });
});

test("sendSynthetic 失败分类（CONTRACT.md 判据）", async () => {
  const withRoute = (status: number, body: unknown) =>
    mockFetch([{ test: (c) => c.url.includes(SYN_PATH), respond: json(status, body) }]).fetch;
  const base = { sessionId: "ses_t1", text: "x", delivery: "queue" as const };
  const S = "http://127.0.0.1:1";

  const nf = await sendSynthetic(svc(S, "pw"), base, {
    fetchImpl: withRoute(404, { _tag: "SessionNotFoundError", sessionID: "ses_t1" }),
  });
  assert.equal(nf.failure, "session-not-found");

  // 404 判据双重：status 404 即可，_tag 缺失也成立（CONTRACT.md）
  const nf2 = await sendSynthetic(svc(S, "pw"), base, { fetchImpl: withRoute(404, {}) });
  assert.equal(nf2.failure, "session-not-found");

  const un = await sendSynthetic(svc(S, "pw"), base, { fetchImpl: withRoute(401, {}) });
  assert.equal(un.failure, "unauthorized");

  const conflict = await sendSynthetic(svc(S, "pw"), base, { fetchImpl: withRoute(409, {}) });
  assert.equal(conflict.failure, "retryable");

  const serverErr = await sendSynthetic(svc(S, "pw"), base, { fetchImpl: withRoute(500, {}) });
  assert.equal(serverErr.failure, "retryable");

  const net = mockFetch([{ test: () => true, respond: () => Promise.reject(new Error("ECONNRESET")) }]);
  const netR = await sendSynthetic(svc(S, "pw"), base, { fetchImpl: net.fetch });
  assert.equal(netR.failure, "retryable");
  assert.ok(netR.detail?.includes("ECONNRESET"));

  const bad = await sendSynthetic(svc(S, "pw"), base, { fetchImpl: withRoute(400, {}) });
  assert.equal(bad.failure, "invalid");
});

// ---------------------------------------------------------------------------
// listInbox

test("listInbox：返回 data 数组；非 2xx 抛错", async () => {
  const { fetch } = mockFetch([
    { test: (c) => c.url.includes("/api/session/ses_t1/inbox"), respond: json(200, { data: [{ id: "msg_1" }] }) },
  ]);
  const items = await listInbox(svc("http://127.0.0.1:1", "pw"), "ses_t1", { fetchImpl: fetch });
  assert.equal(items.length, 1);
  assert.equal(items[0]!["id"], "msg_1");

  const bad = mockFetch([{ test: () => true, respond: json(500, {}) }]);
  await assert.rejects(() => listInbox(svc("http://127.0.0.1:1", "pw"), "ses_t1", { fetchImpl: bad.fetch }));
});
