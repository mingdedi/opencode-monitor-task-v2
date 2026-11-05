// 发现-创建流程（PLUGIN-PLAN §四 server.ts；scripts/verify-m1.ts findOrCreate 内联原型的正式提炼）
//
// 语义照搬 PLAN §2.1 / verify-m1 场景①②③（M1 真机验收过的行为，不重新设计）：
//   读 service.json → health 1s 探测 → 复用（版本兼容）/ 坏文件清理 / stale 清理（pid 死）
//   / 活而不响应或版本不兼容 → 报错诊断（拒绝双开——服务端自身还有单实例锁兜底）
//   / spawn → 就绪轮询 5s → 超时报诊断。
// 发现-创建失败绝不静默（PLUGIN-PLAN §三-4）：报 pid、server.log 路径、service.json 路径。
//
// 纪律（§四）：
// - client 绝不缓存：每次调用现读 service.json，url/password 随服务端重启轮转（纪律 1）
// - spawn 一律 detached + stdio "ignore" + unref（纪律 3）——自成进程组，
//   opencode 退出/插件热重载不影响服务端
// - 命令经 resolveRuntime 解析（禁用 process.execPath——宿主是 bun 编译二进制，§三-5）
// - 双开竞态的结构性防御在服务端（main.ts 单实例锁，后到者退出 0）——插件端不重复设防

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { MonitorClient } from "../../shared/src/client.ts";
import { envFromProcess, serverLogPath, serviceFilePath, type PathEnv } from "../../shared/src/paths.ts";
import type { HealthInfo, ServiceFile } from "../../shared/src/types.ts";
import { versionCompatible } from "../../shared/src/validate.ts";
import { resolveRuntime, type RuntimeDeps } from "./runtime.ts";
import type { EnsureServerResult, RuntimeResolution, SpawnFn } from "./types.ts";

/** 插件端期望的服务端版本——取本包版本（与服务端同 major.minor 发布；patch 视为兼容，
 *  shared versionCompatible 语义）。插件端不 import 服务端包：服务端是被 spawn 的独立进程，
 *  依赖方向不可反向（tui.ts 头注同款边界）。 */
const SERVER_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** health 探测超时（发现流程判据，PLAN §2.1-2 语义） */
const PROBE_TIMEOUT_MS = 1000;
/** 就绪轮询窗口 / 间隔（§四纪律 3：就绪轮询 5s；verify-m1 同款节奏） */
const READY_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 200;

// ---------------------------------------------------------------------------
// pid 探活（与 server/main.ts lockIsPidAlive 同语义：EPERM 按活、/proc Z 僵尸按死——
// 同款重写而非 import：服务端包不在插件依赖面上，两处语义由各自的测试锚定）

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM：进程存在但归属他人——保守视为活（不可清其 service.json）；ESRCH：不存在
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    return true; // 无 /proc（非 Linux）：信任 kill 0
  }
}

// ---------------------------------------------------------------------------

const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, args, options);

type ServiceFileState =
  | { kind: "absent" }
  | { kind: "broken" }
  | { kind: "ok"; svc: ServiceFile };

/** 现读 service.json 三态：不存在 / 坏 JSON / 好（每次现读，绝不缓存） */
function readService(env: PathEnv): ServiceFileState {
  const p = serviceFilePath(env);
  if (!existsSync(p)) return { kind: "absent" };
  try {
    return { kind: "ok", svc: JSON.parse(readFileSync(p, "utf8")) as ServiceFile };
  } catch {
    return { kind: "broken" };
  }
}

/** health 探测：ok 返回 HealthInfo；不可达/非 2xx/超时一律 null（失败路径由调用方裁决） */
async function probe(svc: ServiceFile, fetchImpl: typeof fetch, timeoutMs: number): Promise<HealthInfo | null> {
  try {
    return await new MonitorClient(svc.url, svc.password, { fetchImpl }).health(timeoutMs);
  } catch {
    return null;
  }
}

export interface EnsureServerDeps {
  /** XDG 解析 + spawn 继承的 env（默认 process.env；测试注入指向临时目录） */
  env?: NodeJS.ProcessEnv;
  /** resolveRuntime 锚点——插件包/项目根（默认 process.cwd()） */
  rootDir?: string;
  /** health 探测传输层（测试注入） */
  fetchImpl?: typeof fetch;
  /** 默认 node:child_process spawn（测试注入） */
  spawnImpl?: SpawnFn;
  /** 运行时解析注入（测试注入固定产物） */
  resolve?: (rootDir: string, deps?: RuntimeDeps) => RuntimeResolution;
  /** pid 探活注入（测试注入） */
  isAlive?: (pid: number) => boolean;
  /** 测试注入缩短等待：就绪窗口 / 轮询间隔 */
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * 发现-创建 monitor 服务端：有健康且版本兼容的实例则复用（spawned=false），
 * 否则拉起并等就绪（spawned=true）。失败抛带诊断信息的 Error（pid / service.json /
 * server.log 路径）——绝不静默。
 */
export async function ensureServer(deps: EnsureServerDeps = {}): Promise<EnsureServerResult> {
  const env = deps.env ?? process.env;
  const paths = envFromProcess(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const isAlive = deps.isAlive ?? pidIsAlive;
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const resolve = deps.resolve ?? resolveRuntime;
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const sfPath = serviceFilePath(paths);
  const logPath = serverLogPath(paths);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const diag = (extra: string): string => `${extra} (service.json: ${sfPath}, log: ${logPath})`;

  // --- 发现：读 service.json → health 探测 → 复用 / 清理 / 拒绝 ---
  const found = readService(paths);
  if (found.kind === "broken") {
    unlinkSync(sfPath); // 坏 service.json：清理后创建（verify-m1 场景③）
  } else if (found.kind === "ok") {
    const h = await probe(found.svc, fetchImpl, PROBE_TIMEOUT_MS);
    if (h !== null && versionCompatible(SERVER_VERSION, h.version)) {
      return { spawned: false, svc: found.svc, health: h };
    }
    if (found.svc.pid && isAlive(found.svc.pid)) {
      // 活而不响应 / 版本不兼容：拒绝双开（服务端单实例锁之外的第二道插件端防线；
      // verify-m1 场景①竞态防御同款）
      const seen = h !== null ? `health version ${h.version}` : "health unreachable";
      throw new Error(
        diag(
          `monitor server pid ${found.svc.pid} alive but unhealthy/incompatible (${seen}, expected ${SERVER_VERSION}); refusing to double-spawn`,
        ),
      );
    }
    unlinkSync(sfPath); // stale：pid 死，清理后创建（verify-m1 场景②）
  }

  // --- 创建：解析运行时 → spawn（detached + ignore + env 显式传递 + unref）→ 就绪轮询 ---
  const rt = resolve(deps.rootDir ?? process.cwd(), { env });
  const child = spawnImpl(rt.command, rt.args, { cwd: rt.cwd, stdio: "ignore", detached: true, env });
  child.unref();
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    await sleep(pollIntervalMs);
    const cur = readService(paths);
    if (cur.kind === "ok") {
      const h = await probe(cur.svc, fetchImpl, PROBE_TIMEOUT_MS);
      if (h !== null && versionCompatible(SERVER_VERSION, h.version)) {
        return { spawned: true, svc: cur.svc, health: h };
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        diag(`spawned server exited during startup (code=${child.exitCode} signal=${child.signalCode})`),
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        diag(
          `spawned server did not become healthy within ${readyTimeoutMs}ms (pid=${child.pid ?? "?"}; check log for startup errors)`,
        ),
      );
    }
  }
}
