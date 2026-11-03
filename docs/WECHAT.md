# Weave · 微信接入（agent-wechat）

[agent-wechat](https://github.com/thisnick/agent-wechat) 是第三方开源微信客户端（MIT），**不是腾讯官方接口**。它用一个真实微信号登录，可能违反微信的使用规则，账号有被限制的风险，目前没有可靠的风险数据。**只用新注册的小号，不要用主号。**

## 结构

```text
微信 ⇄ agent-wechat（wx serve，只听 127.0.0.1）⇄ hosted/wechat-bridge ⇄ Weave（只向外的 HTTPS）→ Agent 服务（Claude Agent SDK）
```

桥接程序不开放任何端口。电脑关机或休眠时微信不在线，开机后补收消息。

**试点怎么部署：** 在你自己的 Mac 上跑 wx 守护进程和桥接（两个 launchd 任务），步骤、验证、回退和该警惕的征兆都在 [`deploy/wechat-mac/README.md`](../deploy/wechat-mac/README.md)。下面「启动」一节是手动做法的原理。

**搬到服务器上（试点）：** 这两个程序也可以跑在网站所在的服务器上（两个容器，和 Azora 共用一台机器），你的 Mac 就不在链路里了；代价是小号收到的消息和图片都存在那台服务器上。步骤、退回 Mac 的办法，和隐私说明要补的话（草稿，待确认），在 [`deploy/tencent/wechat/README.md`](../deploy/tencent/wechat/README.md)。

## 谁来回答

微信消息由 Agent 回答，走和网页聊天同一条 Agent SDK 的路，开关是网站的 `WEAVE_AGENT_RUNTIME=sdk`（`deploy/tencent/setup-env.sh` 已经写进 `web.env`）。不开这个开关，微信消息还是走旧的直连模型的路。

| 谁发的 | 叫醒哪个范围 | 它能看到什么 |
| --- | --- | --- |
| 已绑定的人私聊 | 本人范围，通道是微信 | 这个人自己的空间和 Weave 工具（见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 第 6 节） |
| 开启了打卡群的群里 @ 助理 | 群范围，工作目录用群 id 的哈希命名 | 只有这个群：@ 它的那句话，以及这个群的消息记录（成员只显示「成员1」这样的编号）；看不到任何人的个人资料，也没有个人资料相关的工具 |

- 回复由 Agent 的最后一段话决定，Weave 把它排进发送队列，桥接再发出去。群里的回复 @ 提问的人。
- Agent 没跑完、超时、连不上，都当作「结果不确定」告诉提问的人，**不自动重试**（可能已经做了一部分）。服务忙或没起来（明确没开始跑）才说「没有处理」。
- 一条消息先「认领」（标记为处理中）再叫醒，所以两个定时任务同时跑也不会叫醒两次。「处理中」超过 10 分钟的当作中断，记为结果不确定，不重试。
- 一次定时任务最多约 150 秒（桥接 170 秒放弃，nginx 200 秒放弃）：开始后 60 秒内才会开始新的一条，没处理完的留给下一分钟。
- 关闭打卡群时，Agent 里这个群的工作目录一起删除，删不掉会每分钟重试直到服务确认。注销账号时，这个账号开启过的群的工作目录也一起删，删不掉就不注销。
- 群的消息记录交给 Agent 的方式是「调用前快照」，由 `groupSnapshotMessages`（`hosted/lib/weave/wechat.mjs`）提供数据，接线在快照分支里。

## 启动（手动做法）

1. 在 Weave 的环境变量里加上 `WECHAT_BRIDGE_TOKEN`（至少 32 字符）：

   ```sh
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. 安装并登录小号：

   ```sh
   npm install -g @agent-wechat/cli
   wx daemon start
   wx accounts create --alias weave
   wx auth login
   ```

   版本更新很快，建议固定版本（`@agent-wechat/cli@1.3.3`），测过再升级。

3. 创建只有收发权限的密钥，并记下账号 ID：

   ```sh
   wx accounts list
   wx tokens create weave-bridge --accounts ACCOUNT_ID --scopes read --scopes send
   ```

4. 配置并启动桥接：

   ```sh
   cd hosted/wechat-bridge
   cp .env.example .env   # 填 WEAVE_ORIGIN、WECHAT_BRIDGE_TOKEN、WX_TOKEN、WX_ACCOUNT
   npm start
   ```

## 每分钟要有东西触发定时任务

回复和到期提醒都由每分钟一次的定时任务生成。部署在 Cloudflare 上时 Cron 会自动触发，这一节可以跳过。

**用 `wrangler dev` 部署时 Cron 不会触发**（[官方文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)：「Local development does not run Cron Triggers automatically」），手动触发的 `/cdn-cgi/handler/scheduled` 也会报错，因为静态资源那层转发不了定时事件。

这种情况在桥接的 `.env` 里设 `WEAVE_TICK=1`，桥接就会每分钟调用一次 `/api/internal/wechat/tick`。不设的话，消息能收到，但永远不会有回复。**不要在 Cloudflare 上同时开启**，两边同时跑可能重复回复。

设了 `WEAVE_TICK=1` 的桥接不用干等这一分钟：网站对 `/api/internal/wechat/events` 的回答里会带 `wake: true`（刚排进队的消息要叫醒 Agent）或 `outbound: true`（刚排进队了要发出去的消息）。桥接看到 `wake: true` 就马上调用一次定时任务（同一时刻最多一个在跑，多来的合并成再跑一次）；定时任务一返回，或者看到 `outbound: true`，就马上取走要发的消息发出去。每分钟的定时任务和每 20 秒的取件照旧当兜底。旧的网站或旧的桥接不认识这两个字段，行为不变。

## 私聊

在 Weave 的 Channels 点击微信「连接」，用自己的微信给小号发送页面显示的 `绑定 <code>`。没有绑定的人发来的消息只留一个去重标记，不保存内容。

## 打卡群

把小号拉进群后：

| 在群里说 | 效果 |
| --- | --- |
| `@助理 开启打卡群` | 只有已绑定 Weave 的成员能开启。助理先在群里说明会读取消息 |
| 普通消息 | 加密保存为群聊记录，不调用模型 |
| `别记 ……` | 不保存 |
| `@助理 ……` | 助理依据群聊记录回复，并 @ 提问的人 |
| `@助理 关闭打卡群` | 任何成员都能关闭。停止读取并删除这个群的记录 |

规则：

- 没开启的群，消息到 Weave 后直接丢弃，不留任何记录。
- 群聊记录最多保存 50 条、14 天。模型只看到「成员1」这样的代号，看不到微信号或昵称。
- 回复只依据这个群的记录，不使用任何人的目标、反馈或 Notion，也不写入个人记忆。
- 模型费用由开启这个群的人承担。

## 验证

`npm test` 用假服务覆盖规则，[`scripts/agent-wechat-e2e`](../scripts/agent-wechat-e2e/README.md) 用真实 hub 和模拟微信跑通整条链路。**都没有连过真实微信。**

## 发送限速

agent-wechat 自己没有发送限速，微信风控能容忍多少也没有公开数据。所以桥接自己限制发出去的消息（可以用 `WECHAT_SEND_*` 环境变量改，见 `hosted/wechat-bridge/.env.example`）：

| 限制 | 默认 |
| --- | --- |
| 每个聊天每分钟 | 6 条 |
| 所有聊天每分钟 | 12 条 |
| 每天（滑动 24 小时） | 200 条 |
| 两条之间至少隔 | 1.5 秒 |
| 压在限速里超过多久就放弃 | 10 分钟 |

这些数字是保守的猜测。超出的消息留在队列里，租约（5 分钟）到期后桥接会再领一次；压了超过 10 分钟的报告为发送失败，不会隔很久才发出去。没有真正发给微信的尝试（没登录、守护进程不在）不占限额。限额在桥接进程里，重启会清零。

## 目前的限制

- 小号掉线时，消息留在队列里，重新登录后继续发送。需要重新扫码时看 `wx account status` 和桥接日志。
- 只处理文字消息。图片、语音和文件不会转发给 Weave。
- 桥接设了 `WEAVE_TICK=1` 时，消息一到就叫醒 Agent、回复一出就发送，延迟主要是 Agent 自己运行的时间；靠 Cloudflare Cron 触发时，回复仍然走每分钟一次的 Cron，加上 Agent 运行的时间，通常有一到两分钟延迟。
- 超过 6 小时的消息不补回复：私聊被忽略，群消息只作为上下文。
- 群成员不是 Weave 用户时，不知道谁是谁，只有代号。
