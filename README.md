# Weave · 让我们的 Agent 一起行动

Weave 是一个个人生活 Agent：它记住你的目标、偏好和反馈，在合适的时候提醒你采取一个小行动；当活动涉及朋友时，双方的 Agent 可以先协商时间和方案，再由双方本人确认。

正式产品的 Agent 运行时由独立 Node 服务承载，底层使用 [`@anthropic-ai/claude-agent-sdk`](hosted/agent-service/)，通过 Anthropic 兼容协议连接 DeepSeek。Hermes 只负责获得用户授权后的后台主动判断，不是 Weave 对话和协商的主运行时。

**当前渠道：微信 + Notion**

- **微信**：通过可自托管的 Gewechat 兼容适配层接收私聊、生成回复和发送提醒。每个配置的微信用户绑定独立个人空间。
- **Notion**：作为个人长期记忆和计划归档。Weave 只读取你授权的页面，并把你确认过的计划按需写回你的页面。
- **网页**：正式版的账户、设置、朋友邀请、协商确认、提醒和数据导出入口。

[在线使用 Weave](https://weave-council.nicerowan1.chatgpt.site)

正式版本位于 [`hosted/`](hosted/README.md)，使用 Sites 管理登录身份和 Cloudflare D1 持久化数据。根目录的本机服务保留给兼容模式和本地微信测试；正式产品链路使用 `hosted/` 中的认证、Agent SDK 服务、D1 和 Gewechat 桥接。

## 能力概览

### 微信渠道

本项目的微信入口是独立的回调服务，不是官方微信 SDK，也不包含微信登录服务端。它适配历史 Gewechat REST 接口，支持：

- 指定微信用户的文字私聊回调、去重、排队和回复；
- 将每个 wxid 映射到自己的 Agent、计划、反馈和 Notion 页面；
- 在正式 Worker Cron 或本地服务中发送到期提醒；
- 通过“确认计划”“同步 Notion”“反馈：……”等文字完成常用操作。

Gewechat 上游已停止维护，需要自行提供兼容的服务、登录会话和 HTTPS 回调代理。当前适配器只处理预先配置的用户私聊，不支持群聊、语音、图片或自动加好友。模拟测试不会连接真实微信，真实在线状态必须由外部服务确认。详细配置见 [`docs/GEWECHAT.md`](docs/GEWECHAT.md) 和 [`docs/LEGACY_DEMO.md`](docs/LEGACY_DEMO.md)。

#### 正式 `hosted/` 微信回调

正式产品使用以下回调地址接入 Gewechat：

```text
/api/gewechat/callback/<GEWECHAT_CALLBACK_SECRET>
```

- 回调会校验密钥，只接受私聊文字，并按消息 ID 去重；
- 消息先写入 Cloudflare D1，再由 Worker Cron 处理，不在回调请求中直接调用 Agent；
- 登录用户在“个人设置”中注册/更新 Gewechat 回调，生成一次性绑定码，再从微信发送 `绑定 <code>` 完成绑定；
- 绑定后，微信消息进入该用户自己的 Personal Agent、反馈记录和 Notion 长期记忆；支持随时断开微信。

Worker 每分钟 Cron 会：

- 投递到期的账户提醒；
- 发送已绑定用户的微信提醒；
- 处理微信入站消息并发送 Agent 回复；
- 通过持久化队列避免重复发送；
- 发送或处理失败时保留 `uncertain` 状态，不盲目自动重试。

微信绑定、回调注册和正式环境变量见 [`hosted/README.md`](hosted/README.md)。

### Notion 渠道与长期记忆

Notion 连接按用户隔离。用户在 Channels 点击“一键连接”，完成 OAuth 后选择自己的页面；integration token 和 OAuth 配置只在服务端保存，不展示在前端。Weave 的长期记忆由几层组成：

1. 账户内的目标、偏好、可用时间和已确认日程；
2. 用户主动留下的聊天反馈和 check-in；
3. 授权 Notion 页面中的文字，以及最近的 Weave 计划页面；
4. 协作完成后由用户确认的计划和反馈。

生成建议时只抽取与当前任务相关的事实，不把 Notion 内容当作指令，也不会把一个用户的页面或密钥带入另一个用户的上下文。同步前必须先确认计划；写入结果不明确时不会盲目重试，以免创建重复页面。正式版支持按账户导出个人数据。

### 长期记忆与主动提醒：参考 Hermes Agent

主动提醒参考 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的个人 Agent 和后台判断思路，但 Weave 保留自己的数据授权和业务边界：

- 用户必须主动开启，并明确允许使用个人上下文进行后台判断；
- 可设置主动发现或持续目标、检查间隔、允许打扰时段、时区和每日消息上限；
- Hermes 只判断“现在是否值得介入”，没有证据时保持安静；建议会附带原因和证据来源；
- 建议只进入账户通知和聊天，用户可以接受、稍后处理、完成或 dismiss；不会因为模型输出自动发邀请、预约、确认协商或修改目标；
- 过期任务、重复建议、用户新输入和并发写入都会在服务端校验，避免发送过时或重复消息。

实现上，Cloudflare Worker 将到期任务放入 D1 队列，独立的 Node + Python runner 调用固定版本的 Hermes。runner 每次只接收一个用户的最小上下文和该用户自己的模型密钥，禁用 shell、文件、浏览器、网络、cron 和 Hermes 自带记忆工具；Hermes 返回结构化判断后，由 Weave 服务端重新校验证据、权限和业务状态。长期记忆仍由 Weave 的账户存储与用户授权的 Notion 管理，Hermes 不直接持久化用户记忆。对话、习惯议会和朋友协商则走 Claude Agent SDK 服务。

**提醒的送达边界**：正式版 Worker Cron 会把到期事项写入账户通知和聊天；配置 Gewechat 并完成个人绑定后，也会发送微信文字提醒。网页关闭时不会自动变成系统 Push 或短信。正式产品的微信回调、绑定和 Cron 队列配置见 [`hosted/README.md`](hosted/README.md)。

### 定时任务频率

- **正式产品 Cron**：Cloudflare Worker 使用 `* * * * *`，每分钟执行一次。它会投递到期账户提醒，并处理已绑定微信用户的消息和提醒队列。
- **本机兼容服务**：`server.mjs` 内置每秒一次的轮询，适合本地演示和兼容模式；服务停止后不会继续检查。
- **Hermes 主动判断**：独立 runner 每 30 秒轮询一次 D1 任务队列；真正的模型判断仍受用户授权、允许打扰时段、证据、冷却时间和每日预算限制。

一次性提醒可以在到期前取消；到期后只投递一次，并写入账户通知和聊天。配置并绑定 Gewechat 后，正式 Cron 会把这条提醒排入微信文字发送队列。

## 使用流程

1. 使用 ChatGPT 账号登录网页，或按文档配置一个微信用户。
2. 在 Channels 中一键连接 Personal Agent；如果部署使用托管 Agent，用户不需要填写模型密钥。已有用户密钥仍由服务端加密保存，不进入朋友的上下文。
3. 填写目标、偏好和未来可用时间；时间按个人时区显示，服务端按 UTC 保存。
4. 在 Channels 一键连接自己的 Notion，并选择长期记忆页面。
5. 可选开启 Hermes 主动提醒，选择允许打扰时段、检查间隔和提醒上限。
6. 发起散步、运动、学习或吃饭协作；双方 Agent 分别提出方案，双方本人分别确认后才会加入日程。
7. 在网页或微信中留下反馈；确认过的计划可以手动同步到自己的 Notion 页面。

AI 模式由 **Claude Agent SDK** 统一承载，DeepSeek 作为 Anthropic 兼容模型提供方。没有密钥、调用失败或模型返回非法方案时，不会悄悄回退成“已执行”的假结果。未配置独立 Agent SDK 服务时，Worker 仅使用显式的 DeepSeek Anthropic HTTP 适配器作为兼容回退；正式部署应配置 `AGENT_SERVICE_URL` 和 `AGENT_SERVICE_TOKEN`。时间约束、用户授权、冲突检测、版本检查和最终确认由业务代码与数据库并发校验强制执行。

## 本机开发

需要 Node.js 22.13+（建议 Node 24）。

```sh
npm run product:install
npm run product:build
npm test
npm run test:e2e
npm run test:wechat
```

启动兼容模式的本机网页和微信适配器：

```sh
cp .env.example .env
npm run demo
```

首次启动正式版本地预览，请按 [`hosted/README.md`](hosted/README.md) 初始化 D1 数据库；正式版依赖可用的 Sites 登录上下文、`WEAVE_ENCRYPTION_KEY` 和 Agent SDK 服务。Hermes runner 的安装、固定版本和部署配置也在该文档及 [`hosted/hermes-runner/`](hosted/hermes-runner/) 中说明。

常用验证命令：

```sh
npm test
python3 -m unittest discover -s test -p 'hermes_runtime_test.py'
npm run test:e2e
npm run test:wechat
```

测试中的模型、Notion 和 Gewechat 请求使用 HTTP 替身；它们验证接口契约和数据隔离，不代表外部账号已经在线。

## 配置与安全边界

- 本机配置写入被 Git 忽略的 `.env`；正式版配置写入托管平台环境变量，不能提交源码。
- `WEAVE_ENCRYPTION_KEY` 丢失后，已保存的 DeepSeek、Notion 密钥无法解密；请安全备份。
- Notion token、DeepSeek key、微信回调密钥和 Hermes runner token 不放入 URL、日志或命令参数。
- Gewechat 远程地址必须使用 HTTPS；回调入口应由反向代理单独暴露并限流，不要把本机 API 端口直接公开。
- 模型可以提出建议，但不能直接改变协商、日程、账户设置或外部服务状态；所有这些动作都需要服务端规则和用户操作。

## 当前限制

当前版本已经具备正式产品链路：登录与账户隔离、D1 持久化、Claude Agent SDK、微信和 Notion 渠道、双方确认协作、长期记忆与 Hermes 主动提醒。上线规模扩大前仍需要独立任务队列、按参与者索引、负载测试、生产 Cron 监控和外部安全审计。

部署、运行配置、数据保护、Hermes runner 和 Claude Agent SDK 见 [`hosted/README.md`](hosted/README.md)。
