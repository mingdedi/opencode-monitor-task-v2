// M6 真机验收：TUI 面板数据流——feed 状态机 × format 行模型 × 真实服务端
//  ① online 空态：服务端就绪 → feed.tick → online + 空任务 → 本 session 面板折叠（零行）
//  ② 任务行渲染：probe session + createTask → 面板出现 ● 头行/command/计数三行，宽度 ≤ 42
//  ③ session 视角过滤：别的 session 视角看不到本任务（零行）；全量数据带 other-session 摘要行
//  ④ stop → 终态行：■ + exit 标签；pid 从计数行消失
//  ⑤ offline 转换：shutdown 服务端 → feed.tick → offline(pid-dead)（stale service.json）
//     → 面板两行（server offline + auto-starts on next tool call）
//  ⑥ 服务发现自愈：同 XDG 重启服务端（新 url/password）→ feed.tick → online 恢复
// 全部走 TUI 源码路径（src/tui/feed.ts + format.ts + shared MonitorClient），
// 不 mock 任何一层——验收的就是面板将来看到的数据。
//
// 前置：opencode 共享服务运行中（~/.local/state/opencode/service.json 存在且 /api/info 200）
// 隔离：服务端 state 走 /tmp/opencode/omt-verify-m6-<pid>；probe session 用后即删；
//       任务命令零输出（sleep），不触发通知投递（M2–M5 已验收）。
// 用法: node --import tsx scripts/verify-m6.ts

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MonitorClient,
  opencodeAuthHeader,
  opencodeServicePath,
  readOpencodeService,
  serviceFilePath,
  type ServiceFile,
} from "@omt/shared";
import { createFeed, isPidAliveViaSignal, type FeedDeps, type FeedSnapshot } from "../src/tui/feed.ts";
import { renderLines, PANEL_WIDTH } from "../src/tui/format.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { resolveServerEntry } from "./lib/server-entry.ts";
const entry = resolveServerEntry(ROOT);
const XDG = mkdtempSync("/tmp/opencode/omt-verify-m6-");
const STATE = `${XDG}/state`;

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
// 真实 opencode 共享服务的 service.json 路径（注册进服务端白名单，同 verify-m4）
const realServicePath = opencodeServicePath();
function spawnServer(): ChildProcess {
  const child = spawn(entry.command, [...entry.baseArgs, "--opencode-state", realServicePath], {
    cwd: ROOT,
    env: { ...process.env, XDG_STATE_HOME: `${XDG}/state`, XDG_DATA_HOME: `${XDG}/data` },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function readIsolatedServiceFile(): ServiceFile | null {
  try {
    return JSON.parse(readFileSync(serviceFilePath({ XDG_STATE_HOME: STATE }), "utf8")) as ServiceFile;
  } catch {
    return null;
  }
}

async function waitServiceFile(): Promise<ServiceFile> {
  for (let i = 0; i < 50; i++) {
    const svc = readIsolatedServiceFile();
    if (svc) return svc;
    await sleep(100);
  }
  throw new Error("service.json not written");
}

/** 等待 service.json 被新实例覆盖（pid 变化）——SIGKILL 后旧文件残留，必须等换代。 */
async function waitServiceReplaced(prevPid: number): Promise<ServiceFile> {
  for (let i = 0; i < 80; i++) {
    const svc = readIsolatedServiceFile();
    if (svc && svc.pid !== prevPid) return svc;
    await sleep(100);
  }
  throw new Error("service.json not replaced by new instance");
}

async function waitHealthy(url: string, password: string): Promise<void> {
  const probe = new MonitorClient(url, password);
  for (let i = 0; i < 50; i++) {
    try {
      await probe.health(500);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("server did not become healthy in 5s");
}

// ---- 面板实例（TUI 数据路径，唯一注入：隔离的 service.json 读取） ----
const snaps: FeedSnapshot[] = [];
const feed = createFeed({
  now: Date.now,
  readServiceFile: readIsolatedServiceFile,
  fetchImpl: fetch,
  isPidAlive: isPidAliveViaSignal,
  onSnapshot: (s) => snaps.push(s),
} satisfies FeedDeps);
const last = () => snaps.at(-1)!;

// ---- opencode 侧辅助（同 verify-m4 模式） ----
const ocSvc = readOpencodeService();
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

// ---- 场景 ----
async function scenario1_onlineEmpty(): Promise<void> {
  spawnServer();
  const svc = await waitServiceFile();
  await waitHealthy(svc.url, svc.password);

  await feed.tick();
  check("① feed online after server start", last().status.kind === "online", JSON.stringify(last().status));
  check("① empty task list", last().tasks.length === 0);
  const lines = renderLines({ status: last().status, tasks: last().tasks, sessionID: "ses_none", now: Date.now() });
  check("① panel collapses to zero lines when nothing to show", lines.length === 0, JSON.stringify(lines));
}

let sid = "";
async function scenario2_taskRows(): Promise<void> {
  sid = await newProbeSession("omt-verify-m6");
  const svc = readIsolatedServiceFile()!;
  const client = new MonitorClient(svc.url, svc.password);
  const t = await client.createTask({
    command: "sleep 30",
    opencode_port: ocPort,
    session_id: sid,
    description: "m6 panel probe",
    directory: XDG,
  });

  await feed.tick();
  const lines = renderLines({ status: last().status, tasks: last().tasks, sessionID: sid, now: Date.now() });
  const text = lines.map((l) => l.text);
  check("② head row shows 1 running", text[0] === "MONITORS · 1 running", text[0]);
  check("② live row icon + short id", /^● mon_[a-z0-9]{4} /.test(text[1] ?? ""), text[1]);
  check("② description preferred over command", text[2] === "  m6 panel probe", text[2]);
  check("② counts row with pid", /pid \d+/.test(text[3] ?? ""), text[3]);
  check("② all rows fit 42 columns", lines.every((l) => l.text.length <= PANEL_WIDTH));

  // ③ session 视角过滤
  const stranger = renderLines({ status: last().status, tasks: last().tasks, sessionID: "ses_other", now: Date.now() });
  check("③ other session view: detail hidden, summary row only", stranger.length === 1 && /^\s+\+1 running in 1 other session$/.test(stranger[0]!.text), JSON.stringify(stranger.map((l) => l.text)));

  // ④ stop → 终态行
  await client.stopTask(t.id);
  await feed.tick();
  const stopped = renderLines({ status: last().status, tasks: last().tasks, sessionID: sid, now: Date.now() });
  const head = stopped.map((l) => l.text)[1] ?? "";
  check("④ terminal row with exit label", /^■ mon_[a-z0-9]{4} /.test(head) && /exit /.test(head), head);
  check("④ no pid on terminal counts row", !stopped.map((l) => l.text)[3]?.includes("pid"));
  await client.deleteTask(t.id).catch(() => {});
}

async function scenario5_offline(): Promise<void> {
  // kill -9 模拟崩溃：优雅 shutdown 会清理 service.json（feed 读到 no-service-file，
  // 同样收敛为 offline 两行）；pid-dead 分支对应的是崩溃残留的 stale service.json。
  children[0]!.kill("SIGKILL");
  await sleep(400);
  deadPid = readIsolatedServiceFile()?.pid ?? 0;

  await feed.tick();
  check("⑤ offline(pid-dead) after SIGKILL (stale service.json)", JSON.stringify(last().status) === '{"kind":"offline","reason":"pid-dead"}', JSON.stringify(last().status));
  const lines = renderLines({ status: last().status, tasks: last().tasks, sessionID: sid, now: Date.now() });
  check(
    "⑤ offline panel: warn head + auto-start hint",
    lines.length === 2 && lines[0]!.text === "MONITORS · server offline" && lines[1]!.text === "  auto-starts on next tool call",
    JSON.stringify(lines.map((l) => l.text)),
  );
}

let deadPid = 0;
async function scenario6_rediscover(): Promise<void> {
  spawnServer(); // 同 XDG 重启：新 url/password 覆盖 service.json
  const svc = await waitServiceReplaced(deadPid);
  await waitHealthy(svc.url, svc.password);

  await feed.tick();
  check("⑥ feed self-heals to online after server restart", last().status.kind === "online", JSON.stringify(last().status));
}

// ---- 汇总 ----
try {
  await scenario1_onlineEmpty();
  await scenario2_taskRows();
  await scenario5_offline();
  await scenario6_rediscover();
} catch (err) {
  failed++;
  results.push(`  ✘ fatal — ${String(err).slice(0, 300)}`);
} finally {
  if (sid) await deleteProbeSession(sid).catch(() => {});
  // 终局清理：服务端若仍在则优雅关闭；隔离目录删除
  const svc = readIsolatedServiceFile();
  if (svc) {
    try {
      await new MonitorClient(svc.url, svc.password).shutdown();
      await sleep(300);
    } catch {
      /* 已退出 */
    }
  }
  for (const c of children) c.kill("SIGKILL");
  rmSync(XDG, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log(`\nverify-m6: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
