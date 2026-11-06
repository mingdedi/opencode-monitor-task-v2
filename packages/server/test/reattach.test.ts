// reattach 单测：模拟"服务端崩溃后残留"——store 目录 + 活/死任务
// 进程，无任何内存 Monitor。手工构造 meta（模拟崩溃前服务端落盘的快照）后走
// scanAndReclaim / retryPendingTasks 全路径。mock opencode API（无网络）。
// 每测试独立 XDG 目录：任务残留（终态 TTL 内的目录）不跨测试泄漏。
// 覆盖：活认领（缺席摘要一条·绝不逐行重放·last_offset 续读·后续新行正常投递）、
// idle 冻结（恢复 running 从零武装）、死收尾（终态+合并结局通知+StoredTaskView）、
// parked（log 丢失可见）、坏 meta 保守不删、幂等重扫、pending 重投（成功/404/保留/
// FIFO break 保序/与 Monitor append 的写回竞态闭合）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import { LIMITS, opencodeServicePath, type PathEnv, type PublicInfo } from "@omt/shared";
import { buildRegistry, type OpencodeRegistry } from "../src/opencode.ts";
import { isTaskProcessAlive, spawnTask } from "../src/spawner.ts";
import {
  appendPending,
  initTaskDir,
  readMeta,
  readPending,
  taskFilePaths,
  writeMeta,
  writePending,
  type TaskMeta,
} from "../src/taskstore.ts";
import { retryPendingTasks, scanAndReclaim, type ReattachDeps } from "../src/reattach.ts";
import { TaskRegistry } from "../src/registry.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "omt-reattach-"));
let envSeq = 0;

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const OC_URL = "http://127.0.0.1:65534";
const SESSION = "ses_rtest";

// ---------------------------------------------------------------------------
// mock opencode（synthetic 状态可切换：模拟 opencode 短暂不可达后恢复）

interface OcMock {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: Record<string, unknown> | null }>;
  syntheticStatus: number; // 可变：500 → 200 模拟恢复
}

function makeOc(initialStatus = 200): OcMock {
  const calls: OcMock["calls"] = [];
  const mock: OcMock = {
    calls,
    syntheticStatus: initialStatus,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      calls.push({ url: u, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (u.endsWith("/api/info")) return json(200, { version: "2.2.5" });
      if (u.includes("/synthetic")) {
        const s = mock.syntheticStatus;
        return json(s, s === 200 ? { data: { id: "msg_x" } } : s === 404 ? { _tag: "SessionNotFoundError" } : {});
      }
      return json(200, { id: SESSION });
    }) as typeof fetch,
  };
  return mock;
}

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
  env: PathEnv;
  registry: TaskRegistry;
  logs: string[];
  oc: OcMock;
  deps: ReattachDeps;
}

/** 每测试独立 XDG 根：隔离任务目录残留（终态 TTL 1h，测试等不了清理） */
function rig(syntheticStatus = 200): Rig {
  const n = ++envSeq;
  const env: PathEnv = { XDG_STATE_HOME: `${ROOT}/s${n}`, XDG_DATA_HOME: `${ROOT}/d${n}` };
  const registry = new TaskRegistry();
  const logs: string[] = [];
  const oc = makeOc(syntheticStatus);
  const deps: ReattachDeps = {
    env,
    ocRegistry: rigOcRegistry(env),
    registry,
    log: (m) => logs.push(m),
    ocDeps: { fetchImpl: oc.fetchImpl, isAlive: () => true },
    sleep: async () => {},
    tickMs: 25,
    retryDelaysMs: [0, 0, 0],
  };
  return { env, registry, logs, oc, deps };
}

const ocRegistries = new Map<string, OpencodeRegistry>();
function rigOcRegistry(env: PathEnv): OpencodeRegistry {
  // oc service.json 写在 state 根（buildRegistry 的默认条目位置）
  const key = env.XDG_STATE_HOME!;
  let reg = ocRegistries.get(key);
  if (reg === undefined) {
    reg = buildRegistry(env);
    const p = opencodeServicePath(env);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ url: OC_URL, pid: 4242, password: "pw-rtest" }), { mode: 0o600 });
    ocRegistries.set(key, reg);
  }
  return reg;
}

/** 手工构造"崩溃残留"：spawn 任务进程 + 写崩溃前 meta 快照（last_offset 可指定） */
async function residue(
  r: Rig,
  command: string,
  opts: { state?: TaskMeta["state"]; graceDeadline?: number | null; lastOffset?: number; waitLines?: number } = {},
): Promise<{ meta: TaskMeta; id: string }> {
  const id = `mon_${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
  const paths = initTaskDir(r.env, id);
  const spawned = spawnTask(paths, command, { cwd: ROOT });
  const now = Date.now();
  const meta: TaskMeta = {
    schema: 1,
    id,
    command,
    description: "reattach-test",
    session_id: SESSION,
    opencode_port: 65534,
    pid: spawned.pid,
    pgid: spawned.pgid,
    proc_start_time: spawned.procStartTime,
    started_at: now,
    directory: ROOT,
    pattern: null,
    wake_mode: "all",
    delivery: "queue",
    coalesce_ms: 0, // 直通：认领后新行立即投递，断言简单
    max_events: 50,
    idle_timeout_ms: 300_000,
    last_offset: opts.lastOffset ?? 0,
    lines_scanned: 0,
    lines_matched: 0,
    events_sent: 0,
    events_dropped: 0,
    state: opts.state ?? "running",
    exit_info: null,
    grace_deadline: opts.graceDeadline ?? null,
    claimed_by: 0,
    updated_at: now,
  };
  // 先写 meta 再等输出：崩溃窗口内任务照常落 log（文件即管道）
  writeMeta(r.env, meta);
  if (opts.waitLines) {
    await waitFor(() => {
      try {
        return readFileSync(paths.log, "utf8").split("\n").filter(Boolean).length >= opts.waitLines!;
      } catch {
        return false;
      }
    });
  }
  return { meta, id };
}

const syntheticCalls = (r: Rig) => r.oc.calls.filter((c) => c.url.includes("/synthetic"));
const textOf = (c: { body: Record<string, unknown> | null }) => String(c.body?.text ?? "");
const listed = (r: Rig): PublicInfo[] => r.registry.listInfos();

interface Stoppable {
  requestStop(): Promise<unknown>;
}

/** 清场：认领的活任务温和停止并等终态（防进程/目录残留拖累后续测试） */
async function settle(r: Rig, id: string): Promise<void> {
  const view = r.registry.get(id);
  if (view !== undefined && "requestStop" in view) {
    await (view as Stoppable).requestStop();
  }
  await waitFor(() => {
    const info = listed(r).find((t) => t.id === id);
    return info !== undefined && !["running", "idle"].includes(info.state);
  });
}

// ---------------------------------------------------------------------------

test("活认领：缺席行摘要一条（不逐行重放）+ 认领后新行正常投递 + 断点续读", async () => {
  const r = rig();
  // 崩溃前：任务已产出 3 行（服务端缺席期间）
  const { id } = await residue(r, "echo miss-1; echo miss-2; echo miss-3; sleep 3", { waitLines: 3 });
  const res = await scanAndReclaim(r.deps);
  assert.equal(res.claimed, 1);
  assert.equal(res.finalized, 0);
  assert.equal(res.failed, 0);

  // 认领态（同步可查）：running + idle 从零武装（grace 清空）+ 缺席行已记账
  const info = listed(r).find((t) => t.id === id)!;
  assert.equal(info.state, "running");
  assert.equal(info.grace_deadline, null);
  assert.equal(info.lines_scanned, 3);
  assert.ok(info.last_offset > 0);

  // 缺席摘要：恰 1 条 synthetic（3 行绝不逐行重放），含行数与尾部预览。
  // emitReconnect 经 DeliverChain 异步发出——waitFor 投递完成
  assert.ok(await waitFor(() => syntheticCalls(r).length === 1), `expected 1 notice, got ${syntheticCalls(r).length}`);
  const body = textOf(syntheticCalls(r)[0]!);
  assert.ok(body.includes("reconnected"), body);
  assert.ok(body.includes("3 line(s)"), body);
  assert.ok(body.includes("miss-3"), body); // 尾部预览（previewLines=5 内全量）
  assert.equal(syntheticCalls(r)[0]!.body!.delivery, "queue");

  // 认领后新输出：走正常管线（直通 wake 投递，非摘要）——任务 sleep 3 后自然退出
  // 会产生 finalize 前的 pump + lifecycle，断言"新行 wake 或 lifecycle 到达"即可
  assert.ok(
    await waitFor(() => syntheticCalls(r).length >= 2 && !textOf(syntheticCalls(r)[1]!).includes("reconnected")),
    "post-claim output arrives as plain wake/lifecycle, not another summary",
  );
  await settle(r, id);
});

test("idle 冻结：崩溃前 idle 态 → 认领恢复 running、宽限作废、静默从零武装", async () => {
  const r = rig();
  const { id } = await residue(r, "sleep 3", {
    state: "idle",
    graceDeadline: Date.now() - 1000, // 崩溃前宽限"已过期"——不得沿用（否则恢复即被杀）
  });
  const res = await scanAndReclaim(r.deps);
  assert.equal(res.claimed, 1);
  const info = listed(r).find((t) => t.id === id)!;
  assert.equal(info.state, "running");
  assert.equal(info.grace_deadline, null);
  assert.equal(info.idle_deadline, null);
  // 无缺席输出 → 无摘要通知
  assert.equal(syntheticCalls(r).length, 0);
  // 恢复后静默计时从零：等一个 tick 确认未被旧宽限误杀
  await sleep(80);
  assert.equal(listed(r).find((t) => t.id === id)!.state, "running");
  await settle(r, id);
});

test("死收尾：缺席期间自然退出 → 终态 + exit + 一条合并结局通知（含缺席摘要）+ StoredTaskView", async () => {
  const r = rig();
  const { id } = await residue(r, "echo gone-1; echo gone-2; sleep 0.3; exit 7");
  // 等进程真死 + exit 文件写好
  const metaBefore = readMeta(r.env, id)!;
  assert.ok(
    await waitFor(() => !isTaskProcessAlive({ pid: metaBefore.pid!, startTime: metaBefore.proc_start_time })),
    "task should exit while unobserved",
  );
  const res = await scanAndReclaim(r.deps);
  assert.equal(res.finalized, 1);
  assert.equal(res.claimed, 0);

  const info = listed(r).find((t) => t.id === id)!;
  assert.equal(info.state, "failed");
  assert.deepEqual(info.exit_info, { code: "7", reason: "exited" });
  assert.equal(info.lines_scanned, 2); // 缺席行已记账（scanned 含在内）

  // 合并通知恰 1 条：结局 + 缺席摘要
  assert.ok(await waitFor(() => syntheticCalls(r).length === 1));
  const body = textOf(syntheticCalls(r)[0]!);
  assert.ok(body.includes("finished while the server was away"), body);
  assert.ok(body.includes("failed"), body);
  assert.ok(body.includes("exit 7"), body);
  assert.ok(body.includes("gone-2"), body);
  assert.equal(syntheticCalls(r)[0]!.body!.delivery, "queue", "outcome notice is always queue");

  // 幂等：重扫全跳过（终态），不重复发通知
  const res2 = await scanAndReclaim(r.deps);
  assert.deepEqual(res2, { claimed: 0, finalized: 0, failed: 0 });
  assert.equal(syntheticCalls(r).length, 1);
});

test("死收尾残余行：缺席期间的无换行尾行进结局摘要（收尾冲刷在 reattach 死路同样生效）", async () => {
  const r = rig();
  const { id } = await residue(r, 'echo gone-1; printf "half-line-no-nl"');
  const metaBefore = readMeta(r.env, id)!;
  assert.ok(
    await waitFor(() => !isTaskProcessAlive({ pid: metaBefore.pid!, startTime: metaBefore.proc_start_time })),
    "task should exit while unobserved",
  );
  const res = await scanAndReclaim(r.deps);
  assert.equal(res.finalized, 1);

  // 旧行为：残余不成行 → lines_scanned=1、摘要 preview 无尾行；新行为：成行并入摘要
  const info = listed(r).find((t) => t.id === id)!;
  assert.equal(info.lines_scanned, 2, "无换行尾行必须成行计数");
  assert.ok(await waitFor(() => syntheticCalls(r).length === 1));
  const body = textOf(syntheticCalls(r)[0]!);
  assert.ok(body.includes("half-line-no-nl"), `摘要 preview 应含尾行，got: ${body}`);
});

test("死路残留组清空（任务结束=组必然清空）：崩溃期间脱管的孙进程在 finalizeDeadTask 被击杀", async () => {
  const r = rig();
  const { meta } = await residue(r, 'bash -c "sleep 30 & exit 0"; echo gone'); // 双引号内 & 豁免校验
  assert.ok(
    await waitFor(() => !isTaskProcessAlive({ pid: meta.pid!, startTime: meta.proc_start_time })),
    "task should exit while unobserved",
  );
  // wrapper 已死、组内残留 sleep 30（无主状态）——旧行为：finalizeDeadTask 不杀，组存活 30s；
  // 新行为：killTree 两档清空
  const res = await scanAndReclaim(r.deps);
  assert.equal(res.finalized, 1);
  const groupAlive = (): boolean => {
    try {
      process.kill(-meta.pgid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(await waitFor(() => !groupAlive()), "崩溃窗口脱管的残留进程组应被清空");
  const info = listed(r).find((t) => t.id === meta.id)!;
  assert.equal(info.state, "completed", "残留清杀不改变任务结局（exit 0）");
});

test("parked：log 丢失的活任务 → 认领失败标 parked、列表可见、进程不杀", async () => {
  const r = rig();
  const { id } = await residue(r, "sleep 3");
  rmSync(taskFilePaths(r.env, id).log);
  const res = await scanAndReclaim(r.deps);
  assert.equal(res.failed, 1);
  const info = listed(r).find((t) => t.id === id)!;
  assert.equal(info.state, "parked");
  assert.ok(r.logs.some((l) => l.includes("parked")), r.logs.join(" | "));
  // 进程不杀（保守：可能有活输出在写）
  const meta = readMeta(r.env, id)!;
  assert.ok(isTaskProcessAlive({ pid: meta.pid!, startTime: meta.proc_start_time }), "parked task process untouched");
  // 重扫：parked 非活态 → 跳过（不重复计失败）
  const res2 = await scanAndReclaim(r.deps);
  assert.deepEqual(res2, { claimed: 0, finalized: 0, failed: 0 });
  // 清场：手工杀进程组
  process.kill(-meta.pgid!, "SIGKILL");
});

test("坏 meta：保守不删，failed 计数留痕", async () => {
  const r = rig();
  const id = "mon_deadbeef01";
  const paths = initTaskDir(r.env, id);
  writeFileSync(paths.meta, "{ not valid json", { mode: 0o600 });
  const res = await scanAndReclaim(r.deps);
  assert.equal(res.failed, 1);
  assert.ok(r.logs.some((l) => l.includes("unreadable meta")), r.logs.join(" | "));
  // 目录保留
  assert.ok(existsSync(paths.meta), "bad meta dir must not be deleted");
  // 无 exit 佐证 → 不进列表（无法构造视图）
  assert.equal(listed(r).find((t) => t.id === id), undefined);
});

test("终态/parked 重扫入册（真机场景④回归）：二次 scanAndReclaim 后 registry 可查（DELETE 判据）", async () => {
  const r = rig();
  // parked 残留（第一次认领失败产物）
  const { id } = await residue(r, "sleep 3");
  rmSync(taskFilePaths(r.env, id).log);
  const res1 = await scanAndReclaim(r.deps);
  assert.equal(res1.failed, 1);
  assert.ok(r.registry.get(id) !== undefined, "first pass registers parked view");

  // 二次重扫（新 registry——模拟又一次服务端重启）：parked skip 但必须入册，
  // 否则 DELETE（tasks.get 判据）404（旧实现此处漏册，真机场景④暴露）
  const r2 = rig();
  r2.env = r.env; // 同一 store
  r2.deps = { ...r2.deps, env: r.env };
  const res2 = await scanAndReclaim(r2.deps);
  assert.deepEqual(res2, { claimed: 0, finalized: 0, failed: 0 });
  const view = r2.registry.get(id);
  assert.ok(view !== undefined, "parked must be re-registered on rescan");
  assert.equal(view.toPublicInfo().state, "parked");

  // 终态残留同样入册
  const meta = readMeta(r.env, id)!;
  meta.state = "stopped";
  meta.updated_at = Date.now();
  writeMeta(r.env, meta);
  const r3 = rig();
  r3.deps = { ...r3.deps, env: r.env };
  await scanAndReclaim(r3.deps);
  const view3 = r3.registry.get(id);
  assert.ok(view3 !== undefined, "terminal store task must be registered");
  assert.equal(view3.toPublicInfo().state, "stopped");
  process.kill(-meta.pgid!, "SIGKILL");
});

test("invalid 条目即时丢弃不阻塞队首（Review 修复回归）：后继条目照常送达", async () => {
  const r = rig(200);
  const id = "mon_pinv0000001";
  initTaskDir(r.env, id);
  writePending(r.env, id, [
    { idem: "bad1", kind: "lifecycle", delivery: "queue", text: "permanently-rejected", session_id: SESSION, opencode_port: 65534, queued_at: 1 },
    { idem: "good2", kind: "lifecycle", delivery: "queue", text: "should-deliver", session_id: SESSION, opencode_port: 65534, queued_at: 2 },
  ]);
  // 头条恒 400（invalid = 永久拒绝），次条正常
  const realFetch = r.oc.fetchImpl;
  r.oc.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const bodyId = init?.body ? (JSON.parse(init.body as string) as { id?: string }).id : undefined;
    if (bodyId === "bad1") return new Response("{}", { status: 400 });
    return realFetch(url, init);
  }) as typeof fetch;
  r.deps.ocDeps = { ...r.deps.ocDeps, fetchImpl: r.oc.fetchImpl };

  // 旧实现：invalid 与 exhausted 混同 → retained=1 + break → good2 永不被尝试
  const out = await retryPendingTasks(r.deps);
  assert.equal(out.dropped, 1, `dropped=${out.dropped}`);
  assert.equal(out.delivered, 1, `delivered=${out.delivered}`);
  assert.equal(out.retained, 0);
  assert.equal(readPending(r.env, id).length, 0, "both entries retired");
  assert.ok(r.logs.some((l) => l.includes("invalid, permanent rejection")), r.logs.join(" | "));
  assert.ok(textOf(syntheticCalls(r).find((c) => c.body?.id === "good2")!).includes("should-deliver"));
});

test("重扫幂等守卫（Review 修复回归）：已在册任务不二次构造 Monitor", async () => {
  const r = rig();
  const { id } = await residue(r, "sleep 3");
  const res1 = await scanAndReclaim(r.deps);
  assert.equal(res1.claimed, 1);
  const mon1 = r.registry.get(id);
  const notices1 = syntheticCalls(r).length;

  // 同 registry 重扫（懒触发路径）：旧实现会 new 第二个 Monitor（双定时器/双投递）
  const res2 = await scanAndReclaim(r.deps);
  assert.deepEqual(res2, { claimed: 0, finalized: 0, failed: 0 });
  assert.strictEqual(r.registry.get(id), mon1, "registry entry must be the SAME Monitor instance");
  assert.equal(syntheticCalls(r).length, notices1, "no duplicate reconnected notice");

  await settle(r, id);
});

test("死路结局通知 pending-first（Review 修复回归）：投递在途时兜底已落盘，成功后移除", async () => {
  const r = rig(200);
  const { id } = await residue(r, "echo bye; exit 3");
  const metaBefore = readMeta(r.env, id)!;
  assert.ok(
    await waitFor(() => !isTaskProcessAlive({ pid: metaBefore.pid!, startTime: metaBefore.proc_start_time })),
    "task exits while unobserved",
  );
  // 投递人为延迟 200ms：scanAndReclaim 在途期间，pending 必须已含兜底条目
  // （旧顺序此时 pending 为空——重试窗口内二次崩溃即永久丢结局通知）
  const realFetch = r.oc.fetchImpl;
  r.oc.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("/synthetic")) await sleep(200);
    return realFetch(url, init);
  }) as typeof fetch;
  r.deps.ocDeps = { ...r.deps.ocDeps, fetchImpl: r.oc.fetchImpl };

  const inFlight = scanAndReclaim(r.deps);
  await sleep(100); // 进入投递延迟窗口（终态已落盘、通知未送达）
  const midPending = readPending(r.env, id);
  assert.equal(midPending.length, 1, "pending entry must exist while delivery is in flight");
  assert.ok(midPending[0]!.idem.includes("reattach_final"));

  const res = await inFlight;
  assert.equal(res.finalized, 1);
  assert.equal(readPending(r.env, id).length, 0, "retired after successful delivery");
  assert.equal(syntheticCalls(r).length, 1);
});

test("pending 重投：恢复后 FIFO 送达移除；404 放弃；仍失败保留（首败即停保序）", async () => {
  const r = rig(500); // opencode"不可达"期
  const id = "mon_pend000001";
  initTaskDir(r.env, id);
  writePending(r.env, id, [
    {
      idem: "msg_omt_p1",
      kind: "lifecycle",
      delivery: "queue",
      text: "<task-notification>first</task-notification>",
      session_id: SESSION,
      opencode_port: 65534,
      queued_at: 1,
    },
    {
      idem: "msg_omt_p2",
      kind: "lifecycle",
      delivery: "queue",
      text: "<task-notification>second</task-notification>",
      session_id: SESSION,
      opencode_port: 65534,
      queued_at: 2,
    },
  ]);

  // 仍不可达：首条失败即停（保序——前面没送到，后面不抢跑），两条均在册
  const r1 = await retryPendingTasks(r.deps);
  assert.equal(r1.retained, 1); // 只试了第 1 条
  assert.equal(r1.delivered, 0);
  assert.equal(readPending(r.env, id).length, 2);

  // 恢复：FIFO 全部送达
  r.oc.syntheticStatus = 200;
  const r2 = await retryPendingTasks(r.deps);
  assert.equal(r2.delivered, 2);
  assert.equal(readPending(r.env, id).length, 0); // 空即删文件
  const texts = syntheticCalls(r).map(textOf);
  assert.ok(texts.some((t) => t.includes("first")));
  assert.ok(texts.some((t) => t.includes("second")));
  // 幂等 id 复用（CONTRACT.md：重投必须同 id）
  const idems = syntheticCalls(r).map((c) => c.body?.id);
  assert.ok(idems.includes("msg_omt_p1"));

  // 404：放弃移除
  writePending(r.env, id, [
    {
      idem: "msg_omt_p3",
      kind: "lifecycle",
      delivery: "queue",
      text: "gone",
      session_id: SESSION,
      opencode_port: 65534,
      queued_at: 3,
    },
  ]);
  r.oc.syntheticStatus = 404;
  const r3 = await retryPendingTasks(r.deps);
  assert.equal(r3.dropped, 1);
  assert.equal(readPending(r.env, id).length, 0);
  assert.ok(r.logs.some((l) => l.includes("session gone")), r.logs.join(" | "));
});

test("pending 重投写回竞态闭合：投递期间 Monitor 新增条目不丢（filter 收口）", async () => {
  const r = rig(200);
  const id = "mon_race0000001";
  initTaskDir(r.env, id);
  // 构造：文件里 2 条，重投对 m1 送达 200、对 m2 返回 500（保留）；
  // 写回后 append 第 3 条（模拟 Monitor appendPending 与重投写回的交错），
  // 断言下轮 m2/m3 送达且 m1 未复活重投（filter 只移除已送达 idem；幂等 id 兜底）
  writePending(r.env, id, [
    { idem: "m1", kind: "wake", delivery: "queue", text: "one", session_id: SESSION, opencode_port: 65534, queued_at: 1 },
    { idem: "m2", kind: "wake", delivery: "queue", text: "two", session_id: SESSION, opencode_port: 65534, queued_at: 2 },
  ]);
  const realFetch = r.oc.fetchImpl;
  r.oc.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const bodyId = init?.body ? (JSON.parse(init.body as string) as { id?: string }).id : undefined;
    if (bodyId === "m2") {
      return new Response("{}", { status: 500 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  r.deps.ocDeps = { ...r.deps.ocDeps, fetchImpl: r.oc.fetchImpl };
  const out = await retryPendingTasks(r.deps);
  assert.equal(out.delivered, 1);
  assert.equal(out.retained, 1);
  // 期间新增第 3 条（模拟 Monitor appendPending 与重投写回的交错）
  appendPending(
    r.env,
    id,
    { idem: "m3", kind: "wake", delivery: "queue", text: "three", session_id: SESSION, opencode_port: 65534, queued_at: 3 },
    LIMITS.pendingMaxEntries,
  );
  // 下一轮：m2 已恢复送达、m3 送达——全部清空（m1 若未被 filter 掉会重投，幂等 id 保护）
  r.oc.fetchImpl = realFetch;
  r.deps.ocDeps = { ...r.deps.ocDeps, fetchImpl: realFetch };
  const out2 = await retryPendingTasks(r.deps);
  assert.equal(out2.delivered, 2, `delivered=${out2.delivered}`);
  assert.equal(readPending(r.env, id).length, 0);
});
