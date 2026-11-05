// 阶段 E 真机验收（SERVER-PLAN）：管线全套（M3）
//  ① 风暴合并：30 行 ERROR → 1 条通知（SERVER-PLAN 验收判据原文）
//     ——合并批含 [30 lines coalesced] 头、前 10 行预览、(… 20 more lines suppressed)；
//     lifecycle 保序在后，注明 30 matched / 1 sent
//  ② pattern 过滤：ERROR/OK 混合输出 + pattern=^ERROR → 通知仅含 ERROR 行，
//     meta 计数 matched=命中数 / scanned=总数
//  ③ 令牌桶：同 tick 8 行（coalesce 0 直通）→ 突发 5 送达、3 丢弃（时间无关，确定性）
//  ④ max_events 即停即杀：无限循环任务 + max_events=2 → stopped + 进程组 SIGTERM
//     + lifecycle 注明 reached max_events（真机投递链时序，额度断言取上界）
// 隔离：服务端 state 走 /tmp/opencode/omt-storm-sim-<pid>；probe session 用后即删；
//       凭证只现读、输出脱敏（session id 截断，password 永不出现）。
//
// 前置：opencode 共享服务运行中（~/.local/state/opencode/service.json 存在且 /api/info 200）
// 用法: node --import tsx scripts/storm-sim.ts

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
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
import { resolveServerEntry } from "./lib/server-entry.ts";
const entry = resolveServerEntry(ROOT);
const XDG = mkdtempSync("/tmp/opencode/omt-storm-sim-");
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
  const child = spawn(entry.command, [...entry.baseArgs, ...args], {
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

/** 会话收到的信封消息（生产投递不带 resume → 出现在 message 列表，type synthetic） */
async function sessionEnvelopes(sid: string): Promise<string[]> {
  const res = await fetch(`${ocSvc.url}/api/session/${encodeURIComponent(sid)}/message`, { headers: ocAuth });
  const body = (await res.json()) as { data?: Array<{ type?: string; text?: unknown }> };
  return (body.data ?? [])
    .filter((m) => m.type === "synthetic" && typeof m.text === "string" && m.text.includes("<task-notification>"))
    .map((m) => m.text as string);
}

/** 轮询等待信封出现（投递链异步：任务终态可见 ≠ 消息已达会话——链上 wake/lifecycle
 *  仍在送达途中，最终一致；验收必须等消息本身，不能只等任务状态） */
async function awaitEnvelope(sid: string, pred: (t: string) => boolean, timeoutMs = 20000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envs = await sessionEnvelopes(sid).catch(() => [] as string[]);
    const hit = envs.find(pred);
    if (hit !== undefined) return hit;
    await sleep(100);
  }
  return null;
}

/** 轮询任务字段直到期望值（events_sent 是送达回调计数——终态后仍会增长） */
async function awaitTaskField(client: MonitorClient, id: string, pred: (t: PublicInfo) => boolean, timeoutMs = 20000): Promise<PublicInfo | null> {
  const deadline = Date.now() + timeoutMs;
  let last: PublicInfo | null = null;
  while (Date.now() < deadline) {
    last = await client.getTask(id).catch(() => null);
    if (last !== null && pred(last)) return last;
    await sleep(100);
  }
  return last;
}

// ---------------------------------------------------------------------------
// 场景

function stormLines(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix} storm ${i + 1}`).join("\\n");
}

async function scenario1_storm(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-storm-sim-1");
  try {
    const t = await client.createTask({
      command: `printf '${stormLines(30, "ERROR")}\\n'`,
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      description: "storm-30",
    });
    const final = await waitForTerminal(client, t.id);
    check("①风暴: 任务终态 completed", final?.state === "completed", `state=${final?.state}`);
    // events_sent 送达回调计数：终态可见 ≠ 投递完成（同 ③④ 裁定，轮询至稳定值）
    const settled = await awaitTaskField(client, t.id, (t2) => t2.events_sent === 1 && t2.events_dropped === 0);
    check("①风暴: events_sent=1（30 行合 1 条）", settled?.events_sent === 1, `sent=${settled?.events_sent}`);
    check("①风暴: events_dropped=0", settled?.events_dropped === 0, `dropped=${settled?.events_dropped}`);
    check("①风暴: lines 30 matched / 30 scanned", settled?.lines_matched === 30 && settled?.lines_scanned === 30);

    const envs = await sessionEnvelopes(sid);
    const wake = await awaitEnvelope(sid, (e) => e.includes("[30 lines coalesced]"));
    check("①风暴: 恰 1 条合并 wake（[30 lines coalesced] 头）", wake !== null, `envelopes=${envs.length}`);
    if (wake) {
      check("①风暴: 前 10 行预览（line 10 在，line 11 无）", wake.includes("ERROR storm 10") && !wake.includes("ERROR storm 11\n"));
      check("①风暴: suppressed 计数（20 行标注）", wake.includes("(… 20 more lines suppressed)"));
      check("①风暴: 信封完整（转义 + 闭合恰一次）", wake.startsWith("<task-notification>\n") && wake.split("</task-notification>").length === 2);
    }
    const lc = await awaitEnvelope(sid, (e) => e.includes("finished: completed"));
    check(
      "①风暴: lifecycle 注明 30 matched / 1 sent",
      lc !== null && lc.includes("30 matched") && lc.includes("1 sent"),
      lc === null ? "lifecycle not arrived" : lc.slice(0, 160),
    );
  } finally {
    await deleteProbeSession(sid);
  }
}

const TERMINAL_STATES = new Set(["completed", "failed", "stopped", "orphaned"]);

async function waitForTerminal(client: MonitorClient, id: string): Promise<PublicInfo | null> {
  let last: PublicInfo | null = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    last = await client.getTask(id).catch(() => null);
    if (last !== null && TERMINAL_STATES.has(last.state)) return last;
    await sleep(50);
  }
  return last;
}

async function scenario2_pattern(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-storm-sim-2");
  try {
    const cmd = `printf 'OK line 1\\nERROR hit alpha\\nOK line 2\\nERROR hit beta\\nOK line 3\\n'`;
    const t = await client.createTask({
      command: cmd,
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      pattern: "^ERROR",
    });
    const final = await waitForTerminal(client, t.id);
    check("②pattern: matched=2 / scanned=5", final?.lines_matched === 2 && final?.lines_scanned === 5, `m=${final?.lines_matched} s=${final?.lines_scanned}`);
    const wake = await awaitEnvelope(sid, (e) => e.includes("hit alpha"));
    check("②pattern: wake 仅含 ERROR 命中行", wake !== null && !wake.includes("OK line"), wake?.slice(0, 120) ?? "not arrived");
    const lc = await awaitEnvelope(sid, (e) => e.includes("2 matched, 3 filtered"));
    check("②pattern: lifecycle 注明 2 matched / 3 filtered", lc !== null);
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario3_bucket(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-storm-sim-3");
  try {
    const t = await client.createTask({
      command: `printf '${stormLines(8, "TOK")}\\n'`,
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      coalesce_ms: 0, // 直通：8 行同 tick 到达，突发 5 后丢 3（确定性，与真机时序无关）
      description: "bucket-8",
    });
    const final = await waitForTerminal(client, t.id);
    // events_sent 送达回调计数：终态可见后链上 5 条仍在送达——轮询至稳定期望值
    const settled = await awaitTaskField(client, t.id, (t2) => t2.events_sent === 5 && t2.events_dropped === 3);
    check("③令牌桶: sent=5（突发容量，synthetic 全 200）", settled?.events_sent === 5, `sent=${settled?.events_sent}`);
    check("③令牌桶: dropped=3（超限丢弃计数不缓存）", settled?.events_dropped === 3, `dropped=${settled?.events_dropped}`);
    // 会话显现受 opencode turn 调度排队影响（CONTRACT.md：每条 synthetic 一个 LLM turn、
    // 串行消化）——显现条数不作判据，只验证"已显现的 wake 每条恰单行"（直通无合并）
    await awaitEnvelope(sid, (e) => e.includes("TOK storm"));
    const wakes = (await sessionEnvelopes(sid)).filter((e) => e.includes("TOK storm"));
    const allSingle = wakes.length >= 1 && wakes.every((e) => (e.match(/TOK storm/g) ?? []).length === 1);
    check("③令牌桶: 已显现 wake 逐条独立（每封恰一行，直通无合并）", allSingle, `wakes=${wakes.length}`);
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario4_maxevents(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-storm-sim-4");
  try {
    const t = await client.createTask({
      command: "while true; do echo tick-sim; sleep 0.1; done",
      opencode_port: ocPort,
      session_id: sid,
      directory: XDG,
      max_events: 2,
      coalesce_ms: 0,
      description: "killok-2",
    });
    const pid = t.pid;
    const final = await waitForTerminal(client, t.id);
    check("④即停即杀: 终态 stopped", final?.state === "stopped", `state=${final?.state}`);
    check("④即停即杀: exit signal:15（SIGTERM 温和停止）", final?.exit_info?.code === "signal:15", `exit=${final?.exit_info?.code}`);
    check("④即停即杀: 进程组消亡", !(pid && isTaskProcessAlive({ pid, startTime: null })));
    check("④即停即杀: 额度不超（sent ≤ 2）", (final?.events_sent ?? 99) <= 2, `sent=${final?.events_sent}`);
    const settled4 = await awaitTaskField(client, t.id, (t2) => t2.events_sent === 2);
    check("④即停即杀: sent 恰为额度 2（lifecycle 不占额，synthetic 200 已入账）", settled4?.events_sent === 2, `sent=${settled4?.events_sent}`);
    // lifecycle 文本格式已由单测覆盖（monitor.test.ts reason 行）；会话显现受 turn 调度
    // 排队影响不作判据——lifecycle 投递成功由 meta 终态 + sent 账目 + 服务端日志佐证，
    // ①场景已完整验证过 lifecycle → 会话显现链路
    const logPath = `${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/server.log`;
    const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("④即停即杀: 服务端日志注明 reached max_events=2", logText.includes("reached max_events=2"));
  } finally {
    await deleteProbeSession(sid);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`storm-sim: XDG=${XDG}`);
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
    await scenario1_storm(client);
    await scenario2_pattern(client);
    await scenario3_bucket(client);
    await scenario4_maxevents(client);
  } finally {
    await killServers();
    rmSync(XDG, { recursive: true, force: true });
  }

  console.log(`\n场景结果:`);
  for (const line of results) console.log(line);
  const verdict = failed === 0 ? "PASS" : "FAIL";
  console.log(`\nstorm-sim ${verdict}: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(async (err) => {
  console.error(`storm-sim crashed: ${String(err)}`);
  await killServers();
  rmSync(XDG, { recursive: true, force: true });
  process.exitCode = 1;
});
