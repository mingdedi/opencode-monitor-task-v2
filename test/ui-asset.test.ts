// 看板资产门禁：ui.html（唯一编辑入口）→ ui-html.ts（生成物，内嵌 bundle）零漂移。
// 与 build 双形态门禁同哲学：生成物必须与源逐字节一致，npm test 把关——
// 改了 ui.html 忘跑 gen-ui/build 时此处即红。另做单文件自洽性 sanity（零外部资源）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import UI_HTML from "../packages/server/src/ui-html.ts";
import { uiSecurityHeaders } from "../packages/server/src/http.ts";

const srcPath = fileURLToPath(new URL("../packages/server/src/ui.html", import.meta.url));
const src = readFileSync(srcPath, "utf8");

test("漂移门禁：ui-html.ts 生成物与 ui.html 逐字节一致", () => {
  assert.equal(
    UI_HTML,
    src,
    "ui-html.ts stale — run `node scripts/gen-ui.mjs` (or `npm run build`) after editing ui.html",
  );
});

test("单文件自洽：完整 HTML 骨架 + 关键功能标记齐备", () => {
  assert.ok(src.startsWith("<!doctype html>"));
  assert.ok(src.includes("</html>"));
  // 关键功能锚点（防误删）：会话跳转构造、轮询、创建表单、两段式确认、日志 follow
  assert.ok(src.includes("/server/"), "session jump route builder");
  assert.ok(src.includes("btoa(url)"), "base64 instance encoding");
  assert.ok(src.includes('id="createForm"'), "create form");
  assert.ok(src.includes('id="logFollow"'), "log follow toggle");
  assert.ok(src.includes("ARM_WINDOW_MS"), "two-step confirm");
  assert.ok(src.includes("/api/health"), "health polling");
  assert.ok(src.includes("/api/tasks"), "tasks polling");
});

test("零外部资源：无 http(s) 的 src/href 引用（离线可用；跳转链接运行时构造除外）", () => {
  // 只查静态标记区（<script> 之前）：JS 运行时构造的 href（实例/会话跳转）是动态值，不在此列
  const markup = src.split("<script>")[0]!;
  const refs = [...markup.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]!);
  for (const r of refs) {
    assert.ok(
      r.startsWith("data:") || r.startsWith("#") || r === "",
      `external static resource reference found: ${r}`,
    );
  }
  // 无 @import / url( 外部样式
  assert.ok(!/@import\s/.test(src));
  assert.ok(!/url\(\s*['"]?https?:/.test(src));
});

// ---------------------------------------------------------------------------
// i18n 门禁：en/zh 字典 key parity + 使用面（data-i18n* 标记 / tr() 调用）全覆盖

function dictBlock(name: string): string {
  const part = src.split(`const ${name} = {`)[1];
  assert.ok(part !== undefined, `dictionary ${name} not found`);
  return part.split("\n};")[0]!;
}
function dictKeys(block: string): Set<string> {
  return new Set([...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]!));
}

test("i18n：en/zh 字典 key 完全一致（parity）", () => {
  const en = dictKeys(dictBlock("EN"));
  const zh = dictKeys(dictBlock("ZH"));
  assert.ok(en.size > 80, `EN dictionary suspiciously small: ${en.size}`);
  const missingZh = [...en].filter((k) => !zh.has(k));
  const missingEn = [...zh].filter((k) => !en.has(k));
  assert.deepEqual(missingZh, [], "keys missing in ZH");
  assert.deepEqual(missingEn, [], "keys missing in EN");
});

test("i18n：使用面全覆盖——data-i18n* 标记与 tr() 调用的 key 双语皆备", () => {
  const en = dictKeys(dictBlock("EN"));
  const zh = dictKeys(dictBlock("ZH"));
  const used = new Set<string>();
  // 静态标记四种形态
  for (const m of src.matchAll(/data-i18n(?:-html|-placeholder|-title)?="([^"]+)"/g)) used.add(m[1]!);
  // JS 字面量调用（排除 tr("state." + …) 动态拼接——其后跟 + 而非 ,/)）
  for (const m of src.matchAll(/\btr\("([^"]+)"\s*[,)]/g)) used.add(m[1]!);
  // 动态族：tr("state." + …) 覆盖全部 TaskState + gone
  for (const s of ["starting", "running", "idle", "completed", "failed", "stopped", "orphaned", "parked", "gone"]) {
    used.add("state." + s);
  }
  const missing = [...used].filter((k) => !en.has(k) || !zh.has(k));
  assert.deepEqual(missing, [], "used keys missing from dictionaries");
});

test("i18n：设置界面与 cookie 持久化锚点齐备", () => {
  assert.ok(src.includes('id="settingsDialog"'), "settings dialog");
  assert.ok(src.includes('id="langSelect"'), "language selector");
  assert.ok(src.includes("omt_lang="), "cookie persistence");
  assert.ok(src.includes("navigator.language"), "browser language default");
});

// ---------------------------------------------------------------------------
// 安全门禁（审查 F3/F4）：hash CSP 与真实资产零漂移 + markup 零内联事件处理器

test("hash CSP 门禁：真实资产脚本块 sha256 与 http 层计算一致（漂移即红）", () => {
  const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, "单文件看板应恰有一个裸 <script> 块（hash CSP 逐块计算）");
  const hash = createHash("sha256").update(blocks[0]![1]!, "utf8").digest("base64");
  const csp = uiSecurityHeaders(UI_HTML)["content-security-policy"]!;
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`), "CSP script-src hash 与资产脚本不一致");
  assert.ok(!csp.includes("script-src 'unsafe-inline'"), "script-src 不得回退 unsafe-inline");
});

test("markup 零内联事件处理器（hash CSP 不覆盖 on* 属性——事件一律 addEventListener）", () => {
  const markup = src.split("<script>")[0]!;
  const m = markup.match(/\son[a-z]+\s*=/i);
  assert.equal(m, null, `inline event handler found: ${m?.[0]}`);
  // 关键 wiring 锚点：authBanner reload 按钮经 id 接线（原 onclick 已移除）
  assert.ok(src.includes('id="authReload"'), "authReload button");
  assert.ok(src.includes('$("authReload").addEventListener'), "authReload wired via addEventListener");
});

test("esc 纪律锚点：state/数值入 HTML 皆经 esc；connectUrl scheme 白名单", () => {
  assert.ok(src.includes("st-' + esc(t.state)"), "card class state escaped");
  assert.ok(src.includes('u.protocol !== "http:" && u.protocol !== "https:"'), "connectUrl scheme whitelist");
});
