# 架构与设计

> opencode HTTP API 运行时契约见 [CONTRACT.md](CONTRACT.md)；插件契约见
> [PLUGIN-CONTRACT.md](PLUGIN-CONTRACT.md)。

## 1. 总体架构

独立守护服务端 + 薄插件：任务执行逻辑全部在**独立常驻服务端进程**（生命周期自主，
不随 opencode 重启 / 插件热重载而亡），opencode 插件退化为薄客户端（工具注册 + TUI）。

```
┌─────────────────────────────────┐        ┌──────────────────────────────────┐
│  opencode service 进程           │        │  monitor-task 服务端进程（独立守护）│
│                                 │        │                                  │
│  ┌───────────────────────────┐  │  ①任务  │  ┌────────────────────────────┐  │
│  │ 插件（薄）                 │──┼────────┼─►│ HTTP API（127.0.0.1 随机端口,│  │
│  │  · 3 个 MCP 工具           │  │  下达   │  │  Basic auth 鉴权）          │  │
│  │  · TUI 面板               │◄─┼────────┼──│  · 任务注册表 + 状态机       │  │
│  │  · 服务端发现/创建         │  │  ③状态  │  · 输出管线（清洗/过滤/合并） │  │
│  └───────────────────────────┘  │        │  · 文件即管道的执行器          │  │
│                                 │        │  · TaskStore（meta/log/exit）  │  │
│  session 会话 ◄─────────────────┼────────┼──┤  · reattach 恢复             │  │
│        ▲                        │        │  └────────────────────────────┘  │
│        │ ② POST synthetic      │        └────────────┼──────────────────────┘
│        │   (queue/steer)        │                     │ ④ spawn + 日志落盘
└────────┴────────────────────────┘                     │
                                              ~/.local/share/opencode-monitor-task/
                                                         tasks/<id>/
```

三条通信链路：

1. **任务下达**：agent 调插件工具 → 插件转发服务端 HTTP API（命令、正则规则、目的地凭证）
2. **通知注入**：服务端命中后直连 opencode HTTP API `POST /api/session/:id/synthetic`
   （queue/steer 两模式，经官方契约封装层）
3. **状态查询**：插件/TUI 直连服务端 HTTP API（TUI 按 session id 过滤）

## 2. 与 opencode 的交互边界

本项目对 opencode 的全部交互只使用官方公开的 HTTP API（OpenAPI spec 中注册的端点），
不依赖任何内部接口——内部接口没有稳定性承诺，版本升级时可能悄悄变形。

1. **通知注入走 HTTP**：服务端直接调用 `POST /api/session/:id/synthetic`；
   插件端不做任何注入。
2. **封装集中一处**：`@opencode-ai/sdk` 覆盖其已生成的方法；SDK 尚未生成的端点
   （synthetic / inbox）按 spec 手写，全部集中在 `packages/server/src/opencode.ts`，
   SDK 补齐后一行切换。
3. **契约防护**：仓库内存目标版本 spec 快照（`test/fixtures/openapi-*.json`），
   契约测试逐字段对照 payload；运行时语义实测结论见 [CONTRACT.md](CONTRACT.md)。
4. **唯一例外——TUI 侧边栏**：opencode 没有侧边栏的公开 API，源码级对接
   （`defineTuiPlugin`、`sidebar.content` 槽位）是唯一途径。该例外严格限定在展示层：
   TUI 代码不触碰任务执行与通知注入，面板失效的最坏结果只是"没有面板"，
   监控能力不受影响。

## 3. 服务端发现与创建（service.json 模式）

**唯一创建途径**：插件工具调用触发发现-创建流程（按需拉起是唯一生命周期，无 systemd /
开机自启）。不允许多服务端共存。

状态文件：`$XDG_STATE_HOME/opencode-monitor-task/service.json`（默认
`~/.local/state/opencode-monitor-task/`），权限 600，原子写（tmp + rename）：
`{ id, version, url, pid, password, started_at }`——与 opencode 自身的 service.json
模式完全同构（互为镜像）。

**发现流程**（`packages/plugin/src/server.ts` `ensureServer`，每次工具调用现跑）：

1. 读 service.json → 不存在 → 走创建
2. 存在 → `GET {url}/api/health`（Basic auth，1s 超时）
   - 200 且 version 兼容（major.minor 相等即复用，patch 兼容）→ 复用
   - 不可达 → 检查 pid（`kill(pid, 0)`）：死 → 清理 stale 文件后创建；
     活但不响应 → 报错并给出诊断（不盲目双开）
3. 创建：spawn 服务端（`detached: true` + `stdio: "ignore"` + `unref()`，自成进程组），
   轮询 health 就绪（上限 5s），超时报告 pid / server.log / service.json 路径——绝不静默
4. **创建竞态**（多插件实例同时拉起）：服务端启动时先原子抢锁（write-then-link，锁文件
   要么不存在要么内容完整）→ 再核对已有 service.json 的 health → 已有健康实例则
   退出码 0 退出。锁内容含 pid，死持锁者可抢

**运行时解析**（`packages/plugin/src/runtime.ts` `resolveRuntime`）——宿主是 bun 编译的
opencode 二进制（`process.execPath` 非 node），spawn 命令一律经探测链解析：

1. `OMT_SERVER_BIN`（完整命令，诊断/CI 用）→ 2. `OMT_NODE`（指定 node，仍校验 ≥20）→
3. PATH 上的 `node` ≥ 20 + 包内形态（`dist/server.mjs` bundle 优先，退
`packages/server/src/main.ts` + tsx 源码）→ 4. 全部失败 → 结构化诊断
（逐条尝试路径 + 宿主 PATH 原文）。

**退出语义**：SIGTERM/SIGINT → 默认**不杀任务**（任务自成进程组，文件即管道，下次启动
reattach）；仅 `--shutdown-all` 显式参数击杀全部任务进程组；`POST /api/shutdown`
可选 `kill_tasks`。

## 4. 服务端 HTTP API

鉴权统一 `Authorization: Basic base64("monitor:" + password)`，未授权 401 JSON
（timingSafeEqual 比较）。仅监听 `127.0.0.1` 随机端口。

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/health` | GET | 存活/版本/uptime/任务计数/reattach 结果/opencode 实例白名单（发现-创建判据） |
| `/api/tasks` | POST | 创建任务 → 201 + PublicInfo；body 256KB 上限（413） |
| `/api/tasks?session_id=` | GET | 任务列表（registry 与 TaskStore 合并视图；可按会话过滤） |
| `/api/tasks/:id` | GET | 任务详情（PublicInfo） |
| `/api/tasks/:id` | PATCH | 运行时调整（仅 `max_events`；未知字段 400；降额至 ≤已发送数立即即停） |
| `/api/tasks/:id/stop` | POST | 停止（SIGTERM 进程组 → 200ms → SIGKILL）；终态幂等 200；await 完成后返回终态快照 |
| `/api/tasks/:id/keepalive` | POST | idle → running 复活 + 重置计时器；终态 409 |
| `/api/tasks/:id` | DELETE | 立即清理终态记录与任务目录；运行中 409（提示先 stop） |
| `/api/tasks/:id/log?tail=N` | GET | 读日志尾部（tail ∈ [1,1000]，默认 20；另有 4MB 字节界） |
| `/api/shutdown` | POST | 优雅关闭（可选 `kill_tasks`，默认 false） |

## 5. 任务模型与持久化（文件即管道）

不区分 attached/detached——**所有任务统一为"文件即管道"**（所有任务共享同一套
持久化与恢复语义，无前后台模式之分）：

- spawn：`bash -c "<EXIT-trap wrapper>"`，detached 自成进程组，stdio 重定向到任务日志
  文件 fd，父侧立即 closeFd + unref
- wrapper 用 EXIT trap 把退出码写入 `exit` 文件（路径经 env 传递，零引号注入面；
  HUP/INT/TERM 信号 trap 归一为 128+N）；仅 SIGKILL 无法穿透 → `exit unknown`
- 任务目录：`$XDG_DATA_HOME/opencode-monitor-task/tasks/<mon_id>/`（目录 0700，文件 0600）

```
tasks/mon_xxxx/
├── meta.json     # 跨重启真相源（schema 版本化；每-pump 实时写）
├── log           # stdout+stderr 原始合并流（服务端是可离场的 tail 读者）
├── exit          # wrapper EXIT-trap 写入的退出码
└── pending.json  # 投递耗尽后落盘的通知（重投队列）
```

`meta.json` 关键字段：`schema / id / command / description / session_id`（通知目的地）/
`opencode_port`（目的地 opencode 实例端口，注册表索引键；**password 永不落盘**）/
`pid / pgid / proc_start_time`（/proc stat starttime，pid 复用防御）/ `started_at /
directory / pattern / wake_mode / delivery / coalesce_ms / max_events / idle_timeout_ms /
last_offset`（log 已消费字节 = 断点续读点，语义为末换行后字节——reattach 不拼残行）/
`lines_scanned / lines_matched / events_sent / events_dropped / state / exit_info /
grace_deadline`（idle 态 = 宽限截止 epoch ms，仅 idle 态非 null）/ `claimed_by`
（当前看护进程 pid，双认领防御）/ `updated_at`。

**进程管理三件套**：

1. `(pid, /proc/<pid>/stat starttime)` 双因子身份——pid 复用防御
2. `kill(pid, 0)` 探活 + `/proc` state 字母纠错（`Z` 僵尸按死、EPERM 按活）
3. EXIT-trap wrapper 记录退出码

## 6. 任务生命周期状态机

```
starting ──► running ◄──自愈── idle ──宽限期到仍无裁决──► stopped
    │            │  ▲           │
    │            │  └──新输出───┘（idle 裁决通知）
    │            ▼
    └──────► 终态：completed(exit 0) / failed(非零或信号) / stopped(人为/超限)
             orphaned（目的地 session 死亡，温和停止）
```

- `idle` 是**裁决暂停态**：进程仍活，静默仅触发裁决通知（§9）
- `parked`：meta 活态但看护资源故障（如 log 丢失），落盘入册、TUI 可见、可 DELETE——
  恢复失败显式可见，不留隐性失效
- 全部状态由**单一 250ms tick** 驱动（tail→管线→idle 到期→宽限检查→死活→收尾），
  不自持定时器
- 并发上限：每 session_id 最多 16 个存活任务（服务端内存态，不受客户端生命周期影响）；
  第 17 个 400 拒绝

## 7. 输出管线

```
tail 增量 chunk（持久 fd + readSync 250ms 轮询 + StringDecoder 多字节边界
  + 64KB 无换行软换行，兼容进度条 + 临终 flushPending 冲残行）
  → 按 \r\n|\r|\n 分行
  → cleanLine：ANSI CSI/OSC 剥离（单字符 ESC final byte + C0/C1 兜底）、trim、
    单行截断 2000 字符（带 …[truncated] 标记）、空行丢弃
  → preview 收集（尾 5 行，前置于 pattern 过滤）
  → pattern 过滤：命中 → matched++；未命中 → pattern 模式丢弃 / all 模式放行
  → coalesce（tumbling window，默认 500ms，0 关闭）：窗口内多条合并为 1 条通知
      （前 10 行、每行 200 字符、其余计数标注；pending 上限 1000 丢最旧）
  → max_events 天花板 (0,10000]，默认 50，达顶即停即杀
  → 令牌桶节流：突发 5 + 每秒 1，超限丢弃（计数，不缓存）
  → deliverChain（per-task Promise 串行链）保序投递
```

实测：过滤率 82–85.7%，30 行 ERROR 风暴 → 1 条通知，注入延迟 1–8ms。
max_events 即停即杀的触发点在**最后一条 wake 成功送达回调**（失败通知不占额）。

## 8. 通知信封（注入防护）

```
<task-notification>
[monitor mon_xxx · description]
正文（信封标签实体转义，防被监控输出伪造/终止信封）
</task-notification>
```

`</task-notification>` 等标签实体转义——被监控的外部输出无法伪造信封边界；
pattern 过滤双重收窄注入面与 token 消耗。

## 9. idle 两段式裁决

静默到期**不直接杀**：

1. `idle_timeout_ms`（默认 300s）静默 → 转 `idle`，发裁决通知（恒 queue、绕令牌桶、
   不计 max_events）：请 agent 决定 `keepalive`（保留）/ `stop`（立杀）/ 不动作
2. 宽限期（一个完整 `idle_timeout_ms` 窗口）内无决定 → 自动杀
3. 期间命令恢复输出 → 自愈回 `running` 并重武装计时器（任何输出都算活动，
   含被过滤/被节流的行）
4. 生命周期通知（退出/裁决）恒 queue、绕令牌桶、不计 max_events——退出结局必须到达 agent

## 10. 通知注入（服务端 → opencode session）

### 10.1 opencode 实例注册表（防串联白名单）

服务端维护**已注册 opencode 实例表**，注入目标必须是表内条目，否则拒绝
（`PORT_NOT_IN_REGISTRY`）：

- 默认条目：`$XDG_STATE_HOME/opencode/service.json`；启动参数 `--opencode-state <path>`
  可注册更多（多共享服务场景）
- 三层校验：端口命中白名单 → 条目 pid 活（`PID_DEAD`）→ `GET /api/info` 200
  （Basic auth 验证 password，`UNREACHABLE`）——模型幻觉编造的端口、被诱导指向的
  任意本地服务都会被 fail fast 拒绝
- 凭证永不落盘：meta 只存端口；password 每次投递前从对应 service.json 现读
  （opencode 重启后 url/password 都会变）

### 10.2 注入流程与降级链

```
命中产生
  → 按任务 meta 的 opencode_port 定位注册表条目 → 现读该 service.json
  → 校验 pid 活 + GET /api/info 200
  → POST /api/session/{session_id}/synthetic
      { id: "msg_omt_<epoch>_<taskId>_<seq>",   // msg_ 前缀为 spec 要求；epoch 防重启后 seq 复用
        text: "<信封>",
        delivery: "queue"|"steer" }              // delivery 恒显式传（缺省值为 steer）
  → 失败降级链：
      4xx/5xx 可重试错误 → 指数退避 500ms/2s/8s × 3
      → 仍失败 → 落盘 pending.json（60s 周期重投，FIFO 首败即停保序，
          幂等 id 复用天然去重）
      → 404 SessionNotFound → 任务标记 orphaned，温和停止，一次性报告
        （不无限重试死会话；无人接收通知的任务失去看护意义）
```

- **任务创建 fail fast**（先本地后网络）：session 16 上限 → 参数/命令校验 →
  白名单命中（400）→ `GET /api/session/:id` 存活（404 拒绝）→ directory 合法
- per-task `deliverChain` 串行链保证顺序（wake → 尾批 flush → lifecycle）
- opencode service 离线期间命令照常执行、日志照常落盘——重投时合并为摘要
  （缺席期间的行不逐行重放，同 reattach 语义）

## 11. 崩溃恢复（reattach 为必经路径）

服务端启动时扫描 `tasks/` 全部 meta.json（无工作区限制，全部认领）：

1. `(pid, starttime)` 双因子判死活：
   - 死 → 读 exit 文件收尾 → 向所属 session 补发**一条合并结局通知**
     （缺席增量摘要 + 结局，恒 queue 绕桶不计额）
   - 活 → 认领（写 `claimed_by`），构造 → absorbMissed（缺席行按正常管线计数/收集
     预览，不投递）→ emitReconnect 摘要通知——三步为同步原子序列，tick 不可能抢先
     逐行投递；tail 从 `last_offset` 续读
2. 缺席期间的行 → 一条摘要（N 行 / K 命中 / 尾部 5 行预览），**绝不逐行重放**
3. idle 计时冻结语义：无观察者不计时，重挂后从零武装
4. reattach 结果显式化：认领数/失败原因写入服务端日志与 health 响应；认领失败的
    任务标 `parked`，TUI 可见——恢复失败不静默
5. 坏 meta 且无 exit 文件的目录**保守不删**（防误删活任务）

## 12. 清理策略

| 层 | 机制 | 参数 |
|---|---|---|
| registry | 驱逐最旧终态（惰性触发于 add） | 上限 200 |
| TaskStore | sweeper 清终态目录；坏 meta 有 exit 佐证同 TTL，无 exit 永不清 | TTL 1h，启动必扫 + 每 10min |
| DELETE 端点 | 终态记录主动立即清理（模型清噪） | 仅终态，运行中 409 |
| pending 重投 | 60s 独立周期 | FIFO 保序，404 丢弃 |
| 服务端日志 | 单文件追加，不记命令全文（`DEBUG=1` 才详细） | health 暴露 log_bytes |

## 13. 代码结构

```
opencode-monitor-task-v2/            # monorepo（npm workspaces）
├── index.ts                         # 插件 server part 入口 shim（Plugin 下传）
├── tui.ts                           # TUI 入口 shim（jsx runtime 下传）
├── packages/
│   ├── shared/                      # 双端共享
│   │   ├── types.ts                 #   PublicInfo、CreateTaskInput、LIMITS 常量
│   │   ├── client.ts                #   服务端 HTTP 客户端（fetch + Basic auth，可注入）
│   │   ├── envelope.ts              #   通知信封构造与转义（纯函数）
│   │   ├── validate.ts              #   命令/参数校验（与服务端同规则）
│   │   ├── paths.ts                 #   XDG 路径单点（可注入）
│   │   └── ocservice.ts             #   opencode service.json 读取
│   ├── server/                      # 独立服务端（dist/server.mjs 的 bundle 源）
│   │   ├── main.ts                  #   入口：单实例锁、监听、service.json、信号、reattach
│   │   ├── http.ts                  #   路由/鉴权/JSON（node:http 自建，无框架）
│   │   ├── registry.ts              #   任务注册表（纯簿记，<300 行）
│   │   ├── monitor.ts               #   单任务状态机（单一 250ms tick）
│   │   ├── spawner.ts               #   bash wrapper / EXIT trap / 进程组 / 三件套
│   │   ├── tail.ts                  #   日志 tail（offset 断点语义）
│   │   ├── pipeline.ts              #   clean → match → coalesce → throttle（纯函数）
│   │   ├── deliver.ts               #   deliverChain 保序 + 重试 + pending 落盘
│   │   ├── opencode.ts              #   §2 官方契约封装层（SDK + synthetic/inbox 手写）
│   │   ├── taskstore.ts             #   meta/log/exit/pending 持久化 + 原子写
│   │   └── sweeper.ts               #   TTL 清理
│   └── plugin/                      # opencode 插件（薄）
│       ├── index.ts                 #   Plugin.define 组装 + 三工具注册
│       ├── tools.ts                 #   三工具 schema 与转发
│       ├── server.ts                #   ensureServer 发现-创建流程
│       └── runtime.ts               #   resolveRuntime 探测链
├── src/tui/                         # TUI 面板（读服务端 API，展示层豁免区）
├── test/                            # node:test + tsx（零 mock 框架，可注入 clock/fetch）
├── scripts/                         # verify-m* 验收 / storm-sim / probe / build
└── docs/                            # 契约实测与设计文档
```

模块约束：每模块单一职责可独立单测；状态用 discriminated union；registry 严禁包含
spawn/流处理/投递细节；投递失败逐级降级（synthetic → 重试 → pending 落盘；宁可拒绝
不可达 session 的通知，也不丢消息或静默失效）。

发布形态：esbuild --bundle 单文件 `dist/server.mjs`（SDK + workspace 全打包，运行时
需求收敛为 node ≥ 20）；开发期 tsx 源码直跑；两形态由 `resolveRuntime()` 单点切换，
全套 verify 脚本在两种形态下同判据跑（零漂移门禁）。

## 14. 设计动机：为什么是独立服务端

monitor 生命周期若绑在 opencode 插件进程上（插件会被热重载、随 service 重启），
任务进程、并发上限、通知链路都会随之漂移。将任务执行移入独立服务端后：任务与插件
生命周期零耦合；服务端不随 opencode 重启，恢复失败显式标 `parked` 可见；任务状态
落盘（meta/log/exit），磁盘即真相；对 opencode 的交互只走官方 HTTP API 并有
spec 快照契约测试；代码按单一职责模块拆分（discriminated union 状态）。
