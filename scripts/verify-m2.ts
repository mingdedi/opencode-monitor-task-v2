// 阶段 D 真机验收（SERVER-PLAN）：最小闭环（M2）
//  ① 服务端起（隔离 XDG + --opencode-state 真实路径）→ health 就绪
//  ② fail fast 四路：幻觉端口 400 / 死 session 404 / 坏命令 400 / 坏目录 400
//  ③ 闭环 happy：echo + sleep 任务 → synthetic 注入真实 session → inbox 收到
//     wake 信封 + lifecycle 信封（保序/信封完整/description 标注）→ completed
//  ④ failed 终态：exit 3 → failed + lifecycle 信封
//  ⑤ orphaned：session 死亡 → 温和停止进程组 + 停止通知（§三-1）
//  ⑥ health 计数：tasks_alive 归零、tasks_total 正确
// 验收判据（SERVER-PLAN）：下达 echo + sleep 任务 → synthetic 注入真实 session →
//                           会话收到信封消息。
// 隔离：服务端 state 走 /tmp/opencode/omt-verify-m2-<pid>；probe session 用后即删；
//       凭证只现读、输出脱敏（session id 截断，password 永不出现）。
//
// 前置：opencode 共享服务运行中（~/.local/state/opencode/service.json 存在且 /api/info 200）
// 用法: node --import tsx scripts/verify-m2.ts

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MonitorClient,
  MonitorApiError,
  opencodeAuthHeader,
  opencodeServicePath,
  readOpencodeService,
  type HealthInfo,
  type PathEnv,
  type PublicInfo,
} from "@omt/shared";
import { isTaskProcessAlive } from "../packages/server/src/spawner.ts";
import { readExitFile, readMeta } from "../packages/server/src/taskstore.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_TS = path.join(ROOT, "packages", "server", "src", "main.ts");
const XDG = mkdtempSync("/tmp/opencode/omt-verify-m2-");
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

async function waitFor(cond: () => boolean, timeoutMs = 15000): Promise<boolean> {
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

/** 会话收到的信封消息（生产投递不带 resume → 消息调度执行并出现在 message 列表，
 *  type "synthetic" + 顶层 text；inbox 只保留 resume:false 的未调度消息——真机实测。
 *  返回 {text, created}（列表本身新消息在前，排序用 time.created 判） */
async function sessionEnvelopes(sid: string): Promise<Array<{ text: string; created: number }>> {
  const res = await fetch(`${ocSvc.url}/api/session/${encodeURIComponent(sid)}/message`, { headers: ocAuth });
  const body = (await res.json()) as { data?: Array<{ type?: string; text?: unknown; time?: { created?: unknown } }> };
  const out: Array<{ text: string; created: number }> = [];
  for (const m of body.data ?? []) {
    if (m.type === "synthetic" && typeof m.text === "string" && m.text.includes("<task-notification>")) {
      out.push({ text: m.text, created: typeof m.time?.created === "number" ? m.time.created : 0 });
    }
  }
  return out;
}

/** 等待会话收到满足条件的信封（lifecycle 投递与状态可见性有毫秒级竞态） */
async function awaitEnvelope(sid: string, pred: (t: string) => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envs = await sessionEnvelopes(sid).catch(() => [] as Array<{ text: string; created: number }>);
    if (envs.some((e) => pred(e.text))) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 场景

async function scenario1_server_up(realServicePath: string): Promise<MonitorClient> {
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
        client = null; // 未就绪
      }
    }
  }
  check("①服务端: 就绪（service.json + health）", client !== null);
  if (client) {
    const h = await client.health(2000);
    check("①health: tasks_alive=0 / tasks_total=0 / 实例表恰一条且 reachable", h.tasks_alive === 0 && h.tasks_total === 0 && h.opencode_instances.length === 1 && h.opencode_instances[0]!.reachable === true);
    return client;
  }
  throw new Error("server not ready");
}

async function scenario2_fail_fast(client: MonitorClient): Promise<void> {
  const base = { opencode_port: ocPort, session_id: "ses_doesnotexist0000" };
  // 幻觉端口（session 先不谈，端口先被拒）
  try {
    await client.createTask({ command: "echo x", opencode_port: 65534, session_id: "ses_x" });
    check("②幻觉端口 → 400 PORT_NOT_IN_REGISTRY", false, "unexpected success");
  } catch (err) {
    const e = err as MonitorApiError;
    check("②幻觉端口 → 400 PORT_NOT_IN_REGISTRY", e.status === 400 && e.body?.code === "PORT_NOT_IN_REGISTRY", `status=${e.status} code=${e.body?.code}`);
  }
  // 死 session（端口真实、session 捏造）
  try {
    await client.createTask({ ...base, command: "echo x" });
    check("②死 session → 404 SESSION_NOT_FOUND", false, "unexpected success");
  } catch (err) {
    const e = err as MonitorApiError;
    check("②死 session → 404 SESSION_NOT_FOUND", e.status === 404 && e.body?.code === "SESSION_NOT_FOUND", `status=${e.status} code=${e.body?.code}`);
  }
  // 坏命令（$() 拒绝）
  try {
    await client.createTask({ ...base, command: "echo $(date)" });
    check("②坏命令 → 400 INVALID_INPUT", false, "unexpected success");
  } catch (err) {
    const e = err as MonitorApiError;
    check("②坏命令 → 400 INVALID_INPUT", e.status === 400 && e.body?.code === "INVALID_INPUT", `status=${e.status} code=${e.body?.code}`);
  }
  // 坏目录
  try {
    await client.createTask({ ...base, command: "echo x", directory: "/nonexistent-omt-verify-dir" });
    check("②坏目录 → 400 BAD_DIRECTORY", false, "unexpected success");
  } catch (err) {
    const e = err as MonitorApiError;
    check("②坏目录 → 400 BAD_DIRECTORY", e.status === 400 && e.body?.code === "BAD_DIRECTORY", `status=${e.status} code=${e.body?.code}`);
  }
  const h = await client.health(2000);
  check("②fail fast 后: 无任务残留（tasks_total=0）", h.tasks_total === 0);
}

async function scenario3_happy_loop(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-verify-m2-happy");
  try {
    const created = await client.createTask({
      command: "echo hello-m2-stage-d && sleep 1",
      opencode_port: ocPort,
      session_id: sid,
      description: "verify-m2",
    });
    check("③创建: 201 + running + pid 非空", created.state === "running" && created.pid !== null, JSON.stringify({ state: created.state, pid: created.pid }));
    const id = created.id;

    // 显式轮询至终态（顺路观察 alive 计数接线）
    let sawAlive = false;
    let final: PublicInfo | null = null;
    for (let i = 0; i < 300 && !final; i++) {
      const p = await client.getTask(id).catch(() => null);
      if (p && (p.state === "running" || p.state === "idle")) sawAlive = true;
      if (p && (p.state === "completed" || p.state === "failed" || p.state === "stopped" || p.state === "orphaned")) final = p;
      else await sleep(50);
    }
    check("③终态: completed（exit 0 / exited）", final !== null && final.state === "completed" && final.exit_info?.code === "0" && final.exit_info.reason === "exited", JSON.stringify(final?.exit_info ?? null));
    check("③运行中曾见 alive=true（health 计数接线）", sawAlive);
    if (final) {
      check("③计数: lines_matched=1 / events_sent=1 / dropped=0", final.lines_matched === 1 && final.events_sent === 1 && final.events_dropped === 0, `matched=${final.lines_matched} sent=${final.events_sent} dropped=${final.events_dropped}`);
      check("③offset: last_offset > 0 且 = log_bytes（行尾带换行）", final.last_offset > 0 && final.last_offset === final.log_bytes, `off=${final.last_offset} bytes=${final.log_bytes}`);
    }

    // message 列表验收核心：会话收到信封消息（生产路径不带 resume → 调度执行）
    const wakeOk = await awaitEnvelope(sid, (t) => t.includes("hello-m2-stage-d"));
    const lcOk = await awaitEnvelope(sid, (t) => t.includes("finished: completed"));
    check("③会话收到: wake 信封（echo 行）", wakeOk);
    check("③会话收到: lifecycle 信封（退出结局必须到达）", lcOk);
    const envs = await sessionEnvelopes(sid);
    const wake = envs.find((e) => e.text.includes("hello-m2-stage-d"));
    const lc = envs.find((e) => e.text.includes("finished: completed"));
    if (wake) {
      check("③信封: 边界完整 + description 标注", wake.text.startsWith("<task-notification>\n") && wake.text.endsWith("</task-notification>") && wake.text.includes(`[monitor ${id} · verify-m2]`));
    }
    if (wake && lc) {
      check("③保序: wake 先于 lifecycle（time.created 序）", wake.created <= lc.created, `wake=${wake.created} lc=${lc.created}`);
    }

    // TaskStore 落盘
    check("③exit 文件: \"0\"", readExitFile(pathEnv, id) === "0", `exit=${readExitFile(pathEnv, id)}`);
    const meta = readMeta(pathEnv, id);
    check("③meta.json: completed + last_offset 落盘", meta !== null && meta.state === "completed" && meta.last_offset > 0, `meta=${meta === null ? "null" : meta.state}`);
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario4_failed(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-verify-m2-failed");
  try {
    const created = await client.createTask({
      command: "echo boom-m2; exit 3",
      opencode_port: ocPort,
      session_id: sid,
    });
    let final: PublicInfo | null = null;
    for (let i = 0; i < 300 && !final; i++) {
      const p = await client.getTask(created.id).catch(() => null);
      if (p && (p.state === "completed" || p.state === "failed" || p.state === "orphaned")) final = p;
      else await sleep(50);
    }
    check("④failed 终态: exit 3", final !== null && final.state === "failed" && final.exit_info?.code === "3");
    const lcOk = await awaitEnvelope(sid, (t) => t.includes("finished: failed") && t.includes("exit 3"));
    check("④lifecycle 信封含 failed (exit 3)", lcOk);
    check("④exit 文件: \"3\"", readExitFile(pathEnv, created.id) === "3");
  } finally {
    await deleteProbeSession(sid);
  }
}

async function scenario5_orphaned(client: MonitorClient): Promise<void> {
  const sid = await newProbeSession("omt-verify-m2-orphan");
  try {
    // 循环输出：无论删 session 快慢，任何一次 wake 投递都会撞 404 → orphan
    // （消除"删除必须快于首个 250ms tick"的时序依赖；无 $(...) 以过命令校验）
    const created = await client.createTask({
      command: "seq 1 100 | while read i; do echo orphan-m2-$i; sleep 0.2; done",
      opencode_port: ocPort,
      session_id: sid,
    });
    const pid = created.pid!;
    // 任务创建成功后立刻杀死通知目的地 → 首次投递 404 → orphaned + 温和停止
    await deleteProbeSession(sid);
    let final: PublicInfo | null = null;
    for (let i = 0; i < 300 && !final; i++) {
      const p = await client.getTask(created.id).catch(() => null);
      if (p && (p.state === "orphaned" || p.state === "completed" || p.state === "failed")) final = p;
      else await sleep(50);
    }
    check("⑤orphaned: session 死亡后任务终态 orphaned", final !== null && final.state === "orphaned", JSON.stringify(final?.state ?? null));
    check("⑤进程组: 已被温和停止（SIGTERM → signal:15）", final?.exit_info?.code === "signal:15" && final?.exit_info?.reason === "killed", JSON.stringify(final?.exit_info ?? null));
    check("⑤进程: 确已消亡", await waitFor(() => !isTaskProcessAlive({ pid, startTime: null }), 3000));
  } finally {
    await deleteProbeSession(sid); // 快路径已删，此处幂等兜底（createTask 抛出时防泄漏）
  }
}

async function scenario6_health_count(client: MonitorClient): Promise<void> {
  const h: HealthInfo = await client.health(2000);
  check("⑥health: tasks_alive=0 / tasks_total=3（三个场景任务簿记）", h.tasks_alive === 0 && h.tasks_total === 3, `alive=${h.tasks_alive} total=${h.tasks_total}`);
  const list = await client.listTasks();
  check("⑥GET /api/tasks: 3 条", list.length === 3, `len=${list.length}`);
  const filtered = await client.listTasks("ses_none_zzz");
  check("⑥?session_id= 过滤: 空结果", filtered.length === 0);
}

// ---------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error("TIMEOUT: verify-m2 exceeded 150s, killing all children");
  for (const c of children) {
    if (c.pid) {
      try {
        process.kill(c.pid, "SIGKILL");
      } catch {
        /* best-effort */
      }
    }
  }
  process.exit(1);
}, 150_000);

process.on("SIGINT", async () => {
  await killServers();
  rmSync(XDG, { recursive: true, force: true });
  process.exit(130);
});

console.log(`verify-m2: XDG=${XDG}\n`);

const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
  results.push(`■ ${name}`);
  try {
    await fn();
  } catch (err) {
    check(`${name}（场景自身）`, false, String(err));
  }
  results.push("");
};

let client: MonitorClient | null = null;
await run("① 服务端起 + health", async () => {
  client = await scenario1_server_up(opencodeServicePath({}));
});
if (client) {
  const c = client;
  await run("② fail fast 四路", () => scenario2_fail_fast(c));
  await run("③ 闭环 happy（echo + sleep → 真实 session 收到信封）", () => scenario3_happy_loop(c));
  await run("④ failed 终态", () => scenario4_failed(c));
  await run("⑤ orphaned（session 死亡 → 温和停止）", () => scenario5_orphaned(c));
  await run("⑥ health 计数与列表", () => scenario6_health_count(c));
} else {
  results.push("■ ②-⑥（跳过：服务端未就绪）\n");
}

console.log(results.join("\n"));
console.log(`verify-m2: ${passed} passed, ${failed} failed`);

clearTimeout(watchdog);
await killServers();
rmSync(XDG, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
