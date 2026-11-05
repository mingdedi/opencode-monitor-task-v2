# opencode HTTP API 契约实测结论（M0）

> 实测环境：opencode server v2.2.5，Basic auth（`opencode:<password>`，凭证取自
> `service.json`，此处不记录任何实例数据）。快照：`test/fixtures/openapi-*.json`。
> 复测脚本：`scripts/fetch-spec.ts`（快照）、`scripts/probe-synthetic.ts`（运行时语义）。

## synthetic 端点（`POST /api/session/{sessionID}/synthetic`）

| 实测项 | 结果 | 对 v2 实现的影响 |
|---|---|---|
| `delivery:"queue"` | 200，响应 `data.delivery` 回显 `queue` | — |
| `delivery:"steer"` | 200，回显 `steer` | — |
| **省略 `delivery`** | 200，**服务端默认回显 `steer`** | **投递时必须显式传 `delivery`**：lifecycle 通知要求恒 `queue`，靠默认值会变成 steer |
| `resume:false` | 200，消息仅入 inbox | 服务端离线期通知可用 `resume:false` 先落对方收件箱 |
| 幂等 id 重放（同 id 二次 POST） | 200，**返回首次的响应**（相同 text / created 时间戳），不产生新消息 | 重试可安全携带相同 id，天然去重；pending 重投直接复用原 id |
| 缺 `text` 字段 | 400 `InvalidRequestError` `"Missing key\n at [\"text\"]"`，`kind:"Payload"` | — |
| `text:""`（空串） | **200（合法）** | schema 只要求字段存在；v2 信封恒非空，无影响 |
| `delivery:"bogus"` | 400 `InvalidRequestError` `"Expected Session.Inbox.Delivery"` | 枚举校验在服务端 |
| **自定义 `id` 非 `msg_` 前缀**（阶段 D 真机实测） | **400 `InvalidRequestError`**（spec：`Session.Message.ID` pattern `^msg_`） | **幂等 id 必须 `msg_` 前缀**（v2 用 `msg_omt_<taskId>_<seq>`）；probe 当时用 `msg_omt_verify_*` 恰好合规，`omt-` 裸前缀被拒 |
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
  验收观察窗口；同时会实际触发 agent turn（assistant 消息），即 v2 的"唤醒 agent"语义本身
- `POST /api/session`（`session.create`，body 可含 `title`）→ 200；`DELETE /api/session/{sessionID}`（`session.remove`）→ 204 —— probe 的隔离会话搭建/清理通道
- `GET /api/session/{sessionID}` → session 存活校验（任务创建 fail fast）

## 版本下限结论（开放问题 §9-1）

synthetic / inbox 为正式注册端点（OpenAPI 3.1，operationId `session.synthetic`）。
v2 README 将声明要求 opencode ≥ 2.2；更低版本未实测，不做承诺。
