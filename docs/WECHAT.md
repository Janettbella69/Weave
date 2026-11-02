# Weave · 微信接入（agent-wechat）

[agent-wechat](https://github.com/thisnick/agent-wechat) 是第三方开源微信客户端（MIT），**不是腾讯官方接口**。它用一个真实微信号登录，可能违反微信的使用规则，账号有被限制的风险，目前没有可靠的风险数据。**只用新注册的小号，不要用主号。**

## 结构

```text
微信 ⇄ agent-wechat（wx serve，127.0.0.1:6174）⇄ hosted/wechat-bridge ⇄ Weave（只向外的 HTTPS）
```

桥接程序不开放任何端口。电脑关机或休眠时微信不在线，开机后补收消息。

## 启动

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
- 模型费用由开启这个群的人承担，每个群每天最多回复 30 次。

## 目前的限制

- 小号掉线时，消息留在队列里，重新登录后继续发送。需要重新扫码时看 `wx account status` 和桥接日志。
- 只处理文字消息。图片、语音和文件不会转发给 Weave。
- 回复走每分钟一次的 Cron，通常有一到两分钟延迟。
- 超过 6 小时的消息不补回复：私聊被忽略，群消息只作为上下文。
- 群成员不是 Weave 用户时，不知道谁是谁，只有代号。
