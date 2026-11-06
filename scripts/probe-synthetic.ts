// M0：synthetic 端点运行时语义实测
// 实测项：① delivery 两模式 ② resume:false ③ 幂等 id 重放 ④ 409/400 触发条件
// 隔离性：创建专用测试 session，不触碰任何真实会话；结束即删
// 开源卫生：凭证只现读；输出脱敏（session id 截断，password 永不出现）
//
// 用法: node --import tsx scripts/probe-synthetic.ts

import { readOpencodeService, opencodeAuthHeader } from "../packages/shared/src/ocservice.ts";

const svc = readOpencodeService();
const auth = opencodeAuthHeader(svc);

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`${svc.url}${p}`, {
    method,
    headers: { authorization: auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 120) };
  }
  return { status: res.status, json };
}

const mask = (s: string) => (s.length > 10 ? `${s.slice(0, 10)}…` : s);
/** 输出脱敏：完整 session id 不落终端（开源卫生） */
const maskSessionIds = (text: string) => text.replace(/ses_[A-Za-z0-9]+/g, (m) => mask(m));
function show(label: string, r: { status: number; json: unknown }) {
  console.log(`${label.padEnd(34)} -> ${r.status} ${maskSessionIds(JSON.stringify(r.json)).slice(0, 220)}`);
}

// --- setup: 专用测试 session ---
const created = await api("POST", "/api/session", { title: "omt-probe-synthetic" });
const sid = (created.json as { id?: string; data?: { id?: string } })?.id
  ?? (created.json as { data?: { id?: string } })?.data?.id;
if (!sid) {
  console.error("cannot create probe session:", created.status, JSON.stringify(created.json).slice(0, 300));
  process.exit(1);
}
console.log(`probe session ${mask(sid)} created (${created.status})`);

try {
  // ① delivery 两模式
  show("queue delivery", await api("POST", `/api/session/${sid}/synthetic`, {
    text: "PROBE(queue): no response needed",
    delivery: "queue",
  }));
  show("steer delivery", await api("POST", `/api/session/${sid}/synthetic`, {
    text: "PROBE(steer): no response needed",
    delivery: "steer",
  }));

  // ② resume:false —— 应只入收件箱不触发执行
  show("resume:false", await api("POST", `/api/session/${sid}/synthetic`, {
    text: "PROBE(resume:false): parked in inbox",
    resume: false,
  }));
  show("inbox after resume:false", await api("GET", `/api/session/${sid}/inbox`));

  // ③ 幂等 id 重放
  const probeId = `msg_probe_${Date.now()}`;
  show("idempotent first", await api("POST", `/api/session/${sid}/synthetic`, {
    id: probeId,
    text: "PROBE(idempotent) first",
    resume: false,
  }));
  show("idempotent replay(same id)", await api("POST", `/api/session/${sid}/synthetic`, {
    id: probeId,
    text: "PROBE(idempotent) replay",
    resume: false,
  }));

  // ④ 错误形状：400 / 404 / 409
  show("missing text (expect 400)", await api("POST", `/api/session/${sid}/synthetic`, {}));
  show("empty text (expect 400?)", await api("POST", `/api/session/${sid}/synthetic`, { text: "" }));
  show("bogus delivery (expect 400?)", await api("POST", `/api/session/${sid}/synthetic`, {
    text: "x",
    delivery: "bogus",
  }));
  show("unknown session (expect 404)", await api("POST", `/api/session/ses_doesnotexist0000/synthetic`, {
    text: "x",
  }));
  show("no auth (expect 401)", await fetch(`${svc.url}/api/info`).then(async (r) => ({
    status: r.status,
    json: (await r.text()).slice(0, 80),
  })));
} finally {
  // cleanup
  const del = await api("DELETE", `/api/session/${sid}`);
  console.log(`cleanup session.remove -> ${del.status}`);
}
