# opencode 插件契约实测结论

> 范围：① bare import、② `ctx.tool.transform` 注册、③ execute context 形状、
> ④ 返回值/错误呈现、⑤ `context.sessionID`、⑥ 宿主运行时形状、⑦ GUI part 与 RPC 通道。
> 实测环境：opencode 2.2.5 共享服务宿主（①–⑥，2026-11）；
> opencode 2.4.0 共享服务宿主（⑦，2026-11-25）。
> 未经独立触发验证的子项在文中如实标注为未实测。

## ① bare import（server part 入口）

| 结论 | 内容 |
|---|---|
| 可解析 | 根 `index.ts` 顶层 `import { Plugin } from "@opencode/plugin"` 在宿主的 server part 入口扫描下解析成功——setup 得以执行、三工具得以注册 |
| 约束范围 | 宿主只对它实际扫描的入口文件解析 bare `@opencode/*` 说明符；import 链上其他文件一律不可解析（`@opentui/*` 在 tui 入口的同类实证） |
| 实现约束 | 插件目录内零 bare specifier（`node:` 内置除外）：`Plugin` 运行时值由根 `index.ts` 顶层 import 后作为参数下传 `packages/plugin/src/`；`@omt/shared` 全相对路径 import |

## ② 注册路径：`ctx.tool.transform` 为唯一路径

```ts
const reg = await ctx.tool.transform((editor) => {
  editor.add({ name, description, input: <JSON Schema>, execute })
})
// reg.dispose() 撤销注册
```

- **旧的 `tool()` helper 注册方式已不存在**（2026-11 官方 plugins 文档核对）。
- 三工具经此路径注册后**对模型可见可调**：真机验收（opencode 工具列表/日志）+
  真机冒烟三工具全链路；后续开发会话内三工具持续可见。
- 宿主 ctx 无 `tool.transform` 时 `registerTools` 返回 null 留痕跳过（无工具不拖垮宿主）。

## ③ execute context 形状

官方文档形状 `{ sessionID, messageID, agent, signal, progress }`；实测与实现用法：

| 字段 | 实测结论 | 实现用法 |
|---|---|---|
| `sessionID` | **存在**（见⑤） | `monitor` 目的地默认化锚点；缺席时要求显式传 `session_id` |
| `location.directory` | 存在（setup / execute 双源探测，execute 侧优先） | 工作区校验锚点；缺席跳过插件端校验，服务端绝对路径校验兜底 |
| `signal` | 文档形状，未在真机单独触发 Session 停止验证中止行为 | 存在时穿透到 fetch（AbortSignal 桥接，超时与取消并存，node 20.0 手动 addEventListener） |
| `messageID` / `agent` / `progress` | 未使用、未逐字段实测 | — |

防御式窄化：宿主 execute ctx 收窄为本地 `ToolContext`（sessionID / signal / directory），
字段缺失降级不抛错——宿主形状漂移的最坏结果是默认化/取消传播失效，而非工具崩溃。

## ④ 返回值与错误呈现

- `{ content: string }` 保守子集在真宿主工作：信封文本、PublicInfo JSON、日志尾部均以
  content 字符串到达模型。数组形状未使用（保守子集即足，未实测）。
- **可预期失败 → 结构化错误文本**：`error: ...\nhint: ...`（参数校验、服务端 4xx 透传、
  发现-创建诊断带 pid / service.json / server.log 路径）——实证到达模型
  （拒绝双开诊断场景）。
- **意外异常 → 重抛**（宿主转 Tool.Error，模型可见）：防御式路径，未在真机刻意触发。

## ⑤ `context.sessionID` 可用性

**存在，且为宿主权威的"当前 session"。**

- `monitor` 双缺省（不传 `session_id` / `opencode_port`）→ `info.session_id === ctx.sessionID`
  且唤醒信封到达该 session——断言固化。
- 首次真实"工具→服务端→通知→本 session"全链验收通过。

→ 目的地默认化成立：缺省 `session_id = ctx.sessionID`、
`opencode_port = 默认 service.json 端口`，显式传则按显式值。防幻觉的权威来源优于
要求模型抄写。

## ⑥ 宿主运行时形状

| 事实 | 实测依据 | 设计落点 |
|---|---|---|
| `process.execPath` = opencode 二进制（bun compile 单文件，非 node） | 2026-11-05 实测 | spawn 一律禁用 execPath；命令解析全走 `resolveRuntime()` 探测链 |
| 宿主内 `process.cwd()` 可能 = HOME 而非项目根 | kill -9 自愈场景真机实测：rootDir 默认 cwd 使冷启动 spawn 找不到服务端入口（复用路径一直掩盖该问题，已修复） | rootDir 由模块位置推导（`packages/plugin/src` → monorepo 根）；bundle 形态在入口 shim 显式注入 |
| 宿主 PATH 可能不含 node（fnm/nvm multishell 未继承） | 推断场景，未在真机复现（无 fnm 环境） | `resolveRuntime()` 探测链 + `OMT_NODE` / `OMT_SERVER_BIN` 逃生口 + 失败时 PATH 原文诊断 |
| 宿主 env 缺 XDG 变量 | 未观测到缺失；paths.ts HOME 回退为防御 | spawn 显式透传 env（此前曾存在注入 env 未透传到子进程的问题，已修复——服务端与插件须读写同一 state 目录） |

## ⑦ GUI part（gui-experimental）与 RPC 通道（v2.4.0 实测，2026-11-25）

> 结局：GUI part 已按用户决定整体回退（web 端不可用，见下表最后两行；代码零残留，
> 本表为实证记录，复用时按此重做）。RPC 实现亦随代码回退——结论保留，供未来
> Desktop/远程客户端接入时直接复用（无需重新踩坑）。

| 事实 | 实测依据 | 设计落点 |
|---|---|---|
| GUI 发现走**包子路径导出**：插件有 name（package.json）时解析 `<name>/gui-experimental`，必须声明 `exports["./gui-experimental"]`；根文件 `gui-experimental.cjs` fallback 只对无 name 目录生效 | 无 exports 时根 bundle 存在但 `features.gui` 缺席（`GET /api/plugin`）；补 exports 映射后 `gui: true`。二进制内发现逻辑字符串佐证（`Vb` resolver：`r.name ? t(["gui-experimental"]) : t(["gui-experimental.cjs","gui-experimental.js"])`） | exports 三映射：`"."→index.ts`、`"./tui"→tui.ts`、`"./gui-experimental"→gui-experimental.cjs` |
| 加 exports **不破坏** server/TUI 的既有发现 | 加映射后 `features.server/tui` 仍 true，三工具真机可调（monitor_server 复用 daemon 成功） | server/TUI 入口文件不动，零回归 |
| part 重解析发生在 **location 级重载**；config touch 热重载不够 | `touch opencode.json` 后 features 不变；`POST /api/location/reload` 后 `gui: true` | 开发循环：`vite build` → `opencode api post /api/location/reload` |
| bundle 经官方通道下发：`GET /api/plugin/gui?id=<pluginID>` → `{data:{code}}` | 真机取回 14.4KB bundle 全文（web/desktop 前端即经此通道加载） | GUI 必须是预构建单文件 CJS（`@opencode/plugin/gui/vite` preset；shared modules external） |
| `ctx.rpc.register` 可用；RPC HTTP 端点 `POST /api/rpc/{rpcID}/{method}`，请求体 **`{input:{…}}` 包装**，响应 `{output:{…}}` | 裸 `{}` → `rpc.invalid_input "Expected object"`；`{"input":{}}` → 正常输出 | server part 注册 MonitorRpc（snapshot/logTail/stop/keepalive/remove），GUI 经 `ctx.client.rpc` 调用 |
| RPC 输入校验生效（JSON Schema） | 上述 invalid_input 实证 | 契约纯数据单点 `packages/shared/src/rpc.ts`，两入口各自 `Rpc.define`（token 只携带 id+schema） |
| snapshot 只读发现语义与 TUI feed 同构 | daemon 未起 → `offline(pid-dead)`；工具拉起后 → `online` + 全量任务 | GUI 绝不 spawn daemon；按需拉起仍是工具调用专属 |
| GUI API 标记 **experimental**（导出名 `gui-experimental`），版本间可能变形 | 官方文档明示 | 本表结论锁定 v2.4.0；升级后先跑 hello-world 复核 |
| **web 模式不加载 GUI part**：仅 Desktop（Electron）窗口运行 `./gui-experimental`；web 构建的 platform 层无 plugins bridge，窗口从不请求 `/api/plugin/gui` | 真机日志：web 前端零次请求该端点；源码佐证 `packages/app/src/runtime/plugin/extension-plugins.tsx`（"other servers and the web list names"）+ `runtime/platform/web.ts`（无 plugins bridge） | web 场景走 daemon 自托管看板（独立页面）——**已实现**：`GET /` 单文件看板，见 ARCHITECTURE §15 与 `scripts/verify-ui.ts`；GUI part 路线仅保留给未来 Desktop 接入 |
| 浏览器侧渲染（pill/panel 上屏） | Desktop 未实测（本机未装）；web 已确证不加载——服务端链路（发现/下发/RPC）已全通 | 待 Desktop 真机验收补录 |

## 版本下限

插件契约（`Plugin.define` / `ctx.tool.transform` / execute context）以 opencode ≥ 2.2 为准，
与 docs/CONTRACT.md 版本下限结论、README Requirements 一致。
GUI part（⑦）以 opencode ≥ 2.4 为准（v2.4.0 实测；2.2.x 是否含 GUI 发现逻辑未实测）。
