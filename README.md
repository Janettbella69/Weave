# Weave · 让我们的 Agent 一起行动

Weave 是个人生活 Agent 产品：对内协调习惯计划，对外与朋友的 Agent 协商共同活动，再由双方本人确认。

[在线使用 Weave](https://weave-council.nicerowan1.chatgpt.site)

**正式版本位于 [`hosted/`](hosted/README.md)**。它使用真实登录身份与 Cloudflare D1 持久数据库，不再通过人物下拉框模拟两个用户。

## 使用流程

1. 使用 ChatGPT 账号登录，拥有独立个人空间。
2. 在设置中填写自己的 DeepSeek Key，并点击“测试实际连接”。密钥由服务端按用户加密保存，不进入浏览器状态或朋友的上下文。
3. 填写目标、偏好与未来可用时间。输入按设备时区换算保存，日程按个人显示时区呈现。
4. 生成一次性朋友邀请链接，朋友登录并明确接受后建立关系。
5. 发起散步、运动、学习或吃饭协作；双方分别授权本次时间共享后，两位 Agent 使用各自的模型连接提案、拒绝冲突、反提案。
6. 双方本人分别确认，活动才加入日程。支持取消活动、导出 `.ics`、账户提醒、个人反馈与个人数据导出。
7. 可选连接自己的 Notion 集成与页面；读取自己的记忆，手动同步已确认的习惯计划。

AI 模式使用 DeepSeek 的 **Anthropic 协议**，没有密钥、调用失败或模型返回非法方案时不会悄悄回退规则模拟。授权、时间约束、版本检查、冲突检测和最终确认由业务代码与数据库并发校验强制执行。

## Claude Agent SDK

[`hosted/agent-service/`](hosted/agent-service/) 提供独立 Node 服务，使用 `@anthropic-ai/claude-agent-sdk`，指向 `https://api.deepseek.com/anthropic`。每次调用使用独立临时目录，禁用 shell、文件工具和会话落盘。

托管网站运行于 Cloudflare Workers。SDK 的 CLI 子进程需部署到独立 Node 容器，再配置 `AGENT_SERVICE_URL` 和 `AGENT_SERVICE_TOKEN`；未配置该服务时，网站明确使用 DeepSeek Anthropic HTTP 适配器，不声称 SDK 服务已经在线。两者共用同一套业务授权与确认逻辑。

## 开发与验证

需要 Node.js 22.13+（建议 Node 24）。

```sh
npm run product:install
npm run dev
npm test
npm run test:e2e
npm run test:wechat
```

首次本地启动需按 [`hosted/README.md`](hosted/README.md) 初始化预览数据库。开发预览使用平台提供的本地登录模拟；线上登录由 Sites 管理，生产构建不包含本地身份切换。

测试覆盖实际 SQLite 事务下的用户隔离、一次性邀请、密钥加密、双方模型上下文隔离、独立确认、并发丢写与重复预约、Notion 幂等同步及提醒恢复。模型与 Notion 的自动化测试使用 HTTP 替身，真实可用性需在连接设置里实际验证。

## 提醒与部署

正式 Worker 声明每分钟 Cron，执行持久化到期提醒；网页在线时也会刷新并补发。提醒写入账户通知与聊天，**不等于网页关闭时的系统推送或微信消息**。生产 Cron 是否已由托管平台启用需要按部署说明验证。

部署、运行配置、数据保护及 SDK 服务见 [`hosted/README.md`](hosted/README.md)。旧 Gewechat 接口和本机双角色代码保留供兼容测试；`npm run demo` 启动它们，[归档说明](docs/LEGACY_DEMO.md) 与正式产品分开维护。
