# Weave · Gewechat + Notion 接入

## 当前交付与外部依赖

代码实现了 Gewechat REST 客户端、消息回调、持久队列、两个指定用户的身份映射，以及个人 Agent、A2A 协商和 Notion 联动。**模拟验证通过不等于真实微信已连接。**

上游 https://github.com/Devo919/Gewechat 已停止维护，目前只有历史 Java 客户端，不提供完整服务端或可运行镜像。因此本项目不编造 Docker 安装命令，需要自行提供一个可用、兼容这些历史接口的服务。

核实过的源文件：

- `src/main/java/api/base/MessageApi.java`：`/message/postText`，字段 `appId/toWxid/content/ats`。
- `src/main/java/api/base/LoginApi.java`：`/tools/setCallback`、`/login/getLoginQrCode`、`/login/checkLogin`、`/login/checkOnline`。
- `src/main/java/util/OkhttpUtil.java`：`/v2/api` 路径、`X-GEWE-TOKEN`、成功条件 `ret=200`。

回调兼容历史 `TypeName/Appid/Data/Wxid` 和社区封装的 `type_name/appid/data/Wxid` 两种外层格式。仅处理 `AddMsg`、`MsgType=1` 的指定用户私聊；两个 wxid 分别映射到独立的 Lulu / 阿梦个人空间。字段结构需以实际服务回调再核对；尚未实机验证。

## 配置

复制 `.env.example` 为 `.env`，填写：

| 变量 | 含义 |
| --- | --- |
| `GEWECHAT_BASE_URL` | 完整 API 根地址，包含 `/v2/api`；远程必须 HTTPS，本机可用 HTTP |
| `GEWECHAT_TOKEN` | 服务分配的 Token |
| `GEWECHAT_APP_ID` | 机器人登录设备的 appId |
| `GEWECHAT_OWNER_WXID` | 映射到 Lulu 的用户 wxid，不是机器人自身 wxid |
| `GEWECHAT_FRIEND_WXID` | 可选，映射到阿梦的另一个用户 wxid，不能与 Lulu 相同 |
| `GEWECHAT_CALLBACK_SECRET` | 至少 24 字符的随机密钥，用于不可猜测的回调路径 |
| `GEWECHAT_PUBLIC_ORIGIN` | 只代理回调服务的 HTTPS 域名，如 `https://hook.example.com` |
| `GEWECHAT_WEBHOOK_HOST/PORT` | 默认 `127.0.0.1:4318` |
| `NOTION_TOKEN` | Notion integration token |
| `NOTION_PAGE_ID` | Lulu 的授权父页面 ID |
| `NOTION_FRIEND_PAGE_ID` | 阿梦的独立授权父页面 ID，未配置时不回退到 Lulu 页面 |
| `NOTION_FRIEND_TOKEN` | 可选，阿梦的独立 integration token |

密钥只保存在 `.env`。不要提交、发到聊天中或放在命令参数里。生成回调密钥可用：

```sh
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
```

本机 UI 固定只监听 `127.0.0.1`。微信入口为独立的 4318 端口，路径 `/webhooks/gewechat/<secret>`；反向代理仅转发这个入口，**不转发 4317 或 `/api/`**。路径密钥是应用自建的入口保护，不冒充 Gewechat 原生签名。代理应隐藏该路径的访问日志；对外做 HTTPS 和请求限流。若部署在容器中，需要明确设置回调监听地址，并由代理限制入口。

## 登录与注册回调

先运行配置检查（只显示配置是否存在，不显示 Token）：

```sh
npm run gewechat -- status
```

已有可用登录会话可跳过扫码：

```sh
npm run gewechat -- qr
```

二维码命令只输出登录相关 appId、uuid 和二维码字段；请在本机查看。将 appId、uuid 填入 `.env` 的 `GEWECHAT_APP_ID` 和 `GEWECHAT_LOGIN_UUID`，按服务要求扫码，并执行：

```sh
npm run gewechat -- login
npm run gewechat -- online
```

如登录需要验证码，可在本机 `.env` 填 `GEWECHAT_LOGIN_CODE`；不绕过验证。实际服务的响应字段若有不同，需要按返回格式调整客户端。

确认回调服务已启动、代理已配置，再主动注册回调：

```sh
npm run dev
# 另一个终端执行
npm run gewechat -- callback
```

应用启动不会自动修改 Gewechat 的回调配置。CLI 注册会影响该服务当前回调目标，请只对用于本项目的服务执行。

## 在微信中使用

1. 指定用户发送：“昨晚睡了 5 小时，今天很累，晚上和朋友聚餐”。
2. 机器人发送协调后的计划；默认有“规则演示”标识，配置模型后使用真实模型。
3. 回复“确认计划”，确认最近一份计划。
4. 回复“同步 Notion”，写入父页面下的新计划子页面。
5. 回复“反馈：午饭后散步更容易坚持”，存入本地；下一份计划同步时附带最近七条反馈。

每个微信用户与网页中对应的人物共享自己的个人空间，双方记忆隔离。配置两个映射后，可在微信发送“约阿梦散步”“授权协商 <编号>”“确认协商 <编号>”“同步协商 <编号>”；邀请、协商结果和双方确认会通过 Gewechat 通知对应用户。

支持最多两个预配置人物，不支持线上自助注册、群聊、语音、图片或自动加好友。到期提醒需要持续运行服务，按对应 wxid 推送。文字“确认计划”确认该用户最近一份习惯计划；网页卡片也可指定具体计划。

Notion 读取父页面顶层文字，以及最近七个标题以“Weave · ”或旧版“习惯议会 · ”开头的计划子页面，不递归读取其他任意页面。每次最多分页读取 500 个块；父页面过大时需要后续改为数据库索引。未授权或接口失败会返回明确错误，不伪造同步成功。

## 回调可靠性

- 先持久化接收事件，再快速确认回调；后台串行生成和发送回复。
- 用 appId、用户、消息 ID 去重，保留字符串形式的 64 位 ID；不把不安全整数当唯一 ID。
- `queued/processing/ready/sending/sent/uncertain` 状态保存在 `.data/state.json`，每次原子写入。
- 发送失败或超时的事件标记 `uncertain`，不会自动重发；需要人工核对 Gewechat 发送记录。Gewechat 没有在此处提供已核实的发送幂等键，不能保证跨进程故障的严格 exactly-once。
- Notion 写入在发送前记录状态，未确认结果的计划不会自动再次创建，避免因超时盲目写出重复页。
- 重启后继续 `queued/ready` 项；`processing/sending` 项转 `uncertain`，需要人工确认。
- 接收记录达到 5000 项后拒绝新事件（含通知和提醒的发送队列同样需要维护），需停服务、备份后维护历史记录；不要直接删除近期去重记录。
- 回调状态不会证明微信在线；CLI 的 `online` 才向外部服务查询。

## 验证

```sh
npm test
node scripts/smoke-gewechat.mjs
```

第二条使用临时目录和本机模拟 Gewechat，只验证 HTTP 回调、鉴权、去重、Agent、确认、反馈和发送契约；不接触真实微信或 Notion。
