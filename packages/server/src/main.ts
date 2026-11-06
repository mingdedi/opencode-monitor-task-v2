// 服务端入口
// 职责：platform gate → 单实例锁（O_EXCL，内容含 pid）→ 127.0.0.1 随机端口监听
//       → service.json 600 原子写 → 信号处理（默认不杀任务；
//         --shutdown-all / kill_tasks=true 时击杀全部任务进程组）
//       → 日志落 state 目录（默认关闭；--debug / DEBUG=1 启动时开启，开启后也不记
//         命令全文；日志是启动时决定的 debug 选项，不做轮转）
//       → opencode 实例注册表（--opencode-state 多条目；health 实例表实测）
//       → 任务注册表 + 任务端点装配（POST /api/tasks + GET 列表/详情；
//         stop/keepalive/PATCH/DELETE/log + session 上限/registry 驱逐；
//         reattach 认领 + pending 重投 + sweeper TTL + /api/shutdown +
//         列表/详情与 TaskStore 合并视图——parked 与终态从 store 出）
//
// 创建竞态语义：先原子抢锁 → in-use 后到者核对/等待已有 service.json 的 health，
// 健康则打印后退出码 0（后到者自然退出，service.json 由最终存活者持有）；死持锁者可抢。

import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
  envFromProcess,
  LIMITS,
  lockFilePath,
  serverLogPath,
  serviceFilePath,
  stateDir,
  taskDir,
  validatePatchInput,
  versionCompatible,
  type HealthInfo,
  type PathEnv,
  type PublicInfo,
  type ServiceFile,
} from "@omt/shared";
import { createMonitorHttpServer, type TaskEndpointOutcome } from "./http.ts";
import { buildRegistry, parseOpencodeStateArgs, probeInstances, type OpencodeRegistry } from "./opencode.ts";
import { createTask, Monitor, type MonitorDeps } from "./monitor.ts";
import { retryPendingTasks, scanAndReclaim, type ReattachResult } from "./reattach.ts";
import { startSweeper } from "./sweeper.ts";
import { TaskRegistry, isAliveState } from "./registry.ts";
import { ensurePrivateDir, listTaskIds, readMeta, StoredTaskView, taskFilePaths, writeFileAtomic } from "./taskstore.ts";

export const SERVER_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** 后到者等待持锁者就绪的上限（持锁者经 tsx 冷启动，留足余量） */
const WAIT_HOLDER_MS = 8000;
const WAIT_POLL_MS = 250;
/** 对已有实例的 health 探测超时 */
const PROBE_TIMEOUT_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 单实例锁

/** 探活：kill(pid,0) + /proc state 字母纠错（Z 僵尸按死；锁内简化版——
 *  任务进程的 (pid, starttime) 双因子版在 spawner.ts）。
 *  /proc stat 解析从最后一个 ')' 之后取字段。 */
export function lockIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM：进程存在但归属他人——保守视为活（不可抢其锁）；ESRCH：不存在，按死
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const state = afterComm.split(" ")[0];
    return state !== "Z";
  } catch {
    return true; // 无 /proc（非 Linux）：信任 kill 0
  }
}

export interface LockDeps {
  /** 写入锁的 pid（默认 process.pid） */
  pid?: number;
  /** 探活注入（测试用） */
  isAlive?: (pid: number) => boolean;
}

export type LockResult = { kind: "owned" } | { kind: "in-use"; holderPid: number };

let lockTmpSeq = 0;

export function acquireLock(lockPath: string, deps: LockDeps = {}): LockResult {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? lockIsPidAlive;
  for (let attempt = 0; attempt < 3; attempt++) {
    // write-then-link：先完整写 tmp，再 link(2) 原子占位。锁文件要么不存在、要么内容完整——
    // 消除 open(O_EXCL) 与 write 之间"空锁被误判坏锁 → 活锁被 unlink 抢占 → 双实例"的窗口。
    const tmp = `${lockPath}.tmp.${process.pid}.${lockTmpSeq++}`;
    try {
      writeFileSync(tmp, String(pid), { mode: 0o600 });
      chmodSync(tmp, 0o600); // umask 防御（与 taskstore.writeFileAtomic 同策略）
      try {
        linkSync(tmp, lockPath); // 原子：目标存在 → EEXIST
        return { kind: "owned" }; // finally 会 unlink tmp（仅分离链接，锁保留在 lockPath）
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    } finally {
      try {
        unlinkSync(tmp); // linked：分离第二链接；未 linked：清理无用 tmp
      } catch {
        // tmp 未创建（write 前 throw）或已被清，best-effort
      }
    }
    let holder = Number.NaN;
    try {
      holder = parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    } catch {
      // 坏锁内容（历史残留的空锁/损坏锁）：按死持锁者处理
    }
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
      return { kind: "in-use", holderPid: holder };
    }
    try {
      unlinkSync(lockPath); // 死持锁者/坏锁：抢占后重试
    } catch {
      // 竞态：他人已清理，直接重试
    }
  }
  throw new Error(`cannot acquire lock at ${lockPath} after 3 attempts`);
}

// ---------------------------------------------------------------------------
// 服务端自身 service.json

export function writeServiceFile(env: PathEnv, svc: ServiceFile): void {
  ensurePrivateDir(stateDir(env)); // 导出自洽：state 根目录 0700
  writeFileAtomic(serviceFilePath(env), `${JSON.stringify(svc, null, 2)}\n`);
}

/** 读已有 service.json；不存在返回 null；坏 JSON 抛错（发现方据此走清理路径） */
export function readServiceFile(env: PathEnv): ServiceFile | null {
  const p = serviceFilePath(env);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ServiceFile;
}

// ---------------------------------------------------------------------------
// 对已有实例的探测与实例表

/** 对已有实例探测 health */
export async function probeExisting(svc: ServiceFile): Promise<{ ok: boolean; version?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const auth = "Basic " + Buffer.from(`monitor:${svc.password}`).toString("base64");
    const res = await fetch(`${svc.url}/api/health`, { headers: { authorization: auth }, signal: ctrl.signal });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { version?: string };
    return { ok: true, version: body.version };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 启动期恢复时序与 DELETE 裁决（Review 修复，导出供单测）

/** 首轮 pending 重投完成后才启动 sweeper。时序契约：sweeper 的启动必扫不得先于
 *  重投——长停机（> taskTtlMs）重启时，终态任务目录里的 pending 结局通知必须先
 *  得到至少一次重投机会，否则必扫先按 TTL 删目录（连 pending.json），通知一次
 *  未试即永久丢失（不哑跑哲学）。重投异常同样放行清理（双围栏：调用方自带
 *  .catch 留痕，此处兜底逃逸——void 调用不许变成 unhandled rejection）。 */
export async function recoveryThenSweep(
  runPendingRetry: () => Promise<unknown>,
  startSweep: () => void,
): Promise<void> {
  try {
    await runPendingRetry();
  } catch {
    // 逃逸异常吞掉：TTL 清理不可被阻塞（调用方已留痕）
  } finally {
    startSweep();
  }
}

/** DELETE /api/tasks/:id 裁决（纯函数）。Review 修复（合并视图一致性）：GET 列表/
 *  详情能看到 store 侧任务（registry 200 驱逐后目录仍在 TTL 窗口内），DELETE 同样
 *  应能处置——旧实现 registry-only 查询对同一任务 GET 200 / DELETE 404 自相矛盾。
 *  未在册的活态目录（reattach 未跑的崩溃残留）同样 409：无人看护，删目录会留下
 *  无主进程继续跑。
 *  live = registry 在册视图；storeInfo = store 侧补齐视图（未在册时现读 meta） */
export function removalOutcome(
  id: string,
  live: PublicInfo | null,
  storeInfo: PublicInfo | null,
): TaskEndpointOutcome {
  const info = live ?? storeInfo;
  if (info === null) {
    return { status: 404, body: { error: `task ${id} not found`, code: "TASK_NOT_FOUND" } };
  }
  if (isAliveState(info.state)) {
    const hint = live === null ? " (not claimed by this server — reattach pending? probe GET /api/health)" : "";
    return {
      status: 409,
      body: { error: `task ${id} is ${info.state}${hint}; stop it first`, code: "TASK_NOT_TERMINAL" },
    };
  }
  return { status: 204, body: null };
}

// ---------------------------------------------------------------------------
// 装配

export interface MainDeps {
  /** 锁探活注入（测试） */
  isAlive?: (pid: number) => boolean;
  /** 对已有实例的 health 探测注入（测试）；默认真 fetch */
  probe?: (svc: ServiceFile) => Promise<{ ok: boolean; version?: string }>;
  /** 后到者等待持锁者就绪上限（测试注入缩短） */
  waitHolderMs?: number;
}

export interface MainResult {
  code: number;
  /** serve 分支的连接信息（测试/诊断用）；其余分支为空 */
  served?: { url: string; id: string };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: MainDeps = {},
): Promise<MainResult> {
  // platform gate
  if (process.platform === "win32") {
    process.stderr.write("opencode-monitor-task server: unsupported platform win32 (linux/macOS only)\n");
    return { code: 1 };
  }

  const paths = envFromProcess(env);
  const shutdownAll = argv.includes("--shutdown-all");
  const opencodeStatePaths = parseOpencodeStateArgs(argv);
  // 日志开关：启动时一次决定（--debug 参数或 DEBUG=1 env，任一即开），运行中不变。
  // 默认关闭——零写入、server.log 不创建（日志是 debug 选项而非常设设施；
  // 不做轮转，磁盘占用问题随默认关闭一起消解）。开启后也不记命令全文。
  const logOn = argv.includes("--debug") || env["DEBUG"] === "1";
  const logPath = serverLogPath(paths);

  // 单文件追加；
  // 关键事件 + DEBUG 行同闸：开关的目的就是 debug，无需两级独立控制
  const log = (msg: string): void => {
    if (!logOn) return;
    try {
      appendFileSync(logPath, `[${new Date().toISOString()} pid${process.pid}] ${msg}\n`);
    } catch {
      // 日志失败不能影响服务
    }
  };
  const debug = (msg: string): void => {
    if (logOn) log(`DEBUG ${msg}`);
  };

  ensurePrivateDir(stateDir(paths));
  log(`starting version=${SERVER_VERSION} argv=[${argv.join(" ")}]`);
  if (shutdownAll) log("--shutdown-all: all task process groups will be killed on exit");
  const knownArgs = new Set(["--shutdown-all", "--debug", "--opencode-state", ...opencodeStatePaths]);
  for (const a of argv) {
    if (!knownArgs.has(a)) log(`note: unrecognized arg '${a}' ignored (future stages may accept it)`);
  }

  // opencode 实例注册表（默认共享服务 + --opencode-state 追加，路径去重）
  const ocRegistry: OpencodeRegistry = buildRegistry(paths, opencodeStatePaths);
  if (opencodeStatePaths.length > 0) {
    log(`opencode registry: default + ${opencodeStatePaths.length} extra --opencode-state path(s)`);
  }

  // 任务注册表：簿记 + health 计数 + 端点聚合 + session 上限/终态驱逐 + store 合并视图
  const tasks = new TaskRegistry();

  // Monitor 依赖共享装配（createTask 与 reattach/pending 重投同源——tick/重试参数一致）
  const monitorBase: MonitorDeps = { env: paths, ocRegistry, log };

  // reattach 状态（认领结果显式化——health 可见、失败可懒重试）
  let reattachRan = false;
  let reattachInFlight = false;
  let reattachInfo: HealthInfo["reattach"] = null;
  const runReattach = (): void => {
    if (reattachRan || reattachInFlight) return;
    reattachInFlight = true;
    void scanAndReclaim({ ...monitorBase, registry: tasks })
      .then((r) => {
        reattachInfo = { claimed: r.claimed, finalized: r.finalized, failed: r.failed, at: Date.now() };
        reattachRan = true;
        log(`reattach: ${r.claimed} claimed, ${r.finalized} finalized, ${r.failed} failed`);
      })
      .catch((err: unknown) => {
        log(`reattach error (will retry on next health probe): ${String(err).slice(0, 120)}`);
      })
      .finally(() => {
        reattachInFlight = false;
      });
  };

  // --- 单实例锁 ---
  const lockPath = lockFilePath(paths);
  const lock = acquireLock(lockPath, { isAlive: deps.isAlive });
  const probe = deps.probe ?? probeExisting;
  log(`lock ${lock.kind}${lock.kind === "in-use" ? ` (holder pid ${lock.holderPid})` : ""}`);

  if (lock.kind === "in-use") {
    // 后到者：核对/等待持锁者就绪，健康则退出码 0。
    // version 判定与 owned-防御分支统一：health ok 但 version 缺失或 major.minor 不兼容 → 不可信，
    // 拒绝双开退出 1（本服务端 health 恒带 version；缺字段说明对端不是正常实例）
    debug(`waiting for holder to become healthy (≤${WAIT_HOLDER_MS}ms)`);
    const waitMs = deps.waitHolderMs ?? WAIT_HOLDER_MS;
    const deadline = Date.now() + waitMs;
    let incompatible: { svc: ServiceFile; version?: string } | null = null;
    for (;;) {
      let svc: ServiceFile | null = null;
      try {
        svc = readServiceFile(paths);
      } catch {
        svc = null; // 坏 service.json：等持锁者重写
      }
      if (svc) {
        const h = await probe(svc);
        if (h.ok) {
          if (!h.version || !versionCompatible(SERVER_VERSION, h.version)) {
            incompatible = { svc, version: h.version };
            break;
          }
          const line = `existing healthy server instance at ${svc.url} (pid ${lock.holderPid}); exiting 0`;
          log(line);
          process.stdout.write(`${line}\n`);
          return { code: 0 };
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(WAIT_POLL_MS);
    }
    if (incompatible) {
      const msg = incompatible.version
        ? `server pid ${incompatible.svc.pid} runs incompatible version ${incompatible.version} (mine ${SERVER_VERSION}); refusing to double-spawn`
        : `server pid ${incompatible.svc.pid} responded without a version field (not a trustworthy instance); refusing to double-spawn`;
      log(`FATAL ${msg}`);
      process.stderr.write(`${msg}\n`);
      return { code: 1 };
    }
    const msg = `lock held by pid ${lock.holderPid} but no healthy instance appeared within ${waitMs}ms; check ${logPath}`;
    log(`FATAL ${msg}`);
    process.stderr.write(`${msg}\n`);
    return { code: 1 };
  }

  // owned：异常态防御——锁已到手但仍有健康实例在服务（锁与实例脱钩，如锁被误删）。
  // 不盲目双开：让位退出 0，service.json 留给在服务的实例。
  try {
    const existing = readServiceFile(paths);
    if (existing) {
      const h = await probe(existing);
      if (h.ok && h.version && versionCompatible(SERVER_VERSION, h.version)) {
        const line = `lock acquired but healthy instance already serving at ${existing.url}; releasing lock and exiting 0`;
        log(line);
        try {
          unlinkSync(lockPath);
        } catch {
          // best-effort
        }
        process.stdout.write(`${line}\n`);
        return { code: 0 };
      }
    }
  } catch {
    // 坏 service.json：作为最终存活者直接覆盖
  }

  // --- 服务：监听 → 写 service.json → 挂起待信号 ---
  const id = randomUUID();
  const password = randomBytes(32).toString("base64");
  const startedAt = Date.now();
  debug(`identity id=${id}`);

  // health 数据源：实例表每次现读 + verifyInstance 实测；
  // reattach 懒触发
  const health = async (): Promise<HealthInfo> => {
    runReattach();
    let logBytes = 0;
    try {
      logBytes = statSync(logPath).size;
    } catch {
      // 日志尚无：按 0
    }
    return {
      id,
      version: SERVER_VERSION,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      tasks_alive: tasks.aliveCount(),
      tasks_total: tasks.size,
      reattach: reattachInfo, // null = 尚未完成
      opencode_instances: await probeInstances(ocRegistry, paths),
      log_bytes: logBytes,
    };
  };

  // 任务端点装配：创建 + 列表 + 详情 + stop/keepalive/PATCH/DELETE/log +
  //  /api/shutdown、列表/详情与 TaskStore 合并视图——registry 驱逐或崩溃恢复后
  // 目录仍在 TTL 内的终态/parked 任务从 store 补齐。
  // 管理端点（stop/keepalive/PATCH/log）只对在册 Monitor 实例有效——parked 与 store 终态 404
  const asMonitor = (id: string): Monitor | null => {
    const t = tasks.get(id);
    return t instanceof Monitor ? t : null;
  };
  const notFound = (id: string): TaskEndpointOutcome => ({
    status: 404,
    body: { error: `task ${id} not found`, code: "TASK_NOT_FOUND" },
  });
  /** store 侧补充视图：不在 registry 的任务目录（坏 meta 跳过——reattach 已计数留痕） */
  const storedInfo = (id: string): PublicInfo | null => {
    try {
      const meta = readMeta(paths, id);
      return meta === null ? null : new StoredTaskView(meta, taskFilePaths(paths, id).log).toPublicInfo();
    } catch {
      return null;
    }
  };
  const tasksApi = {
    create: async (body: unknown): Promise<TaskEndpointOutcome> => {
      const r = await createTask({ ...monitorBase, registry: tasks }, body);
      return r.ok ? { status: 201, body: r.info } : { status: r.status, body: r.error };
    },
    list: (sessionId: string | undefined): TaskEndpointOutcome => {
      const merged = [...tasks.listInfos(sessionId)];
      for (const id of listTaskIds(paths)) {
        if (tasks.get(id) !== undefined) continue;
        const info = storedInfo(id);
        if (info !== null && (sessionId === undefined || info.session_id === sessionId)) merged.push(info);
      }
      merged.sort((a, b) => a.started_at - b.started_at);
      return { status: 200, body: merged };
    },
    get: (id: string): TaskEndpointOutcome => {
      const t = tasks.get(id);
      if (t !== undefined) return { status: 200, body: t.toPublicInfo() };
      const info = storedInfo(id);
      return info !== null ? { status: 200, body: info } : notFound(id);
    },
    patch: async (id: string, body: unknown): Promise<TaskEndpointOutcome> => {
      const v = validatePatchInput(body);
      if (!v.ok) {
        return { status: 400, body: { error: "invalid patch input", code: "INVALID_INPUT", detail: v.violations } };
      }
      const mon = asMonitor(id);
      if (mon === null) return notFound(id);
      const r = await mon.updateMaxEvents(v.value.max_events);
      return r.ok ? { status: 200, body: r.info } : { status: r.status, body: r.error };
    },
    stop: async (id: string): Promise<TaskEndpointOutcome> => {
      const mon = asMonitor(id);
      if (mon === null) return notFound(id);
      const r = await mon.requestStop();
      return r.ok ? { status: 200, body: r.info } : { status: r.status, body: r.error };
    },
    keepalive: (id: string): TaskEndpointOutcome => {
      const mon = asMonitor(id);
      if (mon === null) return notFound(id);
      const r = mon.keepalive();
      return r.ok ? { status: 200, body: r.info } : { status: r.status, body: r.error };
    },
    remove: (id: string): TaskEndpointOutcome => {
      const t = tasks.get(id);
      // registry 在册用活视图；未在册回落 store 侧补齐视图（Review 修复：与 GET 的
      // 合并视图同源——驱逐后 TTL 窗口内的终态任务同样可 DELETE，见 removalOutcome）
      const plan = removalOutcome(id, t !== undefined ? t.toPublicInfo() : null, t === undefined ? storedInfo(id) : null);
      if (plan.status !== 204) return plan;
      try {
        rmSync(taskDir(paths, id), { recursive: true, force: true });
      } catch (err) {
        return { status: 500, body: { error: `cannot remove task dir: ${String(err)}`, code: "REMOVE_FAILED" } };
      }
      tasks.remove(id);
      return plan;
    },
    readLog: (id: string, tail: string | undefined): TaskEndpointOutcome => {
      const mon = asMonitor(id);
      if (mon === null) return notFound(id);
      // 严格十进制（Review 修复）：Number() 会放过 "0x10"/"1e2"/" 5"——正则先行，
      // 范围校验仍由 readLogTail 把关（防御纵深）
      const raw = tail ?? String(LIMITS.logTailDefaultLines);
      if (!/^\d+$/.test(raw)) {
        return {
          status: 400,
          body: { error: `tail must be an integer in [1, ${LIMITS.logTailMaxLines}]`, code: "INVALID_TAIL" },
        };
      }
      const r = mon.readLogTail(Number(raw));
      return r.ok ? { status: 200, body: r.text } : { status: r.status, body: r.error };
    },
  };

  /** 击杀全部活任务进程组（/api/shutdown kill_tasks=true 与 --shutdown-all 共用）：
   *  走 requestStop 公共路径（尾批 flush + stopped 终态 + lifecycle 通知 + killTree 两档） */
  const killAllLiveTasks = async (): Promise<number> => {
    const mons: Monitor[] = [];
    for (const info of tasks.listInfos()) {
      if (!isAliveState(info.state)) continue;
      const t = tasks.get(info.id);
      if (t instanceof Monitor) mons.push(t);
    }
    for (const mon of mons) {
      await mon.requestStop().catch(() => {}); // 单任务失败不阻断其余（stopAndFinalize 自带围栏）
    }
    return mons.length;
  };
  // 退出钩子（信号处理区赋值——shutdown 端点先于其定义，经此间接引用）
  let exitNow: ((sig: string) => void) | null = null;
  const shutdownEndpoint = async (killTasks: boolean): Promise<{ killed: number }> => {
    const killed = killTasks ? await killAllLiveTasks() : 0;
    log(`shutdown via API (kill_tasks=${killTasks}, killed=${killed})`);
    // 响应先行送出（handle 内同步 end 进内核缓冲），150ms 后退出兜底送达
    setTimeout(() => exitNow?.("shutdown-api"), 150);
    return { killed };
  };

  const server = createMonitorHttpServer({ password, health, tasks: tasksApi, shutdown: shutdownEndpoint });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    const msg = `cannot listen on 127.0.0.1: ${String(err)}`;
    log(`FATAL ${msg}`);
    process.stderr.write(`${msg}\n`);
    return { code: 1 };
  }
  const port = (server.address() as AddressInfo).port;
  const svc: ServiceFile = {
    id,
    version: SERVER_VERSION,
    url: `http://127.0.0.1:${port}`,
    pid: process.pid,
    password,
    started_at: startedAt,
  };
  writeServiceFile(paths, svc);
  log(`listening at ${svc.url} (service.json written)`);

  // --- 启动件（reattach / pending 重投 / sweeper） ---
  // reattach：认领崩溃前任务；health 懒触发兜底（启动扫描异常时重试）
  runReattach();
  // pending 重投：独立 60s 周期。
  // .catch 围栏与 sweeper run() 对齐——生产 deliverNotification 已验证不抛
  // （opencode.ts 全链 catch 为返回值），但 uncaughtException → exit(1) 姿态下
  // 未来任何逃逸异常都不该经此拖垮服务端
  const runPendingRetry = (): Promise<void> =>
    retryPendingTasks({ ...monitorBase, registry: tasks })
      .then((r) => {
        if (r.delivered + r.dropped + r.retained > 0) {
          log(`pending retry: ${r.delivered} delivered, ${r.dropped} dropped, ${r.retained} retained`);
        }
      })
      .catch((err: unknown) => {
        log(`pending retry error: ${String(err).slice(0, 120)}`);
      });
  const pendingTimer = setInterval(() => void runPendingRetry(), LIMITS.pendingRetryMs);
  pendingTimer.unref?.();
  // sweeper：TTL 清理。启动时序（Review 修复）：
  // 首轮 pending 重投完成后才做启动必扫（recoveryThenSweep）——顺序颠倒会在长停机
  // 重启场景先删掉带 pending.json 的 TTL 过期目录，结局通知一次未试即永久丢失；
  // 重投全程有界（逐条 ≤4 次尝试），延迟首扫无害（被清的都是早已过期的目录）
  void recoveryThenSweep(runPendingRetry, () => {
    startSweeper(paths, tasks, log).unref?.();
  });

  // 信号处理：SIGTERM/SIGINT 优雅退出；默认不杀任务——任务自成进程组。
  // --shutdown-all：先 requestStop 全部活任务再退。
  // kill -9 无法清理 → service.json/lock 残留 = 发现流程的 stale 路径，此为设计内行为
  // （任务进程照跑，重启 reattach 认领——P1 的结构性根治）。
  let exiting = false;
  const cleanupFiles = (): void => {
    for (const p of [serviceFilePath(paths), lockPath]) {
      try {
        unlinkSync(p);
      } catch {
        // best-effort（可能已被清/不存在）
      }
    }
  };
  const shutdown = (sig: string): void => {
    if (exiting) return;
    exiting = true;
    const finish = (): void => {
      log(
        `received ${sig}, shutting down${shutdownAll ? " (--shutdown-all: all task groups killed)" : " (any tasks are left running by design)"}`,
      );
      server.close();
      server.closeAllConnections();
      cleanupFiles();
      process.exit(0);
    };
    if (shutdownAll) void killAllLiveTasks().then(finish, finish);
    else finish();
  };
  exitNow = shutdown;
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`uncaughtException: ${detail}`);
    process.exit(1); // exit hook 兜底清理
  });
  process.on("exit", () => {
    if (!exiting) {
      server.close();
      server.closeAllConnections();
      cleanupFiles();
    }
  });

  // 挂起直至信号（serve 分支经 shutdown() 退出）
  await new Promise<never>(() => {});
  throw new Error("unreachable: serve branch exits via signal handlers");
}

// ---------------------------------------------------------------------------
// 直接运行入口（node --import tsx packages/server/src/main.ts）

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main()
    .then((r) => process.exit(r.code))
    .catch((err: unknown) => {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`fatal: ${detail}\n`);
      process.exit(1);
    });
}
