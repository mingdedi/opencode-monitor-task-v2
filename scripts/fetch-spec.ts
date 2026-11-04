// 抓取运行中 opencode 服务的 /openapi.json 快照入库（M0 契约防护，PLAN §1.3-4）
// 凭证从环境/标准位置现读，绝不硬编码；写入前做敏感串自检（开源卫生）
//
// 用法: node --import tsx scripts/fetch-spec.ts

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const stateHome =
  process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.startsWith("/")
    ? process.env.XDG_STATE_HOME
    : path.join(homedir(), ".local/state");

const svcPath = path.join(stateHome, "opencode", "service.json");
const svc = JSON.parse(readFileSync(svcPath, "utf8")) as {
  url: string;
  password: string;
  pid: number;
};

const auth = "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64");
const res = await fetch(`${svc.url}/openapi.json`, { headers: { authorization: auth } });
if (!res.ok) {
  console.error(`GET /openapi.json -> ${res.status}`);
  process.exit(1);
}
const spec = (await res.json()) as {
  info?: { version?: string };
  paths?: Record<string, unknown>;
  openapi?: string;
};

// 敏感串自检：快照中不得出现本机凭证/地址/pid（开源卫生）
const raw = JSON.stringify(spec);
for (const [label, needle] of [
  ["password", svc.password],
  ["service url", svc.url],
  ["pid", String(svc.pid)],
] as const) {
  if (needle && raw.includes(needle)) {
    console.error(`ABORT: ${label} found in spec snapshot — refusing to write`);
    process.exit(1);
  }
}

const version = spec.info?.version ?? "unknown";
const dir = path.join(import.meta.dirname, "..", "test", "fixtures");
// 只保留一份快照（旧的删除，避免版本堆积）
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) {
  if (/^openapi-.*\.json$/.test(f)) {
    // 保留，多版本共存以供版本矩阵；手动清理即可
  }
}
const out = path.join(dir, `openapi-${version}.json`);
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
console.log(
  `saved ${path.relative(process.cwd(), out)} | openapi ${spec.openapi ?? "?"} | version ${version} | ${Object.keys(spec.paths ?? {}).length} paths`,
);
