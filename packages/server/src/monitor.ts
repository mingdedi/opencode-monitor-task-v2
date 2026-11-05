// 单任务状态机（PLAN §2.4/§2.5/§2.7/§2.8 / §6.1；SERVER-PLAN 阶段 D 骨架）
// 全部状态枚举一次成型（TaskState 已含 idle/stopped/orphaned/parked），D 阶段激活：
//   running ──► completed(exit "0") / failed(非零或信号)     —— 自然收尾路径
//   running ──► orphaned（通知目的地 session 死亡）           —— §2.8.2 + SERVER-PLAN §三-1
// 留待后续：idle 两段式裁决 + stop/keepalive（F）；reattach 认领 fromMeta（G）；
//           pattern/coalesce/令牌桶/max_events 即停即杀（E，本版直通）。
//
// 驱动：单一 250ms tick（SERVER-PLAN §一）——tail 增量 → 直通管线（cleanLine 后
// 非空行即命中）→ 投递入链 → 进程死活检查 → 终态收尾（尾批 flush 先入链，lifecycle
// 恒 queue 且不计 max_events，PLAN §2.7-4）。
// createTask 编排：validate（shared）→ resolveTarget 白名单（400）→ directory 存在
// （400，同步本地校验先于网络）→ session 存活（404）→ spawn → 看护接管。
// fail fast 全过才开始执行。

import { randomBytes } from "node:crypto";
import { rmSync, statSync } from "node:fs";
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
import { initTaskDir, readExitFile, writeMeta, type TaskFilePaths, type TaskMeta } from "./taskstore.ts";
import { LogTail } from "./tail.ts";
import { DeliverChain, deliverNotification, type DeliverOutcome } from "./deliver.ts";
import type { TaskRegistry } from "./registry.ts";

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
  /** tick 周期（默认 LIMITS.tailIntervalMs；单测可缩短） */
  tickMs?: number;
  /** 投递重试间隔（默认 500/2s/8s） */
  retryDelaysMs?: readonly number[];
}

export type CreateTaskOutcome =
  | { ok: true; info: PublicInfo }
  | { ok: false; status: number; error: ApiError };

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
const INSTANCE_EPOCH = Date.now().toString(36);

function reasonFromCode(code: string): ExitInfo["reason"] {
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
  private meta: TaskMeta;
  private totalBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private finalizing = false;
  private notifySeq = 0;
  /** 在途 wake 数——与 events_sent 合用构成 max_events 判定（防异步投递窗口超发） */
  private wakeInFlight = 0;

  constructor(deps: MonitorDeps, meta: TaskMeta, paths: TaskFilePaths) {
    this.deps = deps;
    this.meta = meta;
    this.paths = paths;
    this.id = meta.id;
    this.identity = { pid: meta.pid ?? -1, startTime: meta.proc_start_time };
    this.pgid = meta.pgid ?? meta.pid ?? -1;
    this.tail = new LogTail(paths.log, 0); // G 阶段 reattach：从 meta.last_offset 续读
    this.writeMeta();
    const tickMs = deps.tickMs ?? LIMITS.tailIntervalMs;
    this.timer = setInterval(() => void this.tick(), tickMs);
  }

  toPublicInfo(): PublicInfo {
    let logBytes = 0;
    try {
      logBytes = statSync(this.paths.log).size;
    } catch {
      // log 尚未创建（理论不可达：spawnTask 先建 log）
    }
    const m = this.meta;
    return {
      id: m.id,
      description: m.description,
      state: m.state,
      session_id: m.session_id,
      opencode_port: m.opencode_port,
      directory: m.directory,
      command: m.command,
      pattern: m.pattern,
      wake_mode: m.wake_mode,
      delivery: m.delivery,
      coalesce_ms: m.coalesce_ms,
      max_events: m.max_events,
      idle_timeout_ms: m.idle_timeout_ms,
      idle_deadline: null, // F 阶段激活（idle 两段式裁决）
      grace_deadline: null, // F 阶段激活
      started_at: m.started_at,
      pid: m.pid,
      lines_scanned: m.lines_scanned,
      lines_matched: m.lines_matched,
      events_sent: m.events_sent,
      events_dropped: m.events_dropped,
      exit_info: m.exit_info,
      log_bytes: logBytes,
      last_offset: m.last_offset,
      updated_at: m.updated_at,
    };
  }

  // -------------------------------------------------------------------
  // tick：读增量 → 直通投递 → 死活检查 → 收尾

  private async tick(): Promise<void> {
    if (this.finalizing) return;
    try {
      // 死亡检测先行：pump 的落盘故障不得绑架收尾（Review 修复实测：否则任务卡 running）
      if (!isTaskProcessAlive(this.identity)) {
        await this.finalize();
        return;
      }
      this.pump();
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

  /** 读增量并按直通管线投递（cleanLine 后非空行即命中——E 阶段替换为 matcher） */
  private pump(): void {
    const r = this.tail.poll();
    if (r.bytesConsumed === 0) return;
    this.totalBytes += r.bytesConsumed;
    for (const line of r.lines) {
      this.meta.lines_matched += 1; // 直通：全部命中（scanned 留给 E 的 pattern 未命中计数）
      this.emitWake(line);
    }
    this.persistOffset();
  }

  /** 读尽余量只记账不投递（orphan 后无人可投） */
  private pumpSilent(): void {
    const r = this.tail.poll();
    if (r.bytesConsumed === 0) return;
    this.totalBytes += r.bytesConsumed;
    this.meta.lines_matched += r.lines.length;
    this.persistOffset();
  }

  private persistOffset(): void {
    this.meta.last_offset = this.totalBytes - this.tail.pendingBytes();
    this.safeWriteMeta();
  }

  // -------------------------------------------------------------------
  // 通知

  private emitWake(line: string): void {
    if (this.meta.events_sent + this.wakeInFlight >= this.meta.max_events) {
      // 达顶停发（E 阶段接入"即停即杀"完整语义，PLAN §3.3）
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
      text: buildEnvelope({ id: this.id, description: this.meta.description, body: line }),
    });
  }

  private emitLifecycle(): void {
    const m = this.meta;
    const body = [
      `finished: ${m.state}${m.exit_info ? ` (exit ${m.exit_info.code})` : ""}`,
      `lines: ${m.lines_matched} matched, ${m.lines_scanned} filtered`,
      `events: ${m.events_sent} sent, ${m.events_dropped} dropped`,
    ].join("\n");
    // 恒 queue 且绕过链上限（PLAN §2.7-4：退出结局必须到达 agent）；绕令牌桶由 E 管线接入时保证
    this.enqueueNotification({
      kind: "lifecycle",
      delivery: "queue",
      text: buildEnvelope({ id: this.id, description: this.meta.description, body }),
    });
  }

  private enqueueNotification(n: { kind: "wake" | "lifecycle"; delivery: Delivery; text: string }): void {
    const idem = `msg_omt_${INSTANCE_EPOCH}_${this.id}_${this.notifySeq++}`; // Session.Message.ID pattern ^msg_（真机实测：非 msg_ 前缀 400）
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
      (outcome) => this.safeOnDelivered(n.kind, outcome),
      (err) => this.safeOnDelivered(n.kind, { ok: false, kind: "exhausted", detail: `job threw: ${String(err)}` }),
    );
  }

  /** onDelivered 的错误围栏：投递簿记里的任何异常（如 meta 落盘磁盘错误）不得变成
   *  unhandled rejection——那会经 uncaughtException 把整个服务端拖垮（main.ts exit 1） */
  private safeOnDelivered(kind: "wake" | "lifecycle", outcome: DeliverOutcome): void {
    try {
      this.onDelivered(kind, outcome);
    } catch (err) {
      this.safeLog(`task ${this.id} delivery bookkeeping error: ${String(err)}`);
    }
  }

  private onDelivered(kind: "wake" | "lifecycle", outcome: DeliverOutcome): void {
    if (outcome.ok) {
      if (kind === "wake") {
        this.wakeInFlight--;
        this.meta.events_sent += 1; // lifecycle 不计（不占 max_events 额度）
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
      this.pump(); // 进程已死，log 不再增长：此轮即读尽（wake → 尾批 flush → lifecycle 严格序）
    } catch (err) {
      this.safeLog(`task ${this.id} final pump error: ${String(err)}`);
    }
    const raw = await this.readExitWithGrace();
    const code = exitCodeFromRaw(raw);
    this.meta.state = code === "0" ? "completed" : "failed";
    this.meta.exit_info = { code, reason: reasonFromCode(code) };
    this.emitLifecycle();
    this.safeWriteMeta();
    this.tail.close();
    this.safeLog(`task ${this.id} finished: ${this.meta.state} exit=${code}`);
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
