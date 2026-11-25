// Web 看板真机验收：daemon 自托管前端（GET /）+ 鉴权扩展 + 会话跳转 + 操控闭环。
// 与 verify-m7 同隔离模式：state/data 走 /tmp/opencode/omt-verify-ui-<rand>；
// 隔离 XDG 下 opencode/service.json symlink → 真实共享服务（注册表默认条目命中，
// altPasswords 现读真实 opencode 密码——"一把密钥"体验的实证）。
//
// 场景：
//  ① 同端口同鉴权：GET / 无 auth → 401 + WWW-Authenticate；opencode 密码登录 → 200
//     text/html + 安全头（含 hash CSP）；daemon 自身密码同样有效（插件发现通道不破）；
//     错密码拒；CSRF 围栏探针（text/plain 表单 body → 415、cross-site → 403）。
//  ② 会话跳转路由实证：按 UI 同款构造 {url}/server/{base64(url) 去 padding}/session/{id}
//     真机 GET → 200（opencode web 前端路由格式契约锚）。
//  ③ 操控闭环（全程用 opencode 密码——UI 的等价 API 路径）：创建 → 列表/日志 →
//     PATCH max_events → stop 终态 → DELETE；idle 裁决态 keepalive 复活 → stop。
//  ④ shutdown 端点用 opencode 密码可达；退出后 service.json 清理。
//
// 双形态：默认 bundle（dist/server.mjs 存在时），OMT_UI_VERIFY_FORM=source 强制源码形态
// （node --import tsx main.ts）——两形态同判据（零漂移门禁）。
// 前置：opencode 共享服务运行中。用法: node --import tsx scripts/verify-ui.ts
//       OMT_UI_VERIFY_FORM=source node --import tsx scripts/verify-ui.ts

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeAuthHeader, opencodeServicePath, readOpencodeService } from "@omt/shared";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XDG = mkdtempSync("/tmp/opencode/omt-verify-ui-");
const STATE = `${XDG}/state`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- 前置：真实 opencode 共享服务 + 隔离注册表 ----
const ocSvc = readOpencodeService(); // 前置失败即 fatal
const ocPort = Number(new URL(ocSvc.url).port);
const ocAuth = { authorization: opencodeAuthHeader(ocSvc), "content-type": "application/json" };
mkdirSync(`${STATE}/opencode`, { recursive: true });
symlinkSync(opencodeServicePath(), `${STATE}/opencode/service.json`);

const FORM = process.env["OMT_UI_VERIFY_FORM"] ?? (existsSync(path.join(ROOT, "dist", "server.mjs")) ? "bundle" : "source");
const serverCmd =
  FORM === "bundle"
    ? [process.execPath, path.join(ROOT, "dist", "server.mjs")]
    : [process.execPath, "--import", "tsx", path.join(ROOT, "packages", "server", "src", "main.ts")];
console.log(`verify-ui: form=${FORM} xdg=${XDG}`);

const sfPath = `${STATE}/opencode-monitor-task/service.json`;
function readIsolatedService(): { url: string; password: string; pid: number } | null {
  try {
    return JSON.parse(readFileSync(sfPath, "utf8")) as { url: string; password: string; pid: number };
  } catch {
    return null;
  }
}

const daemon = spawn(serverCmd[0]!, serverCmd.slice(1), {
  cwd: ROOT, // tsx 可解析；任务 directory 显式传 XDG，不依赖 daemon cwd
  env: { ...process.env, XDG_STATE_HOME: STATE, XDG_DATA_HOME: `${XDG}/data` },
  stdio: "ignore",
  detached: true,
});
daemon.unref();

const auth = (pw: string) => ({ authorization: "Basic " + Buffer.from(`monitor:${pw}`).toString("base64") });
let base = "";
let daemonPassword = "";

async function waitReady(): Promise<boolean> {
  const deadline = Date.now() + 15000; // tsx 冷启动余量
  while (Date.now() < deadline) {
    const svc = readIsolatedService();
    if (svc) {
      try {
        const res = await fetch(`${svc.url}/api/health`, { headers: auth(svc.password), signal: AbortSignal.timeout(1000) });
        if (res.status === 200) {
          base = svc.url;
          daemonPassword = svc.password;
          return true;
        }
      } catch {
        // 尚未就绪
      }
    }
    await sleep(200);
  }
  return false;
}

async function newProbeSession(): Promise<string> {
  const res = await fetch(`${ocSvc.url}/api/session`, { method: "POST", headers: ocAuth, body: JSON.stringify({ title: "omt-ui-verify probe" }) });
  const body = (await res.json()) as { id?: string; data?: { id?: string } };
  const sid = body.id ?? body.data?.id;
  if (!sid) throw new Error(`cannot create probe session: ${res.status}`);
  return sid;
}

/** UI 同款会话跳转构造（ui.html sessionUrl 的脚本镜像——格式契约判据；
 *  含监听地址归一：0.0.0.0/[::] → loopback，与浏览器可连接地址一致） */
function sessionLink(instanceUrl: string, sid: string): string {
  const u = new URL(instanceUrl);
  if (u.hostname === "0.0.0.0") u.hostname = "127.0.0.1";
  else if (u.hostname === "[::]" || u.hostname === "::") u.hostname = "[::1]";
  const url = u.toString().replace(/\/$/, "");
  const enc = Buffer.from(url).toString("base64").replace(/=+$/, "");
  return `${url}/server/${enc}/session/${encodeURIComponent(sid)}`;
}

let probeSid = "";

async function scenario1_samePortAuth(): Promise<void> {
  console.log("① 同端口看板 + 鉴权扩展");
  const noAuth = await fetch(`${base}/`);
  check("GET / 无 auth → 401", noAuth.status === 401);
  check("401 带 WWW-Authenticate（浏览器登录框触发器）", /^Basic realm="opencode-monitor-task"$/.test(noAuth.headers.get("www-authenticate") ?? ""));

  // "一把密钥"：opencode service get password 的密码直接登录看板
  const ocPw = await fetch(`${base}/`, { headers: auth(ocSvc.password) });
  check("opencode 密码登录看板 → 200", ocPw.status === 200);
  check("content-type text/html", /^text\/html/.test(ocPw.headers.get("content-type") ?? ""));
  const html = await ocPw.text();
  check("页面骨架完整（title + 关键锚点）", html.includes("monitor-task") && html.includes("/server/") && html.includes('id="createForm"') && html.includes("data-i18n"));
  const csp = ocPw.headers.get("content-security-policy") ?? "";
  check("CSP + no-store + nosniff", csp.includes("default-src 'none'") && ocPw.headers.get("cache-control") === "no-store" && ocPw.headers.get("x-content-type-options") === "nosniff");
  check("hash CSP：script-src 为 sha256（非 unsafe-inline）", /script-src 'sha256-[A-Za-z0-9+/=]+'/.test(csp) && !csp.includes("script-src 'unsafe-inline'"));

  // CSRF 围栏（审查 F1）：表单系 Content-Type 与跨站 Sec-Fetch-Site 皆拒，daemon 存活
  const csrfForm = await fetch(`${base}/api/shutdown`, {
    method: "POST",
    headers: { ...auth(ocSvc.password), "content-type": "text/plain" },
    body: '{"kill_tasks":true,"x":"="}',
  });
  check("CSRF：text/plain 表单构造 body → 415", csrfForm.status === 415);
  const csrfXs = await fetch(`${base}/api/shutdown`, {
    method: "POST",
    headers: { ...auth(ocSvc.password), "sec-fetch-site": "cross-site" },
  });
  check("CSRF：Sec-Fetch-Site cross-site → 403", csrfXs.status === 403);
  const stillUp = await fetch(`${base}/api/health`, { headers: auth(ocSvc.password) });
  check("CSRF 探针后 daemon 存活", stillUp.status === 200);

  const ownPw = await fetch(`${base}/`, { headers: auth(daemonPassword) });
  check("daemon 自身密码仍有效（插件发现通道不破）", ownPw.status === 200);
  const wrong = await fetch(`${base}/`, { headers: auth("definitely-wrong") });
  check("错误密码 → 401", wrong.status === 401);

  const health = await fetch(`${base}/api/health`, { headers: auth(ocSvc.password) });
  const hbody = (await health.json()) as { opencode_instances: Array<{ port: number; reachable: boolean }> };
  check("API 同样接受 opencode 密码", health.status === 200);
  check("health 实例表命中真实 opencode（symlink 注册表）", hbody.opencode_instances.some((i) => i.port === ocPort && i.reachable));
}

async function scenario2_sessionLink(): Promise<void> {
  console.log("② 会话跳转路由实证");
  probeSid = await newProbeSession();
  const link = sessionLink(ocSvc.url, probeSid);
  const res = await fetch(link, { signal: AbortSignal.timeout(5000) });
  check("UI 构造的会话链接真机可达 → 200", res.status === 200, `GET ${link.slice(0, 80)}… -> ${res.status}`);
  const ctype = res.headers.get("content-type") ?? "";
  check("返回 web 前端页面（text/html）", ctype.includes("text/html"), ctype);
}

async function scenario3_controlLoop(): Promise<void> {
  console.log("③ 操控闭环（opencode 密码全程）");
  const h = { ...auth(ocSvc.password), "content-type": "application/json" };
  const created = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      command: "for i in 1 2 3 4 5 6 7 8 9 10; do echo ui-smoke-$i; sleep 0.3; done",
      opencode_port: ocPort,
      session_id: probeSid,
      description: "verify-ui smoke loop",
      pattern: "ui-smoke-5",
      max_events: 3,
      directory: XDG,
    }),
  });
  const info = (await created.json()) as { id: string; state: string };
  check("创建 → 201", created.status === 201, `status=${created.status}`);
  const id = info.id;

  await sleep(1200);
  const list = (await (await fetch(`${base}/api/tasks`, { headers: h })).json()) as Array<{ id: string; state: string; lines_scanned: number }>;
  const mine = list.find((t) => t.id === id);
  check("列表可见 + 活态 + 输出在扫描", mine !== undefined && ["running", "starting"].includes(mine.state) && mine.lines_scanned > 0);

  const log = await fetch(`${base}/api/tasks/${id}/log?tail=5`, { headers: h });
  const logText = (await log.json()) as string;
  check("日志尾部可读", log.status === 200 && logText.includes("ui-smoke-"));

  const patch = await fetch(`${base}/api/tasks/${id}`, { method: "PATCH", headers: h, body: JSON.stringify({ max_events: 7 }) });
  check("PATCH max_events → 200", patch.status === 200);

  const stop = await fetch(`${base}/api/tasks/${id}/stop`, { method: "POST", headers: h });
  const stopped = (await stop.json()) as { state: string };
  check("stop → 终态快照", stop.status === 200 && stopped.state === "stopped");

  const del = await fetch(`${base}/api/tasks/${id}`, { method: "DELETE", headers: h });
  check("DELETE 终态 → 204", del.status === 204);

  // idle 裁决态 keepalive 复活（idle_timeout_ms=1000 + 静默命令 → ~1s 转 idle）
  const idleTask = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      command: "sleep 4",
      opencode_port: ocPort,
      session_id: probeSid,
      description: "verify-ui idle probe",
      idle_timeout_ms: 1000,
      directory: XDG,
    }),
  });
  const idleInfo = (await idleTask.json()) as { id: string };
  const iid = idleInfo.id;
  let sawIdle = false;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const t = (await (await fetch(`${base}/api/tasks/${iid}`, { headers: h })).json()) as { state: string };
    if (t.state === "idle") {
      sawIdle = true;
      break;
    }
    await sleep(150);
  }
  check("静默任务转 idle（裁决暂停态）", sawIdle);
  const ka = await fetch(`${base}/api/tasks/${iid}/keepalive`, { method: "POST", headers: h });
  const kaInfo = (await ka.json()) as { state: string };
  check("keepalive → 200 + running 复活", ka.status === 200 && kaInfo.state === "running");
  await fetch(`${base}/api/tasks/${iid}/stop`, { method: "POST", headers: h });
  const del2 = await fetch(`${base}/api/tasks/${iid}`, { method: "DELETE", headers: h });
  check("idle 探针收尾 DELETE → 204", del2.status === 204);
}

async function scenario4_shutdown(): Promise<void> {
  console.log("④ shutdown（opencode 密码可达）");
  const res = await fetch(`${base}/api/shutdown`, {
    method: "POST",
    headers: { ...auth(ocSvc.password), "content-type": "application/json" },
    body: JSON.stringify({ kill_tasks: true }),
  });
  check("shutdown → 200", res.status === 200);
  await sleep(600);
  check("退出后 service.json 清理", readIsolatedService() === null);
}

// ---- 主流程 + 收尾 ----
try {
  if (!(await waitReady())) throw new Error(`daemon not ready in 15s (form=${FORM}, pid=${daemon.pid})`);
  await scenario1_samePortAuth();
  await scenario2_sessionLink();
  await scenario3_controlLoop();
  await scenario4_shutdown();
} catch (err) {
  failed++;
  console.log(`  ✘ fatal: ${String(err)}`);
} finally {
  if (probeSid !== "") {
    await fetch(`${ocSvc.url}/api/session/${probeSid}`, { method: "DELETE", headers: ocAuth }).catch(() => {});
  }
  try {
    process.kill(daemon.pid!, "SIGTERM");
  } catch {
    // 已退出
  }
  await sleep(300);
  rmSync(XDG, { recursive: true, force: true });
}

console.log(`\nverify-ui (${FORM}): ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
