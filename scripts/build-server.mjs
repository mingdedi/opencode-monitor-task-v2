// M8 发布构建（PLUGIN-PLAN §三-5 决策）：esbuild --bundle 单文件 dist/server.mjs。
//
// 打包范围：packages/server/src/main.ts + @omt/shared（workspace TS 源码，exports 指
// 向 ./src/index.ts）+ @opencode-ai/sdk（纯 JS fetch 客户端）——运行时需求收敛为
// "一个 node ≥ 20"，发布包摆脱 monorepo 结构依赖。
//
// 版本一致性：main.ts 的 SERVER_VERSION 经 `new URL("../package.json", import.meta.url)`
// 现读——bundle 形态下解析为 dist/../package.json = 根 package.json（2.0.0）；源码形态
// 读 packages/server/package.json。两处版本号必须一致（versionCompatible 复用判断的
// 判据），构建脚本显式校验后再打包。
//
// 用法: node scripts/build-server.mjs   （npm run build）

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 版本一致性围栏：bundle 形态读根 package.json，源码形态读 packages/server/package.json
const rootVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const serverVersion = JSON.parse(
  readFileSync(path.join(ROOT, "packages", "server", "package.json"), "utf8"),
).version;
if (rootVersion !== serverVersion) {
  console.error(
    `version mismatch: root ${rootVersion} vs packages/server ${serverVersion}; ` +
      `SERVER_VERSION resolves differently across source/bundle forms — align them first`,
  );
  process.exit(1);
}

const result = await build({
  entryPoints: [path.join(ROOT, "packages", "server", "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: path.join(ROOT, "dist", "server.mjs"),
  packages: "bundle", // SDK + @omt/shared 一并打进单文件（§三-5）
  sourcemap: false,
  minify: false, // 服务端诊断友好：保留可读性，体积不是发布形态的痛点
  logLevel: "info",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((acc, o) => acc + o.bytes, 0);
console.log(`dist/server.mjs built (${(bytes / 1024).toFixed(1)} KiB), version ${rootVersion}`);
