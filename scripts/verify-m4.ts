// 阶段 F 真机验收（SERVER-PLAN）：裁决与管理（M4）
//  ① idle 两段式全路径：短窗口（2500ms）静默 → idle + 裁决信封（含 keepalive 指引，
//     queue/不占额）→ 不动作 → 宽限到期自动杀 stopped（v1 reason 文案）+ 进程组消亡
//  ② keepalive 复活：idle → keepalive → running + grace 清空 + 计时重置（再次转 idle
//     而非被杀）→ 第二次 idle 后 stop 收场
//  ③ 输出自愈：静默转 idle 后恢复输出 → running → 自然 completed（宽限不杀）
//  ④ 并发上限：同 session 第 17 个存活任务 400 SESSION_TASK_LIMIT；stop 释放额度后可再建
//  ⑤ 终态拒绝 + 幂等：终态上 keepalive/PATCH → 409 TASK_TERMINAL；stop → 200 同快照
//  ⑥ 管理面：运行中 DELETE → 409；终态 DELETE → 204 + 404；PATCH 运行中生效；
//     降额即杀（lowered by update）；readLog 尾部
// 隔离：服务端 state 走 /tmp/opencode/omt-verify-m4-<pid>；probe session 用后即删；
//       投递成功判据以 synthetic 200 + meta 计数为权威（CONTRACT.md E 阶段裁定），
//       信封显现只对裁决通知断言一次（每条 synthetic 一个 LLM turn——省 turn 预算）。
//
// 前置：opencode 共享服务运行中（~/.local/state/opencode/service.json 存在且 /api/info 200）
// 用法: node --import tsx scripts/verify-m4.ts

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MonitorApiError,
  MonitorClient,
  opencodeAuthHeader,
  opencodeServicePath,
  readOpencodeService,
  type HealthInfo,
  type PathEnv,
  type PublicInfo,
} from "@omt/shared";
import { isTaskProcessAlive } from "../packages/server/src/spawner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_TS = path.join(ROOT, "packages", "server", "src", "main.ts");
const XDG = mkdtempSync("/tmp/opencode/omt-verify-m4-");
const pathEnv: PathEnv = { XDG_STATE_HOME: `${XDG}/state`, XDG_DATA_HOME: `${XDG}/data` };

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
function spawnServer(args: string[]): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", MAIN_TS, ...args], {
    cwd: ROOT,
    env: { ...process.env, XDG_STATE_HOME: pathEnv.XDG_STATE_HOME, XDG_DATA_HOME: pathEnv.XDG_DATA_HOME },
    stdio: "ignore",
    detached: true,
  });
  children.push(child);
  return child;
}
async function killServers(): Promise<void> {
  for (const c of children) {
    if (c.pid) {
      try {
        process.kill(c.pid, "SIGTERM");
      } catch {
        /* 已死 */
      }
    }
  }
  await sleep(400);
}

async function waitFor(cond: () => boolean, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

/** 期待 client 调用抛 MonitorApiError 且 status/code 符合 */
async function expectApiError(
  fn: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<{ ok: boolean; got?: string }> {
  try {
    await fn();
    return { ok: false, got: "no error thrown" };
  } catch (err) {
    if (err instanceof MonitorApiError) {
      return { ok: err.status === status && err.body?.code === code, got: `${err.status}/${err.body?.code}` };
    }
    return { ok: false, got: String(err) };
  }
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

/** 轮询任务字段直到期望值 */
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

// ---------------------------------------------------------------------------
// 场景

async function scenario1_twoStage(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-verify-m4-1");
  try {
    const t = await client.createTask({
      // 纯内建忙循环（无前台外部子进程）：TERM 后无 "已终止/Terminated" 作业回声行——
      // 杀后冲刷语义会读回声行并占 wake 额度，破坏 sent=0 断言（回声也是真实输出，
      // 语义上送达正确；此处为断言确定性消除回声，与 monitor.test 同款处理）
      command: "while :; do :; done",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      idle_timeout_ms: 2500,
      description: "idle-2stage",
    });
    const pid = t.pid;

    // 第一段：转 idle，宽限字段齐备（idle_deadline 剩余毫秒 / grace_deadline epoch）
    const idle = await awaitTask(client, t.id, (x) => x.state === "idle");
    check("①两段式: 转 idle（裁决暂停态，进程仍活）", idle?.state === "idle", `state=${idle?.state}`);
    check("①两段式: 进程仍活", !!(pid && isTaskProcessAlive({ pid, startTime: null })));
    check(
      "①两段式: grace_deadline epoch 已设",
      idle?.grace_deadline !== null && (idle?.grace_deadline ?? 0) > Date.now() - 500,
      `grace=${idle?.grace_deadline}`,
    );
    check(
      "①两段式: idle_deadline 剩余毫秒 ∈ (0, 2500]",
      idle?.idle_deadline !== null && (idle?.idle_deadline ?? 0) > 0 && (idle?.idle_deadline ?? 0) <= 2500,
      `remaining=${idle?.idle_deadline}`,
    );

    // 裁决信封到达会话（恒 queue 不占额——sent 恒 0）
    const arb = await awaitEnvelope(sid, (e) => e.includes("monitor idle:"));
    check("①两段式: 裁决信封到达会话", arb !== null, "not arrived");
    if (arb) {
      check("①两段式: 信封注明 no output for 2500ms", arb.includes("no output for 2500ms"), arb.slice(0, 120));
      check("①两段式: 信封含 keepalive 指引", arb.includes(`monitor_manage(action="keepalive", monitor_id="${t.id}")`));
      check("①两段式: 信封含宽限警示", arb.includes("No decision within 2500ms"));
    }

    // 第二段：不动作 → 宽限到期自动杀（总 5s：idle 2.5 + grace 2.5）
    const dead = await awaitTask(client, t.id, (x) => x.state === "stopped", 12000);
    check("①两段式: 宽限到期自动杀 stopped", dead?.state === "stopped", `state=${dead?.state}`);
    check("①两段式: exit signal:15（SIGTERM 温和停止）", dead?.exit_info?.code === "signal:15", `exit=${dead?.exit_info?.code}`);
    check("①两段式: 终态清空宽限字段", dead?.grace_deadline === null && dead?.idle_deadline === null);
    check("①两段式: 进程组消亡", !(pid && isTaskProcessAlive({ pid, startTime: null })));
    check("①两段式: 裁决通知不占 wake 额度（sent=0）", (await client.getTask(t.id)).events_sent === 0);
    // lifecycle reason：meta/服务端日志权威（信封受 turn 调度排队影响不作判据——E 阶段裁定）
    const logPath = `${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/server.log`;
    const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("①两段式: 服务端日志注明 idle timeout 自动杀", logText.includes("idle timeout after 2500ms without output"));
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario2_keepalive(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-verify-m4-2");
  try {
    const t = await client.createTask({
      command: "sleep 300",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      idle_timeout_ms: 2000,
    });
    // 转 idle → keepalive 复活
    await awaitTask(client, t.id, (x) => x.state === "idle");
    const revived = await client.keepalive(t.id);
    check("②keepalive: idle → running 复活", revived.state === "running", `state=${revived.state}`);
    check("②keepalive: 宽限清空", revived.grace_deadline === null && revived.idle_deadline === null);
    // 计时重置：再次静默 2s → 再次转 idle（而非被宽限杀）
    const again = await awaitTask(client, t.id, (x) => x.state === "idle", 8000);
    check("②keepalive: 计时重置——再次转 idle 而非被杀", again?.state === "idle", `state=${again?.state}`);
    // 收场：从 idle 态 stop（覆盖 idle → stopped 路径）
    const stopped = await client.stopTask(t.id);
    check("②keepalive: idle 态 stop → stopped", stopped.state === "stopped" && stopped.exit_info?.code === "signal:15");
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario3_selfHeal(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-verify-m4-3");
  try {
    // t=1.5s 转 idle；宽限截止 t=3.0s；t=2.2s 恢复输出（窗口内）→ 自愈 running；t=2.6s 自然退出
    const t = await client.createTask({
      command: "sleep 2.2; printf 'REVIVED-m4 line\\n'; sleep 0.4",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      idle_timeout_ms: 1500,
    });
    await awaitTask(client, t.id, (x) => x.state === "idle");
    const healed = await awaitTask(client, t.id, (x) => x.state === "running", 6000);
    check("③自愈: idle --新输出--> running", healed?.state === "running", `state=${healed?.state}`);
    const final = await awaitTask(client, t.id, (x) => x.state === "completed", 8000);
    check("③自愈: 宽限不杀，自然 completed", final?.state === "completed", `state=${final?.state}`);
    // sent 送达回调计数：终态可见 ≠ 投递完成（E 阶段裁定）——轮询至稳定值
    const settled = await awaitTask(client, t.id, (x) => x.events_sent === 1, 8000);
    check("③自愈: 恢复行送达（sent=1）", settled?.events_sent === 1, `sent=${settled?.events_sent}`);
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario4_sessionCap(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-verify-m4-4");
  try {
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      const t = await client.createTask({
        command: "sleep 600",
        opencode_port: ocPort,
        session_id: sid,
        directory: XDG,
        description: `cap-${i}`,
      });
      ids.push(t.id);
    }
    const list = await client.listTasks(sid);
    check("④上限: 16 个存活任务在册", list.filter((x) => x.state === "running").length === 16, `alive=${list.length}`);

    // 第 17 个 → 400 SESSION_TASK_LIMIT
    const rej = await expectApiError(
      () => client.createTask({ command: "sleep 600", opencode_port: ocPort, session_id: sid, directory: XDG }),
      400,
      "SESSION_TASK_LIMIT",
    );
    check("④上限: 第 17 个任务 400 SESSION_TASK_LIMIT", rej.ok, rej.got ?? "");

    // stop 释放额度后可再建（生命周期闭环）
    await client.stopTask(ids[0]!);
    const again = await client.createTask({ command: "sleep 600", opencode_port: ocPort, session_id: sid, directory: XDG });
    check("④上限: stop 释放额度后可再建", again.state === "running");
    ids.push(again.id);

    // 清场：并行 stop（各自 killTree 宽限并发走）
    await Promise.all(ids.map((id) => client.stopTask(id).catch(() => null)));
    const final = await client.listTasks(sid);
    check("④上限: 清场后全部 stopped", final.every((x) => x.state === "stopped"), final.map((x) => x.state).join(","));
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario5_terminalReject(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-verify-m4-5");
  try {
    // 短任务自然终态
    const t = await client.createTask({
      command: "echo done-m5",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      coalesce_ms: 0,
    });
    const final = await awaitTask(client, t.id, (x) => x.state === "completed");
    check("⑤终态拒绝: 任务 completed", final?.state === "completed");

    const ka = await expectApiError(() => client.keepalive(t.id), 409, "TASK_TERMINAL");
    check("⑤终态拒绝: keepalive → 409 TASK_TERMINAL", ka.ok, ka.got ?? "");
    const patch = await expectApiError(() => client.updateTask(t.id, { max_events: 10 }), 409, "TASK_TERMINAL");
    check("⑤终态拒绝: PATCH → 409 TASK_TERMINAL", patch.ok, patch.got ?? "");

    // stop 幂等：终态 → 200 同快照（v1 already-stopped 语义）
    const stopped = await client.stopTask(t.id);
    check("⑤幂等: 终态 stop → 200 且快照仍 completed", stopped.state === "completed");

    // readLog：echo 行可见
    const log = await client.readLog(t.id, 5);
    check("⑤readLog: 尾部含输出行", log.includes("done-m5"), JSON.stringify(log.slice(0, 60)));
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario6_manageOps(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-verify-m4-6");
  try {
    // 运行中 DELETE → 409
    const run = await client.createTask({
      command: "sleep 300",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
    });
    const del1 = await expectApiError(() => client.deleteTask(run.id), 409, "TASK_NOT_TERMINAL");
    check("⑥管理面: 运行中 DELETE → 409 TASK_NOT_TERMINAL", del1.ok, del1.got ?? "");
    // PATCH 运行中生效
    const patched = await client.updateTask(run.id, { max_events: 123 });
    check("⑥管理面: PATCH 运行中生效（max_events=123）", patched.max_events === 123, `me=${patched.max_events}`);
    // stop → 终态 DELETE → 204 → get 404
    await client.stopTask(run.id);
    await client.deleteTask(run.id);
    const gone = await expectApiError(() => client.getTask(run.id), 404, "TASK_NOT_FOUND");
    check("⑥管理面: 终态 DELETE → 204 后 404", gone.ok, gone.got ?? "");

    // 降额即杀：2 条已送达 + PATCH max_events=1 → 立即 stopped
    const t2 = await client.createTask({
      command: "printf 'L1-m6\\nL2-m6\\n'; sleep 300",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      coalesce_ms: 0,
      max_events: 50,
    });
    await awaitTask(client, t2.id, (x) => x.events_sent === 2);
    const lowered = await client.updateTask(t2.id, { max_events: 1 });
    check("⑥降额即杀: 降至已送达数以下 → 立即 stopped", lowered.state === "stopped", `state=${lowered.state}`);
    const logPath = `${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/server.log`;
    const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("⑥降额即杀: 日志注明 lowered by update", logText.includes("reached max_events=1 (lowered by update)"));
  } finally {
    await deleteProbeSession(sid);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`verify-m4: XDG=${XDG}`);
  const realServicePath = opencodeServicePath(); // 真实 opencode 共享服务
  if (!existsSync(realServicePath)) throw new Error(`opencode service.json not found: ${realServicePath}`);

  spawnServer(["--opencode-state", realServicePath]);
  const sfPath = `${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/service.json`;
  let client: MonitorClient | null = null;
  for (let i = 0; i < 50 && !client; i++) {
    await sleep(100);
    if (existsSync(sfPath)) {
      try {
        const svc = JSON.parse(readFileSync(sfPath, "utf8")) as { url: string; password: string };
        client = new MonitorClient(svc.url, svc.password);
        await client.health(2000);
      } catch {
        client = null;
      }
    }
  }
  if (!client) throw new Error("server not ready");
  const h: HealthInfo = await client.health(2000);
  console.log(`server ready: uptime=${h.uptime_s}s instances=${h.opencode_instances.length}`);

  try {
    await scenario1_twoStage(client);
    await scenario2_keepalive(client);
    await scenario3_selfHeal(client);
    await scenario4_sessionCap(client);
    await scenario5_terminalReject(client);
    await scenario6_manageOps(client);
  } finally {
    await killServers();
    rmSync(XDG, { recursive: true, force: true });
  }

  console.log(`\n场景结果:`);
  for (const line of results) console.log(line);
  const verdict = failed === 0 ? "PASS" : "FAIL";
  console.log(`\nverify-m4 ${verdict}: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(async (err) => {
  console.error(`verify-m4 crashed: ${String(err)}`);
  await killServers();
  rmSync(XDG, { recursive: true, force: true });
  process.exitCode = 1;
});
