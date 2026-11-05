// M7 真机验收（PLUGIN-PLAN §五-P3）：插件 MCP 工具三件套——六场景固化为可重跑断言。
// 手工记分板（commit 706cc4a，2026-11-05 活宿主全绿）的脚本化，此后回归一跑即验。
//
//  ① 注册接线：官方契约形状（ctx.tool.transform + editor.add，§一-3）的宿主 ctx 调
//     真实 registerTools → 三工具入册（name/schema/execute 可调）；宿主路径缺失 →
//     null 留痕跳过（无工具不拖垮宿主）。场景②-⑥ 的执行入口 = 本场景的注册产物
//     （宿主 add 拿到的同一闭包），而非直接调工具工厂。
//     [插件锚点] 纯脚本没有 transform 通道——注册路径只存在于宿主形状下。
//  ② 默认化全链：monitor 不传 session_id/opencode_port（宿主权威默认化，§三-1）→
//     pattern 命中 → synthetic 唤醒"当前 session"。verify-m2 必须显式传两参数，
//     双缺省 + 通知到达正确 session 是插件形态独有断言（首次真实
//     "工具→服务端→通知→本 session"全链；M2 验收是脚本模拟插件行为）。
//  ③ storm 合并：30 行 ERROR → 1 条合并通知（[30 lines coalesced]）；max_events=2
//     预算的是通知不是行（30 行只花 1 额度，任务不被杀自然 completed）。
//  ④ idle 裁决决策链：裁决信封（monitor_manage 工具话术）→ keepalive 复活（计时
//     重置：再次转 idle 而非被杀）→ stop 收场 → lifecycle "reason: stopped by request"。
//  ⑤ kill -9 自愈：硬崩后任务照跑（detached 进程组）→ 缺席期间自然退出 → 下一工具
//     调用自动拉起服务端（脚本全程不显式 spawn 服务端——拉起只发生在 execute 内的
//     ensureServer）+ reattach finalized + away-finish 合并信封。冷启动在非项目根
//     cwd 下触发（宿主内 cwd=HOME 真机 bug 的回归锚，commit 706cc4a rootDir 修复）。
//  ⑥ 拒绝双开：伪造旧版本 service.json（pid 活 + 假 health 返回 0.0.9）→ 工具返回
//     结构化诊断（refusing to double-spawn + service.json/log 路径 + hint 行）。
//
// 前置：opencode 共享服务运行中（~/.local/state/opencode/service.json 且 /api/info 200）
// 隔离：服务端 state/data 走 /tmp/opencode/omt-verify-m7-<pid>；默认 opencode 注册表
//       条目 = 隔离 XDG 下的 opencode/service.json symlink → 真实文件（插件的
//       defaultOpencodePort 与服务端 buildRegistry 都现读它，每次投递前现读凭证）；
//       probe session 用后即删；password 永不出现（session id 输出截断）。
// 用法: node --import tsx scripts/verify-m7.ts

import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MonitorClient,
  opencodeAuthHeader,
  opencodeServicePath,
  readOpencodeService,
  type HealthInfo,
  type PublicInfo,
} from "@omt/shared";
import { isTaskProcessAlive } from "../packages/server/src/spawner.ts";
import { readExitFile } from "../packages/server/src/taskstore.ts";
import { registerTools, type ToolDeps, type ToolSpec } from "../packages/plugin/src/tools.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XDG = mkdtempSync("/tmp/opencode/omt-verify-m7-");
const STATE = `${XDG}/state`;
/** 插件期望的服务端版本（ensureServer 同源读法——升级不破断言） */
const PLUGIN_VERSION = (JSON.parse(readFileSync(new URL("../packages/plugin/package.json", import.meta.url), "utf8")) as { version: string }).version;
/** 隔离 XDG：工具 deps.env 与 spawn 出的服务端共享（url/password 随重启轮转，靠现读跟随） */
const TOOL_ENV = { ...process.env, XDG_STATE_HOME: `${XDG}/state`, XDG_DATA_HOME: `${XDG}/data` };

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

// ---- 真实 opencode 共享服务（前置 + probe session/信封判据，verify-m2 同款） ----
const ocSvc = readOpencodeService(); // 前置失败即 fatal
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
/** 会话收到的信封（message 列表 ∪ inbox）。真机实测（P3）：synthetic 被接纳后
 *  是否立即"调度执行"进 message 列表由 opencode 决定——probe session 无 agent
 *  消费时可能滞留 inbox（持久收件箱，synthetic 的底座）；两者都是"已送达 opencode"
 *  的证明。生产语义里目标 session 有 agent 在等待，inbox 即唤醒。 */
async function sessionEnvelopes(sid: string): Promise<string[]> {
  const res = await fetch(`${ocSvc.url}/api/session/${encodeURIComponent(sid)}/message`, { headers: ocAuth });
  const body = (await res.json()) as { data?: Array<{ type?: string; text?: unknown }> };
  const fromMessages = (body.data ?? [])
    .filter((m) => m.type === "synthetic" && typeof m.text === "string" && m.text.includes("<task-notification>"))
    .map((m) => m.text as string);
  const inb = (await fetch(`${ocSvc.url}/api/session/${encodeURIComponent(sid)}/inbox`, { headers: ocAuth }).catch(() => null));
  if (inb !== null) {
    const ib = (await inb.json().catch(() => null)) as { data?: Array<{ type?: string; payload?: { text?: unknown } }> } | null;
    for (const m of ib?.data ?? []) {
      const t = m.payload?.text;
      if (m.type === "synthetic" && typeof t === "string" && t.includes("<task-notification>")) fromMessages.push(t);
    }
  }
  return fromMessages;
}
async function awaitEnvelope(sid: string, pred: (t: string) => boolean, timeoutMs = 25000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = (await sessionEnvelopes(sid).catch(() => [] as string[])).find(pred);
    if (hit !== undefined) return hit;
    await sleep(150);
  }
  return null;
}

// ---- 隔离 service.json（工具/服务端发现-创建的读写点） ----
const sfPath = `${STATE}/opencode-monitor-task/service.json`;
function readIsolatedService(): { url: string; password: string; pid: number } | null {
  try {
    return JSON.parse(readFileSync(sfPath, "utf8")) as { url: string; password: string; pid: number };
  } catch {
    return null;
  }
}
/** 隔离环境直连 client（收尾 shutdown 与 health.reattach 断言用——核心链路仍走工具） */
function isolatedClient(): MonitorClient | null {
  const svc = readIsolatedService();
  return svc ? new MonitorClient(svc.url, svc.password) : null;
}

// ---------------------------------------------------------------------------
// 场景①：注册接线（官方契约形状的宿主 ctx → registerTools → 三工具入册）

/** 宿主 add 收到的注册产物（场景②-⑥ 的执行入口——与真宿主拿到的是同一闭包） */
const registered: Array<{ name: string; description: string; input: Record<string, unknown>; execute: (input: unknown, ctx: unknown) => Promise<{ content: string }> }> = [];
const deps: ToolDeps = { env: TOOL_ENV };
const fakeHostCtx = {
  tool: {
    // 官方契约形状（PLUGIN-PLAN §一-3，live P3 真宿主实测同形状）：
    // transform(editor => editor.add(spec)) → reg.dispose()
    transform: async (fn: (editor: unknown) => void) => {
      fn({ add: (s: (typeof registered)[number]) => registered.push(s) });
      return { dispose: () => registered.splice(0) };
    },
  },
  location: { directory: XDG },
};

async function scenario1_registration(): Promise<void> {
  const noPath = await registerTools({}, deps);
  check("①宿主无 tool.transform → null 留痕跳过（无工具不拖垮宿主）", noPath === null);

  const reg = await registerTools(fakeHostCtx, deps);
  check("①注册返回句柄（transform 正常路径）", reg !== null && typeof reg === "object" && typeof reg.dispose === "function");
  check(
    "①三工具入册：monitor_server / monitor / monitor_manage",
    registered.length === 3 && registered.map((s) => s.name).join(",") === "monitor_server,monitor,monitor_manage",
    registered.map((s) => s.name).join(","),
  );
  const monitor = registered.find((s) => s.name === "monitor")!;
  check("①schema 形状：object + required command（模型自校验面）", monitor.input["type"] === "object" && Array.isArray(monitor.input["required"]) && (monitor.input["required"] as string[]).includes("command"));
  check("①execute 可调（宿主拿到的是函数）", typeof monitor.execute === "function");
}

/** 经注册产物调用工具（场景②-⑥ 唯一执行入口） */
function tool(name: string): (typeof registered)[number] {
  const s = registered.find((x) => x.name === name);
  if (!s) throw new Error(`tool ${name} not registered`);
  return s;
}
/** monitor 工具的"当前 session"ctx（宿主权威 sessionID 的模拟——P0-⑤ 实测存在） */
const asSession = (sid: string) => ({ sessionID: sid });
/** 从工具 content 提取 PublicInfo JSON（"monitor started (id …)\n{json}" / "…\n{json}" 形状） */
function infoFrom(content: string): PublicInfo {
  return JSON.parse(content.slice(content.indexOf("{"))) as PublicInfo;
}

// ---------------------------------------------------------------------------
// 场景②：默认化全链（不传 session_id / opencode_port → 唤醒"当前 session"）

async function scenario2_defaultedLoop(): Promise<void> {
  const sid = await newProbeSession("omt-verify-m7-2");
  try {
    const out = await tool("monitor").execute(
      { command: "echo hello-m7-first && sleep 0.6", pattern: "hello-m7-first", description: "m7-plugin-loop", directory: XDG },
      asSession(sid),
    );
    check("②返回: monitor started 文本", /^monitor started \(id mon_[a-z0-9]+, state running\)/.test(out.content), out.content.slice(0, 80));
    const info = infoFrom(out.content);
    check("②默认化: 目的地 session = 宿主 ctx.sessionID（未手传）", info.session_id === sid, `${info.session_id.slice(0, 12)}… vs ctx`);
    check("②默认化: 目的地端口 = 默认共享服务实例（未手传）", info.opencode_port === ocPort, `${info.opencode_port} vs ${ocPort}`);
    const id = info.id;

    const wake = await awaitEnvelope(sid, (t) => t.includes("hello-m7-first"));
    check("②唤醒: pattern 命中行送达当前 session", wake !== null, "wake not arrived");
    if (wake) {
      check("②信封: 完整边界 + description 标注", wake.startsWith("<task-notification>\n") && wake.includes(`[monitor ${id} · m7-plugin-loop]`));
    }
    const lc = await awaitEnvelope(sid, (t) => t.includes("finished: completed"));
    check("②结局: lifecycle 信封送达（退出结局必须到达）", lc !== null, "lifecycle not arrived");

    // 计数经 monitor_manage status 轮询至稳定（送达回调异步于终态可见）
    let settled: PublicInfo | null = null;
    for (let i = 0; i < 60 && !settled; i++) {
      const s = await tool("monitor_manage").execute({ action: "status", monitor_id: id }, asSession(sid));
      const p = JSON.parse(s.content) as PublicInfo;
      if (p.state === "completed" && p.events_sent === 1) settled = p;
      else await sleep(150);
    }
    check("②计数: matched=1 / sent=1（echo 行恰一唤醒）", settled !== null && settled.lines_matched === 1, JSON.stringify(settled ? { m: settled.lines_matched, s: settled.events_sent } : null));
  } finally {
    await deleteProbeSession(sid);
  }
}

// ---------------------------------------------------------------------------
// 场景③：storm 合并 + max_events 预算的是通知不是行

async function scenario3_storm(): Promise<void> {
  const sid = await newProbeSession("omt-verify-m7-3");
  try {
    // 单 printf 30 行原子快发（storm-sim 同款——全部落进默认 500ms coalesce 窗口，
    // 消除 while-read 逐行 fork 的机器速度依赖）
    const stormLines = Array.from({ length: 30 }, (_, i) => `ERROR storm-m7 line-${i + 1}`).join("\n");
    const out = await tool("monitor").execute(
      { command: `printf '${stormLines}\n'`, pattern: "storm-m7", description: "m7-storm", directory: XDG, max_events: 2 },
      asSession(sid),
    );
    const id = infoFrom(out.content).id;

    let settled: PublicInfo | null = null;
    for (let i = 0; i < 80 && !settled; i++) {
      const s = await tool("monitor_manage").execute({ action: "status", monitor_id: id }, asSession(sid));
      const p = JSON.parse(s.content) as PublicInfo;
      if (p.state === "completed" && p.events_sent === 1) settled = p;
      else await sleep(150);
    }
    check("③合并: 30 行 → events_sent=1（coalesce 窗口收拢）", settled !== null && settled.events_sent === 1, JSON.stringify(settled ? { state: settled.state, sent: settled.events_sent } : null));
    check("③记账: lines_matched=30（行全数命中）", settled?.lines_matched === 30, `matched=${settled?.lines_matched}`);
    check("③预算: max_events=2 下 30 行风暴不被杀（额度管通知不管行）→ completed", settled?.state === "completed" && settled?.max_events === 2, `state=${settled?.state}`);

    const wake = await awaitEnvelope(sid, (t) => t.includes("storm-m7"));
    check("③信封: [30 lines coalesced] 合并头", wake !== null && wake.includes("[30 lines coalesced]"), wake?.slice(0, 120) ?? "not arrived");
    if (wake) {
      check("③信封: 前 10 行预览 + suppressed 计数", wake.includes("storm-m7 line-10") && wake.includes("(… 20 more lines suppressed)"));
    }
  } finally {
    await deleteProbeSession(sid);
  }
}

// ---------------------------------------------------------------------------
// 场景④：idle 裁决决策链（信封工具话术 → keepalive → 再 idle → stop）

async function scenario4_adjudication(): Promise<void> {
  const sid = await newProbeSession("omt-verify-m7-4");
  try {
    const out = await tool("monitor").execute(
      { command: "sleep 180", idle_timeout_ms: 2500, description: "m7-adjudication", directory: XDG },
      asSession(sid),
    );
    const id = infoFrom(out.content).id;

    const status = async (): Promise<PublicInfo> => {
      const s = await tool("monitor_manage").execute({ action: "status", monitor_id: id }, asSession(sid));
      return JSON.parse(s.content) as PublicInfo;
    };
    const poll = async (pred: (p: PublicInfo) => boolean, timeoutMs: number): Promise<PublicInfo | null> => {
      const deadline = Date.now() + timeoutMs;
      let last: PublicInfo | null = null;
      while (Date.now() < deadline) {
        last = await status().catch(() => null);
        if (last !== null && pred(last)) return last;
        await sleep(150);
      }
      return last;
    };

    const idle = await poll((p) => p.state === "idle", 12000);
    check("④第一段: 静默 2500ms → idle（进程仍活，裁决暂停态）", idle?.state === "idle", `state=${idle?.state}`);

    const arb = await awaitEnvelope(sid, (t) => t.includes("monitor idle: no output for 2500ms"));
    check("④信封: 裁决通知送达当前 session", arb !== null, "not arrived");
    if (arb) {
      check("④信封: monitor_manage 工具话术（keepalive 指引带 monitor_id）", arb.includes(`monitor_manage(action="keepalive", monitor_id="${id}")`), arb.slice(0, 200));
      check("④信封: 宽限警示（No decision within 2500ms）", arb.includes("No decision within 2500ms"));
    }

    const ka = await tool("monitor_manage").execute({ action: "keepalive", monitor_id: id }, asSession(sid));
    check("④keepalive: 工具确认文本", ka.content.startsWith("keepalive acknowledged"), ka.content.slice(0, 60));
    const revived = infoFrom(ka.content);
    check("④keepalive: idle → running 复活 + 宽限清空", revived.state === "running" && revived.grace_deadline === null && revived.idle_deadline === null, `state=${revived.state}`);

    const again = await poll((p) => p.state === "idle", 10000);
    check("④计时重置: 再次转 idle 而非被宽限杀", again?.state === "idle", `state=${again?.state}`);

    const stop = await tool("monitor_manage").execute({ action: "stop", monitor_id: id }, asSession(sid));
    const stopped = infoFrom(stop.content);
    check("④stop: idle 态收场 → stopped", stop.content.startsWith("stop requested") && stopped.state === "stopped", `state=${stopped.state}`);

    const lc = await awaitEnvelope(sid, (t) => t.includes("reason: stopped by request"));
    check("④结局: lifecycle 注明 stopped by request（决策链收口）", lc !== null && lc.includes("finished: stopped"), lc?.slice(0, 160) ?? "not arrived");
  } finally {
    await deleteProbeSession(sid);
  }
}

// ---------------------------------------------------------------------------
// 场景⑤：kill -9 自愈（任务照跑 → 缺席退出 → 下一工具调用自动拉起 + reattach）

async function scenario5_kill9_selfHeal(): Promise<void> {
  const sid = await newProbeSession("omt-verify-m7-5");
  const prevCwd = process.cwd();
  try {
    const out = await tool("monitor").execute(
      { command: "echo away-start-m7; sleep 1.5; exit 0", description: "m7-away-finish", directory: XDG },
      asSession(sid),
    );
    const info = infoFrom(out.content);
    const pid = info.pid!;

    const svc = readIsolatedService();
    process.kill(svc!.pid, "SIGKILL"); // 硬崩：service.json/lock 残留 = stale 素材
    await sleep(300);
    check("⑤硬崩: 任务进程不受牵连（detached 进程组）", isTaskProcessAlive({ pid, startTime: null }), `pid=${pid}`);

    await sleep(2400); // 缺席期间自然退出（1.5s）+ EXIT-trap 落盘
    check("⑤缺席: 任务已退出，wrapper 自记 exit=0（文件即管道）", !isTaskProcessAlive({ pid, startTime: null }) && readExitFile({ XDG_STATE_HOME: STATE, XDG_DATA_HOME: `${XDG}/data` }, info.id) === "0");

    // 宿主内 cwd=HOME 的回归锚（commit 706cc4a rootDir 修复）：冷启动在非项目根 cwd 下触发，
    // 旧实现（锚点=process.cwd()）在此必失败——spawn 找不到服务端入口。
    process.chdir(homedir());
    const list = await tool("monitor_manage").execute({ action: "list", session_id: sid }, asSession(sid));
    check("⑤自愈: 工具调用自动拉起服务端（脚本全程零显式 spawn）", !list.content.startsWith("error:"), list.content.slice(0, 100));
    check("⑤reattach: 合并视图可见 away-finish 任务 completed", list.content.includes(info.id) && /completed/.test(list.content), list.content.slice(0, 200));

    // reattach 显式化（health 懒触发，直连断言 finalized 计数）
    let ra: HealthInfo["reattach"] = null;
    for (let i = 0; i < 40 && !ra; i++) {
      const c = isolatedClient();
      const h = c ? await c.health().catch(() => null) : null;
      if (h?.reattach !== null) ra = h?.reattach ?? null;
      else await sleep(150);
    }
    check("⑤reattach: finalized=1（缺席退出收尾，显式化不哑跑）", ra?.finalized === 1, JSON.stringify(ra));

    const env = await awaitEnvelope(sid, (t) => t.includes("finished while the server was away"));
    check("⑤信封: away-finish 合并结局送达（摘要不重放）", env !== null && env.includes("finished: completed (exit 0)"), env?.slice(0, 160) ?? "not arrived");
  } finally {
    process.chdir(prevCwd);
    await deleteProbeSession(sid);
  }
}

// ---------------------------------------------------------------------------
// 场景⑥：拒绝双开（伪造旧版本 service.json → 结构化诊断）

async function scenario6_doubleSpawnRefusal(): Promise<void> {
  // 现服务端优雅退场（service.json 自清 → 伪造素材的干净起点）
  const c = isolatedClient();
  if (c) {
    await c.shutdown().catch(() => {});
    await sleep(600);
  }

  // 假 health：响应 version 0.0.9（与插件期望 0.1.0 的 major.minor 都不同）
  const fake = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "fake", version: "0.0.9", uptime_s: 1, tasks_alive: 0, tasks_total: 0, reattach: null, opencode_instances: [], log_bytes: 0 }));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;

  try {
    // 伪造 service.json：pid 活（本脚本进程）+ health 可达但版本不兼容
    mkdirSync(path.dirname(sfPath), { recursive: true });
    writeFileSync(sfPath, `${JSON.stringify({ id: "forged", version: "0.0.9", url: fakeUrl, pid: process.pid, password: "x", started_at: Date.now() }, null, 2)}\n`);

    const out = await tool("monitor_manage").execute({ action: "list" }, asSession("ses_none"));
    check("⑥拒绝: error: 前缀（结构化文本，模型可见可继续）", out.content.startsWith("error: monitor server discovery/startup failed:"), out.content.slice(0, 120));
    check("⑥拒绝: 诊断注明 incompatibility 与双方版本", out.content.includes("alive but unhealthy/incompatible") && out.content.includes("health version 0.0.9") && out.content.includes(`expected ${PLUGIN_VERSION}`), out.content.slice(0, 200));
    check("⑥拒绝: refusing to double-spawn（不盲目双开）", out.content.includes("refusing to double-spawn"));
    check("⑥拒绝: 诊断带 service.json / log 路径（绝不静默）", out.content.includes(sfPath) && out.content.includes("server.log"), out.content.slice(0, 300));
    check("⑥拒绝: hint 行指路诊断", /\nhint: /.test(out.content) && out.content.includes("pid / service.json / server.log paths"));
    check("⑥现场: 未拉起新服务端（拒绝而非绕过）", readIsolatedService()?.url === fakeUrl, JSON.stringify(readIsolatedService()?.url));
  } finally {
    fake.close();
    try {
      unlinkSync(sfPath);
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error("TIMEOUT: verify-m7 exceeded 180s");
  process.exit(1);
}, 180_000);

process.on("SIGINT", () => {
  console.error("interrupted");
  process.exit(130);
});

console.log(`verify-m7: XDG=${XDG} opencode=${ocSvc.url.replace(/\/\/.*@/, "//")} (port ${ocPort})\n`);

const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
  results.push(`■ ${name}`);
  try {
    await fn();
  } catch (err) {
    check(`${name}（场景自身）`, false, String(err).slice(0, 300));
  }
  results.push("");
};

// 前置：隔离 XDG 下挂默认 opencode 注册表条目（symlink——现读跟随真实服务轮转）
mkdirSync(`${STATE}/opencode`, { recursive: true });
const realServicePath = opencodeServicePath({});
if (!existsSync(realServicePath)) throw new Error(`opencode service.json not found: ${realServicePath}`);
symlinkSync(realServicePath, `${STATE}/opencode/service.json`);

await run("① 注册接线（transform → add 三工具）", scenario1_registration);
await run("② 默认化全链（monitor 双缺省 → 唤醒当前 session）", scenario2_defaultedLoop);
await run("③ storm 合并（30 行 → 1 通知；max_events 管通知不管行）", scenario3_storm);
await run("④ idle 裁决决策链（keepalive → 再 idle → stop）", scenario4_adjudication);
await run("⑤ kill -9 自愈（自动拉起 + reattach + away-finish 信封）", scenario5_kill9_selfHeal);
await run("⑥ 拒绝双开（伪造旧版本 → 结构化诊断）", scenario6_doubleSpawnRefusal);

// ---- 终局清理：隔离服务端优雅关闭（若仍在），隔离目录删除 ----
const fin = isolatedClient();
if (fin) {
  await fin.shutdown().catch(() => {});
  await sleep(400);
  const svc = readIsolatedService();
  if (svc) {
    try {
      process.kill(svc.pid, "SIGKILL");
    } catch {
      /* 已死 */
    }
  }
}
rmSync(XDG, { recursive: true, force: true });

console.log(results.join("\n"));
console.log(`\nverify-m7: ${passed} passed, ${failed} failed`);
clearTimeout(watchdog);
process.exit(failed > 0 ? 1 : 0);
