# Weave 正式应用

采用 Sites 管理登录、Vinext/React 页面、Cloudflare Worker API 与 D1 数据库。每次请求从服务端登录上下文取得身份；不接受 `?person=` 切换账户。朋友只能通过一次性邀请建立关系，不能浏览全站账号目录。

## 本机开发

```sh
npm ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_aromatic_slapstick.sql
npm run dev
```

仅首次初始化空预览数据库时执行以上 SQL；后续迁移按编号追加，不重复应用已执行迁移。本机预览数据库独立于线上 D1。本机登录是 Sites 的开发模拟，不构成生产认证。

创建被 Git 忽略的 `.dev.vars`：

```text
WEAVE_ENCRYPTION_KEY=<64位十六进制随机密钥>
```

可使用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成。线上值通过 Sites 环境变量工具保存，不提交源码。**加密主密钥必须安全备份；丢失后已保存的用户模型/Notion密钥无法解密。**

## 模型与 SDK

默认模型 `deepseek-flash`，也支持 `deepseek-v4-pro`。用户在页面中填写自己的 DeepSeek Key，点击实际连接测试。Web 适配器使用 `https://api.deepseek.com/anthropic/v1/messages`。

启用 Claude Agent SDK：

1. 进入 `agent-service/`，执行 `npm ci`。
2. 设置至少32字符随机 `AGENT_SERVICE_TOKEN`，`npm start`；生产可使用该目录 Dockerfile，部署后须由 HTTPS 代理提供入口。
3. 网站设置 `AGENT_SERVICE_URL=https://<你的服务>` 与相同的 `AGENT_SERVICE_TOKEN`。
4. 运行 SDK 服务的 `/health` 检查，并在网站设置中执行真实模型连接测试，确认整个链路。

SDK 每次调用使用独立临时目录、独立配置目录和明确传入的 DeepSeek Key；`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`。不继承用户技能或项目配置，不开放文件或 shell 工具，不保存会话到磁盘。业务计划、协商记录与记忆由 D1 保存。运行服务不等于实际模型调用通过，需有有效 Key 与余额。

## 数据与并发

数据库保存按用户、协商、邀请和朋友关系分开的文档行。每次变更通过 D1 原子 batch 与提交版本检查写入。普通独立用户变更可合并；协商与个人安排使用严格版本检查，冲突返回409，让用户刷新重试，防止两项活动同时占用同一时间。

所有查询、修改、确认、计划同步、邀请撤销均在服务端检查归属/成员资格。跨站写请求被拒绝。写操作有持久化的每账号每分钟限额。模型/Notion凭据使用带用户ID附加认证数据的 AES-GCM 加密，状态与导出接口不返回密钥。

当前存储访问会读取文档集合，适合初期用户规模；大规模上线需要按参与者索引/分页、独立后台任务队列和负载测试。不是经外部安全审计或大流量压测的版本。

## Notion

每位用户在设置中配置自己的集成 Token 和父页面 ID，先向集成授权页面。读取页面用于本人习惯建议，不进入对外协商。已确认计划可手动同步。同步前先持久化发送状态，结果不明确时不自动重发，需先在 Notion 核对。

## 后台提醒

`worker/index.ts` 实现 `scheduled`，构建配置声明每分钟 Cron；读取 D1 并将到期提醒写入所属账号的通知与聊天。提交发生竞争时重试，已经投递的不重复执行。需要确认托管平台保留并启用 Worker Cron；若平台不支持，应使用外部计划任务调用受保护的任务入口。网页打开时也补发过期提醒。

当前提醒不是系统 Push、短信或微信送达。导出 .ics 也需用户导入自己的日历，不自动写入第三方账号。

## 发布

`.openai/hosting.json` 保存 Site ID 与 `DB` 绑定名，迁移在发布时应用。使用 Sites 的 source/package/save/deploy 工作流，保留站点身份。站点可公开登录，但所有个人 API 均要求认证且按账号授权。

发布不带模型 Key、不含个人数据、也不从旧版 Lulu/阿梦导入私人记录。用户分别连接自己的模型与 Notion。确认授权、取消活动和修改个人安排都会记录真实业务状态，不由模型直接写数据库。
