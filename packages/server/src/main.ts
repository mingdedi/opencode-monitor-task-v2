// 服务端入口（PLAN §2.1 / §6.1；SERVER-PLAN 阶段 B 最小版 + 阶段 C 注册表接线 + 阶段 D 任务闭环）
// 职责：platform gate → 单实例锁（O_EXCL，内容含 pid）→ 127.0.0.1 随机端口监听
//       → service.json 600 原子写 → 信号处理（默认不杀任务，PLAN §2.1 退出语义）
//       → 日志落 state 目录（不记命令全文，DEBUG=1 才详细，PLAN §4）
//       → opencode 实例注册表（--opencode-state 多条目，§2.8.1；health 实例表实测）
//       → 任务注册表 + 任务端点装配（阶段 D：POST /api/tasks + GET 列表/详情）
// 仍不含：管理端点（F）、reattach（G）、/api/shutdown（G）。
//
// 创建竞态语义（PLAN §2.1-4）：先原子抢锁 → in-use 后到者核对/等待已有 service.json 的 health，
// 健康则打印后退出码 0（后到者自然退出，service.json 由最终存活者持有）；死持锁者可抢。

import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
  envFromProcess,
  lockFilePath,
  serverLogPath,
  serviceFilePath,
  stateDir,
  versionCompatible,
  type HealthInfo,
  type PathEnv,
  type ServiceFile,
} from "@omt/shared";
import { createMonitorHttpServer, type TaskEndpointOutcome } from "./http.ts";
import { buildRegistry, parseOpencodeStateArgs, probeInstances, type OpencodeRegistry } from "./opencode.ts";
import { createTask } from "./monitor.ts";
import { TaskRegistry } from "./registry.ts";
import { ensurePrivateDir, writeFileAtomic } from "./taskstore.ts";

export const SERVER_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** 后到者等待持锁者就绪的上限（持锁者经 tsx 冷启动，留足余量） */
const WAIT_HOLDER_MS = 8000;
const WAIT_POLL_MS = 250;
/** 对已有实例的 health 探测超时（PLAN §2.1-2） */
const PROBE_TIMEOUT_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 单实例锁（PLAN §2.1-4；SERVER-PLAN §一：锁文件内容含 pid，死持锁者可抢）

/** 探活：kill(pid,0) + /proc state 字母纠错（Z 僵尸按死——PLAN §2.3 三件套之二的锁内简化版；
 *  任务进程的 (pid, starttime) 双因子版在 spawner.ts（阶段 C））。
 *  /proc stat 解析从最后一个 ')' 之后取字段（comm 可含空格/括号，SERVER-PLAN §一 spawner 要点）。 */
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
// 服务端自身 service.json（与 opencode service.json 同构，PLAN §2.1）

export function writeServiceFile(env: PathEnv, svc: ServiceFile): void {
  ensurePrivateDir(stateDir(env)); // 导出自洽：state 根目录 0700（PLAN §4）
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

/** 对已有实例探测 health（auth 按 service.json 的 password；PLAN §2.1-2 语义） */
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
  // platform gate（PLAN §9-4：Windows 不支持，统一前置校验）
  if (process.platform === "win32") {
    process.stderr.write("opencode-monitor-task server: unsupported platform win32 (linux/macOS only)\n");
    return { code: 1 };
  }

  const paths = envFromProcess(env);
  const shutdownAll = argv.includes("--shutdown-all");
  const opencodeStatePaths = parseOpencodeStateArgs(argv);
  const debugOn = env["DEBUG"] === "1";
  const logPath = serverLogPath(paths);

  // 日志：单文件追加（SERVER-PLAN §三-6：第一版不轮转，health 暴露 log_bytes）；
  // 默认只记关键事件不含命令全文，详细诊断仅 DEBUG=1（PLAN §4）
  const log = (msg: string): void => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()} pid${process.pid}] ${msg}\n`);
    } catch {
      // 日志失败不能影响服务
    }
  };
  const debug = (msg: string): void => {
    if (debugOn) log(`DEBUG ${msg}`);
  };

  ensurePrivateDir(stateDir(paths));
  log(`starting version=${SERVER_VERSION} argv=[${argv.join(" ")}]`);
  if (shutdownAll) log("--shutdown-all flag recorded (task-group kill wiring lands in stage G)");
  const knownArgs = new Set(["--shutdown-all", "--opencode-state", ...opencodeStatePaths]);
  for (const a of argv) {
    if (!knownArgs.has(a)) log(`note: unrecognized arg '${a}' ignored (future stages may accept it)`);
  }

  // opencode 实例注册表（§2.8.1 白名单：默认共享服务 + --opencode-state 追加，路径去重）
  const ocRegistry: OpencodeRegistry = buildRegistry(paths, opencodeStatePaths);
  if (opencodeStatePaths.length > 0) {
    log(`opencode registry: default + ${opencodeStatePaths.length} extra --opencode-state path(s)`);
  }

  // 任务注册表（阶段 D：簿记 + health 计数 + 端点聚合；F 阶段加上限/驱逐，G 加 store 合并视图）
  const tasks = new TaskRegistry();

  // --- 单实例锁 ---
  const lockPath = lockFilePath(paths);
  const lock = acquireLock(lockPath, { isAlive: deps.isAlive });
  const probe = deps.probe ?? probeExisting;
  log(`lock ${lock.kind}${lock.kind === "in-use" ? ` (holder pid ${lock.holderPid})` : ""}`);

  if (lock.kind === "in-use") {
    // 后到者：核对/等待持锁者就绪，健康则退出码 0（PLAN §2.1-4 后到者自然退出）。
    // version 裁定与 owned-防御分支统一：health ok 但 version 缺失或 major.minor 不兼容 → 不可信，
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

  // health 数据源：实例表每次现读 + verifyInstance 实测（§2.8.1——url/password 会变，绝不缓存）
  const health = async (): Promise<HealthInfo> => {
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
      reattach: null, // G 阶段接入（PLAN §2.9-5）
      opencode_instances: await probeInstances(ocRegistry, paths),
      log_bytes: logBytes,
    };
  };

  // 任务端点装配（阶段 D：创建 + 列表 + 详情；F 阶段补 stop/keepalive/PATCH/DELETE/log）
  const tasksApi = {
    create: async (body: unknown): Promise<TaskEndpointOutcome> => {
      const r = await createTask(
        { env: paths, ocRegistry, registry: tasks, log },
        body,
      );
      return r.ok ? { status: 201, body: r.info } : { status: r.status, body: r.error };
    },
    list: (sessionId: string | undefined): TaskEndpointOutcome => ({
      status: 200,
      body: tasks.listInfos(sessionId),
    }),
    get: (id: string): TaskEndpointOutcome => {
      const t = tasks.get(id);
      return t
        ? { status: 200, body: t.toPublicInfo() }
        : { status: 404, body: { error: `task ${id} not found`, code: "TASK_NOT_FOUND" } };
    },
  };

  const server = createMonitorHttpServer({ password, health, tasks: tasksApi });
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

  // 信号处理：SIGTERM/SIGINT 优雅退出；默认不杀任务——任务自成进程组（PLAN §2.1 退出语义）。
  // kill -9 无法清理 → service.json/lock 残留 = 发现流程的 stale 路径，此为设计内行为。
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
    log(`received ${sig}, shutting down (any tasks are left running by design)`);
    server.close();
    server.closeAllConnections();
    cleanupFiles();
    process.exit(0);
  };
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
