// 单任务状态机（PLAN §2.4/§2.5/§2.7/§2.8 / §6.1；SERVER-PLAN 阶段 D 骨架 + 阶段 E 管线
// 全套 + 阶段 F 裁决与管理）。已激活状态路径：
//   running ──► completed(exit "0") / failed(非零或信号)     —— 自然收尾路径
//   running ──► orphaned（通知目的地 session 死亡）           —— §2.8.2 + SERVER-PLAN §三-1
//   running ──► stopped（max_events 即停即杀，PLAN §3.3）      —— 阶段 E
//   running ──► idle（静默 idle_timeout_ms，裁决通知）          —— 阶段 F（§2.7 两段式）
//   idle ──► running（keepalive / 新输出自愈，重武装计时）      —— 阶段 F
//   idle ──► stopped（宽限一个完整窗口仍无裁决 → 自动杀）       —— 阶段 F（§三-5）
//   running/idle ──► stopped（stop 端点 / update 降额即杀）    —— 阶段 F
//   阶段 G：reattach 认领 fromMeta（absorbMissed + emitReconnect，
//   reattach.ts 编排）；投递耗尽落 pending（重投兜底，§2.8.2 末段）。
//
// 驱动：单一 250ms tick（SERVER-PLAN §一）——tail 增量 → 管线（preview 收集【前置于
// pattern 过滤】——§2.5 末 v1 bug 根治点 → scanned/matched 计数 → pattern 过滤 →
// coalesce 入窗/直通）→ coalesce 到期 flush → 令牌桶 + max_events 节流投递 → idle/
// 宽限到期检查（F——v1 的独立 idleTimer/graceTimer 全部收进 tick，不自持定时器）
// → 进程死活检查 → 终态收尾（尾批 flush 先入链，lifecycle 恒 queue 且不计 max_events、
// 绕令牌桶，PLAN §2.7-4；idle 裁决通知同规则）。
// 即停即杀触发点：第 max_events 条 wake 成功送达（onDelivered）——失败的通知不占额
// （D 阶段裁定：events_sent 成功回调计数 + wakeInFlight 防超发，与 v1 入链计数有意
// 分歧，进度记录在案）。
// idle 语义（v1 资产继承）：任何输出（含被过滤/被节流行）重置静默计时；转 idle 前
// 冲净 coalesce 批尾（裁决通知不得吞批尾）；裁决/退出通知恒 queue 绕桶不占额。
// createTask 编排：validate（shared）→ session 存活上限 16（⓪，本地先于网络）→
// resolveTarget 白名单（400）→ directory 存在（400，同步本地校验先于网络）→
// session 存活（404）→ spawn → 看护接管。fail fast 全过才开始执行。

import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, rmSync, statSync } from "node:fs";
import {
  LIMITS,
  buildEnvelope,
  validateCreateInput,
  type ApiError,
  type Delivery,
  type ExitInfo,
  type PathEnv,
  type PublicInfo,
} from "@omt/shared";
import { resolveTarget, verifySessionAlive, type OcDeps, type OpencodeRegistry } from "./opencode.ts";
import { exitCodeFromRaw, isTaskProcessAlive, killTree, spawnTask } from "./spawner.ts";
import {
  appendPending,
  initTaskDir,
  metaToPublicInfo,
  readExitFile,
  writeMeta,
  type PendingEntry,
  type TaskFilePaths,
  type TaskMeta,
} from "./taskstore.ts";
import { LogTail } from "./tail.ts";
import { Coalescer, TokenBucket, formatCoalesced, makeMatcher, type Matcher } from "./pipeline.ts";
import { DeliverChain, deliverNotification, type DeliverOutcome } from "./deliver.ts";
import { isAliveState, type TaskRegistry } from "./registry.ts";

// ---------------------------------------------------------------------------
// createTask：fail fast 校验 + spawn + 看护接管

export interface MonitorDeps {
  env: PathEnv;
  /** opencode 实例白名单注册表（§2.8.1） */
  ocRegistry: OpencodeRegistry;
  /** 服务端日志（不记命令全文，PLAN §4） */
  log: (msg: string) => void;
  ocDeps?: OcDeps;
  /** 等待注入（deliver 重试退避 + exit 文件竞态宽限；单测加速） */
  sleep?: (ms: number) => Promise<void>;
  /** 时钟注入（令牌桶补充 + coalesce 窗口判定；单测可控推进） */
  now?: () => number;
  /** tick 周期（默认 LIMITS.tailIntervalMs；单测可缩短） */
  tickMs?: number;
  /** 投递重试间隔（默认 500/2s/8s） */
  retryDelaysMs?: readonly number[];
}

export type CreateTaskOutcome =
  | { ok: true; info: PublicInfo }
  | { ok: false; status: number; error: ApiError };

/** 管理端点（stop/keepalive/PATCH/log）出参：http 层直接映射 status + body */
export type ManageOutcome = CreateTaskOutcome;

/** GET log 出参（裸文本，非 PublicInfo） */
export type ReadLogOutcome =
  | { ok: true; text: string }
  | { ok: false; status: number; error: ApiError };

/** session 存活上限拒绝（首查与复检共用出参） */
function sessionCapError(sessionId: string): { ok: false; status: number; error: ApiError } {
  return {
    ok: false,
    status: 400,
    error: {
      error: `session ${sessionId} already has ${LIMITS.sessionMaxAliveTasks} live tasks (per-session cap)`,
      code: "SESSION_TASK_LIMIT",
    },
  };
}

export async function createTask(
  deps: MonitorDeps & { registry: TaskRegistry },
  body: unknown,
): Promise<CreateTaskOutcome> {
  const ocDeps = deps.ocDeps ?? {};
  const v = validateCreateInput(body);
  if (!v.ok) {
    return { ok: false, status: 400, error: { error: "invalid task input", code: "INVALID_INPUT", detail: v.violations } };
  }
  const input = v.value;

  // fail fast ⓪：每 session 存活任务上限（PLAN §2.4——服务端内存态，R5-2 根治；
  // 本地纯内存检查先于一切网络校验）
  if (deps.registry.aliveCountForSession(input.session_id) >= LIMITS.sessionMaxAliveTasks) {
    return sessionCapError(input.session_id);
  }

  // fail fast ①：opencode_port 白名单三层校验（§2.8.1——模型幻觉端口/任意本地服务拒绝）
  const target = await resolveTarget(deps.ocRegistry, input.opencode_port, deps.env, ocDeps);
  if (!target.ok) {
    return {
      ok: false,
      status: 400,
      error: { error: `opencode_port ${input.opencode_port} rejected: ${target.reason}`, code: target.code },
    };
  }
  // fail fast ②：directory 绝对路径（validate 已做）+ 存在且是目录（§3.3 服务端侧校验；
  // 同步本地校验先于网络校验——省一次对死目标的往返）
  const dir = input.directory ?? process.cwd();
  let dirOk = false;
  try {
    dirOk = statSync(dir).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    return { ok: false, status: 400, error: { error: `directory does not exist: ${dir}`, code: "BAD_DIRECTORY" } };
  }
  // fail fast ③：session 存活实测（§3.3——404 拒绝；verifySessionAlive 的 catch-all
  // 把网络瞬断也归为 false，detail 如实标注两种可能，避免误导 agent）
  if (!(await verifySessionAlive(target.svc, input.session_id, ocDeps))) {
    return {
      ok: false,
      status: 404,
      error: {
        error: `session ${input.session_id} not found on port ${input.opencode_port} (404, or liveness check failed — opencode busy/restarted?)`,
        code: "SESSION_NOT_FOUND",
      },
    };
  }

  // fail fast ⓪′：session 上限复检（Review 修复：TOCTOU 防御）——首查 ⓪ 与登记之间
  // 经历两次网络 await，同 session 并发创建可同时通过首查；本复检之后至
  // registry.add 全程同步（initTaskDir/spawnTask/构造/add 均无 await），检查-登记
  // 原子化，并发竞态窗口闭合
  if (deps.registry.aliveCountForSession(input.session_id) >= LIMITS.sessionMaxAliveTasks) {
    return sessionCapError(input.session_id);
  }

  const id = `mon_${randomBytes(6).toString("hex")}`;
  const paths = initTaskDir(deps.env, id);
  let spawned;
  try {
    spawned = spawnTask(paths, input.command, { cwd: dir });
  } catch (err) {
    try {
      rmSync(paths.dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    return { ok: false, status: 500, error: { error: `spawn failed: ${String(err)}`, code: "SPAWN_FAILED" } };
  }
  const now = Date.now();
  const meta: TaskMeta = {
    schema: 1,
    id,
    command: input.command,
    description: input.description ?? null,
    session_id: input.session_id,
    opencode_port: input.opencode_port,
    pid: spawned.pid,
    pgid: spawned.pgid,
    proc_start_time: spawned.procStartTime,
    started_at: now,
    directory: dir,
    pattern: input.pattern ?? null,
    wake_mode: input.wake_mode,
    delivery: input.delivery,
    coalesce_ms: input.coalesce_ms,
    max_events: input.max_events,
    idle_timeout_ms: input.idle_timeout_ms,
    last_offset: 0,
    lines_scanned: 0,
    lines_matched: 0,
    events_sent: 0,
    events_dropped: 0,
    state: "running",
    exit_info: null,
    grace_deadline: null,
    claimed_by: process.pid,
    updated_at: now,
  };
  let mon: Monitor;
  try {
    mon = new Monitor(deps, meta, paths);
  } catch (err) {
    // 构造失败（如 meta 首写碰上磁盘故障）：不留幽灵进程与残目录（R5-1 类残余入口）
    await killTree(spawned.pgid).catch(() => {});
    try {
      rmSync(paths.dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    return { ok: false, status: 500, error: { error: `monitor init failed: ${String(err)}`, code: "MONITOR_INIT_FAILED" } };
  }
  deps.registry.add(mon);
  deps.log(`task ${id} created (session ${meta.session_id}, port ${meta.opencode_port})`);
  return { ok: true, info: mon.toPublicInfo() };
}

// ---------------------------------------------------------------------------
// Monitor：看护循环

/** 服务端实例 epoch（模块加载时刻，进程内恒定）——幂等 id 防跨重启碰撞：
 *  G 阶段 reattach 后新通知若复用崩溃前的 seq（同任务同序号），synthetic 的
 *  同 id 重放会静默丢弃新内容（CONTRACT.md 实测：返回首次响应） */
export const INSTANCE_EPOCH = Date.now().toString(36);

export function reasonFromCode(code: string): ExitInfo["reason"] {
  if (code.startsWith("signal:")) return "killed";
  if (code === "unknown") return "unknown";
  return "exited";
}

export class Monitor {
  readonly id: string;
  private readonly deps: MonitorDeps;
  private readonly paths: TaskFilePaths;
  private readonly identity: { pid: number; startTime: number | null };
  private readonly pgid: number;
  private readonly tail: LogTail;
  private readonly chain = new DeliverChain();
  private readonly now: () => number;
  private readonly matcher: Matcher | null;
  private readonly bucket: TokenBucket;
  private readonly coalescer: Coalescer | null; // coalesce_ms > 0 时存在；0 = 直通
  /** 尾部预览 ring（未过滤行流，前置于 pattern 过滤收集——§2.5 末 v1 bug 根治；
   *  G 阶段 reattach 摘要数据源，PLAN §2.9-3） */
  private readonly preview: string[] = [];
  private meta: TaskMeta;
  private totalBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private finalizing = false;
  private notifySeq = 0;
  /** 在途 wake 数——与 events_sent 合用构成 max_events 判定（防异步投递窗口超发） */
  private wakeInFlight = 0;
  /** 最近一次输出/keepalive 时刻（v1 资产：任何输出重置静默计时，含被过滤/被节流行；
   *  spawn 即武装——从未输出的任务静默满窗口同样触发裁决）。不落盘：G 阶段 reattach
   *  按"无观察者不计时，重挂后从零武装"（PLAN §2.9-4） */
  private lastActivityAt: number;

  constructor(deps: MonitorDeps, meta: TaskMeta, paths: TaskFilePaths) {
    this.deps = deps;
    this.meta = meta;
    this.paths = paths;
    this.id = meta.id;
    this.identity = { pid: meta.pid ?? -1, startTime: meta.proc_start_time };
    this.pgid = meta.pgid ?? meta.pid ?? -1;
    this.now = deps.now ?? (() => Date.now());
    this.lastActivityAt = this.now(); // spawn 即武装静默计时（v1 armIdle-at-start 语义）
    this.matcher = makeMatcher(meta.pattern, meta.wake_mode);
    this.bucket = new TokenBucket({ now: this.now });
    this.coalescer = meta.coalesce_ms > 0 ? new Coalescer(meta.coalesce_ms) : null;
    // 断点续读（G 阶段 reattach）：起点 = meta.last_offset（行安全断点，tail.ts 语义）。
    // createTask 路径 last_offset 恒 0，行为不变；reattach 认领前先 absorbMissed
    // 消费缺席增量（摘要化，绝不逐行重放——PLAN §2.9-3），此后新输出走正常管线
    this.tail = new LogTail(paths.log, meta.last_offset);
    this.totalBytes = meta.last_offset; // 已消费绝对字节（续读时从断点起算——persistOffset 依赖）
    this.writeMeta();
    const tickMs = deps.tickMs ?? LIMITS.tailIntervalMs;
    this.timer = setInterval(() => void this.tick(), tickMs);
  }

  /** 尾部预览（未过滤；G 阶段 reattach 摘要数据源） */
  latestPreview(): readonly string[] {
    return this.preview;
  }

  // -------------------------------------------------------------------
  // reattach 认领（G 阶段；PLAN §2.9——由 reattach.ts 在构造后同步调用，
  // 先于任何 tick 回调：JS 单线程下构造→吸收→摘要通知是无竞态原子序列）

  /** 吸收缺席期间的输出：只记账不投递（pumpSilent 复用 ingestLines——scanned/matched
   *  分类与 preview 收集和正常管线完全一致；offset 前进 = 这段输出已被消费，
   *  之后的 tick 只投递新输出）。idle 计时不受缺席行影响（§2.9-4 从零武装）。 */
  absorbMissed(): { lines: number; matched: number } {
    const before = { scanned: this.meta.lines_scanned, matched: this.meta.lines_matched };
    this.pumpSilent();
    return {
      lines: this.meta.lines_scanned - before.scanned,
      matched: this.meta.lines_matched - before.matched,
    };
  }

  /** reattach 摘要通知（§2.9-3）：一条合并（N 行 / K 命中 / 尾部预览），绝不逐行
   *  重放。lifecycle 同级规则：恒 queue、绕令牌桶、不计 max_events（恢复语义通知，
   *  占额会在达顶场景丢摘要——违背"不哑跑"哲学）。预览数据源 = latestPreview()
   *  （前置于 pattern 过滤收集——v1 bug 根治点在 reattach 路径同样生效）。 */
  emitReconnect(stats: { lines: number; matched: number }): void {
    const m = this.meta;
    const body = [
      `reconnected: task survived a server restart; ${stats.lines} line(s) of output were produced while unobserved (${stats.matched} matched) — summarized, not replayed line-by-line.`,
      ...(this.preview.length > 0 ? [`tail preview:`, ...this.preview] : []),
      `events: ${m.events_sent + this.wakeInFlight} sent, ${m.events_dropped} dropped`,
    ].join("\n");
    this.enqueueNotification({
      kind: "lifecycle",
      delivery: "queue",
      text: buildEnvelope({ id: this.id, description: m.description, body }),
    });
  }

  toPublicInfo(): PublicInfo {
    let logBytes = 0;
    try {
      logBytes = statSync(this.paths.log).size;
    } catch {
      // log 尚未创建（理论不可达：spawnTask 先建 log）
    }
    // 构造逻辑与 StoredTaskView 同源（taskstore.metaToPublicInfo 单一真源）
    const info = metaToPublicInfo(this.meta, this.now);
    info.log_bytes = logBytes;
    return info;
  }

  // -------------------------------------------------------------------
  // tick：读增量 → 管线 → coalesce 到期 → idle/宽限到期 → 死活检查 → 收尾
  // （F 起 v1 的独立 idleTimer/graceTimer 全部收进本 tick，不自持定时器）

  private async tick(): Promise<void> {
    if (this.finalizing) return;
    try {
      // 死亡检测先行：pump 的落盘故障不得绑架收尾（Review 修复实测：否则任务卡 running）
      if (!isTaskProcessAlive(this.identity)) {
        await this.finalize();
        return;
      }
      this.pump(); // idle 态下有输出会在 pump 内自愈回 running（v1 资产）
      if (this.meta.state === "running") {
        this.flushCoalesceIfDue();
        if (this.now() - this.lastActivityAt >= this.meta.idle_timeout_ms) this.enterIdle();
      } else if (this.meta.state === "idle") {
        const gd = this.meta.grace_deadline;
        // 宽限期 = 一个完整 idle_timeout_ms 窗口（SERVER-PLAN §三-5）；到期仍 idle → 自动杀
        if (gd !== null && this.now() >= gd) void this.stopForIdleTimeout();
      }
    } catch (err) {
      this.safeLog(`task ${this.id} tick error: ${String(err)}`);
    }
  }

  /** 日志通道自身故障不外泄（吞掉——看护优先于日志） */
  private safeLog(msg: string): void {
    try {
      this.deps.log(msg);
    } catch {
      // 日志通道故障：到此为止
    }
  }

  /** meta 落盘容错：磁盘故障只留痕，绝不阻断状态机推进（内存态为准，G 阶段 reattach 自愈） */
  private safeWriteMeta(): void {
    try {
      this.writeMeta();
    } catch (err) {
      this.safeLog(`task ${this.id} meta persist error: ${String(err)}`);
    }
  }

  /** 读增量并走管线：静默计时重置（任何输出都算活动，含被过滤/被节流行——v1 资产）
   *  → idle 自愈（新输出 → running，v1 resumeRunning）→ preview 收集（前置，§2.5 末）
   *  → scanned → pattern 过滤 → 命中行入 coalesce 窗（或直通 dispatch）。offset 持久化。 */
  private pump(): void {
    const r = this.tail.poll();
    if (r.bytesConsumed === 0) return;
    this.lastActivityAt = this.now();
    if (this.meta.state === "idle") {
      this.meta.state = "running";
      this.meta.grace_deadline = null;
      this.safeLog(`task ${this.id} resumed running (new output during idle grace)`);
    }
    this.totalBytes += r.bytesConsumed;
    this.ingestLines(r.lines, true);
    this.persistOffset();
  }

  /** 行流公共管线（投递与 silent 记账共用：preview/scanned/matched 分类一致，
   *  仅 silent 不投递——orphan 后无人可投，但计数语义不变） */
  private ingestLines(lines: readonly string[], deliverable: boolean): void {
    for (const line of lines) {
      // ① preview 收集前置于 pattern 过滤（v1 bug 根治点：pattern 模式下摘要预览
      //    恒空——顺序上根治，未命中行同样进预览）
      this.preview.push(line);
      if (this.preview.length > LIMITS.previewLines) this.preview.shift();
      // ② 计数：scanned 对全部清洗后非空行；matched 仅命中（直通无 pattern 时全命中）
      this.meta.lines_scanned += 1;
      const m = this.matcher !== null ? this.matcher.judge(line) : null;
      if (m === null) {
        this.meta.lines_matched += 1; // 直通：无过滤，全部命中
      } else if (m.matched) {
        this.meta.lines_matched += 1;
      } else if (!m.pass) {
        continue; // pattern 模式未命中：计数后丢弃，永不唤醒
      }
      // ③ pass 行投递：coalesce 窗口或直通
      if (!deliverable) continue;
      if (this.coalescer !== null) {
        this.coalescer.add(line, this.now());
      } else {
        this.dispatchWake(line);
      }
    }
  }

  /** 读尽余量只记账不投递（orphan 后无人可投） */
  private pumpSilent(): void {
    const r = this.tail.poll();
    if (r.bytesConsumed === 0) return;
    this.totalBytes += r.bytesConsumed;
    this.ingestLines(r.lines, false);
    this.persistOffset();
  }

  /** coalesce 窗口到期 flush（tumbling；到期判定由本 tick 驱动——SERVER-PLAN §一） */
  private flushCoalesceIfDue(): void {
    if (this.coalescer === null || !this.coalescer.due(this.now())) return;
    const batch = this.coalescer.flush();
    if (batch !== null) this.dispatchWake(formatCoalesced(batch));
  }

  /** 立即 flush 窗口内余量（终态收尾前调用：尾批先入链保序，v1 flushCoalesce 资产；
   *  绕 state 检查但保留令牌桶与 max_events 上限——v1 ignoreFinalized 语义） */
  private flushCoalesceNow(): void {
    if (this.coalescer === null) return;
    const batch = this.coalescer.flush();
    if (batch !== null) this.dispatchWake(formatCoalesced(batch));
  }

  private persistOffset(): void {
    this.meta.last_offset = this.totalBytes - this.tail.pendingBytes();
    this.safeWriteMeta();
  }

  // -------------------------------------------------------------------
  // 通知

  /** 节流投递一条 wake（单行或合并批正文）：max_events 达顶丢弃 → 令牌桶超限丢弃
   *  （v1 dispatchLine 资产顺序；超限丢弃计数、永不缓存）→ 入链。
   *  无 state 检查——终态尾批 flush 也走此路（v1 ignoreFinalized 语义：绕 state、
   *  保留桶与上限）。lifecycle 不走此路（恒入链绕桶不计额，PLAN §2.7-4）。 */
  private dispatchWake(text: string): void {
    if (this.meta.events_sent + this.wakeInFlight >= this.meta.max_events) {
      // 达顶停发（即停即杀在最后一条 wake 成功送达回调触发——失败通知不占额）
      this.meta.events_dropped += 1;
      return;
    }
    if (!this.bucket.tryTake()) {
      this.meta.events_dropped += 1;
      return;
    }
    if (this.chain.depth >= LIMITS.coalescePendingMax) {
      // 链上 pending 上限（v1 资产语义：防内存膨胀，超限丢弃计数）
      this.meta.events_dropped += 1;
      return;
    }
    this.wakeInFlight++;
    this.enqueueNotification({
      kind: "wake",
      delivery: this.meta.delivery,
      text: buildEnvelope({ id: this.id, description: this.meta.description, body: text }),
    });
  }

  private emitLifecycle(reason?: string): void {
    const m = this.meta;
    const body = [
      `finished: ${m.state}${m.exit_info ? ` (exit ${m.exit_info.code})` : ""}`,
      ...(reason !== undefined ? [reason] : []),
      `lines: ${m.lines_matched} matched, ${m.lines_scanned - m.lines_matched} filtered`,
      // sent 含在途 wake（保序下必先于本 lifecycle 送达——agent 视角一致；
      // 若在途者最终失败会补计 dropped，此处按发出时点口径）
      `events: ${m.events_sent + this.wakeInFlight} sent, ${m.events_dropped} dropped`,
    ].join("\n");
    // 恒 queue 且绕过链上限（PLAN §2.7-4：退出结局必须到达 agent）；绕令牌桶由
    // dispatchWake 之外直入链保证（lifecycle 不经 dispatchWake）
    this.enqueueNotification({
      kind: "lifecycle",
      delivery: "queue",
      text: buildEnvelope({ id: this.id, description: this.meta.description, body }),
    });
  }

  /** idle 裁决通知（§2.7 两段式第一段）：文案 v1 资产继承，工具话术指向 v2 的
   *  monitor_manage（PLAN §3.4）。与 lifecycle 同规则：恒 queue、绕令牌桶、不计
   *  max_events（PLAN §2.7-4"退出/裁决"同级）——裁决必须到达 agent。 */
  private emitIdleNotice(ms: number): void {
    const body = [
      `monitor idle: no output for ${ms}ms — command still running (pid ${this.meta.pid}).`,
      `Keep it: monitor_manage(action="keepalive", monitor_id="${this.id}") resets the idle timer.`,
      `Kill it now: monitor_manage(action="stop", monitor_id="${this.id}").`,
      `No decision within ${ms}ms (grace period): it will be killed automatically.`,
    ].join("\n");
    this.enqueueNotification({
      kind: "idle",
      delivery: "queue",
      text: buildEnvelope({ id: this.id, description: this.meta.description, body }),
    });
  }

  private enqueueNotification(n: { kind: "wake" | "lifecycle" | "idle"; delivery: Delivery; text: string }): void {
    const idem = `msg_omt_${INSTANCE_EPOCH}_${this.id}_${this.notifySeq++}`; // Session.Message.ID pattern ^msg_（真机实测：非 msg_ 前缀 400）
    // pending 落盘快照（G 阶段）：投递参数自包含——重投不依赖 meta 可读
    const entry: PendingEntry = {
      idem,
      kind: n.kind,
      delivery: n.delivery,
      text: n.text,
      session_id: this.meta.session_id,
      opencode_port: this.meta.opencode_port,
      queued_at: Date.now(),
    };
    const p = this.chain.run(() =>
      deliverNotification(
        {
          ocRegistry: this.deps.ocRegistry,
          env: this.deps.env,
          ocDeps: this.deps.ocDeps,
          retryDelaysMs: this.deps.retryDelaysMs,
          sleep: this.deps.sleep,
        },
        {
          sessionId: this.meta.session_id,
          opencodePort: this.meta.opencode_port,
          text: n.text,
          delivery: n.delivery,
          idempotencyId: idem,
        },
      ),
    );
    void p.then(
      (outcome) => this.safeOnDelivered(n.kind, outcome, entry),
      (err) =>
        this.safeOnDelivered(n.kind, { ok: false, kind: "exhausted", detail: `job threw: ${String(err)}` }, entry),
    );
  }

  /** onDelivered 的错误围栏：投递簿记里的任何异常（如 meta 落盘磁盘错误）不得变成
   *  unhandled rejection——那会经 uncaughtException 把整个服务端拖垮（main.ts exit 1） */
  private safeOnDelivered(kind: "wake" | "lifecycle" | "idle", outcome: DeliverOutcome, entry: PendingEntry): void {
    try {
      this.onDelivered(kind, outcome, entry);
    } catch (err) {
      this.safeLog(`task ${this.id} delivery bookkeeping error: ${String(err)}`);
    }
  }

  private onDelivered(kind: "wake" | "lifecycle" | "idle", outcome: DeliverOutcome, entry: PendingEntry): void {
    if (outcome.ok) {
      if (kind === "wake") {
        this.wakeInFlight--;
        this.meta.events_sent += 1; // lifecycle/idle 不计（不占 max_events 额度）
        this.safeWriteMeta();
        // 即停即杀（PLAN §3.3 "达顶即停即杀"）：第 max_events 条 wake 成功送达。
        // 竞态幂等：若进程已先自然死亡（finalize 已收尾），stopForMaxEvents 早退，
        // 自然终态优先——退出结局已由 lifecycle 送达，语义无损
        if (this.meta.events_sent >= this.meta.max_events) void this.stopForMaxEvents();
        return;
      }
      this.safeWriteMeta();
      return;
    }
    if (kind === "wake") this.wakeInFlight--;
    if (outcome.kind === "session-not-found") {
      if (this.finalizing) {
        // 任务已在收尾/已终态（lifecycle 或末批 wake 撞上 session 死亡）：看护无需撤除，
        // 但丢失必须留痕（不哑跑哲学）——计数 + 日志
        this.meta.events_dropped += 1;
        this.safeLog(
          `task ${this.id} notification dropped (${kind}/session-not-found, task already finalizing): ${outcome.detail.slice(0, 120)}`,
        );
        this.safeWriteMeta();
        return;
      }
      // §2.8.2：死 session 不无限重试 → orphaned；§三-1：SIGTERM 温和停止，看护撤除
      void this.orphan(outcome.detail);
      return;
    }
    if (outcome.kind === "exhausted") {
      // G 阶段（§2.8.2 降级链末段）：重试耗尽 → 落盘 pending，60s 周期重投兜底。
      // 账目口径：pending 在册不算丢（dropped = 真正放弃数）；仅被上限挤掉的
      // 最旧条目或落盘失败才计 dropped
      let evicted = 0;
      try {
        evicted = appendPending(this.deps.env, this.id, entry, LIMITS.pendingMaxEntries);
      } catch (err) {
        // pending 落盘失败（磁盘故障）：通知真正丢失——计 dropped 留痕
        this.meta.events_dropped += 1;
        this.safeLog(
          `task ${this.id} notification lost (${kind}: pending persist failed): ${String(err).slice(0, 120)}`,
        );
        this.safeWriteMeta();
        return;
      }
      if (evicted > 0) this.meta.events_dropped += evicted;
      this.safeLog(
        `task ${this.id} notification deferred to pending (${kind}, retries exhausted): ${outcome.detail.slice(0, 120)}`,
      );
      this.safeWriteMeta();
      return;
    }
    // invalid（4xx 契约错误，调用方 bug）：重投无意义，直接放弃计 dropped——契约测试守门
    this.meta.events_dropped += 1;
    this.safeLog(
      `task ${this.id} notification dropped (${kind}/${outcome.kind}): ${outcome.detail.slice(0, 120)}`,
    );
    this.safeWriteMeta();
  }

  // -------------------------------------------------------------------
  // 终态

  /** 自然收尾：尾批 flush（wake 先入链保序）→ exit 收集 → lifecycle → 终态落盘。
   *  状态推进以内存为准，各步落盘故障仅留痕（磁盘故障不卡状态机——Review 修复实测） */
  private async finalize(): Promise<void> {
    this.finalizing = true;
    this.stopTimer();
    try {
      this.pump(); // 进程已死，log 不再增长：此轮即读尽
      this.flushCoalesceNow(); // coalesce 窗内余量：尾批入链（lifecycle 之前，v1 资产）
    } catch (err) {
      this.safeLog(`task ${this.id} final pump error: ${String(err)}`);
    }
    const raw = await this.readExitWithGrace();
    const code = exitCodeFromRaw(raw);
    this.meta.state = code === "0" ? "completed" : "failed";
    this.meta.grace_deadline = null;
    this.meta.exit_info = { code, reason: reasonFromCode(code) };
    this.emitLifecycle();
    this.safeWriteMeta();
    this.tail.close();
    this.safeLog(`task ${this.id} finished: ${this.meta.state} exit=${code}`);
  }

  /** max_events 即停即杀（PLAN §3.3）：第 max_events 条 wake 成功送达回调触发。
   *  竞态幂等：若进程已先自然死亡（finalize 已收尾），自然终态优先——退出结局已由
   *  lifecycle 送达，语义无损 */
  private stopForMaxEvents(): Promise<void> {
    return this.stopAndFinalize(
      `reason: reached max_events=${this.meta.max_events}`,
      `task ${this.id} stopped: reached max_events=${this.meta.max_events}`,
    );
  }

  /** 人为/超限停止公共路径（F 提取，三路复用）：尾批 flush → SIGTERM 温和杀进程组
   *  （killTree 两档）→ stopped 终态 → lifecycle 注明 reason。调用方：stopForMaxEvents
   *  / stopForIdleTimeout / requestStop。经 void 调用（onDelivered 同步回调内）或
   *  await（管理端点）——全程围栏，异常外泄即 unhandled rejection（orphan 同款纪律） */
  private async stopAndFinalize(lifecycleReason: string, logLine: string): Promise<void> {
    if (this.finalizing) return; // 自然收尾/orphan/已停：先到者赢
    this.finalizing = true;
    this.stopTimer();
    try {
      this.flushCoalesceNow(); // 窗内余量仍属 agent（达顶批会被 dispatchWake 计 dropped）
      const tier = await killTree(this.pgid);
      const raw = await this.readExitWithGrace();
      const code = exitCodeFromRaw(raw);
      this.meta.state = "stopped";
      this.meta.grace_deadline = null;
      this.meta.exit_info = { code, reason: reasonFromCode(code) };
      this.emitLifecycle(lifecycleReason);
      this.safeWriteMeta();
      this.tail.close();
      this.safeLog(`${logLine} (process group killed, tier=${tier}, exit=${code})`);
    } catch (err) {
      // 看护撤除路径故障（如磁盘错误）：状态兜底推进 + 留痕，绝不外泄
      this.meta.state = "stopped";
      this.meta.grace_deadline = null;
      this.meta.exit_info = this.meta.exit_info ?? { code: "unknown", reason: "unknown" };
      try {
        this.writeMeta();
      } catch {
        // 双重故障：只剩日志
      }
      this.tail.close(); // close 内部自吞错
      this.safeLog(`task ${this.id} stop error (state forced to stopped): ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------
  // idle 两段式裁决（PLAN §2.7；v1 enterIdleGrace 资产，tick 驱动版）

  /** 第一段：静默满窗口（任何输出/keepalive 都会重置 lastActivityAt）→ 冲净批尾
   *  → 转 idle → 裁决通知（恒 queue 绕桶不占额）→ 宽限一个完整窗口（§三-5）。 */
  private enterIdle(): void {
    if (this.meta.state !== "running") return; // v1 guard：仅 running 态进入
    const ms = this.meta.idle_timeout_ms;
    this.flushCoalesceNow(); // 批尾先入链（v1：裁决通知不得吞批尾——此时 state 仍 running）
    this.meta.state = "idle";
    this.meta.grace_deadline = this.now() + ms;
    this.safeWriteMeta();
    this.emitIdleNotice(ms);
    this.safeLog(`task ${this.id} idle ${ms}ms without output — arbitration notice sent (grace ${ms}ms)`);
  }

  /** 第二段：宽限到期仍 idle（无 keepalive、无输出自愈）→ 自动杀（v1 reason 文案原样） */
  private stopForIdleTimeout(): Promise<void> {
    const ms = this.meta.idle_timeout_ms;
    const reason = `idle timeout after ${ms}ms without output (no keepalive within ${ms}ms grace period)`;
    return this.stopAndFinalize(`reason: ${reason}`, `task ${this.id} stopped: ${reason}`);
  }

  // -------------------------------------------------------------------
  // 管理操作（阶段 F；PLAN §2.2 端点语义，v1 stop/keepalive/update 资产继承）

  /** 管理操作存活门卫：终态、或收尾中（finalizing 窗口内 meta.state 尚未落终态——
   *  Review 修复：旧实此刻按 running 放行并翻转状态，响应声称任务活着）一律 409；
   *  null = 放行（live 判谓单源于 registry.isAliveState，勿另立副本） */
  private liveGuardError(action: string): ApiError | null {
    if (this.finalizing) {
      return { error: `task ${this.id} is finalizing (${action} is for live tasks)`, code: "TASK_TERMINAL" };
    }
    if (!isAliveState(this.meta.state)) {
      return { error: `task ${this.id} already ${this.meta.state} (${action} is for live tasks)`, code: "TASK_TERMINAL" };
    }
    return null;
  }

  /** POST /api/tasks/:id/stop：running/idle → 温和停止（await 完成后返回终态快照，
   *  响应准确反映结局——管理操作低频，killTree+exit 宽限的亚秒等待可接受）；
   *  终态 → 幂等 200 返回当前快照（v1 语义：already stopped 亦是成功） */
  async requestStop(): Promise<ManageOutcome> {
    if (!isAliveState(this.meta.state)) {
      return { ok: true, info: this.toPublicInfo() };
    }
    await this.stopAndFinalize("reason: stopped by request", `task ${this.id} stopped: by request`);
    return { ok: true, info: this.toPublicInfo() };
  }

  /** POST /api/tasks/:id/keepalive：idle → 复活 running + 重置静默计时（v1
   *  resumeRunning + armIdle）；running → 无害显式保活（仅重置计时）；
   *  终态/收尾中 → 409 拒绝（阶段 F 验收判据：终态上 keepalive/update 拒绝） */
  keepalive(): ManageOutcome {
    const guard = this.liveGuardError("keepalive");
    if (guard !== null) return { ok: false, status: 409, error: guard };
    if (this.meta.state === "idle") {
      this.meta.state = "running";
      this.meta.grace_deadline = null;
      this.lastActivityAt = this.now();
      this.safeWriteMeta();
      this.safeLog(`task ${this.id} resumed running (keepalive)`);
    } else {
      this.lastActivityAt = this.now(); // running：无害显式保活（v1 语义）
    }
    return { ok: true, info: this.toPublicInfo() };
  }

  /** PATCH /api/tasks/:id（max_events 运行时调整，PLAN §3.3 "运行中可调"）：
   *  降额后已达标（events_sent ≥ 新值）→ 立即即停即杀（v1 资产 same ceiling rule）；
   *  在途 wake 补足的情形由 onDelivered 用新上限自然触发。终态/收尾中 → 409。 */
  async updateMaxEvents(n: number): Promise<ManageOutcome> {
    const guard = this.liveGuardError("update");
    if (guard !== null) return { ok: false, status: 409, error: guard };
    this.meta.max_events = n;
    this.safeWriteMeta();
    if (this.meta.events_sent >= n) {
      await this.stopAndFinalize(
        `reason: reached max_events=${n} (lowered by update)`,
        `task ${this.id} stopped: reached max_events=${n} (lowered by update)`,
      );
    }
    return { ok: true, info: this.toPublicInfo() };
  }

  /** GET /api/tasks/:id/log?tail=N：原始合并流尾部 N 行（默认 20；裸文本响应——
   *  log 是 tail 读者的原始管道，此处只取尾不清洗）。
   *  有界读（Review 修复）：log 无轮转无上界（§9-2），整读会在事件循环上同步阻塞
   *  全部任务看护、内存尖峰可 OOM——只读尾 logTailMaxBytes 字节再切行；窗口起点
   *  落在行中/字符中时丢弃窗口首行（恰齐行界时保守丢弃一行，tail 语义无损），
   *  窗口内无换行（巨型单行）则整窗返回其尾部；超长行场景返回行数可能少于请求 */
  readLogTail(lines: number): ReadLogOutcome {
    if (!Number.isInteger(lines) || lines < 1 || lines > LIMITS.logTailMaxLines) {
      return {
        ok: false,
        status: 400,
        error: { error: `tail must be an integer in [1, ${LIMITS.logTailMaxLines}]`, code: "INVALID_TAIL" },
      };
    }
    let fd: number;
    try {
      fd = openSync(this.paths.log, "r");
    } catch {
      return { ok: true, text: "" }; // log 不可读（理论不可达：spawnTask 先建 log）→ 空尾
    }
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - LIMITS.logTailMaxBytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, start + got);
        if (n <= 0) break; // EOF（并发写不影响：读到多少算多少）
        got += n;
      }
      let parts = buf.subarray(0, got).toString("utf8").split("\n");
      if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop(); // 尾换行不成品行
      if (start > 0 && parts.length > 1) parts = parts.slice(1); // 窗口首行是残行
      return { ok: true, text: parts.slice(-lines).join("\n") };
    } finally {
      closeSync(fd); // close 内部不抛（fd 由 openSync 保证有效）
    }
  }

  /** orphaned：通知目的地已死——停止通知、SIGTERM 温和停止进程组（§三-1）。
   *  全程围栏：本方法经 void 调用（rejection 无人接），异常外泄即 unhandled rejection */
  private async orphan(detail: string): Promise<void> {
    if (this.finalizing) return; // 已在收尾（如 lifecycle 自身发现 session 死）
    this.finalizing = true;
    this.stopTimer();
    try {
      this.pumpSilent();
      const tier = await killTree(this.pgid);
      const raw = await this.readExitWithGrace();
      const code = exitCodeFromRaw(raw);
      this.meta.state = "orphaned";
      this.meta.grace_deadline = null;
      this.meta.exit_info = { code, reason: reasonFromCode(code) };
      this.safeWriteMeta();
      this.tail.close();
      this.safeLog(`task ${this.id} orphaned: ${detail.slice(0, 120)} (process group killed, tier=${tier})`);
    } catch (err) {
      // 看护撤除路径故障（如磁盘错误）：状态兜底推进 + 留痕，绝不外泄
      this.meta.state = "orphaned";
      this.meta.exit_info = this.meta.exit_info ?? { code: "unknown", reason: "unknown" };
      try {
        this.writeMeta();
      } catch {
        // 双重故障：只剩日志
      }
      this.tail.close(); // close 内部自吞错
      this.safeLog(`task ${this.id} orphan error (state forced to orphaned): ${String(err)}`);
    }
  }

  /** 进程死亡与 trap 写 exit 文件的竞态宽限（wrapper 几乎即时写；SIGKILL 则永无——unknown） */
  private async readExitWithGrace(): Promise<string | null> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < 3; i++) {
      const raw = readExitFile(this.deps.env, this.id);
      if (raw !== null) return raw;
      await sleep(100);
    }
    return null;
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private writeMeta(): void {
    this.meta.updated_at = Date.now();
    writeMeta(this.deps.env, this.meta);
  }
}
