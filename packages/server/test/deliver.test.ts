// deliver 单测：DeliverChain 保序/失败隔离 + deliverNotification
// 重试语义（retryable 退避、404/400 即返、401 归 retryable、resolveTarget 每次现读）
// fetch-mock + 隔离 XDG 假 service.json（无网络）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { opencodeServicePath, type PathEnv } from "@omt/shared";
import { buildRegistry, type OpencodeRegistry } from "../src/opencode.ts";
import { DEFAULT_RETRY_DELAYS_MS, DeliverChain, deliverNotification } from "../src/deliver.ts";

let root: string;
let env: PathEnv;
let ocRegistry: OpencodeRegistry;

const OC_URL = "http://127.0.0.1:65533";

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "omt-deliver-"));
  env = { XDG_STATE_HOME: `${root}/state`, XDG_DATA_HOME: `${root}/data` };
  ocRegistry = buildRegistry(env);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeService(): void {
  const p = opencodeServicePath(env);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ url: OC_URL, pid: 4242, password: "pw-test" }), { mode: 0o600 });
}

function removeService(): void {
  try {
    rmSync(opencodeServicePath(env), { force: true });
  } catch {
    /* 不存在 */
  }
}

/** mock fetch：/api/info 恒 200；synthetic 按 responses 队列依次出队（空则 200） */
function mockFetch(responses: Array<{ status: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: Record<string, unknown> | null }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  let syntheticCount = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null });
    if (u.endsWith("/api/info")) {
      return new Response(JSON.stringify({ version: "2.2.5" }), { status: 200 });
    }
    if (u.includes("/synthetic")) {
      const r = responses[Math.min(syntheticCount++, responses.length - 1)];
      return new Response(JSON.stringify(r?.body ?? { data: { id: `msg_${syntheticCount}` } }), {
        status: r?.status ?? 200,
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const job = {
  sessionId: "ses_test",
  opencodePort: 65533,
  text: "<task-notification>\n[monitor mon_t]\nbody\n</task-notification>",
  delivery: "queue" as const,
  idempotencyId: "msg_omt_mon_t_0", // 调用方（monitor）负责 msg_ 前缀（Session.Message.ID pattern）
};

const sleep0 = async () => {};

// ---------------------------------------------------------------------------
// DeliverChain

test("DeliverChain：严格保序（前 job 未完成，后 job 不开跑）", async () => {
  const chain = new DeliverChain();
  const order: string[] = [];
  const slow = chain.run(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push("slow-done");
  });
  chain.run(async () => {
    order.push("fast-done");
  });
  await chain.run(async () => {
    order.push("last-done");
  });
  await slow;
  assert.deepEqual(order, ["slow-done", "fast-done", "last-done"]);
});

test("DeliverChain：前 job 抛错不阻断后续（失败隔离），depth 归零", async () => {
  const chain = new DeliverChain();
  const order: string[] = [];
  const bad = chain.run(async () => {
    throw new Error("boom");
  });
  await assert.rejects(bad);
  await chain.run(async () => {
    order.push("recovered");
  });
  assert.deepEqual(order, ["recovered"]);
  assert.equal(chain.depth, 0);
});

test("DeliverChain：depth 反映在途数", async () => {
  const chain = new DeliverChain();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const p = chain.run(() => gate);
  assert.equal(chain.depth, 1);
  release();
  await p;
  assert.equal(chain.depth, 0);
});

// ---------------------------------------------------------------------------
// deliverNotification

test("直投成功：首投 200 → ok，messageId 透传，payload 契约（delivery 显式 + 幂等 id）", async () => {
  writeService();
  const { fetchImpl, calls } = mockFetch([]);
  const r = await deliverNotification(
    { ocRegistry, env, ocDeps: { fetchImpl, isAlive: () => true }, sleep: sleep0 },
    job,
  );
  assert.equal(r.ok, true);
  const syn = calls.find((c) => c.url.includes("/synthetic"))!;
  assert.equal(syn.body!.delivery, "queue");
  assert.equal(syn.body!.id, "msg_omt_mon_t_0");
  assert.equal(syn.body!.text, job.text);
});

test("默认重试间隔 = 500/2s/8s", () => {
  assert.deepEqual(DEFAULT_RETRY_DELAYS_MS, [500, 2000, 8000]);
});

test("retryable 退避重试：500,500 → 第三次 200 成功（共 3 投）", async () => {
  writeService();
  const { fetchImpl, calls } = mockFetch([{ status: 500 }, { status: 500 }, { status: 200 }]);
  const r = await deliverNotification(
    { ocRegistry, env, ocDeps: { fetchImpl, isAlive: () => true }, retryDelaysMs: [0, 0], sleep: sleep0 },
    job,
  );
  assert.equal(r.ok, true);
  assert.equal(calls.filter((c) => c.url.includes("/synthetic")).length, 3);
});

test("重试耗尽：恒 500 → exhausted（首投 + delays.length 次重试）", async () => {
  writeService();
  const { fetchImpl, calls } = mockFetch([{ status: 500 }]);
  const r = await deliverNotification(
    { ocRegistry, env, ocDeps: { fetchImpl, isAlive: () => true }, retryDelaysMs: [0, 0, 0], sleep: sleep0 },
    job,
  );
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, "exhausted");
  assert.equal(calls.filter((c) => c.url.includes("/synthetic")).length, 4);
});

test("session-not-found：404 即返不重试（orphaned 判据）", async () => {
  writeService();
  const { fetchImpl, calls } = mockFetch([{ status: 404, body: { _tag: "SessionNotFoundError" } }]);
  const r = await deliverNotification(
    { ocRegistry, env, ocDeps: { fetchImpl, isAlive: () => true }, retryDelaysMs: [0, 0, 0], sleep: sleep0 },
    job,
  );
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, "session-not-found");
  assert.equal(calls.filter((c) => c.url.includes("/synthetic")).length, 1);
});

test("invalid：400 即返不重试（调用方 bug，契约测试守门）", async () => {
  writeService();
  const { fetchImpl, calls } = mockFetch([{ status: 400, body: { _tag: "InvalidRequestError" } }]);
  const r = await deliverNotification(
    { ocRegistry, env, ocDeps: { fetchImpl, isAlive: () => true }, retryDelaysMs: [0], sleep: sleep0 },
    job,
  );
  assert.equal((r as { kind: string }).kind, "invalid");
  assert.equal(calls.filter((c) => c.url.includes("/synthetic")).length, 1);
});

test("unauthorized 归 retryable：401 后重试自愈（重投时现读凭证）", async () => {
  writeService();
  const { fetchImpl } = mockFetch([{ status: 401, body: { _tag: "UnauthorizedError" } }, { status: 200 }]);
  const r = await deliverNotification(
    { ocRegistry, env, ocDeps: { fetchImpl, isAlive: () => true }, retryDelaysMs: [0], sleep: sleep0 },
    job,
  );
  assert.equal(r.ok, true);
});

test("resolveTarget 现读：service.json 首读失败（不存在）→ 重试间隙补上 → 成功", async () => {
  removeService();
  const { fetchImpl } = mockFetch([]);
  const p = deliverNotification(
    { ocRegistry, env, ocDeps: { fetchImpl, isAlive: () => true }, retryDelaysMs: [0], sleep: sleep0 },
    job,
  );
  // 首投在无 service.json 下 resolveTarget 失败 → 进入 0ms 退避；立即补写后重试成功
  writeService();
  const r = await p;
  assert.equal(r.ok, true);
});

test("端口不命中注册表：重试耗尽 → exhausted（含 PORT_NOT_IN_REGISTRY 原因）", async () => {
  writeService();
  const { fetchImpl } = mockFetch([]);
  const r = await deliverNotification(
    {
      ocRegistry,
      env,
      ocDeps: { fetchImpl, isAlive: () => true },
      retryDelaysMs: [0],
      sleep: sleep0,
    },
    { ...job, opencodePort: 65534 },
  );
  assert.equal(r.ok, false);
  assert.match((r as { detail: string }).detail, /PORT_NOT_IN_REGISTRY/);
});
