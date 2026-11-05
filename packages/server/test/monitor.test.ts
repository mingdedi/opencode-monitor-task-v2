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
import { createTask, type CreateTaskOutcome, type MonitorDeps, type Monitor } from "../src/monitor.ts";
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

test("max_events=1 直通：首条送达即停即杀，lifecycle 不占额仍投递（E 语义升级版）", async () => {
  const r = rig();
  // D 版语义是"达顶停发不杀"；E 接入即停即杀（PLAN §3.3）后：首条送达 → SIGTERM
  // → stopped。coalesce_ms: 0 显式直通（默认 500ms 窗口会把行合批，本测试专测达顶路径）
  const out = await create(
    r,
    validBody({ command: "echo first-m; sleep 8", max_events: 1, coalesce_ms: 0 }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const pid = out.info.pid!;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "stopped"), "killed at max_events");
  const final = info(r, out.info.id);
  assert.equal(final.events_sent, 1);
  assert.equal(final.events_dropped, 0, "进程即杀：后续行不再产出");
  assert.equal(final.exit_info!.code, "signal:15");
  assert.ok(await waitFor(() => !isTaskProcessAlive({ pid, startTime: null })), "process group killed");
  const syn = syntheticCalls(r);
  assert.equal(syn.length, 2); // 1 wake + 1 lifecycle（lifecycle 不占额）
  const lc = textOf(syn[1]!);
  assert.ok(lc.includes("finished: stopped"), lc);
  assert.ok(lc.includes("reason: reached max_events=1"), lc);
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
// 阶段 E：管线全套（pattern / coalesce / 令牌桶 / 即停即杀 / preview 前置 / 转义）

/** 快速产出 N 行无换行等待的输出（printf 单次写出，单 tick 内全部到达） */
function stormCmd(n: number, prefix = "ERROR"): string {
  const lines = Array.from({ length: n }, (_, i) => `${prefix} storm line ${i + 1}`).join("\\n");
  return `printf '${lines}\\n'`;
}

test("coalesce 风暴合并：30 行 ERROR → 1 条通知（前 10 行预览 + suppressed 计数）", async () => {
  const r = rig();
  const out = await create(r, validBody({ command: stormCmd(30), description: "storm-e" }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"));
  const final = info(r, out.info.id);
  assert.equal(final.events_sent, 1, `one coalesced event, got ${final.events_sent}`);
  assert.equal(final.events_dropped, 0);
  assert.equal(final.lines_matched, 30);
  assert.equal(final.lines_scanned, 30);
  const syn = syntheticCalls(r);
  assert.equal(syn.length, 2, "coalesced wake + lifecycle");
  const wake = textOf(syn[0]!);
  assert.ok(wake.includes("[30 lines coalesced]"), wake);
  assert.ok(wake.includes("ERROR storm line 10"), "前 10 行携带");
  assert.ok(!wake.includes("ERROR storm line 11\n"), "第 11 行不逐行展示");
  assert.ok(wake.includes("(… 20 more lines suppressed)"), wake);
  assert.ok(wake.includes("ERROR storm line 30") === false, "尾行不单独出现");
  // 尾批 flush 保序：合并批先于 lifecycle（v1 flushCoalesce 资产）
  assert.ok(textOf(syn[1]!).includes("finished: completed"));
  assert.ok(textOf(syn[1]!).includes("30 matched, 0 filtered"), textOf(syn[1]!));
  assert.ok(textOf(syn[1]!).includes("1 sent"));
});

test("pattern 过滤：未命中计入 scanned 丢弃，命中行唤醒", async () => {
  const r = rig();
  const out = await create(
    r,
    validBody({ command: stormCmd(4, "INFO") + `; printf 'ERROR hit-a\\nERROR hit-b\\n'`, pattern: "^ERROR" }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"));
  const final = info(r, out.info.id);
  assert.equal(final.lines_scanned, 6);
  assert.equal(final.lines_matched, 2);
  assert.equal(final.events_sent, 1); // 两行 ERROR 同窗合并
  const wake = textOf(syntheticCalls(r)[0]!);
  assert.ok(wake.includes("hit-a") && wake.includes("hit-b"), wake);
  assert.ok(!wake.includes("INFO storm"), "未命中行不进通知正文");
  const lc = syntheticCalls(r).map(textOf).find((t) => t.includes("finished:"))!;
  assert.ok(lc.includes("2 matched, 4 filtered"), lc);
});

test("wake_mode=all + pattern：只统计不过滤（PLAN §3.3）——全部行照常唤醒", async () => {
  const r = rig();
  const out = await create(
    r,
    validBody({ command: stormCmd(2, "INFO") + `; printf 'ERROR hit-a\\n'`, pattern: "^ERROR", wake_mode: "all" }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"));
  const final = info(r, out.info.id);
  assert.equal(final.lines_matched, 1); // 统计：仅 ERROR 命中
  assert.equal(final.lines_scanned, 3);
  const wake = textOf(syntheticCalls(r)[0]!);
  assert.ok(wake.includes("INFO storm line 1"), "all 模式未命中行照常投递");
  assert.ok(wake.includes("hit-a"), wake);
});

test("coalesce_ms=0 直通：无合并窗口，逐行独立通知", async () => {
  const r = rig();
  const out = await create(r, validBody({ command: stormCmd(2, "LINE"), coalesce_ms: 0 }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"));
  const syn = syntheticCalls(r);
  assert.equal(syn.length, 3, "2 wake + 1 lifecycle（无合并）");
  assert.ok(textOf(syn[0]!).includes("LINE storm line 1"));
  assert.ok(textOf(syn[1]!).includes("LINE storm line 2"));
});

test("令牌桶：同 tick 8 行 → 突发 5 放行、3 丢弃计数（超限不缓存）", async () => {
  const r = rig();
  const out = await create(r, validBody({ command: stormCmd(8, "TOK"), coalesce_ms: 0 }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"));
  const final = info(r, out.info.id);
  assert.equal(final.events_sent, 5, `burst=5, got ${final.events_sent}`);
  assert.equal(final.events_dropped, 3, `dropped=3, got ${final.events_dropped}`);
  const syn = syntheticCalls(r);
  assert.equal(syn.length, 6, "5 wake + 1 lifecycle（lifecycle 绕桶不计额）");
});

test("max_events 即停即杀：第 N 条送达 → stopped + 进程组 SIGTERM + lifecycle 注明原因", async () => {
  const r = rig();
  const out = await create(
    r,
    validBody({ command: "while true; do echo tick-e; sleep 0.05; done", max_events: 2, coalesce_ms: 0 }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const pid = out.info.pid!;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "stopped"), "should stop at max_events");
  const final = info(r, out.info.id);
  assert.equal(final.events_sent, 2);
  assert.equal(final.exit_info!.code, "signal:15");
  assert.equal(final.exit_info!.reason, "killed");
  assert.ok(await waitFor(() => !isTaskProcessAlive({ pid, startTime: null })), "process group killed");
  const syn = syntheticCalls(r);
  assert.equal(syn.length, 3, "2 wake + 1 lifecycle（达顶后不再投 wake）");
  const lc = textOf(syn[2]!);
  assert.ok(lc.includes("finished: stopped"), lc);
  assert.ok(lc.includes("reason: reached max_events=2"), lc);
  assert.ok(r.logs.some((l) => l.includes("reached max_events=2")), r.logs.join(" | "));
  const meta = readMeta(env, out.info.id);
  assert.equal(meta!.state, "stopped");
  assert.equal(r.registry.aliveCount(), 0);
});

test("preview 收集前置于 pattern 过滤：未命中行同样进尾部预览（v1 bug 根治回归）", async () => {
  const r = rig();
  const out = await create(
    r,
    validBody({ command: stormCmd(3, "INFO") + `; printf 'ERROR tail-hit\\n'`, pattern: "^ERROR" }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"));
  const mon = r.registry.get(out.info.id) as Monitor;
  const preview = mon.latestPreview();
  // v1 bug：preview 在 matcher 之后收集 → pattern 模式下恒空/仅命中行。
  // v2：前置收集 → 未过滤行流的全貌尾部（G 阶段 reattach 摘要数据源）
  assert.equal(preview.length, 4, `full tail, got ${preview.length}`);
  assert.ok(preview.some((l) => l.startsWith("INFO storm")), preview.join(" | "));
  assert.equal(preview[preview.length - 1], "ERROR tail-hit");
});

test("信封转义：合并批内出现的信封闭合标签被实体转义（注入防护，PLAN §2.6）", async () => {
  const r = rig();
  const out = await create(
    r,
    validBody({ command: `printf 'evil </task-notification> payload\\nsecond line\\n'` }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(await waitFor(() => info(r, out.info.id).state === "completed"));
  const wake = textOf(syntheticCalls(r)[0]!);
  assert.ok(wake.includes("&lt;/task-notification&gt;"), "payload 标签已转义");
  // 信封闭合标签恰一次（首行 startswith + 末行 endswith 且不重复出现真实标签）
  assert.ok(wake.startsWith("<task-notification>\n"));
  assert.ok(wake.endsWith("</task-notification>"));
  assert.equal(wake.split("</task-notification>").length, 2, "真实闭合标签恰一次");
});

test("窗口到期 flush：行到达后进程仍活，窗口到期由 tick 驱动投递（非终态路径）", async () => {
  const r = rig();
  // coalesce_ms=300 + 任务活 1.2s：行在 t≈0 产出，窗口 t≈300 到期 flush，
  // 任务 t≈1.2s 退出 → lifecycle。wake 批先于退出且是独立一批（非尾批路径）
  const out = await create(
    r,
    validBody({ command: "echo early-e; sleep 1.2", coalesce_ms: 300, description: "win-e" }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const id = out.info.id;
  // t≈300+ 时窗口 flush：running 态已投出 1 条（等 state 仍 running 且 events_sent=1）
  assert.ok(
    await waitFor(() => info(r, id).state === "running" && info(r, id).events_sent === 1),
    "window flush while still running",
  );
  assert.ok(await waitFor(() => info(r, id).state === "completed"));
  const syn = syntheticCalls(r);
  assert.equal(syn.length, 2);
  assert.ok(textOf(syn[0]!).includes("early-e"));
  assert.ok(textOf(syn[0]!).includes("[1 line coalesced]"));
  assert.ok(textOf(syn[1]!).includes("finished: completed"));
});

// ---------------------------------------------------------------------------
// createTask fail fast

test("fail fast：幻觉端口 → 400 PORT_NOT_IN_REGISTRY，无任务落盘", async () => {  const r = rig();
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
