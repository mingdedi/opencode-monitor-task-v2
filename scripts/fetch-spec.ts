// 抓取运行中 opencode 服务的 /openapi.json 快照入库
// 凭证从环境/标准位置现读，绝不硬编码；写入前做敏感串自检（开源卫生）
//
// 用法: node --import tsx scripts/fetch-spec.ts

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeAuthHeader, readOpencodeService } from "../packages/shared/src/ocservice.ts";

const svc = readOpencodeService();
const auth = opencodeAuthHeader(svc);
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
// 多版本快照共存（供版本矩阵对照），过期版本手动清理
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
mkdirSync(dir, { recursive: true });
const out = path.join(dir, `openapi-${version}.json`);
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
console.log(
  `saved ${path.relative(process.cwd(), out)} | openapi ${spec.openapi ?? "?"} | version ${version} | ${Object.keys(spec.paths ?? {}).length} paths`,
);
