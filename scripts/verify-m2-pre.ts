// 阶段 C 真机验收（SERVER-PLAN）：进程管理与注入契约
//  ① verifyInstance / resolveTarget / verifySessionAlive 真机（真实共享 opencode 服务）
//  ② sendSynthetic 真机：隔离 probe session + resume:false + 幂等 id 重放 + inbox 可见
//  ③ wrapper 四态：exit 0 / exit 7 / 组 TERM（signal:15）/ SIGKILL（无文件 → unknown）
//  ④ detached 存活 + 双因子 starttime + killTree 两档 + 任务目录权限
//  ⑤ 服务端接线：--opencode-state 注册表 → health.opencode_instances 实测 reachable/version
// 隔离：任务/服务端 state 走 /tmp/opencode/omt-verify-m2pre-<pid>；probe session 用后即删；
//       凭证只现读、输出脱敏（session id 截断，password 永不出现）。
//
// 前置：opencode 共享服务运行中（~/.local/state/opencode/service.json 存在且 /api/info 200）
// 用法: node --import tsx scripts/verify-m2-pre.ts

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MonitorClient, opencodeAuthHeader, opencodeServicePath, readOpencodeService, type HealthInfo, type PathEnv } from "@omt/shared";
import {
  buildRegistry,
  listInbox,
  resolveTarget,
  sendSynthetic,
  verifyInstance,
  verifySessionAlive,
} from "../packages/server/src/opencode.ts";
import { exitCodeFromRaw, isTaskProcessAlive, killTree, spawnTask } from "../packages/server/src/spawner.ts";
import { initTaskDir, readExitFile } from "../packages/server/src/taskstore.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { resolveServerEntry } from "./lib/server-entry.ts";
const entry = resolveServerEntry(ROOT);
const XDG = mkdtempSync("/tmp/opencode/omt-verify-m2pre-");
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

// ---- 服务端进程（场景⑤）----
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

// ---- 任务辅助 ----
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

let seq = 0;
function newTask(command: string) {
  const id = `mon_v${Date.now().toString(36)}${(seq++).toString(36)}`;
  const paths = initTaskDir(pathEnv, id);
  const t = spawnTask(paths, command, { cwd: XDG });
  return { id, t, paths, log: () => readFileSync(paths.log, "utf8") };
}

// ---------------------------------------------------------------------------
// 场景

async function scenario1_instance_contract(): Promise<{ svcUrl: string; port: number; probeSession: string }> {
  const svc = readOpencodeService(); // 真实共享服务（前置）
  const port = Number(new URL(svc.url).port);

  const inst = await verifyInstance(svc);
  check("①verifyInstance: ok 且 version 实测非空", inst.ok && typeof inst.version === "string" && inst.version !== "", inst.detail ?? "");

  const reg = buildRegistry({}); // 默认条目 = 真实共享服务
  const ok = await resolveTarget(reg, port, {});
  check("①resolveTarget: 真实端口三层校验通过", ok.ok === true, ok.ok ? "" : ok.reason);
  const ghost = await resolveTarget(reg, 65534, {});
  check("①resolveTarget: 幻觉端口 65534 → PORT_NOT_IN_REGISTRY", ghost.ok === false && ghost.code === "PORT_NOT_IN_REGISTRY", ghost.ok ? "" : ghost.code);

  const auth = opencodeAuthHeader(svc);
  const created = await fetch(`${svc.url}/api/session`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ title: "omt-verify-m2pre" }),
  });
  const createdBody = (await created.json()) as { id?: string; data?: { id?: string } };
  const sid = createdBody.id ?? createdBody.data?.id;
  if (!sid) throw new Error(`cannot create probe session: ${created.status}`);
  check("①probe session: 创建成功", created.status === 200);

  check("①verifySessionAlive: 真实 session → true", await verifySessionAlive(svc, sid));
  check("①verifySessionAlive: 捏造 session → false", !(await verifySessionAlive(svc, "ses_doesnotexist0000")));
  return { svcUrl: svc.url, port, probeSession: sid };
}

async function scenario2_synthetic(probeSession: string): Promise<void> {
  const svc = readOpencodeService(); // 现读

  // resume:false + queue：只入收件箱，不触发执行、不打扰任何真实会话
  const idem = `msg_omt_verify_${Date.now()}`;
  const first = await sendSynthetic(svc, {
    sessionId: probeSession,
    text: "VERIFY(stage-c): synthetic contract, no response needed",
    delivery: "queue",
    id: idem,
    resume: false,
  });
  check("②sendSynthetic: ok", first.ok, first.detail ?? "");

  // 幂等重放：同 id → 回显首次 messageId（CONTRACT.md 实测语义）
  const replay = await sendSynthetic(svc, {
    sessionId: probeSession,
    text: "VERIFY(stage-c): replay with same id, must dedupe",
    delivery: "queue",
    id: idem,
    resume: false,
  });
  check(
    "②幂等重放: messageId 与首次相同（真去重）",
    replay.ok && first.messageId !== undefined && replay.messageId === first.messageId,
    `first=${first.messageId} replay=${replay.messageId}`,
  );

  const inbox = await listInbox(svc, probeSession);
  check("②listInbox: 幂等消息在收件箱且不重复", inbox.filter((m) => m["id"] === first.messageId).length === 1, `inbox=${inbox.length}`);

  const nf = await sendSynthetic(svc, { sessionId: "ses_doesnotexist0000", text: "x", delivery: "queue" });
  check("②404 判别: 死 session → session-not-found（降级链判据）", nf.failure === "session-not-found", nf.detail ?? "");

  const del = await fetch(`${svc.url}/api/session/${probeSession}`, { method: "DELETE", headers: { authorization: opencodeAuthHeader(svc) } });
  check("②cleanup: probe session 已删", del.status === 204 || del.status === 200, `status=${del.status}`);
}

async function scenario3_wrapper_states(): Promise<void> {
  const exited = (id: string) => readExitFile(pathEnv, id);

  const a = newTask("echo v-stage-c; exit 0");
  check('③态① exit0: exit 文件 "0"', await waitFor(() => exited(a.id) === "0"), `exit=${exited(a.id)}`);
  check("③态① exit0: log 落盘", a.log().includes("v-stage-c"));

  const b = newTask("echo o; echo e 1>&2; exit 7");
  check('③态② exit7: exit 文件 "7"', await waitFor(() => exited(b.id) === "7"), `exit=${exited(b.id)}`);

  const c = newTask("echo READY; sleep 30");
  await waitFor(() => c.log().includes("READY")); // 就绪标记：wrapper 信号 trap 已装好
  const tierC = await killTree(c.t.pgid);
  check("③态③ TERM: killTree 档位 term", tierC === "term");
  check('③态③ TERM: exit 文件 "signal:15"', await waitFor(() => exited(c.id) === "signal:15"), `exit=${exited(c.id)}`);

  const d = newTask("echo READY; sleep 30");
  await waitFor(() => d.log().includes("READY"));
  process.kill(-d.t.pgid, "SIGKILL");
  await waitFor(() => !isTaskProcessAlive({ pid: d.t.pid, startTime: null }));
  await sleep(200); // 留出"本不该发生的写入"窗口
  check("③态④ SIGKILL: 无 exit 文件", exited(d.id) === null, `exit=${exited(d.id)}`);
  check('③态④ SIGKILL: exitCodeFromRaw → "unknown"', exitCodeFromRaw(exited(d.id)) === "unknown");
}

async function scenario4_detached_twofactor_killtree(): Promise<void> {
  const e = newTask("echo READY; sleep 30");
  await waitFor(() => e.log().includes("READY"));
  check("④detached: 任务存活（父侧已放手，服务端可离场）", isTaskProcessAlive({ pid: e.t.pid, startTime: e.t.procStartTime }));
  if (process.platform === "linux" && e.t.procStartTime !== null) {
    check("④双因子: starttime 错位 → 按死（pid 复用防御）", !isTaskProcessAlive({ pid: e.t.pid, startTime: e.t.procStartTime + 1 }));
  } else {
    check("④双因子: 非 Linux 单因子降级", isTaskProcessAlive({ pid: e.t.pid, startTime: null }));
  }
  check("④killTree: 温和档清场", (await killTree(e.t.pgid)) === "term");

  const f = newTask("trap '' TERM; echo READY; exec sleep 30");
  await waitFor(() => f.log().includes("READY"));
  check("④killTree: 抗 TERM → 升级 KILL", (await killTree(f.t.pgid)) === "kill");

  check("④权限: 任务目录 0700", (statSync(f.paths.dir).mode & 0o777) === 0o700);
  check("④权限: log 文件 600", (statSync(f.paths.log).mode & 0o777) === 0o600);
}

async function scenario5_server_health_registry(realServicePath: string): Promise<void> {
  // --opencode-state 指向真实共享服务 service.json；隔离 XDG 下默认条目不存在 → 恰一条
  spawnServer(["--opencode-state", realServicePath]);
  const sfPath = `${pathEnv.XDG_STATE_HOME}/opencode-monitor-task/service.json`;
  let health: HealthInfo | null = null;
  for (let i = 0; i < 50 && !health; i++) {
    await sleep(100);
    if (existsSync(sfPath)) {
      try {
        const svc = JSON.parse(readFileSync(sfPath, "utf8")) as { url: string; password: string };
        health = await new MonitorClient(svc.url, svc.password).health(2000).catch(() => null);
      } catch {
        /* 未就绪 */
      }
    }
  }
  check("⑤health: 服务端就绪", health !== null);
  if (health) {
    const inst = health.opencode_instances;
    check("⑤health: 实例表恰一条（隔离 XDG 默认条目不存在）", inst.length === 1, JSON.stringify(inst.map((i) => i.port)));
    const e = inst[0];
    check(
      "⑤health: reachable=true 且 version 实测非空",
      e !== undefined && e.reachable === true && typeof e.version === "string" && e.version !== "",
      JSON.stringify(e),
    );
    check("⑤health: pid_alive=true", e !== undefined && e.pid_alive === true);
  }
  await killServers();
  check("⑤cleanup: SIGTERM 后 service.json 自清", !existsSync(sfPath));
}

// ---------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error("TIMEOUT: verify-m2-pre exceeded 120s, killing all children");
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
}, 120_000);

process.on("SIGINT", async () => {
  await killServers();
  rmSync(XDG, { recursive: true, force: true });
  process.exit(130);
});

console.log(`verify-m2-pre: XDG=${XDG}\n`);

// 场景①需前置（真实共享服务在跑），失败则 ② 依赖不可满足——顺序执行、逐场捕获
let scenarioFailed = false;
const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
  results.push(`■ ${name}`);
  try {
    await fn();
  } catch (err) {
    scenarioFailed = true;
    check(`${name}（场景自身）`, false, String(err));
  }
  results.push("");
};

let probeSession: string | null = null;
await run("① 实例契约（verifyInstance / resolveTarget / verifySessionAlive 真机）", async () => {
  const ctx = await scenario1_instance_contract();
  probeSession = ctx.probeSession;
});
if (probeSession !== null) {
  await run("② synthetic 注入契约（隔离 session，resume:false）", () => scenario2_synthetic(probeSession!));
} else {
  results.push("■ ② synthetic（跳过：场景① 未取得 probe session）\n");
}
await run("③ wrapper 四态", scenario3_wrapper_states);
await run("④ detached / 双因子 / killTree / 权限", scenario4_detached_twofactor_killtree);
let realServicePath: string | null = null;
try {
  void readOpencodeService(); // 前置仍在：服务不在则跳过场景⑤
  realServicePath = opencodeServicePath({});
} catch {
  realServicePath = null;
}
if (realServicePath !== null) {
  await run("⑤ 服务端接线（--opencode-state → health 实例表实测）", () => scenario5_server_health_registry(realServicePath!));
} else {
  results.push("■ ⑤ 服务端接线（跳过：真实共享服务不可用）\n");
}

console.log(results.join("\n"));
console.log(`verify-m2-pre: ${passed} passed, ${failed} failed`);

// 收尾：清服务端子进程与隔离目录（任务进程已由各场景 killTree 清场）
clearTimeout(watchdog);
await killServers();
rmSync(XDG, { recursive: true, force: true });
process.exit(failed > 0 || scenarioFailed ? 1 : 0);
