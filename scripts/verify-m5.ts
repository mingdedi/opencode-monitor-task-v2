// 真机验收：恢复与加固
//  ① 优雅 kill：SIGTERM 服务端 → 任务进程存活照跑（log 持续增长）→ 重启 reattach
//     认领 → health.reattach.claimed=1 → 缺席摘要恰 1 条送达真实 session（绝不逐行重放）
//     → last_offset 续读（缺席行不重算）
//  ② 缺席期间自然退出：SIGTERM 服务端 → 任务退出（exit 文件落盘）→ 重启 → finalized=1
//     → 终态 + exit code + 合并结局信封（"finished while the server was away" + 摘要）
//  ③ kill -9 硬崩溃：service.json/lock 残留（stale 路径）→ 重启照常认领 + 摘要送达
//  ④ parked：SIGTERM 后删任务 log → 重启 → reattach.failed=1 + /api/tasks 显示 parked
//     （P1 根治：认领失败可见，不哑跑）+ 进程不被误杀
//  ⑤ /api/shutdown：无 kill_tasks → 服务端退、任务存活；kill_tasks=true → killed=2、
//     进程组全灭、服务端退
//  ⑥ 权限审计：state/data 根与任务目录 0700；meta.json/log/exit 600；
//     server.log 不含命令全文
// 隔离：服务端 state/data 走 /tmp/opencode/omt-verify-m5-<pid>；probe session 用后即删；
//       投递成功判据 = synthetic 200 + 信封实际到达会话（message API，）。
//
// 前置：opencode 共享服务运行中（~/.local/state/opencode/service.json 存在且 /api/info 200）
// 用法: node --import tsx scripts/verify-m5.ts

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MonitorClient,
  opencodeAuthHeader,
  readOpencodeService,
  type HealthInfo,
  type PathEnv,
  type PublicInfo,
} from "@omt/shared";
import { isTaskProcessAlive } from "../packages/server/src/spawner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { resolveServerEntry } from "./lib/server-entry.ts";
const entry = resolveServerEntry(ROOT);
const XDG = mkdtempSync("/tmp/opencode/omt-verify-m5-");
const pathEnv: PathEnv = { XDG_STATE_HOME: `${XDG}/state`, XDG_DATA_HOME: `${XDG}/data` };
const SERVER_LOG = `${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/server.log`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

// ---- 服务端进程 ----
const children: ChildProcess[] = [];
let currentServer: ChildProcess | null = null;
/** 真实 opencode 共享服务的 service.json（注册表白名单条目；verify 前置） */
const realServicePath = `${homedir()}/.local/state/opencode/service.json`;
function spawnServer(): ChildProcess {
  const child = spawn(entry.command, [...entry.baseArgs, "--opencode-state", realServicePath], {
    cwd: ROOT,
    env: { ...process.env, XDG_STATE_HOME: pathEnv.XDG_STATE_HOME, XDG_DATA_HOME: pathEnv.XDG_DATA_HOME },
    stdio: "ignore",
    detached: true,
  });
  children.push(child);
  currentServer = child;
  return child;
}
async function waitServerHealthy(timeoutMs = 15000): Promise<MonitorClient> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(`${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/service.json`, "utf8");
      const svc = JSON.parse(raw) as { url: string; password: string };
      const client = new MonitorClient(svc.url, svc.password);
      const h = await client.health();
      if (h.version) return client;
    } catch {
      // 尚未就绪
    }
    await sleep(150);
  }
  throw new Error("server did not become healthy");
}
/** 等 reattach 完成（health.reattach 非 null） */
async function awaitReattach(client: MonitorClient, timeoutMs = 20000): Promise<HealthInfo["reattach"]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await client.health().catch(() => null);
    if (h?.reattach !== null && h?.reattach !== undefined) return h.reattach;
    await sleep(150);
  }
  return null;
}
/** 真正在服务的实例 pid（service.json 是唯一真相源——spawn 链中的 no-op 后到者不是服务者） */
function servingPid(): number | null {
  try {
    const raw = readFileSync(svcPathOf(), "utf8");
    return (JSON.parse(raw) as { pid?: number }).pid ?? null;
  } catch {
    return null;
  }
}
async function stopServerHard(sig: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
  const svc = servingPid();
  if (svc !== null) {
    try {
      process.kill(svc, sig);
    } catch {
      /* 已死 */
    }
  }
  // 兜底：spawn 链中可能残留的 child（in-use no-op 已自行退出，SIGKILL 场景 service.json 可能残留）
  for (const c of children) {
    if (c.pid && c.pid !== svc) {
      try {
        process.kill(c.pid, sig);
      } catch {
        /* 已死 */
      }
    }
  }
  await sleep(400);
  currentServer = null;
}
async function killServers(): Promise<void> {
  for (const c of children) {
    if (c.pid) {
      try {
        process.kill(c.pid, "SIGKILL");
      } catch {
        /* 已死 */
      }
    }
  }
  await sleep(200);
}

async function waitFor(cond: () => boolean, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

// ---- opencode 侧辅助 ----
const ocSvc = readOpencodeService(); // 前置：真实共享服务
const ocPort = Number(new URL(ocSvc.url).port);
const ocAuth = { authorization: opencodeAuthHeader(ocSvc), "content-type": "application/json" };

async function newProbeSession(title: string): Promise<string> {
  const res = await fetch(`${ocSvc.url}/api/session`, { method: "POST", headers: ocAuth, body: JSON.stringify({ title }) });
  const body = (await res.json()) as { id?: string; data?: { id?: string } };
  const sid = body.id ?? body.data?.id;
  if (!sid) throw new Error(`cannot create probe session: ${res.status}`);
  return sid;
}
async function deleteProbeSession(sid: string): Promise<void> {
  await fetch(`${ocSvc.url}/api/session/${sid}`, { method: "DELETE", headers: ocAuth }).catch(() => {});
}
/** 会话收到的信封消息（生产投递 → message 列表，type synthetic） */
async function sessionEnvelopes(sid: string): Promise<string[]> {
  const res = await fetch(`${ocSvc.url}/api/session/${encodeURIComponent(sid)}/message`, { headers: ocAuth });
  const body = (await res.json()) as { data?: Array<{ type?: string; text?: unknown }> };
  return (body.data ?? [])
    .filter((m) => m.type === "synthetic" && typeof m.text === "string" && m.text.includes("<task-notification>"))
    .map((m) => m.text as string);
}
async function awaitEnvelope(sid: string, pred: (t: string) => boolean, timeoutMs = 25000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envs = await sessionEnvelopes(sid).catch(() => [] as string[]);
    const hit = envs.find(pred);
    if (hit !== undefined) return hit;
    await sleep(150);
  }
  return null;
}
async function awaitTask(client: MonitorClient, id: string, pred: (t: PublicInfo) => boolean, timeoutMs = 20000): Promise<PublicInfo | null> {
  const deadline = Date.now() + timeoutMs;
  let last: PublicInfo | null = null;
  while (Date.now() < deadline) {
    last = await client.getTask(id).catch(() => null);
    if (last !== null && pred(last)) return last;
    await sleep(50);
  }
  return last;
}

const taskLog = (id: string) => `${pathEnv.XDG_DATA_HOME}/opencode-monitor-task/tasks/${id}/log`;
const logSize = (id: string) => {
  try {
    return statSync(taskLog(id)).size;
  } catch {
    return -1;
  }
};

// ---------------------------------------------------------------------------
// 场景

async function scenario1_graceful(): Promise<void> {
  const sid = await newProbeSession("omt-verify-m5-1");
  try {
    spawnServer();
    const client = await waitServerHealthy();
    const t = await client.createTask({
      command: "seq 1 200 | while read i; do echo away-line-$i; sleep 0.2; done",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      description: "graceful-reattach",
    });
    const pid = t.pid;
    // 等任务产出几行再杀服务端
    await waitFor(() => logSize(t.id) > 20);

    // SIGTERM 优雅退出：任务必须存活照跑
    await stopServerHard("SIGTERM");
    check("①优雅kill: 服务端退出后任务进程存活", !!(pid && isTaskProcessAlive({ pid, startTime: null })));
    const sizeBefore = logSize(t.id);
    await sleep(700);
    check("①优雅kill: 缺席期间 log 持续增长（文件即管道）", logSize(t.id) > sizeBefore, `${sizeBefore} -> ${logSize(t.id)}`);

    // 重启：reattach 认领 + 摘要恰一条（不逐行重放）
    spawnServer();
    const client2 = await waitServerHealthy();
    const ra = await awaitReattach(client2);
    check("①优雅kill: reattach.claimed=1", ra?.claimed === 1, JSON.stringify(ra));
    const after = await client2.getTask(t.id);
    check("①优雅kill: 任务恢复 running", after.state === "running", `state=${after.state}`);
    check(
      "①优雅kill: last_offset 续读（缺席行已计入 scanned，无重放重算）",
      after.lines_scanned > 3 && after.last_offset > 20,
      `scanned=${after.lines_scanned} offset=${after.last_offset}`,
    );

    const summary = await awaitEnvelope(sid, (e) => e.includes("reconnected"));
    check("①优雅kill: 缺席摘要信封送达真实会话", summary !== null, "not arrived");
    if (summary) {
      check("①优雅kill: 摘要注明 not replayed line-by-line", summary.includes("not replayed line-by-line"), summary.slice(0, 160));
      check("①优雅kill: 摘要含缺席行尾部预览（away-line-）", summary.includes("away-line-"), summary.slice(0, 200));
    }
    // 绝不逐行重放：此刻会话里的信封只有这一条 reconnected（任务未结束，无 lifecycle）
    const envs = await sessionEnvelopes(sid);
    check("①优雅kill: 缺席输出只此一条信封（风暴不逐行重放）", envs.length === 1, `envelopes=${envs.length}`);

    // 清场：stop → lifecycle 信封到达
    await client2.stopTask(t.id);
    const fin = await awaitTask(client2, t.id, (x) => x.state === "stopped");
    check("①优雅kill: stop 收场", fin?.state === "stopped", `state=${fin?.state}`);
    check("①优雅kill: 进程组消亡", !(pid && isTaskProcessAlive({ pid, startTime: null })));
    await stopServerHard("SIGTERM"); // 清场：场景自起点干净（后续场景不再受本场景实例牵连）
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario2_deadWhileAway(): Promise<void> {
  const sid = await newProbeSession("omt-verify-m5-2");
  try {
    spawnServer();
    const client = await waitServerHealthy();
    // 任务先起（活着），随即杀服务端——退出必须发生在"无观察者"期间
    const t = await client.createTask({
      command: "echo last-words; sleep 1; exit 9",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      description: "dead-while-away",
    });
    const pid = t.pid;
    await stopServerHard("SIGTERM");
    check("②缺席退出: 服务端缺席时任务仍在跑（观察窗口起点）", !!(pid && isTaskProcessAlive({ pid, startTime: null })));
    await waitFor(() => !isTaskProcessAlive({ pid: pid!, startTime: null })); // 缺席期间退出

    spawnServer();
    const client2 = await waitServerHealthy();
    const ra = await awaitReattach(client2);
    check("②缺席退出: reattach.finalized=1", ra?.finalized === 1, JSON.stringify(ra));
    const after = await client2.getTask(t.id);
    check("②缺席退出: 终态 failed + exit 9", after.state === "failed" && after.exit_info?.code === "9", `state=${after.state} exit=${after.exit_info?.code}`);
    check("②缺席退出: 缺席行已记账（last-words）", after.lines_scanned === 1, `scanned=${after.lines_scanned}`);

    const env = await awaitEnvelope(sid, (e) => e.includes("finished while the server was away"));
    check("②缺席退出: 合并结局信封送达", env !== null, "not arrived");
    if (env) {
      check("②缺席退出: 信封含 exit 9 与缺席摘要", env.includes("exit 9") && env.includes("last-words"), env.slice(0, 200));
    }
    // 合并视图：registry 空但 store 有 → 列表可见
    const list = await client2.listTasks(sid);
    check("②缺席退出: 终态任务在合并列表视图中可见", list.some((x) => x.id === t.id && x.state === "failed"));
    await stopServerHard("SIGTERM"); // 清场
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario3_kill9(): Promise<void> {
  const sid = await newProbeSession("omt-verify-m5-3");
  try {
    spawnServer();
    const client = await waitServerHealthy();
    const t = await client.createTask({
      command: "seq 1 300 | while read i; do echo k9-line-$i; sleep 0.2; done",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      description: "kill9-reattach",
    });
    await waitFor(() => logSize(t.id) > 20);

    // kill -9：无清理钩子运行——service.json/lock 残留 = stale 路径素材
    await stopServerHard("SIGKILL");
    const pid = t.pid;
    check("③kill-9: 任务进程不受牵连（detached 进程组）", !!(pid && isTaskProcessAlive({ pid, startTime: null })));
    const svcPath = `${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/service.json`;
    check("③kill-9: service.json 残留（stale 素材）", existsSync(svcPath));

    spawnServer();
    const client2 = await waitServerHealthy(); // 发现-创建流程走 stale 清理后接管
    const ra = await awaitReattach(client2);
    check("③kill-9: 硬崩溃后照常认领 claimed=1", ra?.claimed === 1, JSON.stringify(ra));
    const summary = await awaitEnvelope(sid, (e) => e.includes("reconnected"));
    check("③kill-9: 缺席摘要送达", summary !== null, "not arrived");
    await client2.stopTask(t.id);
    await awaitTask(client2, t.id, (x) => x.state === "stopped");
    await stopServerHard("SIGTERM"); // 清场
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario4_parked(): Promise<void> {
  const sid = await newProbeSession("omt-verify-m5-4");
  try {
    spawnServer();
    const client = await waitServerHealthy();
    const t = await client.createTask({
      command: "sleep 60",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      description: "parked-case",
    });
    const pid = t.pid;
    await stopServerHard("SIGTERM");
    // 服务端缺席期间 log 丢失（磁盘/人为故障模拟）→ 认领失败 → parked
    unlinkSync(taskLog(t.id));

    spawnServer();
    const client2 = await waitServerHealthy();
    const ra = await awaitReattach(client2);
    check("④parked: reattach.failed=1", ra?.failed === 1, JSON.stringify(ra));
    const parked = await client2.getTask(t.id);
    check("④parked: state=parked（列表可见，P1 根治不哑跑）", parked.state === "parked", `state=${parked.state}`);
    check("④parked: 进程不误杀", !!(pid && isTaskProcessAlive({ pid, startTime: null })));
    // 重启幂等：parked 非活态不再重复认领
    await stopServerHard("SIGTERM");
    spawnServer();
    const client3 = await waitServerHealthy();
    const ra2 = await awaitReattach(client3);
    check("④parked: 重扫不再计失败（幂等）", ra2?.failed === 0, JSON.stringify(ra2));
    check("④parked: 再次重启后仍可见", (await client3.getTask(t.id)).state === "parked");
    // 清场：DELETE 终态清理路径（parked 非活态可 DELETE）
    await client3.deleteTask(t.id);
    check("④parked: parked 可 DELETE 清理", (await client3.getTask(t.id).catch(() => null)) === null);
    process.kill(-pid!, "SIGKILL");
    await stopServerHard("SIGTERM"); // 清场
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario5_shutdownApi(): Promise<void> {
  const sid = await newProbeSession("omt-verify-m5-5");
  try {
    spawnServer();
    const client = await waitServerHealthy();
    const t1 = await client.createTask({ command: "sleep 120", opencode_port: ocPort, session_id: sid, directory: XDG, description: "sd-1" });
    const t2 = await client.createTask({ command: "sleep 120", opencode_port: ocPort, session_id: sid, directory: XDG, description: "sd-2" });
    const svcRaw = readFileSync(`${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/service.json`, "utf8");
    const svc = JSON.parse(svcRaw) as { url: string; password: string };

    // 优雅关停（默认不杀任务）
    const r1 = await fetch(`${svc.url}/api/shutdown`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`monitor:${svc.password}`).toString("base64"), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const b1 = (await r1.json()) as { ok?: boolean; killed?: number };
    check("⑤shutdown: 无 kill_tasks 响应 ok/killed=0", r1.status === 200 && b1.ok === true && b1.killed === 0, JSON.stringify(b1));
    await sleep(600); // 等 150ms 延迟退出 + exit 钩子清理落地
    check("⑤shutdown: 服务端已退出（service.json 自清）", !existsSync(svcPathOf()));
    check("⑤shutdown: 任务进程照常存活（设计语义）", !!(t1.pid && isTaskProcessAlive({ pid: t1.pid, startTime: null })) && !!(t2.pid && isTaskProcessAlive({ pid: t2.pid, startTime: null })));

    // 重启认领后 kill_tasks=true 全杀
    spawnServer();
    const client2 = await waitServerHealthy();
    await awaitReattach(client2);
    const svc2 = JSON.parse(readFileSync(svcPathOf(), "utf8")) as { url: string; password: string };
    const r2 = await fetch(`${svc2.url}/api/shutdown`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`monitor:${svc2.password}`).toString("base64"), "content-type": "application/json" },
      body: JSON.stringify({ kill_tasks: true }),
    });
    const b2 = (await r2.json()) as { ok?: boolean; killed?: number };
    check("⑤shutdown: kill_tasks=true 响应 killed=2", r2.status === 200 && b2.killed === 2, JSON.stringify(b2));
    await sleep(800);
    check("⑤shutdown: 两任务进程组全灭", !isTaskProcessAlive({ pid: t1.pid!, startTime: null }) && !isTaskProcessAlive({ pid: t2.pid!, startTime: null }));
    currentServer = null; // 已退出
  } finally {
    await deleteProbeSession(sid);
  }
}
function svcPathOf(): string {
  return `${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/service.json`;
}

async function scenario6_audit(): Promise<void> {
  const mode = (p: string): number | null => {
    try {
      return statSync(p).mode & 0o777;
    } catch {
      return null;
    }
  };
  const stateRoot = `${pathEnv.XDG_STATE_HOME}/opencode-monitor-task`;
  const tasksRoot = `${pathEnv.XDG_DATA_HOME}/opencode-monitor-task/tasks`;
  check("⑥审计: state 根目录 0700", mode(stateRoot) === 0o700, String(mode(stateRoot)));
  check("⑥审计: tasks 根目录 0700", mode(tasksRoot) === 0o700, String(mode(tasksRoot)));
  // 任一现存任务目录与文件
  const entries = existsSync(tasksRoot) ? readdirSync(tasksRoot) : [];
  let dirOk = true;
  let fileOk = true;
  for (const e of entries) {
    if (mode(`${tasksRoot}/${e}`) !== 0o700) dirOk = false;
    for (const f of ["meta.json", "log", "exit", "pending.json"]) {
      const m = mode(`${tasksRoot}/${e}/${f}`);
      if (m !== null && m !== 0o600) fileOk = false;
    }
  }
  check("⑥审计: 任务目录 0700", dirOk, entries.join(","));
  check("⑥审计: meta/log/exit/pending 600", fileOk);
  // server.log 不含命令全文
  const logText = existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, "utf8") : "";
  check("⑥审计: server.log 无命令全文", !logText.includes("while read i") && !logText.includes("sleep 120"), `log ${logText.length}B`);
  check("⑥审计: server.log 含 reattach 认领留痕（显式化）", logText.includes("reattach:"), "no reattach trace");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`verify-m5: XDG=${XDG}\n`);

  await scenario1_graceful();
  console.log("场景① 优雅 kill + reattach：");
  console.log(results.splice(0).join("\n"));

  await scenario2_deadWhileAway();
  console.log("\n场景② 缺席期间自然退出：");
  console.log(results.splice(0).join("\n"));

  await scenario3_kill9();
  console.log("\n场景③ kill -9 硬崩溃：");
  console.log(results.splice(0).join("\n"));

  await scenario4_parked();
  console.log("\n场景④ parked 可见：");
  console.log(results.splice(0).join("\n"));

  await scenario5_shutdownApi();
  console.log("\n场景⑤ /api/shutdown：");
  console.log(results.splice(0).join("\n"));

  await scenario6_audit();
  console.log("\n场景⑥ 权限审计：");
  console.log(results.splice(0).join("\n"));

  console.log(`\n===== verify-m5: ${passed} passed, ${failed} failed =====`);
  await killServers();
  await sleep(200);
  try {
    rmSync(XDG, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("verify-m5 fatal:", err);
  try {
    rmSync(XDG, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  killServers().then(() => process.exit(1));
});
