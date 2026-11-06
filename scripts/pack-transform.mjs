// 发布形态转换：pack/publish 时剥离 package.json 的 workspaces 字段。
//
// 动机：workspaces 是 monorepo 开发概念；发布 tarball 里它会让 npm 在安装侧把
// packages/* 当 workspace 解析（包内无对应 package.json），实测触发
// EUNSUPPORTEDPROTOCOL / 安装失败。发布包是自包含单包（bundle + 相对路径 TS 源），
// workspaces 必须不随包发布。
//
// 时序（npm pack/publish）：prepack → [pack 固化 tarball] → postpack。
// prepack：备份 package.json → .package.json.workspaces.bak 后删除 workspaces
// postpack：从备份恢复（幂等：无备份即无事）
// 中断防护：prepack 发现既有备份（上次 pack 被 Ctrl-C 之类中断）时先恢复再重来，
// 并在 stderr 留痕；.bak 已入 .gitignore。
//
// 用法: node scripts/pack-transform.mjs prepack|postpack

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "package.json");
const BAK = path.join(ROOT, ".package.json.workspaces.bak");

const mode = process.argv[2];

if (mode === "prepack") {
  // 中断残留自愈：上次 prepack 后未到 postpack
  if (existsSync(BAK)) {
    copyFileSync(BAK, PKG);
    rmSync(BAK);
    process.stderr.write("pack-transform: recovered package.json from a stale prepack backup\n");
  }
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  if (!("workspaces" in pkg)) {
    process.stderr.write("pack-transform: nothing to strip (no workspaces field)\n");
    process.exit(0);
  }
  copyFileSync(PKG, BAK);
  delete pkg.workspaces;
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
  process.stderr.write("pack-transform: workspaces stripped for pack\n");
} else if (mode === "postpack") {
  if (!existsSync(BAK)) {
    process.stderr.write("pack-transform: no backup to restore\n");
    process.exit(0);
  }
  copyFileSync(BAK, PKG);
  rmSync(BAK);
  process.stderr.write("pack-transform: workspaces restored\n");
} else {
  process.stderr.write("usage: node scripts/pack-transform.mjs prepack|postpack\n");
  process.exit(1);
}
