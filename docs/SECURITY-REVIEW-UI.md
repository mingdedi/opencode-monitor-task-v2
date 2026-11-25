# 安全审查：Web 看板变更集（2026-11-25）

> 范围：工作区未提交更改 —— `http.ts`（GET / + altPasswords + WWW-Authenticate）、
> `main.ts`/`opencode.ts`（密码现读注入）、`ui.html`/`ui-html.ts`/`gen-ui.mjs`（单文件看板）、
> `verify-ui.ts`/`ui-asset.test.ts`（验收与门禁）及配套文档。
> 方法：逐行代码审查 + 隔离 daemon 真机 PoC（XDG 隔离，用后即清）+ 浏览器行为文献核实。
> 本文档只记录结论，未改动任何代码。

## 总体结论

看板的客户端卫生做得相当好（esc()/textContent 纪律、CSP、无外部资源、无 eval），
"纯客户端零新增端点"的说法属实。但**鉴权机制从"插件专用密码"变成"浏览器 ambient
凭证"之后，CSRF 成为真实攻击面**——这是本次变更引入的最重要问题（F1，已 PoC 实证）。
其余为设计权衡与纵深防御项。

## 既有安全姿态（核实无误，予以保留）

- 监听 `127.0.0.1` 随机端口（main.ts:549），service.json 0600、state 目录 0700。
- daemon 密码 `randomBytes(32)` base64；`timingSafeEqual` 逐候选比较、不提前返回。
- 路由严格正则（`mon_[a-z0-9]+`）、tail 严格十进制、body 256KB 上限、JSON 解析围栏。
- 创建链路四层校验：参数 validate → 注册表白名单 → pid 活 → /api/info + session 存活。
- 看板响应头：CSP `default-src 'none'` + `connect-src 'self'` + `frame-ancestors 'self'`
  + `base-uri 'none'` + `form-action 'none'`、`no-store`、`nosniff`、`no-referrer`。
- 日志（被监控输出，不可信）走 `textContent`；任务字符串经 `esc()`；URL 里的 id 经
  `encodeURIComponent`；`target=_blank` 均带 `rel="noopener"`。
- 无 CORS 头（跨源读被浏览器拦截）；无 eval/new Function/外部资源。
- 任务 id 含 48bit 随机（`mon_` + 6 字节 hex），不可枚举。

## F1（高）CSRF：Basic auth 凭证跨站自动携带 + 服务端不校验 Content-Type

**机制**（三个条件全部成立）：

1. 浏览器对 Basic auth 凭证按 origin 缓存，**跨站请求同样自动携带**，无 SameSite
   之类的约束（MDN/OWASP 明确列为 CSRF 高危模式）。用户登录看板后，凭证常驻浏览器。
2. Chrome 的 Local Network Access 只拦子资源请求，**不拦顶层表单导航**——恶意页面
   自动提交 `<form method="POST" enctype="text/plain">` 到 loopback/内网地址依然畅通
   （Firefox/Safari 无 LNA，更不拦）。
3. 服务端 `readBody` 后直接 `JSON.parse`，**不看 Content-Type**。text/plain 表单可
   构造合法 JSON：单隐藏域 name=`{"kill_tasks":true,"x":"`、value=`"}` →
   body 为 `{"kill_tasks":true,"x":"="}`（`=` 落在字符串值内，多余字段被忽略）。

**真机 PoC**（隔离 daemon，源码形态，2026-11-25）：

```
POST /api/tasks   Content-Type: text/plain
body: {"command":"echo csrf-poc","opencode_port":1,"session_id":"ses_x","x":"="}
→ 400 PORT_NOT_IN_REGISTRY   ← body 被完整解析并进入业务层（拒绝来自白名单而非类型）

POST /api/shutdown  Content-Type: text/plain
body: {"kill_tasks":true,"x":"="}
→ 200 {"ok":true,"killed":0}  ← daemon 随即退出（health 连接拒绝）
```

两个 body 都是表单可逐字节构造的。即：**用户登录看板期间访问的任何网页，都可以
关闭 daemon 并击杀全部被监控任务进程组**，只需知道 host:port。

**影响分级**：

- `POST /api/shutdown`：无条件 DoS（空 body 的表单也行——空表单 POST 同样被接受）。
- `POST /api/tasks`：任意命令执行，但需额外知道注册端口 + 存活 session_id
  （跨源读不到列表，需带外获取；session id 会出现在 opencode web URL 里，可能经
  Referer 等渠道泄露）。
- `stop/keepalive`：需猜中 48bit 随机任务 id，风险低。

**现实约束与放大因素**：loopback 随机端口是减速带不是边界（导航计时可扫端口，
慢但可行）；而经 WireGuard 转发/固定端口部署时（本机运维惯例是按主机递增固定端口），
地址完全可预测，攻击直接成立。防火墙挡公网入站不挡此类攻击——请求由用户浏览器
从内部发出。

**修复建议**（兼容性已核实）：

- 全局规则：POST/PATCH 请求**若携带 Content-Type 则必须为 `application/json`**，
  否则 415。表单必带 form 系 content-type（空表单也带）→ 全部被拒；
  无 body 的 fetch/curl 不带该头 → 不受影响。
- 现有第一方客户端全部已发 `application/json`（shared/client.ts:58、ui.html api()、
  verify-ui.ts），零破坏；裸 `curl -d` 用户需补 `-H`（文档提一句）。
- 可再叠加 `Sec-Fetch-Site`/`Origin` 检查（cross-site 拒绝）作纵深。
- 注意：仅靠"要求 JSON body"不够——shutdown 接受空 body，必须按"头存在即校验"实现。

## F2（中，设计权衡）密码等价扩大了凭证爆炸半径

`altPasswords` 使**任一注册 opencode 实例的当前密码 = monitor API 全权**，包括
创建任务执行命令（directory 任意绝对路径，插件工作区守卫不适用——文档已明示）。

- 变更前：远程 opencode web 用户持 opencode 密码，但 monitor API 另有独立密码；
  变更后：opencode 密码直接兑换 daemon 宿主上的 shell，且不经 opencode 的权限询问。
  在 WireGuard 暴露 opencode 的部署里，这是实打实的权限扩张（信任域内可接受，
  但应知情）。
- `--opencode-state` 可注册其它信任域的 service.json——其密码同样兑换本 daemon 全权。
- ARCHITECTURE §15 "安全面不扩大"对端点成立，对**凭证集合**不成立，建议措辞补一句。
- 建议：altPasswords 做成显式开关（如 `--ui-alt-passwords`），或至少在 README
  安全段落写明"opencode 密码即 shell 执行权"。

## F3（低-中，纵深防御）两处 esc() 纪律漏网

UI 自述纪律"一切任务侧字符串经 esc()"，有两处例外：

1. **实例 chip 的 href 无 scheme 校验**（ui.html render()，~L904）：
   `esc(connectUrl(i.url))` 只防属性 breakout，不防 `javascript:` scheme。
   `new URL("javascript:…")` 解析成功、port 归一为 80，能通过 probeInstances 进入
   health 实例表 → 顶栏出现可点击的 XSS 链接。对比 `sessionUrl()` 有
   `/^https?:\/\//` 校验——同一数据源两套标准。
   数据源是注册 service.json（本地同用户可写），攻击者本已可用其密码直调 API，
   故为纵深项；修复：connectUrl 或 chip 渲染处统一限定 http(s)。
2. **`t.state` 未转义进入 class 属性**（cardHtml，~L964：`class="card st-' + t.state`）：
   state 正常是服务端枚举，但 `readMeta` 裸 `JSON.parse` 无运行时校验，
   StoredTaskView.toPublicInfo 直传 `meta.state`——被篡改的 meta.json（本地同用户）
   可注入任意字符串 breakout class 属性。修复：`esc(t.state)` 或 readMeta 处枚举白名单。

## F4（低，加固）CSP script-src 'unsafe-inline' 使 CSP 对 XSS 零防护

单文件内联脚本是静态的，可改用 **hash CSP**（`script-src 'sha256-…'`，gen-ui 时
计算注入），让 CSP 成为 esc() 之外的第二道闸。唯一内联事件处理器
`onclick="location.reload()"`（L285）改为 addEventListener 即可配合。
当前形态下任何 esc() 回归都直接执行，CSP 不兜底。

## F5（低）杂项

- API JSON 响应未带 `nosniff`（仅看板带）——建议全局加，成本一行。
- `altPasswords` 在**每个请求（含未鉴权）同步读文件**——未鉴权者可制造文件 I/O
  放大；建议先验 daemon 密码/有 Authorization 头再读 alt 文件。注册条目多时
  同步读也阻塞事件循环。
- 无鉴权失败日志/限速（loopback + 强随机密码下风险低，可留档不做）。
- `sessionUrl` 的 `btoa(url)` 遇非 ASCII url 抛错，而 `render()` 在 tick 的
  try/catch 之外 → 轮询渲染永久卡死（健壮性；url 来自 service.json，正常 ASCII）。
- Basic auth 明文 base64：loopback/WireGuard 内无碍；切勿置于纯 HTTP 反代之后。
  浏览器缓存凭证至关浏览器才清（无"登出"），共用机器需知悉。
- 404 反射 method+pathname 于 JSON 响应——content-type application/json，无 XSS，无需动。

## 部署事实核对

代码恒绑 `127.0.0.1` 随机端口——"防火墙不暴露公网"之外还有 loopback 绑定双保险。
远程访问必经隧道/转发；F1 的分析对浏览器实际使用的 origin（转发地址）同样成立，
且转发端口通常固定，比 loopback 随机端口更易被 CSRF 命中。

## 修复优先级

1. F1：Content-Type 强制（+可选 Sec-Fetch-Site）——一处围栏，兼容第一方全部客户端。
2. F2：altPasswords 显式开关或文档明示——产品决策。
3. F3/F4：esc(t.state)、chip scheme 校验、hash CSP——小改，纵深。
4. F5：nosniff 全局化、alt 密码懒读——顺手。

## 修复记录（2026-11-26，全部落地）

- **F1**：http.ts handle() 鉴权后双围栏——POST/PATCH 携带 Content-Type 必须
  `application/json`（参数容忍）否则 415 `UNSUPPORTED_MEDIA_TYPE`；
  `Sec-Fetch-Site: cross-site` 的 POST/PATCH/DELETE 一律 403 `CROSS_SITE_REJECTED`。
  实现比审查建议更严：fetch 对字符串 body 自动附 `text/plain` 头（undici 与浏览器
  同行为），故"无头放行"仅覆盖真正无 body 的调用。原 PoC 复测：构造 body 与空表单
  body 皆 415，合法 JSON shutdown 200。回归：http.test.ts 新增 415/403/放行矩阵、
  verify-ui ① 真机探针。
- **F2**：取"保留一把密钥默认 + 显式退出开关 + 文档明示"路线（保 verify-ui 实证的
  核心体验）：main.ts `--no-alt-passwords` 关闭凭证等价（真机实证：opencode 密码
  401、daemon 密码 200）；README Web dashboard 增"Credential equivalence is a
  real grant"段、Security notes 重写；ARCHITECTURE §4/§15 措辞修正（端点零新增、
  凭证集合有扩大）。
- **F3**：a) scheme 白名单双层——服务端 probeInstances/resolveTarget 拒非 http(s)
  条目（opencode.test.ts 新增 javascript:/data:/ftp: 回归）；客户端 connectUrl
  仅 http(s)、失败/坏 scheme 一律 null，chip 降级纯展示 span，fillInstanceOptions
  null 合并显示原 url。b) cardHtml 的 state/pid/计数器/opencode_port 全部 esc()
  （esc 纪律无例外）；ui-asset.test.ts 锚点门禁。
- **F4**：`uiSecurityHeaders(ui)` 导出——script-src 为脚本块 sha256 hash
  （createServer 时一次计算），无脚本 → 'none'；ui.html 移除 onclick 改
  `id="authReload"` + addEventListener；ui-asset.test.ts 双门禁（真实资产 hash
  漂移、markup 零 on* 属性）；verify-ui 真机判据。
- **F5**：send() 全响应 nosniff（含 204）；altPasswords 懒读（无头/非 Basic/daemon
  命中 → 零文件 I/O，http.test 计数回归）；sessionUrl 的 btoa 入 try/catch，
  异常降级无链接不卡死渲染。鉴权失败限速按审查结论留档不做（loopback + 强随机密码）。
- **验证**：typecheck ✔；npm test 332/332 ✔；build（gen-ui + esbuild）✔；
  verify-ui bundle 27/27 ✔、source 27/27 ✔；--no-alt-passwords 与原 PoC 复测 ✔。
- **遗留知悉项**（非代码缺陷）：Basic auth 明文 base64——勿置纯 HTTP 反代之后；
  浏览器凭证缓存至关浏览器才清（无登出）；404 JSON 反射 method/pathname 无 XSS。
