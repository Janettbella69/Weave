# Weave · 让我们的 Agent 一起行动

Weave 是一个帮人坚持习惯的个人 Agent。它记住你的目标和反馈，在合适的时候提醒你做一个小动作；涉及朋友时，帮你们约好时间，最后由两个人自己确认。

**线上地址：** <https://weave.azorashopping.site/>

## 现在的状态

这是一个早期项目。下面把能用的、没实测过的和还没有的分开写。

**代码和测试都有**

- **网页聊天：** 个人 Agent 依据你的目标、偏好和最近的反馈回答。
- **当天计划：** 运动、睡眠、饮食三个角色各提建议，再由协调步骤合成三个行动。确认后可以同步到 Notion。
- **朋友协作：** 用一次性链接加好友。散步、运动、学习或吃饭，每次单独授权共享时间，两人可用时间有重合时由模型选一个，双方本人确认后才进日程，可导出 `.ics`。
- **提醒：** 到期后进入网页通知和聊天。
- **后台主动判断（可选）：** 你开启并授权后，定期判断现在值不值得开口。证据不足就保持安静，每天最多发 1 到 3 条。
- **数据：** 可以导出和删除自己的账号数据。

**有代码，但没有实测过**

- **微信：** 通过第三方客户端 [agent-wechat](https://github.com/thisnick/agent-wechat) 接入私聊和打卡群。它**不是腾讯官方接口**，有账号风险。整条链路只在模拟微信上跑通过，没有连过真实微信，见 [`docs/WECHAT.md`](docs/WECHAT.md)。

**还没有**

- **习惯本身：** 还没有「习惯」和「完成记录」这两样数据，所以答不出「这周做了几次」，也算不出完成率。
- **真正的长期记忆：** 现在给模型的是最近 7 条反馈、最近 16 条消息和 Notion 页面的文字，没有筛选和归纳。
- **效果评测：** 测试验证的是规则对不对，不是建议好不好。
- **收费：** 还没有定价和付费功能。

## 工作原理

```text
网页 ──────────────┐
微信 ⇄ agent-wechat ⇄ 桥接 ──┤→ Weave 服务（业务规则 + D1 数据库）→ 模型（DeepSeek）
Notion ⇄ OAuth ────┘
```

| 目录 | 作用 |
| --- | --- |
| `hosted/app` | 页面和 API 路由 |
| `hosted/lib/weave` | 业务规则：授权、协商、提醒、微信队列 |
| `hosted/agent-service` | 用 Claude Agent SDK 调模型，关闭了全部工具 |
| `hosted/hermes-runner` | 用 Hermes 做后台主动判断，同样没有工具 |
| `hosted/wechat-bridge` | 和 agent-wechat 跑在同一台电脑上，只向外连接 Weave |

**模型只能提议，不能动手。** 协商、日程、账户设置和外部服务的改动，都要经过服务端校验和本人操作。模型调用失败或返回不合规的内容时，不会假装已经执行。

目前所有模型调用都不带工具，所以 Agent SDK 和 Hermes 这两层实际上都只调用一次模型。没有配置 Agent SDK 服务时，Worker 会直接请求 DeepSeek 的接口。

## 数据去哪了

- **Weave 的服务器：** 目标、偏好、聊天、计划和日程都存在数据库里，**没有加密**。不注册的访客也一样，Cookie 只用来认出你。
- **加密保存的：** 模型 Key、Notion Token、微信号，以及打卡群的聊天记录。
- **DeepSeek：** 你的消息和相关资料会发给它来生成回复。
- **Notion：** 只有你连接后才会读取你选的页面，确认过的计划才会写回去。
- **打卡群：** 没开启的群不留任何记录。开启后，群里的回复只看这个群的记录，不碰任何人的个人资料。规则见 [`docs/WECHAT.md`](docs/WECHAT.md)。

完整说明在网站的[隐私说明](https://weave.azorashopping.site/privacy)页面。

## 本机运行

需要 Node.js 22.13 以上，建议用 Node 24。

```sh
npm run product:install
npm run product:build
```

首次运行要初始化本地数据库并配置 `WEAVE_ENCRYPTION_KEY`，步骤见 [`hosted/README.md`](hosted/README.md)，之后用 `npm run dev` 启动。

根目录的 `server.mjs` 等文件是早期的本机演示，`npm run demo` 启动，和 `hosted/` 里的正式产品是两套代码。

## 测试

```sh
npm test                 # 业务规则、账号隔离、微信队列和桥接
npm run test:e2e         # 早期演示的 HTTP 流程
python3 -m unittest discover -s test -p 'hermes_runtime_test.py'
```

微信的端到端测试需要先编译 agent-wechat 的模拟器，见 [`scripts/agent-wechat-e2e`](scripts/agent-wechat-e2e/README.md)。

这些测试里的模型、Notion 和微信上游都是假的，通过测试不代表外部账号已经连通。

## 部署

`hosted/` 可以部署到 Sites 和 Cloudflare，配置见 [`hosted/README.md`](hosted/README.md)。线上站点跑在自己的服务器上，这部分部署文件还没有放进这个仓库。

部署时要注意：

- `WEAVE_ENCRYPTION_KEY` 丢失后，已保存的 Key 和 Token 都无法解密，请安全备份。
- 回复和提醒靠每分钟的 Cron 生成。`wrangler dev` 不会自动触发 Cron，要自己定时请求，见 [`docs/WECHAT.md`](docs/WECHAT.md)。
- 数据库访问每次都读取全部用户的数据，只适合早期规模。上线规模扩大前还需要索引、任务队列、负载测试和安全审计。
