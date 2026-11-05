// Monitor 单测（SERVER-PLAN 阶段 D）：真任务进程 + mock opencode API（无网络）。
// 覆盖：直通闭环（wake→lifecycle 保序/内容/幂等 id）、completed/failed 终态、
// max_events 达顶停发（lifecycle 不受额）、orphaned 温和停止（§三-1）、
// 投递耗尽不阻断生命周期、createTask fail fast 四路（白名单/session/目录/参数）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { opencodeServicePath, taskDir, type PathEnv, type PublicInfo } from "@omt/shared";
import { buildRegistry, type OpencodeRegistry } from "../src/opencode.ts";
import { isTaskProcessAlive } from "../src/spawner.ts";
import { readMeta } from "../src/taskstore.ts";
import { createTask, type CreateTaskOutcome, type MonitorDeps } from "../src/monitor.ts";
import { TaskRegistry } from "../src/registry.ts";

let root: string;
let env: PathEnv;
let ocRegistry: OpencodeRegistry;

const OC_URL = "http://127.0.0.1:65533";
const SESSION = "ses_mtest";

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "omt-monitor-"));
  env = { XDG_STATE_HOME: `${root}/state`, XDG_DATA_HOME: `${root}/data` };
  ocRegistry = buildRegistry(env);
  const p = opencodeServicePath(env);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ url: OC_URL, pid: 4242, password: "pw-test" }), { mode: 0o600 });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mock opencode API

interface OcMock {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: Record<string, unknown> | null }>;
}

function makeOc(
  opts: { sessionStatus?: number; syntheticStatus?: number; syntheticDelayMs?: number } = {},
): OcMock {
  const calls: OcMock["calls"] = [];
  let synCount = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    calls.push({ url: u, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null });
    if (u.endsWith("/api/info")) return json(200, { version: "2.2.5" });
    if (u.includes("/synthetic")) {
      if (opts.syntheticDelayMs) await sleep(opts.syntheticDelayMs);
      const s = opts.syntheticStatus ?? 200;
      synCount++;
      return json(s, s === 200 ? { data: { id: `msg_${synCount}` } } : s === 404 ? { _tag: "SessionNotFoundError" } : {});
    }
    if (/\/api\/session\/[^/]+$/.test(u)) return json(opts.sessionStatus ?? 200, { id: SESSION });
    return json(404, {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const sleep0 = async () => {};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

interface Rig {
  registry: TaskRegistry;
  logs: string[];
  oc: OcMock;
}

function rig(ocOpts?: Parameters<typeof makeOc>[0]): Rig {
  const registry = new TaskRegistry();
  const logs: string[] = [];
  const oc = makeOc(ocOpts);
  return { registry, logs, oc };
}

function depsOf(r: Rig): MonitorDeps & { registry: TaskRegistry } {
  return {
    env,
    ocRegistry,
    registry: r.registry,
    log: (m) => r.logs.push(m),
    ocDeps: { fetchImpl: r.oc.fetchImpl, isAlive: () => true },
    sleep: sleep0, // exit 竞态宽限与投递退避加速（真实等待语义由 verify-m2.ts 真机覆盖）
    tickMs: 25,
    retryDelaysMs: [0, 0, 0],
  };
}

function validBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: "echo hi-mtest",
    opencode_port: 65533,
    session_id: SESSION,
    directory: root,
    ...extra,
  };
}

async function create(r: Rig, body: Record<string, unknown>): Promise<CreateTaskOutcome> {
  return await createTask(depsOf(r), body);
}

function info(r: Rig, id: string): PublicInfo {
  const v = r.registry.get(id);
  assert.ok(v, "monitor should be in registry");
  return v.toPublicInfo();
}

const syntheticCalls = (r: Rig) => r.oc.calls.filter((c) => c.url.includes("/synthetic"));
const textOf = (c: { body: Record<string, unknown> | null }) => String(c.body?.text ?? "");

// ---------------------------------------------------------------------------
// 闭环与终态

test("直通闭环：echo 行 → wake 信封 → 退出 → lifecycle 信封（保序/内容/幂等 id 唯一）", async () => {
  const r = rig();
  const out = await create(r, validBody({ command: "echo hello-m; sleep 0.2", description: "mon-desc" }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const id = out.info.id;
  assert.equal(out.info.state, "running");
  assert.equal(out.info.delivery, "queue"); // 默认
  assert.equal(out.info.pid !== null, true);
  assert.equal(out.info.idle_deadline, null); // F 阶段激活字段
  assert.equal(out.info.grace_deadline, null);

  assert.ok(await waitFor(() => info(r, id).state === "completed"), "should complete");
  const final = info(r, id);
  assert.deepEqual(final.exit_info, { code: "0", reason: "exited" });
  assert.equal(final.lines_matched, 1);
  assert.equal(final.events_sent, 1); // 只计 wake
  assert.equal(final.events_dropped, 0);
  assert.ok(final.last_offset > 0);
  assert.equal(final.last_offset, final.log_bytes, "echo 行尾带换行：行安全点 = 文件尾");

  const syn = syntheticCalls(r);
  assert.equal(syn.length, 2, `expect wake+lifecycle, got ${syn.length}`);
  // 保序：wake 先于 lifecycle（PLAN §5.1 deliverChain 资产）
  assert.ok(textOf(syn[0]!).includes("hello-m"), textOf(syn[0]!));
  assert.ok(textOf(syn[1]!).includes("finished: completed"), textOf(syn[1]!));
  // 信封完整 + description 标注 + 转义在信封层完成
  assert.ok(textOf(syn[0]!).startsWith("<task-notification>\n"));
  assert.ok(textOf(syn[0]!).endsWith("</task-notification>"));
  assert.ok(textOf(syn[0]!).includes(`[monitor ${id} · mon-desc]`));
  // 投递契约：delivery 显式传 + 幂等 id 唯一且 msg_ 前缀（Session.Message.ID pattern，真机实测）
  assert.equal(syn[0]!.body!.delivery, "queue");
  assert.equal(syn[1]!.body!.delivery, "queue"); // lifecycle 恒 queue
  const ids = syn.map((c) => c.body!.id);
  assert.equal(new Set(ids).size, 2);
  for (const i of ids) assert.match(String(i), /^msg_omt_[a-z0-9]+_mon_/); // 含实例 epoch（防跨重启碰撞）

  // meta.json 落盘 = 真相源（claimed_by = 看护进程）
  const meta = readMeta(env, id);
  assert.ok(meta !== null, "meta.json should exist");
  assert.equal(meta.state, "completed");
  assert.equal(meta.claimed_by, process.pid);
  assert.equal(meta.exit_info!.code, "0");
  // registry 聚合
  assert.equal(r.registry.aliveCount(), 0);
  assert.equal(r.registry.listInfos(SESSION).length, 1);
});

test("failed 终态：exit 7 → failed + exit_info", async () => {
  const r = rig();
  const out = await create(r, validBody({ command: "echo boom-m; exit 7" }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "failed"));
  const final = info(r, out.info.id);
  assert.deepEqual(final.exit_info, { code: "7", reason: "exited" });
  const lc = syntheticCalls(r).map(textOf).find((t) => t.includes("finished:"));
  assert.ok(lc !== undefined && lc.includes("failed"), String(lc));
});

test("max_events 达顶停发：后续行丢弃计数，lifecycle 不受额仍投递", async () => {
  const r = rig();
  const out = await create(
    r,
    validBody({ command: "echo l1; sleep 0.25; echo l2; sleep 0.25; echo l3", max_events: 1 }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"));
  const final = info(r, out.info.id);
  assert.equal(final.events_sent, 1, JSON.stringify(final));
  assert.equal(final.events_dropped, 2); // l2/l3 达顶丢弃
  const syn = syntheticCalls(r);
  assert.equal(syn.length, 2); // 1 wake + 1 lifecycle（lifecycle 不占额）
  assert.ok(textOf(syn[1]!).includes("finished: completed"));
});

test("orphaned：session 死亡（404）→ 停止通知 + SIGTERM 温和停止进程组（§三-1）", async () => {
  const r = rig({ syntheticStatus: 404 });
  const out = await create(r, validBody({ command: "echo orphan-m; sleep 30" }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const pid = out.info.pid!;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "orphaned"), "should orphan");
  const final = info(r, out.info.id);
  assert.equal(final.exit_info!.code, "signal:15");
  assert.equal(final.exit_info!.reason, "killed");
  assert.ok(await waitFor(() => !isTaskProcessAlive({ pid, startTime: null })), "process group killed");
  // 只有一次失败的 wake 尝试，之后不再通知（不无限重试死会话）
  const syn = syntheticCalls(r);
  assert.equal(syn.length, 1, `expect exactly 1 attempted wake, got ${syn.length}`);
  assert.ok(r.logs.some((l) => l.includes("orphaned")), r.logs.join(" | "));
  assert.equal(r.registry.aliveCount(), 0);
});

test("投递耗尽不阻断生命周期：恒 500 → wake/lifecycle 都落 drop，任务照常 completed", async () => {
  const r = rig({ syntheticStatus: 500 });
  const out = await create(r, validBody({ command: "echo dead-letter; sleep 0.2" }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"));
  const final = info(r, out.info.id);
  assert.equal(final.events_sent, 0);
  assert.equal(final.events_dropped, 2); // wake（重试 3 次）+ lifecycle（重试 3 次）
  // 首投 + 3 重试 × 2 条通知 = 8 次 synthetic 尝试
  assert.equal(syntheticCalls(r).length, 8);
  assert.ok(r.logs.some((l) => l.includes("dropped")), r.logs.join(" | "));
});

test("session 死于收尾窗口：404 不触发 orphan，丢失计数留痕（Review 修复回归）", async () => {
  // synthetic 恒 404 且延迟 150ms：404 到达时任务已 finalize——旧实现此路径
  // orphan() 早退后既不计数也不留痕（哑丢），且 wake 版本同理
  const r = rig({ syntheticStatus: 404, syntheticDelayMs: 150 });
  const out = await create(r, validBody({ command: "sleep 0.15; echo bye-finalize" }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"), "自然收尾优先，不被 orphan 抢占");
  assert.ok(await waitFor(() => info(r, out.info.id).events_dropped === 2), `dropped=${info(r, out.info.id).events_dropped}`);
  const final = info(r, out.info.id);
  assert.equal(final.state, "completed"); // 不是 orphaned：进程已自然退出
  assert.equal(final.events_sent, 0);
  assert.equal(final.exit_info!.code, "0");
  // 留痕：两条 404（wake + lifecycle）都有"already finalizing"日志
  const traces = r.logs.filter((l) => l.includes("already finalizing"));
  assert.equal(traces.length, 2, r.logs.join(" | "));
  assert.equal(r.registry.aliveCount(), 0);
});

test("投递簿记落盘故障不外泄：meta 写失败只留痕，不崩看护（Review 修复回归）", async () => {
  const r = rig();
  const out = await create(r, validBody({ command: "echo durable; sleep 0.2" }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  // 外科式破坏：仅废掉 meta.json 的原子替换（占位成目录 → rename 永远 EISDIR）。
  // 不能 chmod 整个任务目录——那会连带废掉 wrapper 的 EXIT-trap 写 exit 文件，
  // 任务真实结局就是 unknown/failed，测的不是簿记路径。
  // 旧实现：onDelivered 内 writeMeta 抛出 → unhandled rejection → uncaughtException 拖垮服务端
  const metaPath = `${taskDir(env, out.info.id)}/meta.json`;
  rmSync(metaPath);
  mkdirSync(metaPath);
  try {
    assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"), "内存态看护不受磁盘故障影响");
    const final = info(r, out.info.id);
    assert.equal(final.events_sent, 1);
    assert.equal(final.exit_info!.code, "0", "wrapper 的 exit 文件不受 meta 故障影响");
    assert.ok(
      r.logs.some((l) => l.includes("persist error") || l.includes("tick error") || l.includes("bookkeeping error")),
      r.logs.join(" | "),
    );
  } finally {
    rmSync(metaPath, { recursive: true, force: true }); // 还原为可清理状态
  }
});

test("多任务并发：两任务各自闭环，registry 计数正确", async () => {
  const r = rig();
  const a = await create(r, validBody({ command: "echo a-m; sleep 0.3" }));
  const b = await create(r, validBody({ command: "echo b-m; sleep 0.1" }));
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(r.registry.aliveCount(), 2);
  assert.ok(await waitFor(() => info(r, a.info.id).state === "completed" && info(r, b.info.id).state === "completed"));
  assert.equal(r.registry.aliveCount(), 0);
  assert.equal(r.registry.size, 2);
  assert.equal(r.registry.listInfos(SESSION).length, 2);
});

// ---------------------------------------------------------------------------
// createTask fail fast

test("fail fast：幻觉端口 → 400 PORT_NOT_IN_REGISTRY，无任务落盘", async () => {
  const r = rig();
  const out = await create(r, validBody({ opencode_port: 65534 }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 400);
  assert.equal(out.error.code, "PORT_NOT_IN_REGISTRY");
  assert.equal(r.registry.size, 0);
});

test("fail fast：session 不存在 → 404 SESSION_NOT_FOUND", async () => {
  const r = rig({ sessionStatus: 404 });
  const out = await create(r, validBody({ session_id: "ses_gone" }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 404);
  assert.equal(out.error.code, "SESSION_NOT_FOUND");
});

test("fail fast：目录不存在 → 400 BAD_DIRECTORY", async () => {
  const r = rig();
  const out = await create(r, validBody({ directory: "/nonexistent-omt-dir-xyz" }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 400);
  assert.equal(out.error.code, "BAD_DIRECTORY");
});

test("fail fast：参数违规 → 400 INVALID_INPUT（violations 明细透传）", async () => {
  const r = rig();
  const out = await create(r, validBody({ command: "echo $(date)" }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 400);
  assert.equal(out.error.code, "INVALID_INPUT");
  assert.ok(JSON.stringify(out.error.detail).includes("command"));
  // 无 syntheic 调用（fail fast 在执行前）
  assert.equal(syntheticCalls(r).length, 0);
});
