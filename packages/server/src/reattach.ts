// 崩溃恢复 reattach（PLAN §2.9；SERVER-PLAN 阶段 G）——服务端重启后的必经路径。
// 流程：扫 tasks/ 全部 meta.json（按 directory 无工作区限制，全部认领）→
//   (pid, starttime) 双因子判死活：
//     死 → 读 exit 收尾 → 缺席输出摘要（绝不逐行重放）→ 向所属 session 补发
//          合并结局通知 → StoredTaskView 进 registry（终态可见）
//     活 → 认领（idle 冻结裁定：恢复 running、宽限作废、静默从零武装——§2.9-4）
//          → Monitor（tail 从 last_offset 续读）→ absorbMissed 吸收缺席增量
//          → 有缺席行则 emitReconnect 一条摘要（lifecycle 同级：queue/绕桶/不计额）
//   认领失败（meta 可解析但看护资源故障，如 log 丢失）→ state=parked 落盘 +
//   StoredTaskView 进列表（P1 根治：等待认领可见，可 DELETE 清理）。
//   坏 meta：保守不删（§2.9-6；有 exit 佐证交 sweeper 同 TTL 清），仅计数留痕。
// 结果显式化：claimed/finalized/failed 进服务端日志与 health.reattach（§2.9-5）。
//
// 幂等性：终态 meta 直接跳过（补发发生在落终态之前——若通知已耗尽则落 pending，
// 重投兜底）；单实例锁保证无并发认领者。

import { LIMITS, buildEnvelope } from "@omt/shared";
import { makeMatcher } from "./pipeline.ts";
import { INSTANCE_EPOCH, Monitor, reasonFromCode, type MonitorDeps } from "./monitor.ts";
import { deliverNotification } from "./deliver.ts";
import { exitCodeFromRaw, isTaskProcessAlive } from "./spawner.ts";
import { LogTail } from "./tail.ts";
import {
  appendPending,
  listTaskIds,
  readExitFile,
  readMeta,
  readPending,
  StoredTaskView,
  taskFilePaths,
  writeMeta,
  writePending,
  type PendingEntry,
  type TaskMeta,
} from "./taskstore.ts";
import { isAliveState, type TaskRegistry } from "./registry.ts";

export interface ReattachResult {
  /** 认领存活任务数 */
  claimed: number;
  /** 收尾死亡任务数（补发合并结局通知） */
  finalized: number;
  /** 认领失败数（坏 meta / parked） */
  failed: number;
}

export type ReattachDeps = MonitorDeps & { registry: TaskRegistry };

/** 扫描并认领全部 store 任务（main.ts 启动时 + health 懒触发调用） */
export async function scanAndReclaim(deps: ReattachDeps): Promise<ReattachResult> {
  const result: ReattachResult = { claimed: 0, finalized: 0, failed: 0 };
  for (const id of listTaskIds(deps.env)) {
    // 重扫幂等防御（Review 修复）：懒触发路径在首扫失败后可整轮重跑——本实例已看护
    // （在册 Monitor / StoredTaskView）的任务跳过，否则二次构造 Monitor = 双定时器、
    // 双投递、双计数。单实例锁保证跨进程无并发认领，本守卫闭合同进程重扫
    if (deps.registry.get(id) !== undefined) continue;
    let meta: TaskMeta | null = null;
    try {
      meta = readMeta(deps.env, id);
    } catch (err) {
      // 坏 meta：保守不删（§2.9-6）；sweeper 按 exit 佐证同 TTL 处理
      result.failed++;
      deps.log(`task ${id} reattach: unreadable meta (${String(err).slice(0, 80)}) — left in place`);
      continue;
    }
    if (meta === null) {
      // 目录在而 meta 无（异常删除窗口）：同坏 meta 保守处理
      result.failed++;
      deps.log(`task ${id} reattach: meta.json missing — left in place`);
      continue;
    }
    if (!isAliveState(meta.state)) {
      // 终态：跳过（结局通知已在落终态前发出；若有 pending 由重投器兜底）。
      // 仍以 StoredTaskView 入册——registry 是 /api/tasks 与管理端点的第一真相源，
      // 重启后 store 终态/parked 必须对 GET/DELETE/list 可见（真机场景④暴露：
      // 仅靠 http 层合并视图兜底会漏掉 DELETE 路径）；200 上限自然管理
      // 极罕见的"终态 + 进程仍活"（stop 崩溃窗口残留）：不重发通知不杀进程，
      // 留日志观察（sweeper TTL 到点清目录时进程通常早已消亡）
      if (meta.pid !== null && isTaskProcessAlive({ pid: meta.pid, startTime: meta.proc_start_time })) {
        deps.log(`task ${id} reattach: terminal (${meta.state}) but process still alive — skipped, sweeper will TTL it`);
      }
      deps.registry.add(new StoredTaskView(meta, taskFilePaths(deps.env, id).log));
      continue;
    }
    // 活态 meta：双因子判死活（pid 缺失无法探活 → 按死收尾，exit unknown）
    const alive = meta.pid !== null && isTaskProcessAlive({ pid: meta.pid, startTime: meta.proc_start_time });
    if (!alive) {
      await finalizeDeadTask(deps, meta);
      result.finalized++;
      continue;
    }
    // 存活：认领。idle 冻结裁定（§2.9-4）——无观察者期间不计时，恢复 running、
    // 宽限作废、静默计时由 Monitor 构造从零武装；claimed_by 重写（双认领防御簿记）
    meta.state = "running";
    meta.grace_deadline = null;
    meta.claimed_by = process.pid;
    try {
      const mon = new Monitor(deps, meta, taskFilePaths(deps.env, id));
      // 构造 → 吸收 → 摘要：同步序列，先于任何 tick 回调（单线程原子性）
      const stats = mon.absorbMissed();
      if (stats.lines > 0) mon.emitReconnect(stats);
      deps.registry.add(mon);
      result.claimed++;
      deps.log(
        `task ${id} reattach: claimed (pid ${meta.pid}, ${stats.lines} missed line(s) summarized)`,
      );
    } catch (err) {
      // 看护资源故障（log 丢失/不可读等）：parked——不杀进程（可能有活输出在写）、
      // 不哑跑（列表可见等待处置）。可 stop？无 Monitor 实例 → DELETE 清理或人工修复
      meta.state = "parked";
      meta.grace_deadline = null;
      meta.updated_at = Date.now();
      try {
        writeMeta(deps.env, meta);
        deps.registry.add(new StoredTaskView(meta, taskFilePaths(deps.env, id).log));
      } catch {
        // parked 落盘失败（磁盘故障）：目录保持崩溃前 meta，下轮 reattach 再试
      }
      result.failed++;
      deps.log(`task ${id} reattach: cannot attach (${String(err).slice(0, 120)}) — parked`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 死任务收尾：缺席摘要 + exit 结局合并为一条通知（省 turn 预算——E 阶段裁定）

interface MissedSummary {
  lines: number;
  matched: number;
  preview: string[];
  /** 缺席增量已消费的绝对 offset（行安全断点；log 不可读时为原值） */
  newOffset: number;
}

/** 读缺席增量（last_offset → 文件尾）并按管线同款语义计数（scanned/matched/preview）。
 *  绝不投递、不逐行重放（§2.9-3）。log 丢失/不可读：返回零摘要（结局仍要送达）。 */
function summarizeMissed(env: ReattachDeps["env"], meta: TaskMeta): MissedSummary {
  const paths = taskFilePaths(env, meta.id);
  let tail: LogTail | null = null;
  try {
    tail = new LogTail(paths.log, meta.last_offset);
    const r = tail.poll();
    const matcher = makeMatcher(meta.pattern, meta.wake_mode);
    let matched = 0;
    const preview: string[] = [];
    for (const line of r.lines) {
      // preview 收集前置于 pattern 过滤（§2.5 末根治点——死路同款语义）
      preview.push(line);
      if (preview.length > LIMITS.previewLines) preview.shift();
      const m = matcher !== null ? matcher.judge(line) : null;
      if (m === null || m.matched) matched++;
    }
    const offset = meta.last_offset + r.bytesConsumed - tail.pendingBytes();
    return { lines: r.lines.length, matched, preview, newOffset: Math.max(meta.last_offset, offset) };
  } catch {
    return { lines: 0, matched: 0, preview: [], newOffset: meta.last_offset };
  } finally {
    tail?.close();
  }
}

async function finalizeDeadTask(deps: ReattachDeps, metaInput: TaskMeta): Promise<void> {
  const meta = metaInput;
  const missed = summarizeMissed(deps.env, meta);
  const raw = readExitFile(deps.env, meta.id);
  const code = exitCodeFromRaw(raw);
  meta.state = code === "0" ? "completed" : "failed";
  meta.grace_deadline = null;
  meta.exit_info = { code, reason: reasonFromCode(code) };
  meta.claimed_by = process.pid;
  meta.lines_scanned += missed.lines;
  meta.lines_matched += missed.matched;
  meta.last_offset = missed.newOffset;
  meta.updated_at = Date.now();
  try {
    writeMeta(deps.env, meta);
  } catch (err) {
    deps.log(`task ${meta.id} reattach: terminal meta persist failed (${String(err).slice(0, 80)})`);
  }

  // 合并通知（摘要 + 结局，一条）：lifecycle 同级——恒 queue、绕令牌桶、不计 max_events
  const body = [
    `reconnected: task finished while the server was away.`,
    `finished: ${meta.state}${meta.exit_info ? ` (exit ${meta.exit_info.code})` : ""}`,
    ...(missed.lines > 0
      ? [
          `${missed.lines} line(s) were produced while unobserved (${missed.matched} matched) — summarized, not replayed:`,
          ...missed.preview,
        ]
      : []),
    `lines: ${meta.lines_matched} matched, ${meta.lines_scanned - meta.lines_matched} filtered`,
    `events: ${meta.events_sent} sent, ${meta.events_dropped} dropped`,
  ].join("\n");
  const text = buildEnvelope({ id: meta.id, description: meta.description, body });
  const idem = `msg_omt_${INSTANCE_EPOCH}_${meta.id}_reattach_final`;

  // pending-first（Review 修复）：先落 pending 再投递。旧顺序（终态 meta 落盘 → 投递 →
  // 耗尽才落 pending）在重试窗口（默认退避全程 ~10.5s——恰是 opencode 不可达、最易
  // 连带崩溃的时段）内二次崩溃会永久丢失结局通知：下轮启动见终态直接跳过，pending
  // 尚未写入。先落后投则任何时点崩溃都由重投器凭同 idem 兜底；投递成功后移除
  // pending，若移除前崩溃 → 下轮重投同 id，synthetic 幂等去重，无害。
  // 注意：在册 Monitor 的 lifecycle 路径维持旧顺序（既有权衡——pending-first 对每条
  // 通知引入三倍 IO 且与 wake 不落盘的设计分歧，仅在恢复路径的单一通知上值得）
  let pendingOnDisk = false;
  try {
    const r = appendPending(
      deps.env,
      meta.id,
      {
        idem,
        kind: "lifecycle",
        delivery: "queue",
        text,
        session_id: meta.session_id,
        opencode_port: meta.opencode_port,
        queued_at: Date.now(),
      },
      LIMITS.pendingMaxEntries,
    );
    pendingOnDisk = true;
    if (r.evicted > 0) {
      meta.events_dropped += r.evicted;
      try {
        writeMeta(deps.env, meta);
      } catch {
        // best-effort
      }
    }
    if (r.reset) {
      deps.log(`task ${meta.id} pending: file was corrupt — reset (previous entries abandoned)`);
    }
  } catch (err) {
    // pending 落盘失败（磁盘故障）：仍尝试直投——成功则无需兜底，失败即真丢（留痕）
    deps.log(`task ${meta.id} reattach: pending pre-write failed (${String(err).slice(0, 60)}) — delivering anyway`);
  }

  const outcome = await deliverNotification(
    {
      ocRegistry: deps.ocRegistry,
      env: deps.env,
      ocDeps: deps.ocDeps,
      retryDelaysMs: deps.retryDelaysMs,
      sleep: deps.sleep,
    },
    {
      sessionId: meta.session_id,
      opencodePort: meta.opencode_port,
      text,
      delivery: "queue",
      idempotencyId: idem,
    },
  );
  if (outcome.ok) {
    if (pendingOnDisk) retirePending(deps, meta.id, idem);
    deps.log(`task ${meta.id} reattach: finalized ${meta.state} (exit ${code}), outcome notice delivered`);
  } else if (outcome.kind === "session-not-found") {
    // 会话已死：pending 无处可去，移除 + 计 dropped 留痕（不哑跑）；终态照常
    if (pendingOnDisk) retirePending(deps, meta.id, idem);
    meta.events_dropped += 1;
    try {
      writeMeta(deps.env, meta);
    } catch {
      // best-effort
    }
    deps.log(`task ${meta.id} reattach: finalized ${meta.state}, but session is gone (notice dropped)`);
  } else {
    // 耗尽：pending 已在册，重投器兜底；invalid 同样留给重投器按永久失败丢弃（不重投）
    deps.log(`task ${meta.id} reattach: finalized ${meta.state}, outcome notice deferred to pending`);
  }
  deps.registry.add(new StoredTaskView(meta, taskFilePaths(deps.env, meta.id).log));
}

/** 移除单条 pending（投递成功/死 session 后收尾）；失败无害：残留条目由重投器以同
 *  idem 重投，synthetic 幂等去重 */
function retirePending(deps: ReattachDeps, id: string, idem: string): void {
  try {
    const current = readPending(deps.env, id);
    writePending(deps.env, id, current.filter((e) => e.idem !== idem));
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// pending 重投（SERVER-PLAN §三-2：独立 60s 周期，不等 sweeper 的 10min）
// 遍历 store 全部任务（死任务目录同样有 pending——结局通知的兜底也在这里）；
// 逐条复用原幂等 id 重投（CONTRACT.md：先到的 200 后重放安全，真去重）。
// 处置分类：ok → 移除；404/invalid（永久失败）→ 丢弃计 dropped 并继续；
// exhausted（暂不可达）→ 保留并停试其后条目（保序——前面没送到，后面不抢跑）。
// 并发闭合：与 Monitor 的 appendPending 同文件读改写竞态，用"结束时重读并过滤
// 本轮已送达 idem"收口（单线程内 filter 原子；期间新增的条目自然保留）。

export interface PendingRetryResult {
  /** 重投成功移除条数 */
  delivered: number;
  /** 404 放弃条数（死 session；账目在重投器统计与 server.log，不回写 meta——
   *  meta 可能正被在册 Monitor 并发改写，盲目回写会竞态覆盖） */
  dropped: number;
  /** 仍失败保留条数（下轮再试） */
  retained: number;
}

export async function retryPendingTasks(deps: ReattachDeps): Promise<PendingRetryResult> {
  const out: PendingRetryResult = { delivered: 0, dropped: 0, retained: 0 };
  for (const id of listTaskIds(deps.env)) {
    let entries: PendingEntry[];
    try {
      entries = readPending(deps.env, id);
    } catch (err) {
      deps.log(`task ${id} pending: unreadable (${String(err).slice(0, 60)}) — reset`);
      continue;
    }
    if (entries.length === 0) continue;
    const deliveredIdems = new Set<string>();
    for (const entry of entries) {
      const outcome = await deliverNotification(
        {
          ocRegistry: deps.ocRegistry,
          env: deps.env,
          ocDeps: deps.ocDeps,
          retryDelaysMs: deps.retryDelaysMs,
          sleep: deps.sleep,
        },
        {
          sessionId: entry.session_id,
          opencodePort: entry.opencode_port,
          text: entry.text,
          delivery: entry.delivery,
          idempotencyId: entry.idem,
        },
      );
      if (outcome.ok) {
        deliveredIdems.add(entry.idem);
        out.delivered++;
        continue;
      }
      if (outcome.kind === "session-not-found") {
        // 死 session：pending 无处可去，放弃计 dropped（活任务的 orphan 由正常管线触发；
        // pending 里的多为终态任务结局或服务端缺席期间的补发——session 死了就放手）
        out.dropped++;
        deliveredIdems.add(entry.idem); // 从 pending 移除
        deps.log(`task ${id} pending: entry dropped (session gone): ${outcome.detail.slice(0, 80)}`);
        continue;
      }
      if (outcome.kind === "invalid") {
        // 永久拒绝（4xx 契约错误）：重投永无成功可能（§2.8.2 invalid 不重试）——丢弃
        // 计 dropped 并继续。Review 修复：旧实现把 invalid 与 exhausted 混同保留并
        // break——队首一条 invalid 将永久阻塞其后的全部条目（每轮单次尝试后即停），
        // pending 队列静默饿死
        out.dropped++;
        deliveredIdems.add(entry.idem); // 从 pending 移除
        deps.log(`task ${id} pending: entry dropped (invalid, permanent rejection): ${outcome.detail.slice(0, 80)}`);
        continue;
      }
      // exhausted：目标暂不可达——保留下轮再试；保序起见本轮不试其后条目
      out.retained++;
      break;
    }
    if (deliveredIdems.size === 0) continue; // 全保留：无写回必要
    try {
      // 竞态闭合：重读后过滤本轮已送达/已放弃的 idem（期间 Monitor 新增的保留）
      const current = readPending(deps.env, id);
      writePending(deps.env, id, current.filter((e) => !deliveredIdems.has(e.idem)));
      deps.log(`task ${id} pending: ${deliveredIdems.size} entr(y/ies) retired after retry`);
    } catch (err) {
      deps.log(`task ${id} pending: rewrite failed (${String(err).slice(0, 60)}) — retried entries may redeliver (idempotent)`);
    }
  }
  return out;
}
