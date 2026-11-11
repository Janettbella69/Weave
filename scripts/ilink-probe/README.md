# iLink 通道测试

实验，不是产品代码。看微信官方给 Agent 的私聊通道 iLink（腾讯给 OpenClaw 做的微信插件用的就是它）能不能当 Weave 私聊的底座。群聊不在这里测，群还是走小号。

## 要回答的三件事

1. **绑定能撑多久**：能不能撑过 72 小时、撑满一周，中间要不要重新扫码。小号那条路每次登录满 72 小时就被微信作废。
2. **用户多久不说话以后，主动发的消息就送不到了**：网上说是 24 小时，不是官方说法。
3. **用户发来的照片能不能拿到**，并解密成一个文件。

## 它做什么

- **扫码**：用要测试的那个微信扫一次码，程序拿到这个连接的钥匙。
- **收消息**：一直在线。每收到一条马上回一句：文字回「收到」，照片回解开了没有。
- **发测试**：从你最后一句话开始数，在第 1、3、6、12、18、22、24、26、30、36、48、60、72、96、120、144、168 小时各发一条「测试 #N：距你上次说话 X 小时。不用回。」你一说话就重新数。程序停过的话，错过的时间点不补发。
- **记录**：只记时间、消息类型、字数和服务器怎么回，不记消息内容。照片解开后存成文件，只为确认真的解得开。

## 协议从哪来

照腾讯官方插件 `@tencent-weixin/openclaw-weixin` 2.4.10（MIT）的写法，不装 OpenClaw：

- 扫码：`ilink/bot/get_bot_qrcode`、`ilink/bot/get_qrcode_status`（可能要输入手机上显示的数字）
- 收消息：`ilink/bot/getupdates` 长轮询；服务器说钥匙失效（-14）时停 1 小时再试，和插件一样
- 发消息：`ilink/bot/sendmessage`，带上最近一条消息给的 `context_token`
- 照片：从 CDN 下载，用 AES-128-ECB 解密
- 上线、下线：`ilink/bot/msg/notifystart`、`notifystop`

自报身份 `bot_agent` 照实写 `Weave-ilink-probe/0.1`。

## 在服务器上跑

在一个独立的小容器 `ilink-probe` 里跑，数据在卷 `ilink-probe-data` 里。不碰 weave、wechat、Azora 的任何容器。用的 Node 镜像和微信桥接是同一个，服务器上已经有了。

```bash
# 开始：还没连上就先画二维码让你扫，然后在后台跑。要在 Mac 的终端里用 ssh -t 跑，才显示得出二维码。
ssh -t <服务器> 'bash ~/ilink-probe/scripts/ilink-probe/start.sh'
# 看结果（只看，不改东西）
ssh <服务器> 'bash ~/ilink-probe/scripts/ilink-probe/status.sh'
# 停下：数据留着；加 --delete-data 连钥匙、记录、照片一起删
ssh <服务器> 'bash ~/ilink-probe/scripts/ilink-probe/stop.sh --delete-data'
```

## 测试期间要做的

1. 扫码连上以后：给它发一句话，再发一张照片。
2. 之后先别回它。可以把这个对话设成「消息免打扰」，不影响收消息。
3. 第 3 天、第 7 天各给它发一句话。
4. 结束时说一下手机上收到了哪几条「测试 #N」，截图也行。结果里写的「服务器收下了」不等于送到了。

## 数据

卷 `ilink-probe-data` 里：`account.json`（钥匙，权限 600）、`state.json`、`events.jsonl`（不含消息内容）、`photos/`（解开的照片）。`stop.sh --delete-data` 全部删掉。测完再删服务器上这份代码：`rm -rf ~/ilink-probe`。

## 测试

```bash
node --test scripts/ilink-probe/probe.test.mjs scripts/ilink-probe/scripts.test.mjs
```

用本机的假 iLink 服务器和假 docker，不连微信、不花钱。

## 还不知道的

- 连上以后，微信里这个对话叫什么名字、能不能改：扫码后看。
- 测完怎么在微信里解除这个连接：没查到。删掉服务器上的钥匙以后，程序就不能再收发了。
