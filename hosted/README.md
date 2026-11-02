# Weave 正式应用

采用 Sites 管理登录、Vinext/React 页面、Cloudflare Worker API 与 D1 数据库。每次请求从服务端登录上下文取得身份（访客 Cookie 或 ChatGPT Sites 头）；不接受 `?person=` 切换账户。朋友只能通过一次性邀请建立关系，不能浏览全站账号目录。

## 本机开发

```sh
npm ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_aromatic_slapstick.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_guest_sessions.sql
npm run dev
```

仅首次初始化空预览数据库时执行以上 SQL；后续迁移按编号追加，不重复应用已执行迁移。本机预览数据库独立于线上 D1。首页点击「直接开始」会写入 `weave_guest` HttpOnly Cookie 并在 D1 记录匿名会话 id；本机也可继续使用 Sites 的 ChatGPT 登录模拟（`/signin-with-chatgpt`），不构成生产认证。

创建被 Git 忽略的 `.dev.vars`：

```text
WEAVE_ENCRYPTION_KEY=<64位十六进制随机密钥>
```

可使用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成。线上值通过 Sites 环境变量工具保存，不提交源码。**加密主密钥必须安全备份；丢失后已保存的用户模型/Notion密钥无法解密。**

## 模型与 SDK

默认模型 `deepseek-flash`，也支持 `deepseek-v4-pro`。用户在页面中填写自己的 DeepSeek Key，点击实际连接测试。Weave 的正式 Agent 运行时是独立的 Claude Agent SDK 服务，DeepSeek 通过 Anthropic 兼容接口提供模型能力。

配置 Claude Agent SDK：

1. 进入 `agent-service/`，执行 `npm ci`。
2. 设置至少32字符随机 `AGENT_SERVICE_TOKEN`，`npm start`；生产可使用该目录 Dockerfile，部署后须由 HTTPS 代理提供入口。
3. 网站设置 `AGENT_SERVICE_URL=https://<你的服务>` 与相同的 `AGENT_SERVICE_TOKEN`。
4. 运行 SDK 服务的 `/health` 检查，并在网站设置中执行真实模型连接测试，确认整个链路。

SDK 每次调用使用独立临时目录、独立配置目录和明确传入的 DeepSeek Key；`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`。不继承用户技能或项目配置，不开放文件或 shell 工具，不保存会话到磁盘。业务计划、协商记录与记忆由 D1 保存。运行服务不等于实际模型调用通过，仍需有效 Key 与余额。

未配置 `AGENT_SERVICE_URL` 时，Worker 使用显式的 DeepSeek Anthropic HTTP 适配器作为本地和兼容回退；这条路径不改变业务授权和数据隔离。正式部署应配置 Agent SDK 服务，让网页聊天、习惯议会和朋友协商统一走 Claude Agent SDK。

Hermes runner 是独立的后台主动判断组件，不替代 Claude Agent SDK。它只在用户主动开启并授权后读取最小化的个人上下文，返回“保持安静、提出建议或跟进已有建议”的结构化判断；Weave 服务端再次校验事实、权限、冷却时间和每日预算后，才写入通知或微信队列。

## 数据与并发

数据库保存按用户、协商、邀请和朋友关系分开的文档行。每次变更通过 D1 原子 batch 与提交版本检查写入。普通独立用户变更可合并；协商与个人安排使用严格版本检查，冲突返回409，让用户刷新重试，防止两项活动同时占用同一时间。

所有查询、修改、确认、计划同步、邀请撤销均在服务端检查归属/成员资格。跨站写请求被拒绝。写操作有持久化的每账号每分钟限额。模型/Notion凭据使用带用户ID附加认证数据的 AES-GCM 加密，状态与导出接口不返回密钥。

当前存储访问会读取文档集合，适合初期用户规模；大规模上线需要按参与者索引/分页、独立后台任务队列和负载测试。不是经外部安全审计或大流量压测的版本。

## Notion

设置页的 Channels 只显示连接状态。用户点击“一键连接”后完成 Notion OAuth，再从已授权页面中选择一个作为长期记忆与计划归档页面；Token 只在服务端交换并加密保存，浏览器不会收到 Token、客户端密钥或内部地址。部署者将 OAuth 应用配置放在 Sites secret 中（`NOTION_OAUTH_CLIENT_ID`、`NOTION_OAUTH_CLIENT_SECRET`、`NOTION_OAUTH_REDIRECT_URI`），不放入前端或提交到 Git。读取页面用于本人习惯建议，不进入对外协商。已确认计划可手动同步；同步前先持久化发送状态，结果不明确时不自动重发，需先在 Notion 核对。

## 微信通道（agent-wechat）

Weave 的 Worker 不直接连微信。`hosted/wechat-bridge/` 和 [agent-wechat](https://github.com/thisnick/agent-wechat) 跑在同一台电脑上，只向外连接 Weave：把收到的文字消息发到 `/api/internal/wechat/events`，再从 `/api/internal/wechat/claim` 领取要发送的消息，用 `/api/internal/wechat/receipt` 回报结果。三个接口都用 `WECHAT_BRIDGE_TOKEN` 鉴权，这个密钥需要配置在 Sites 环境变量和桥接两边。

消息先写入 D1，由每分钟的 Cron 调用 Agent，再进入发送队列，所以回复通常有一到两分钟的延迟。桥接所在的电脑关机时微信不在线；恢复后，6 小时内的消息会补回复，更早的私聊被忽略，更早的群消息只保存为上下文。

登录 Weave 后进入“个人设置”里的 Channels，点击微信“连接”，再在自己的微信中发送页面显示的一次性 `绑定 <code>` 消息。之后微信消息进入该账号自己的 Personal Agent、反馈记录和 Notion 长期记忆；每个账号最多绑定一个微信身份，可随时断开。

微信提醒与网页提醒共用同一个账户提醒。没有配置桥接时，网页通知和聊天提醒仍然正常工作。安装步骤和打卡群规则见 [`docs/WECHAT.md`](../docs/WECHAT.md)。

## 后台提醒

`worker/index.ts` 实现 `scheduled`，`vite.config.ts` 声明 `* * * * *`，即每分钟执行一次。每次 Cron 会读取 D1：

- 投递到期账户提醒；
- 发送已绑定用户的微信提醒；
- 处理微信入站消息并发送 Agent 回复；
- 通过持久化队列避免重复发送；
- 发送或处理失败时保留 `uncertain` 状态，不盲目自动重试。

提交发生竞争时会重试，已经投递的提醒不会重复执行。部署后应在平台日志中确认 Cron 已触发；本地预览可用 Wrangler 的 scheduled 模拟验证。网页打开时也会补发过期提醒。

根目录的兼容服务 `server.mjs` 另有一个每秒轮询器，仅用于本地兼容模式；它不是正式 Worker 的调度频率。Hermes runner 独立每 30 秒轮询一次主动判断队列，模型是否介入仍由用户授权和服务端策略决定。

当前提醒不是系统 Push 或短信送达；运行微信桥接并完成绑定后可以通过微信文字送达。导出 .ics 仍需用户导入自己的日历，不自动写入第三方账号。

## 发布

`.openai/hosting.json` 保存 Site ID 与 `DB` 绑定名，迁移在发布时应用。使用 Sites 的 source/package/save/deploy 工作流，保留站点身份。站点可公开登录，但所有个人 API 均要求认证且按账号授权。

发布不带模型 Key、不含个人数据、也不从旧版 Lulu/阿梦导入私人记录。用户分别连接自己的模型与 Notion。确认授权、取消活动和修改个人安排都会记录真实业务状态，不由模型直接写数据库。
