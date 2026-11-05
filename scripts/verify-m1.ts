// M1 真机验收（SERVER-PLAN 阶段 B）：
//  ① 发现-创建-复用全流程 + 权限审计（service.json 600 / state 0700 / 锁含 pid）
//  ② kill -9 后 stale service.json 清理重建
//  ③ 坏 service.json 清理路径
//  ④ 双并发 spawn 竞争锁只留一个存活者（后到者退出码 0）
//  ⑤ 持锁者 kill -9 后死锁可抢（新实例接管）
//  ⑥ 优雅退出（SIGTERM）自清 service.json 与锁
// 隔离：XDG 指向 /tmp/opencode/omt-verify-m1-<pid>，不触碰真实用户目录。
// 发现-创建流程为插件端行为（PLAN §2.1）的脚本内联模拟——正式实现属插件端 spawn-server.ts。
//
// 用法: node --import tsx scripts/verify-m1.ts

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MonitorClient, versionCompatible, type HealthInfo, type ServiceFile } from "@omt/shared";
import { lockFilePath, serviceFilePath, stateDir, type PathEnv } from "@omt/shared";
import { SERVER_VERSION } from "../packages/server/src/main.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { resolveServerEntry } from "./lib/server-entry.ts";
const entry = resolveServerEntry(ROOT);
const XDG = mkdtempSync("/tmp/opencode/omt-verify-m1-");
const pathEnv: PathEnv = { XDG_STATE_HOME: `${XDG}/state`, XDG_DATA_HOME: `${XDG}/data` };
const serverEnv = { ...process.env, XDG_STATE_HOME: pathEnv.XDG_STATE_HOME, XDG_DATA_HOME: pathEnv.XDG_DATA_HOME };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 子进程是否仍在运行——被信号杀死时 exitCode 为 null 而 signalCode 有值，两者都要看 */
const isRunning = (c: ChildProcess): boolean => c.pid !== undefined && c.exitCode === null && c.signalCode === null;
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---- 记分 ----
let passed = 0;
let failed = 0;
const results: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    results.push(`  ✔ ${name}`);
  } else {
    failed++;
    results.push(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- 服务端进程管理 ----
const children: ChildProcess[] = [];
function spawnServer(): ChildProcess {
  const child = spawn(entry.command, [...entry.baseArgs], {
    cwd: ROOT,
    env: serverEnv,
    stdio: "ignore",
    detached: true, // 自成进程组（插件端 §2.1-3 同款行为）
  });
  children.push(child);
  return child;
}

async function waitExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  if (!isRunning(child)) return child.exitCode;
  return await new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined as unknown as number | null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

async function killAll(sig: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
  for (const c of children) {
    if (isRunning(c) && c.pid) {
      try {
        process.kill(c.pid, sig);
      } catch {
        /* 已死 */
      }
    }
  }
  await sleep(300);
  if (sig === "SIGTERM") {
    for (const c of children) {
      if (isRunning(c) && c.pid) {
        try {
          process.kill(c.pid, "SIGKILL");
        } catch {
          /* 兜底 */
        }
      }
    }
    await sleep(200);
  }
}

function resetState(): void {
  rmSync(`${XDG}/state`, { recursive: true, force: true });
  rmSync(`${XDG}/data`, { recursive: true, force: true });
}

// ---- 发现-创建流程（§2.1 插件端行为模拟）----

async function probe(svc: ServiceFile): Promise<HealthInfo | null> {
  try {
    return await new MonitorClient(svc.url, svc.password).health(1000);
  } catch {
    return null;
  }
}

async function findOrCreate(): Promise<{ spawned: boolean; svc: ServiceFile; health: HealthInfo; child?: ChildProcess }> {
  const sf = serviceFilePath(pathEnv);
  if (existsSync(sf)) {
    let svc: ServiceFile | null = null;
    try {
      svc = JSON.parse(readFileSync(sf, "utf8")) as ServiceFile;
    } catch {
      svc = null;
    }
    if (!svc) {
      unlinkSync(sf); // 坏 service.json：清理后创建
    } else {
      const h = await probe(svc);
      if (h && versionCompatible(SERVER_VERSION, h.version)) return { spawned: false, svc, health: h };
      if (svc.pid && isPidAlive(svc.pid)) {
        throw new Error(`server pid ${svc.pid} alive but unhealthy/incompatible; refusing to double-spawn`);
      }
      unlinkSync(sf); // stale：pid 死，清理后创建
    }
  }
  const child = spawnServer();
  const deadline = Date.now() + 5000;
  for (;;) {
    await sleep(200);
    if (existsSync(sf)) {
      try {
        const svc = JSON.parse(readFileSync(sf, "utf8")) as ServiceFile;
        const h = await probe(svc);
        if (h && versionCompatible(SERVER_VERSION, h.version)) return { spawned: true, svc, health: h, child };
      } catch {
        /* 未就绪，继续轮询 */
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`spawned server exited (code=${child.exitCode} signal=${child.signalCode})`);
    if (Date.now() > deadline) throw new Error("server did not become healthy within 5s");
  }
}

// ---- 场景 ----

async function scenario1_discover_create_reuse(): Promise<void> {
  const first = await findOrCreate();
  check("①创建: spawned=true", first.spawned === true);
  check("①创建: health 200 且 id/version 匹配", first.health.id === first.svc.id && first.health.version === SERVER_VERSION);
  check("①创建: 监听 127.0.0.1 随机端口", first.svc.url.startsWith("http://127.0.0.1:") && !first.svc.url.endsWith(":0"));
  const second = await findOrCreate();
  check("①复用: spawned=false 且同实例", second.spawned === false && second.svc.id === first.svc.id && second.svc.url === first.svc.url);
  // 权限审计（PLAN §4）
  check("①权限: service.json 600", (statSync(serviceFilePath(pathEnv)).mode & 0o777) === 0o600, String(statSync(serviceFilePath(pathEnv)).mode & 0o777));
  check("①权限: state 目录 0700", (statSync(stateDir(pathEnv)).mode & 0o777) === 0o700);
  const lockStat = statSync(lockFilePath(pathEnv));
  check("①权限: 锁 600 且内容=服务端 pid", (lockStat.mode & 0o777) === 0o600 && readFileSync(lockFilePath(pathEnv), "utf8") === String(first.svc.pid));
  check("①权限: 锁目录无 .tmp 残留", readdirSync(path.dirname(lockFilePath(pathEnv))).filter((f) => f.includes(".tmp.")).length === 0);
}

async function scenario2_stale_service(): Promise<void> {
  // kill -9 现有实例：service.json 残留为 stale
  const alive = children.find((c) => isRunning(c));
  if (!alive?.pid) throw new Error("no alive server from scenario 1");
  const stalePid = alive.pid;
  process.kill(alive.pid, "SIGKILL");
  await sleep(300);
  check("②前置: kill -9 后 service.json 残留", existsSync(serviceFilePath(pathEnv)));
  check("②前置: 残留 pid 已死", !isPidAlive(stalePid));
  const r = await findOrCreate();
  check("②stale 清理: 清理重建 spawned=true", r.spawned === true);
  check("②stale 清理: 新实例健康", r.health.id === r.svc.id);
  check("②stale 清理: 新 pid ≠ 旧 pid", r.svc.pid !== stalePid);
}

async function scenario3_broken_service_file(): Promise<void> {
  await killAll();
  resetState();
  mkdirSync(stateDir(pathEnv), { recursive: true });
  writeFileSync(serviceFilePath(pathEnv), "{ this is not json");
  check("③前置: 坏 service.json 就位", existsSync(serviceFilePath(pathEnv)));
  const r = await findOrCreate();
  check("③坏文件: 清理后创建 spawned=true", r.spawned === true);
  check("③坏文件: 新实例健康且文件已换新", r.health.id === r.svc.id && r.svc.password.length > 20);
}

async function scenario4_double_spawn_race(): Promise<void> {
  await killAll();
  resetState();
  const a = spawnServer();
  await sleep(60); // 微错峰：模拟插件端两实例几乎同时拉起（a 稍先到达抢锁点；b 后到走 in-use 路径）
  const b = spawnServer();
  const exitPids = await Promise.race([
    Promise.all([waitExit(a, 20_000), waitExit(b, 20_000)]).then(() => "both-exited" as const),
    (async () => {
      // 等待恰一个退出
      for (let i = 0; i < 100; i++) {
        await sleep(200);
        const aDead = !isRunning(a);
        const bDead = !isRunning(b);
        if (aDead !== bDead) return "one-exited" as const;
        if (aDead && bDead) return "both-exited" as const;
      }
      return "timeout" as const;
    })(),
  ]);
  check("④竞态: 恰一个退出", exitPids === "one-exited", `outcome=${exitPids}`);
  const loser = !isRunning(a) ? a : b;
  const winner = loser === a ? b : a;
  check("④竞态: 后到者退出码 0", loser.exitCode === 0, `exitCode=${loser.exitCode}`);
  check("④竞态: 存活者仍活着", isRunning(winner) && winner.pid !== undefined && isPidAlive(winner.pid));
  const svc = JSON.parse(readFileSync(serviceFilePath(pathEnv), "utf8")) as ServiceFile;
  check("④竞态: service.json 归存活者", svc.pid === winner.pid, `svc.pid=${svc.pid} winner.pid=${winner.pid}`);
  const h = await probe(svc);
  check("④竞态: 存活者 health OK", h !== null && h.id === svc.id);
  const reuse = await findOrCreate();
  check("④竞态: 事后发现走复用", reuse.spawned === false && reuse.svc.id === svc.id);
}

async function scenario5_dead_lock_takeover(): Promise<void> {
  const alive = children.find((c) => isRunning(c));
  if (!alive?.pid) throw new Error("no alive server from scenario 4");
  const oldPid = alive.pid;
  process.kill(alive.pid, "SIGKILL");
  await sleep(300);
  check("⑤前置: kill -9 后锁残留", existsSync(lockFilePath(pathEnv)));
  const r = await findOrCreate();
  check("⑤死锁抢占: 新实例接管 spawned=true", r.spawned === true);
  check("⑤死锁抢占: 新实例健康", r.health.id === r.svc.id && r.svc.pid !== oldPid);
  check("⑤死锁抢占: 锁已换新 pid", readFileSync(lockFilePath(pathEnv), "utf8") === String(r.svc.pid));
}

async function scenario6_graceful_shutdown(): Promise<void> {
  const alive = children.find((c) => isRunning(c));
  if (!alive?.pid) throw new Error("no alive server from scenario 5");
  process.kill(alive.pid, "SIGTERM");
  const code = await waitExit(alive, 5000);
  check("⑥优雅退出: 退出码 0", code === 0, `code=${code}`);
  check("⑥优雅退出: service.json 已清", !existsSync(serviceFilePath(pathEnv)));
  check("⑥优雅退出: 锁已清", !existsSync(lockFilePath(pathEnv)));
}

// ---- watchdog + 收尾 ----
const watchdog = setTimeout(() => {
  console.error("TIMEOUT: verify-m1 exceeded 90s, killing all children");
  for (const c of children) {
    if (isRunning(c) && c.pid) {
      try {
        process.kill(c.pid, "SIGKILL");
      } catch {
        /* best-effort */
      }
    }
  }
  process.exit(1);
}, 90_000);

process.on("SIGINT", async () => {
  await killAll("SIGKILL");
  process.exit(130);
});

const scenarios: Array<[string, () => Promise<void>]> = [
  ["① 发现-创建-复用 + 权限", scenario1_discover_create_reuse],
  ["② stale service.json 清理", scenario2_stale_service],
  ["③ 坏 service.json 清理", scenario3_broken_service_file],
  ["④ 双并发竞争锁", scenario4_double_spawn_race],
  ["⑤ 死锁抢占", scenario5_dead_lock_takeover],
  ["⑥ 优雅退出自清", scenario6_graceful_shutdown],
];

console.log(`verify-m1: XDG=${XDG} server=${SERVER_VERSION}\n`);
let scenarioFailed = false;
for (const [name, fn] of scenarios) {
  results.push(`■ ${name}`);
  try {
    await fn();
  } catch (err) {
    scenarioFailed = true;
    check(`${name}（场景自身）`, false, String(err));
  }
  results.push("");
}

console.log(results.join("\n"));
console.log(`verify-m1: ${passed} passed, ${failed} failed`);

clearTimeout(watchdog);
await killAll();
rmSync(XDG, { recursive: true, force: true });
process.exit(failed > 0 || scenarioFailed ? 1 : 0);
