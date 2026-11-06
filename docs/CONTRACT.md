# opencode HTTP API 契约实测结论

> 实测环境：opencode server v2.2.5，Basic auth（`opencode:<password>`，凭证取自
> `service.json`，此处不记录任何实例数据）。快照：`test/fixtures/openapi-*.json`。
> 复测脚本：`scripts/fetch-spec.ts`（快照）、`scripts/probe-synthetic.ts`（运行时语义）。

## synthetic 端点（`POST /api/session/{sessionID}/synthetic`）

| 实测项 | 结果 | 对本项目的影响 |
|---|---|---|
| `delivery:"queue"` | 200，响应 `data.delivery` 回显 `queue` | — |
| `delivery:"steer"` | 200，回显 `steer` | — |
| **省略 `delivery`** | 200，**服务端默认回显 `steer`** | **投递时必须显式传 `delivery`**：lifecycle 通知要求恒 `queue`，靠默认值会变成 steer |
| `resume:false` | 200，消息仅入 inbox | 服务端离线期通知可用 `resume:false` 先落对方收件箱 |
| 幂等 id 重放（同 id 二次 POST） | 200，**返回首次的响应**（相同 text / created 时间戳），不产生新消息 | 重试可安全携带相同 id，天然去重；pending 重投直接复用原 id |
| 缺 `text` 字段 | 400 `InvalidRequestError` `"Missing key\n at [\"text\"]"`，`kind:"Payload"` | — |
| `text:""`（空串） | **200（合法）** | schema 只要求字段存在；本项目信封恒非空，无影响 |
| `delivery:"bogus"` | 400 `InvalidRequestError` `"Expected Session.Inbox.Delivery"` | 枚举校验在服务端 |
| **自定义 `id` 非 `msg_` 前缀**（真机实测） | **400 `InvalidRequestError`**（spec：`Session.Message.ID` pattern `^msg_`） | **幂等 id 必须 `msg_` 前缀**（本项目用 `msg_omt_<taskId>_<seq>`）；裸 `omt-` 前缀被拒 |
| 不存在的 session | 404 `{"_tag":"SessionNotFoundError","sessionID":...}` | 降级链判据：`status===404` 或 `_tag==="SessionNotFoundError"` |
| 无鉴权 | 401 `UnauthorizedError` | 凭证失效的判据 |
| 409 Conflict | **正常路径未观测到** | 按可重试错误处理（同 5xx 退避重试） |

## 响应形状

```jsonc
// 200
{
  "data": {
    "id": "msg_...",            // 服务端生成（未传 id 时）；重放时回显首次 id
    "sessionID": "ses_...",
    "time": { "created": 1793814647599 },
    "type": "synthetic",
    "payload": { "text": "..." },
    "delivery": "queue" | "steer"
  }
}
```

## 配套端点

- `GET /api/session/{sessionID}/inbox` → 200 `{data: Synthetic[]}`（持久收件箱；**resume:false 的消息可见**；
  不带 resume（默认调度执行）的消息不留在 inbox——真机实测 inbox 为空，消息转入会话）
- `GET /api/session/{sessionID}/message` → 200 `{data: Message[]}`：**已调度执行的 synthetic 输入出现在此**，
  形状 `{ id: "<所传幂等id>", type: "synthetic", text: "<正文顶层字段>" }`——生产投递（不带 resume）的
  验收观察窗口；同时会实际触发 agent turn（assistant 消息），即本项目的"唤醒 agent"语义本身
- `POST /api/session`（`session.create`，body 可含 `title`）→ 200；`DELETE /api/session/{sessionID}`（`session.remove`）→ 204 —— probe 的隔离会话搭建/清理通道
- `GET /api/session/{sessionID}` → session 存活校验（任务创建 fail fast）

## 服务发现（opencode service.json）

| 事实 | 内容 |
|---|---|
| 发现文件 | `~/.local/state/opencode/service.json`（`$XDG_STATE_HOME` 尊重）：`{ id, version, url, pid, password }`，权限 600，随机端口 |
| **url/password 每次 service 重启都会变** | 注入前必须现读，不可缓存凭证 |
| 鉴权方式 | `Authorization: Basic base64("opencode:" + password)`；亦支持 `?auth_token=` query 参数。`GET /api/info` 返回 200 即凭证有效判据 |
| standalone 实测**不写 service.json** | `--standalone` 起私有服务（port 0 随机端口）但 state 目录无 service.json 产出，共享 service.json 不受影响。推论：白名单验证天然把注入目标限定为共享后台服务；standalone / `--server` 远程模式不受支持 |
| 配套端点 | `GET /api/session/:id/inbox`（持久收件箱）、`GET /api/event`（事件流，可监听 session 删除——后续增强预留）、`POST /api/session/:id/prompt`（本项目不使用）、`GET /api/session`（存活校验） |
| 调试工具 | `opencode api <operation-id>` 可直接对运行中服务发请求（如 `opencode api session.synthetic --param ... -d ...`） |
| spec 获取 | 运行中 server 的 `GET /openapi.json`（带 auth；`/doc` 是 Swagger UI 页面）。快照复取：`scripts/fetch-spec.ts` |

## npm SDK 使用事实（`@opencode-ai/sdk`）

| 事实 | 结论 |
|---|---|
| latest 与 dev 的 v2 client **均未生成** `session.synthetic` / `inbox` 方法 | SDK 生成滞后于 server——synthetic/inbox 按 spec 手写薄封装（`packages/server/src/opencode.ts`），SDK 补齐后一行切换 |
| **v2 client 须从子路径 `@opencode-ai/sdk/v2/client` 导入**，且走 `client.v2.session` 命名空间 | 包根入口是旧版风格客户端，顶层 `client.session` 无 `/api` 前缀，对 2.2.x server 请求不通 |
| 官方 server 文档确认 Basic auth 为文档化行为（`OPENCODE_SERVER_PASSWORD`，username 默认 `opencode`） | 鉴权方式官方支持 |
| client-only 构造：`createOpencodeClient({ baseUrl, fetch, throwOnError })` | 独立进程用法；fetch 可注入（测试） |

## synthetic 调度时序（真机实测）

**POST 200 ≠ 消息即时显现**。密集注入实验（同 session 快速连发 6 条 synthetic，幂等 id 各异）：

- 6 条 POST 全部即时 200（几 ms/条）
- 消息**经 opencode 串行 turn 调度后才出现在 message 列表**：每条 synthetic 触发一个真实
  agent turn（`assistant` + `idle` 消息成对出现），turn 串行排队、每 turn 一次 LLM 调用（秒级）
- 30s 后仅前 2 条已调度显现，其余 4 条仍在队列（无丢失——继续等待会消化）

对本项目的三点影响：

1. **投递成功判据以 synthetic 200 + 服务端 events 计数（meta）为权威**；会话侧"消息可见数"
   是调度行为，验收不作判据（lifecycle → 会话显现的链路由单 wake 场景完整验证）
2. **佐证令牌桶 / coalesce 的设计价值**：每条通知 = 一个 LLM turn，风暴合并 30→1 就是在省
   29 个 turn——通知预算同时是 turn 预算
3. **pending 重投的去重依据不变**：幂等 id 重放返回首次响应（上表），重投安全

## 版本下限结论

synthetic / inbox 为正式注册端点（OpenAPI 3.1，operationId `session.synthetic`）。
README 已声明要求 opencode ≥ 2.2；更低版本未实测，不做承诺。
