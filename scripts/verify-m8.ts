// M8 权限审计复验（PLAN §4 / §7-M8：权限审计[0700/600/日志内容]）。
//
// 场景（真机实证，非静态检查——每项断言都建立在真实运行产物上）：
//  ① 启动即权限：state/data 根目录 0700（umask 防御：显式 chmod 追溯已存在目录）
//  ② service.json / lock 600（凭证文件仅同用户可读）
//  ③ 任务目录链 0700：tasks/ 与 tasks/<id>/；meta.json 与 log 文件 600
//  ④ meta.json 无 password 键（凭证永不落盘——只存 opencode_port，PLAN §2.8.1）
//  ⑤ server.log 不含命令全文（PLAN §4：v1 世界可读日志记命令全文的泄漏面修复）——
//     创建带唯一标记的命令任务，日志全文 grep 标记必须零命中
//  ⑥ plugin/tui 诊断日志落点审计：DEBUG=1 时写入 0700 state 目录内（同 server.log 层，
//     权限由目录 0700 保证）——脚本内静态断言代码路径的 mkdir mode（不真跑宿主）
//
// 形态：经 resolveServerEntry（scripts/lib/server-entry.ts）——dist/server.mjs 存在时
// 自动审计 bundle 形态，源码形态同判据。M8 验收要求两种形态各跑一遍。
//
// 前置：opencode 共享服务运行中（白名单 + session 存活校验；probe session 用后即删）
// 隔离：XDG 定向 /tmp/opencode/omt-verify-m8-<pid>，退出清理
// 用法: node --import tsx scripts/verify-m8.ts

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MonitorClient,
  opencodeAuthHeader,
  opencodeServicePath,
  readOpencodeService,
  serviceFilePath,
  stateDir,
  dataDir,
  lockFilePath,
  type ServiceFile,
} from "@omt/shared";
import { resolveServerEntry } from "./lib/server-entry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XDG = mkdtempSync("/tmp/opencode/omt-verify-m8-");
const STATE = `${XDG}/state`;
const DATA = `${XDG}/data`;
const PATHS = {
  XDG_STATE_HOME: STATE,
  XDG_DATA_HOME: DATA,
} as NodeJS.ProcessEnv;

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

// ---- 权限读取 ----
function modeOf(p: string): number | null {
  try {
    return statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}
function dirEntries(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// ---- 服务端进程（当前形态）----
const entry = resolveServerEntry(ROOT);
const realServicePath = opencodeServicePath();
const children: ChildProcess[] = [];
function spawnServer(): ChildProcess {
  const child = spawn(entry.command, [...entry.baseArgs, "--opencode-state", realServicePath], {
    cwd: ROOT,
    env: { ...process.env, XDG_STATE_HOME: STATE, XDG_DATA_HOME: DATA },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function main(): Promise<void> {
  console.log(`M8 permission audit — server form: ${entry.form}`);
  const ocSvc = readOpencodeService();

  // probe session（任务通知目的地；用后即删）
  const ocAuth = { authorization: opencodeAuthHeader(ocSvc), "content-type": "application/json" };
  const sres = await fetch(`${ocSvc.url}/api/session`, { method: "POST", headers: ocAuth, body: JSON.stringify({ title: "omt-verify-m8-audit" }) });
  const sbody = (await sres.json()) as { id?: string; data?: { id?: string } };
  const sid = sbody.id ?? sbody.data?.id;
  if (!sid) throw new Error(`cannot create probe session: ${sres.status}`);
  const ocPort = new URL(ocSvc.url).port;

  // ① 启动（等待 health 就绪）
  spawnServer();
  let svc: ServiceFile | null = null;
  for (let i = 0; i < 40 && svc === null; i++) {
    await sleep(125);
    try {
      const raw = JSON.parse(readFileSync(serviceFilePath(PATHS), "utf8")) as ServiceFile;
      const c = new MonitorClient(raw.url, raw.password);
      if ((await c.health().catch(() => null)) !== null) svc = raw;
    } catch {
      // 尚未就绪
    }
  }
  if (svc === null) throw new Error("server did not become healthy");

  // ① 根目录 0700（umask 防御：无论进程 umask 如何，显式 chmod 保证）。
  //   state 根启动即建；data 根在首个任务创建时建（initTaskDir）——其检查移至场景③后
  check("① state 根目录 0700", modeOf(stateDir(PATHS)) === 0o700, `got ${modeOf(stateDir(PATHS))?.toString(8)}`);

  // ② service.json / lock 600
  check("② service.json 600", modeOf(serviceFilePath(PATHS)) === 0o600, `got ${modeOf(serviceFilePath(PATHS))?.toString(8)}`);
  check("② lock 600", modeOf(lockFilePath(PATHS)) === 0o600, `got ${modeOf(lockFilePath(PATHS))?.toString(8)}`);

  // ③④ 带唯一标记的任务（pattern 命中 → 有投递活动；命令本身即泄漏标记）
  const MARKER = `OMT_AUDIT_${process.pid}_${Date.now().toString(36)}`;
  const client = new MonitorClient(svc.url, svc.password);
  const created = await client.createTask({
    command: `echo leaktest-${MARKER} && sleep 30`,
    pattern: MARKER,
    session_id: sid,
    opencode_port: Number(ocPort),
    description: "m8 permission audit",
    idle_timeout_ms: 60000,
  });
  check("③ 任务创建成功（审计载体）", created.state === "running", JSON.stringify(created).slice(0, 120));

  // 等命中 + 投递落日志
  await sleep(1500);

  // ①' data 根目录在首个任务创建时建立（initTaskDir → ensurePrivateDir）——此时必在
  check("① data 根目录 0700", modeOf(dataDir(PATHS)) === 0o700, `got ${modeOf(dataDir(PATHS))?.toString(8)}`);

  // ③ 任务目录链与文件权限
  const tasksRoot = path.join(dataDir(PATHS), "tasks");
  const taskDir = path.join(tasksRoot, created.id);
  check("③ tasks/ 0700", modeOf(tasksRoot) === 0o700, `got ${modeOf(tasksRoot)?.toString(8)}`);
  check("③ 任务目录 0700", modeOf(taskDir) === 0o700, `got ${modeOf(taskDir)?.toString(8)}`);
  check("③ meta.json 600", modeOf(path.join(taskDir, "meta.json")) === 0o600, `got ${modeOf(path.join(taskDir, "meta.json"))?.toString(8)}`);
  check("③ 任务 log 600", modeOf(path.join(taskDir, "log")) === 0o600, `got ${modeOf(path.join(taskDir, "log"))?.toString(8)}`);

  // ④ meta.json 无凭证字段（PLAN §2.8.1：password 每次现读，永不落盘）
  const meta = JSON.parse(readFileSync(path.join(taskDir, "meta.json"), "utf8")) as Record<string, unknown>;
  check("④ meta.json 无 password 键", !("password" in meta), `keys: ${Object.keys(meta).join(",")}`);
  check("④ meta.json 无 auth 键", !("auth" in meta) && !("token" in meta), `keys: ${Object.keys(meta).join(",")}`);

  // ⑤ server.log 全文不含命令标记（不记命令全文；DEBUG 默认关）
  const serverLogPath = path.join(stateDir(PATHS), "server.log");
  const serverLog = readFileSync(serverLogPath, "utf8");
  check("⑤ server.log 不含命令全文标记", !serverLog.includes(MARKER), `marker leaked into ${serverLogPath}`);
  // 对照组：命令确实执行了（任务 log 内有标记）——证明 ⑤ 不是"命令没跑"的假阴性
  const taskLog = readFileSync(path.join(taskDir, "log"), "utf8");
  check("⑤ 对照组: 任务 log 含标记（命令确实执行）", taskLog.includes(MARKER));

  // ⑥ plugin/tui 诊断日志落点：state 目录（0700）内——静态审计代码路径的 mkdir mode
  const pluginSrc = readFileSync(path.join(ROOT, "packages", "plugin", "src", "index.ts"), "utf8");
  const tuiFeedSrc = readFileSync(path.join(ROOT, "src", "tui", "feed.ts"), "utf8");
  check("⑥ plugin.log 落 state 目录且 mkdir 0700", pluginSrc.includes("stateDir(envFromProcess())") && pluginSrc.includes("0o700"));
  check("⑥ tui.log 落 state 目录且 mkdir 0700", tuiFeedSrc.includes("0o700"));

  // 收尾：停任务（终态化，日志完整）→ 删 probe session
  await client.stopTask(created.id).catch(() => {});
  await sleep(400);
  await fetch(`${ocSvc.url}/api/session/${sid}`, { method: "DELETE", headers: ocAuth }).catch(() => {});
}

// ---- 汇总 ----
try {
  await main();
} catch (err) {
  failed++;
  results.push(`  ✘ fatal: ${String(err)}`);
} finally {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      // best-effort
    }
  }
  await sleep(300);
  rmSync(XDG, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log(`\n${passed} passed, ${failed} failed (form: ${entry.form})`);
process.exit(failed > 0 ? 1 : 0);
