# Weave · 让我们的 Agent 一起行动

Weave 是一个帮人坚持习惯的个人助理（Personal Agent）。你在网页或微信里跟它说话，它帮你把目标拆成每天的一小步，记下你做到没有，到点提醒你。朋友们可以把它拉进微信打卡群，在群里 @ 它。它记住的东西写在一个 `MEMORY.md` 文件里，你随时能看。

**线上地址：** <https://weave.azorashopping.site/>。现在是单用户部署（一个账号，进站要访问密码），多用户登录在后面的计划里。

## 现在能做什么

### 网页

宽屏是左边一列导航，手机是底部的标签栏。

| 页面 | 做什么 |
| --- | --- |
| 聊天 | 和 Weave 对话。每条消息叫醒一次 Agent，它自己决定要不要查数据、记一笔、设提醒，最后回你一段话 |
| 待办 | 今天要做的小习惯，点一下记成「做到了」，再点一下取消；下面是之后的提醒 |
| 目标 | 上面是「正在追踪」：每个目标一张卡，挂着每天的小习惯，显示这周做了几天和最近 7 天。下面是「创建一个目标」：从健康、人际关系、财务、事业、兴趣爱好、效率、其他七类里选一类，和 Weave 聊着拆成每天的一小步 |
| 记录 | 每个习惯一张月历（做到了 / 没做 / 还没开始），这个月做到几天、最长连续几天、连着错过两天几次，还有最近记下的几条 |
| 设置 | 所在地时间、连接器（Notion、微信）、导出数据、删除账号、隐私说明 |
| 助理主页 | 从 Weave 的头像或设置进入。「提醒」栏列出还没响的提醒，可以删；「记忆」栏显示 Weave 自己写的 `MEMORY.md` 原文，只读 |

### 微信

- **私聊：** 在设置里连接微信，用自己的微信把「绑定 + 码」发给 Weave 的小号。之后在微信里聊的就是同一个 Weave、同一份记录。
- **打卡群：** 把小号拉进群，已绑定 Weave 的成员说 `@助理 开启打卡群`，之后群里有人 @ 它，它就回答。它只看这个群的记录，看不到任何人的个人资料。群里的命令和规则见 [`docs/WECHAT.md`](docs/WECHAT.md)。

微信现在是试点，进度见下面的「连接器」。

## 它是怎么工作的

和 Claude Code 一样：一个 Agent、一个循环、按需调用工具。代码里没有流程图，也没有「用户说了 X 就走 Y」。完整设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

```text
网页 ──────────────────────────────┐
微信 ⇄ agent-wechat ⇄ 微信桥接 ─────┤
                                   ▼
      Weave 网站（hosted/）：页面、业务规则、数据库
         │  ▲
    叫醒 │  │ 取快照、调用 weave 工具（凭这一轮的通行证）
         ▼  │
      Agent 服务（hosted/agent-service/）：Claude Agent SDK，每轮一个一次性容器
         │
         ▼
      模型代理（换成真 Key、按 token 记账）──→ DeepSeek
```

### 一条消息的经过

1. 网站先存下你的消息，签一张只对这一轮有效的通行证（capability），然后叫醒 Agent 服务。
2. Agent 服务凭通行证向网站取数据，写成 SQLite 快照 `weave/weave.db`（目标、习惯、完成记录、提醒；群里是这个群的消息），再开一个一次性容器，跑 Claude Agent SDK 的 `query()`。
3. Agent 自己决定怎么做：写 SQL 查快照，用 Bash 跑代码，用技能（Skill），调 weave 工具记录或发消息，把学到的稳定事实写进 `MEMORY.md`。
4. weave 工具只是一层薄壳，规则都在网站后端（`hosted/lib/weave/agent-tools.mjs`）。同一次工具调用重放时，原样返回上次的结果，不会记两条、发两次。
5. Agent 的最后一段话就是回复。网站把它存下来；微信的回复排进发送队列，由桥接发出去。
6. 出错不自动重试，因为这一轮可能已经记过东西或发过消息。没拿到完整结果时，如实告诉你结果不确定。

### 两种范围（scope）

同一个 Agent，只有工具表不同（`hosted/agent-service/scopes.mjs`）。

| | 本人范围 | 打卡群范围 |
| --- | --- | --- |
| 什么时候醒 | 每个用户在网页或微信私聊里找它 | 开启了打卡群的群里有人 @ 它 |
| 看得到什么 | 这个用户自己的数据和工作目录 | 只有这个群的消息记录，成员只显示成「成员1」这样的编号 |
| 内置工具 | Bash、Read、Write、Edit、Glob、Grep、Skill、WebSearch | Bash、Read、Write、Edit、Glob、Grep、Skill |
| weave 工具 | `send_message`、`save_goal`、`save_habit`、`log_completion`、`set_reminder` | 只有 `send_message`，只能发回这个群 |
| 技能 | `weekly-review`（每周回顾） | 无 |

两种范围都不给 WebFetch 和子 Agent，Bash 没有网络。不在清单上的工具直接拒绝，不弹确认，因为这时没人在场。

### weave 工具

只有会写东西的工具，读数据一律查快照（教材 p.16「查数留SQL,不要封成MCP」）。

| 工具 | 做什么 | 后端的规则 |
| --- | --- | --- |
| `send_message` | 给本人发消息：这一轮来自微信就发到微信，来自网页就进网页通知；在群里只能发回这个群 | 收件人由通行证决定，模型选不了；1–700 字；没人找它的那几轮，遇到安静时段不发；每人每天最多 20 条；同一句话 24 小时内不重发 |
| `save_goal` | 新建或修改目标 | 七类之一；最多同时追踪 10 个，不追了就归档 |
| `save_habit` | 新建或修改习惯：名字、身份、触发时机、最小一步，可以挂在目标下 | 名字 1–30 字；最多 20 个；只能挂在还在追踪的目标上 |
| `log_completion` | 记一次「做到了」 | 同一个习惯同一天只记一条；日期按本人时区，不记未来的日子 |
| `set_reminder` | 设一个只响一次的提醒 | 1–500 字，必须是将来的时间 |

### 记忆和数据

- 每个用户（和每个打卡群）在 Agent 服务里有自己的工作目录：`MEMORY.md`、笔记、脚本，加上当天的会话。`MEMORY.md` 每次醒来都放进系统提示，Agent 学到稳定的事实就自己改它。同一个当地日期接着用同一段会话，第二天开新的，靠 `MEMORY.md` 带过去。
- 目标、习惯、完成记录、提醒和聊天存在网站的数据库里，网页显示的就是这一份。Agent 读的是叫醒前的快照，写只能走 weave 工具。快照每轮整个重建，在容器里只读，Agent 在里面改的东西带不到下一轮。

### 护栏

- 不设轮数上限（教材 p.22、p.26）。兜底是费用熔断和每轮 10 分钟超时。费用熔断用的是 `maxBudgetUsd`：本人范围 $2、群 $1，按 SDK 估的价格算，不是实付。
- 容器里的 CLI 只拿到一个一轮一换的运行令牌。真的模型 Key 只在模型代理里，Agent 读不到。
- 模型代理按 token 记账：每个账号每天 40 万、全站每天 600 万（草稿数字，环境变量 `AGENT_DAILY_TOKENS_*`）。用完返回 429，这一轮马上结束。
- 同一个人的消息排队，一条一条处理；线上服务器同时只跑 1 轮。

### 模型

DeepSeek，默认 `deepseek-flash`，也支持 `deepseek-v4-pro`，走 DeepSeek 的 Anthropic 兼容接口。Agent 服务的模型表里还有 Kimi、GLM、千问（都是 Anthropic 格式接口，还没用真 Key 跑过），网站现在只用 DeepSeek。

## 连接器（持续更新）

连接器会一直加、一直更新。给 Agent 用的外部服务（比如 Notion）都按同一个办法接：钥匙只留在网站后端，Agent 拿到的是一层薄壳工具，规则在后端（[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 第 4 节）。

| 连接器 | 现在 | 接下来 |
| --- | --- | --- |
| 微信私聊 | 2026-11-03 起在真实微信上试点，绑定和回复都跑通了。小号常驻在另一部手机上，wx 守护进程和桥接跑在 Mac 上（[`deploy/wechat-mac`](deploy/wechat-mac/README.md)） | 把 wx 守护进程和桥接搬到服务器，用户的消息和图片不放在个人电脑上 |
| 微信打卡群 | 开启后 @ 它就回答。群消息加密保存，最多 50 条、14 天 | 看图：@ 它时带上同一个人刚发的照片（草稿 PR [#33](https://github.com/Janettbella69/Weave/pull/33)） |
| Notion | 设置里一键连接：在 Notion 自己的页面选择器里勾选页面，回来就连好了。Weave 只用你勾选的页面，授权令牌只在网站后端解密 | 接进 Agent：一个 Notion MCP，三个动作，搜索、把页面读成 markdown、在页面末尾追加。每个用户只在自己的私聊里用，只读写自己勾选的页面；读回来的内容按不可信数据处理。底层的读和追加已经在 `hosted/lib/weave/notion.mjs` 里 |

微信走的是 [agent-wechat](https://github.com/thisnick/agent-wechat)，第三方开源客户端，**不是腾讯官方接口**。它用一个真实的微信号登录，有被限制的风险，所以只用小号。细节和发送限速见 [`docs/WECHAT.md`](docs/WECHAT.md)。

## 接下来

- **主动来找你**（草稿 PR [#35](https://github.com/Janettbella69/Weave/pull/35)）：重复提醒、Weave 自己排的跟进、按档位定期来看看你；要不要主动开口，先由决策模型 Jev 判断；聊天右侧加一个 Weave 面板。现在 Weave 只在你交代的时间提醒你一次。
- **连接器**：微信搬到服务器、看图、Notion 接进 Agent（见上）。
- **多用户登录**：每个人有自己的账号和空间。
- **深度研究（Deep Research）**：唯一会开子 Agent 的场景（ARCHITECTURE 第 8 节）。
- **删掉旧路径**（见文末「旧代码」）。
- **评测**：从真实对话攒评测集，人工判对错：该不该开口、记得对不对、有没有泄露、有没有说没做的事。现在的测试验证的是规则对不对，不是建议好不好。

## 数据和隐私

- **网站的数据库：** 目标、习惯、完成记录、提醒和聊天都存在这里，**没有加密**。
- **加密保存的：** 模型 Key、Notion 授权令牌、微信号、打卡群的消息记录（AES-GCM）。
- **Agent 服务：** 每个用户一个工作目录（`MEMORY.md`、笔记、当天的会话），在服务器上。
- **DeepSeek：** 你的消息、`MEMORY.md` 和这一轮查到的数据，会发给它来生成回复。
- **导出和删除：** 设置里能导出你在网站里的数据。删除账号会先删掉 Agent 的工作目录（包括你开启过的打卡群的），删不掉就不注销。

完整说明在网站的[隐私说明](https://weave.azorashopping.site/privacy)页面。

## 目录

| 目录 | 作用 |
| --- | --- |
| `hosted/app` | 页面和 API 路由；新界面在 `hosted/app/workspace` |
| `hosted/lib/weave` | 业务规则：工具后端、快照、叫醒、通行证、目标和习惯、提醒、微信队列、Notion 连接 |
| `hosted/agent-service` | Agent 服务：全仓库唯一调用 Claude Agent SDK `query()` 的地方（[说明](hosted/agent-service/README.md)） |
| `hosted/wechat-bridge` | 微信桥接：和 agent-wechat 跑在同一台电脑上，只向外连接 Weave |
| `hosted/worker` | Worker 入口：访问密码、定时任务 |
| `deploy/tencent` | 线上部署：docker compose，网站 + Agent 服务 |
| `deploy/wechat-mac` | 微信试点：在 Mac 上跑 wx 守护进程和桥接 |
| `scripts` | SDK 探针、微信端到端、Notion 授权端到端 |
| `docs` | 架构、微信、设计稿和实施计划（`docs/superpowers`） |
| `test` | 根目录的测试 |

## 本机运行

需要 Node.js 22.13 以上（Agent 服务的镜像用 Node 24）。

**1. 网站**

```sh
npm run product:install   # 装 hosted/ 的依赖
npm run product:build
```

第一次要初始化本地数据库，并在被 Git 忽略的 `hosted/.dev.vars` 里写 `WEAVE_ENCRYPTION_KEY`，步骤见 [`hosted/README.md`](hosted/README.md)。之后 `npm run dev`，打开后点「直接开始」，用访客身份进去。

**2. Agent 服务**（聊天要用）

```sh
cd hosted/agent-service
npm ci
cp .env.example .env
npm start
```

`.env` 里至少填 `AGENT_SERVICE_TOKEN`（32 位以上）、`DEEPSEEK_API_KEY`、`WEAVE_API_URL`（本机网站的地址）。没有 Docker 就设 `AGENT_ISOLATION=local`，只用于本机开发；用 Docker 要先建镜像，见 [`hosted/agent-service/README.md`](hosted/agent-service/README.md)。

再在 `hosted/.dev.vars` 里加上：

```text
WEAVE_AGENT_RUNTIME=sdk
AGENT_SERVICE_URL=http://127.0.0.1:4320
AGENT_SERVICE_TOKEN=<和 Agent 服务的一样>
```

## 测试

```sh
npm test                                   # 根目录：业务规则、工具后端、快照、微信队列和桥接、前端逻辑
npm --prefix hosted/agent-service ci
npm --prefix hosted/agent-service test     # Agent 服务契约测试：本地假模型，不要 Key；容器那组没有 Docker 会跳过
node scripts/agent-sdk-probe/probe.mjs     # SDK 探针：43 项，本地假模型
npm run test:e2e                           # 旧演示的 HTTP 流程
```

CI（`.github/workflows`）在每个 PR 上跑这些，另外还跑：容器契约测试（容器里没有网络、读不到真 Key）、部署冒烟（用测试配置把 compose 起起来）、旧的 Hermes 适配测试、类型检查和生产构建。

测试里的模型、Notion 和微信上游都是假的，通过测试不代表外部账号已经连通。用真 DeepSeek 跑一次冒烟见 [`scripts/agent-sdk-probe`](scripts/agent-sdk-probe/README.md) 的 `real-smoke.mjs`，要真 Key，会花一点钱。

## 部署

线上跑在一台腾讯云服务器上，和 Azora 共用。docker compose 项目 `weave` 里有两个服务：

- **`web`（网站）：** 容器里用 `wrangler dev` 跑 Worker，数据库在 Docker 卷里。端口只绑在 Docker 的内部网卡上，外网连不到，由 Azora 的 nginx 转发 `weave.azorashopping.site`。整站有访问密码（`WEAVE_BASIC_AUTH`），内部接口用各自的令牌鉴权。带看门狗：每 10 秒查一次，网站连续 3 次不回答，就让容器重启。
- **`agent`（Agent 服务）：** 通过 Docker 给每一轮开一个一次性容器（镜像 `weave-agent:0.3.316`），每个人的工作目录在宿主机上。

第一次部署、更新、回退、内存和排错，见 [`deploy/tencent/README.md`](deploy/tencent/README.md)。

要注意：

- **`WEAVE_ENCRYPTION_KEY` 要备份**（在 `web.env` 里）。丢了，之前存的 Key 和令牌都解不开。
- **`wrangler dev` 不跑 Cloudflare 的定时任务（Cron）。** 到点提醒和处理微信消息，现在靠微信桥接每分钟调一次 `/api/internal/wechat/tick`（桥接设 `WEAVE_TICK=1`）。网页开着时，每次请求也会把到点的提醒送进聊天和通知。
- **数据库每次读取全部用户的数据**，只适合早期规模。
- **连接器要另外配。** `setup-env.sh` 不写这几项：Notion 要在 `web.env` 里加 `NOTION_OAUTH_CLIENT_ID`、`NOTION_OAUTH_CLIENT_SECRET`、`NOTION_PUBLIC_ORIGIN`，并在 Notion 的集成里登记回调地址 `<站点>/api/connections/notion/callback`（见 [`hosted/README.md`](hosted/README.md) 的 Notion 一节）；微信的桥接令牌由 Mac 上的 `deploy/wechat-mac/set-token.sh` 通过 `deploy/tencent/set-wechat-token.sh` 写进去。

`hosted/` 也能发布到 Sites / Cloudflare，那里定时任务会自动触发，见 [`hosted/README.md`](hosted/README.md)。

## 旧代码（会删）

- 不设 `WEAVE_AGENT_RUNTIME=sdk` 时，网页聊天和微信走旧路径：直连模型的 `chatFor`、三个角色合成的当天计划（`habitCouncil`）、模型参与的朋友协商、Hermes 后台判断（`hosted/hermes-runner`）。线上已经设了 `sdk`，新界面上也没有这些入口。按 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 第 11 节会删掉。
- 根目录的 `server.mjs`、`council.mjs` 等文件和 `public/` 是黑客松时期的本机演示（`npm run demo`，见 [`docs/DEMO.md`](docs/DEMO.md)），和 `hosted/` 是两套代码。

## 参与开发

仓库规则在 [`AGENTS.md`](AGENTS.md)，Claude Code 和 Codex 都按它来：

- Agent 相关的设计和改动，以《Agent Harness 教材》为原则，先引教材原文和页码，再下结论。
- 开发 Agent 功能前，先查 [Claude Agent SDK 的文档](https://code.claude.com/docs/en/agent-sdk/overview.md)。
