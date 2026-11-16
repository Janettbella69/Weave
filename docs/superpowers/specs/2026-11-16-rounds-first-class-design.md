# 第二步设计：把「一轮」做成一等公民

状态：草稿（2026-11-16），只出设计，不含实现。分支 `docs/rounds-first-class-design`。
这是三步重建的第二步。第一步「换底座」（Node + SQLite + 每天备份）在分支 `docs/base-node-sqlite-design` 上写，写这份时还没有内容，所以下面对第一步只做了最小假设，见 3.3。
依据：2026-11-04 全代码审查（`01-channels.md`、`02-brain.md`），《Agent Harness 教材》，Claude Agent SDK 官方文档（用 `curl` 读的 `code.claude.com/docs/en/agent-sdk/` 下的 `agent-loop`、`hooks`、`sessions`、`session-storage`、`structured-outputs`、`cost-tracking`、`observability`、`hosting`）。
代码证据都写成 `文件:行号`，对着 `origin/feat/deploy-tencent` 的 9ef71f9。

## 0. 一页摘要

- **问题**：模型一轮从几秒变成几十秒，骨架还是「桥接敲钟 + 一串挂着等的请求」。「一轮」只是散在 9 个文件里的开关。说话有两个出口。模型看不到她看到的聊天记录。没有运行记录。
- **做法**：服务器上有一本账。每一轮在账上是一行：进来、跑、说话、送达、结果都写在这一行上。
  1. **轮次类型表**：一张只放数据的表，每种轮一行。代码只读这张表，不再到处判断 `direct` / `background` / `purpose`。
  2. **一本账**：5 张表（`inbox`、`rounds`、`round_events`、`messages`、`deliveries`）。它同时是以后评测的原料。
  3. **唯一的说话出口：`send_message`**。最后一段话降为「工作记录」，对方永远看不到。
  4. **异步**：网站记账，Agent 服务来取工作单，做完按 `runId` 回报。网页和桥接都不再挂着长请求。闹钟只留一个，在网站进程里。桥接只当搬运工。
  5. **聊天记录进快照**：`messages` 表放进 `weave.db`，模型能看到她看到的那份。
- **迁移**：放在开关后面。先私聊（只开主人自己的账号），再群，再网页，最后清理旧代码。每一步可以单独回退。
- **最大的风险**：模型在「有人直接找它」的那一轮忘了调 `send_message`，对方就收不到回复。有账上的指标、有兜底系统句、上线前有真模型冒烟（先报价）。
- **要主人拍板的事**在第 8 节。

## 1. 先引原文，再下结论

这些是后面所有判断的依据。页码是教材 PDF 的页码。

| 原文 | 页 | 用在哪 |
| --- | --- | --- |
| 「不要写死流程、不要状态机、不要设轮数上限」（判断表，违背「一个循环」） | p.15 | 类型表只放数据，不放「第一步做 A、第二步做 B」 |
| 「代码合法的位置有四个」：Agent 启动之前（预处理）、基础设施（网关、计费、鉴权）、Hook 只管副作用（备份、审计、拦截）、人把关之前的暂存 | p.20 | 3.7 逐段自查 |
| 「如果是在 Agent 还没启动的时候，你就给它做好了一点准备，这样其实是不影响 Agent 的灵活能力的。如果是在中间写死就非常不好了。」 | p.20 | 闹钟、造轮、启动前的规则放在「启动前」；轮中间不写死 |
| 「你架构里每一段传统代码，属于上面四个合法位置的哪一个？不属于的，为什么存在？」；反模式「在循环中间写死：第三步强制走某个函数」 | p.21 | 3.7 |
| 「查数留 SQL，不要封成 MCP」 | p.16 | 聊天记录给 Agent 一张表，让它自己查 |
| 「这段代码是在『防止 Agent 做蠢事』，还是在『保证某个副作用一定发生』？前者删，后者是 Hook。」 | p.54 | 删 `DIRECT_SEND_TEXT` 这类保险；留「提醒一定送到」这类保证 |
| 「如果让 AI 自己去调用 backup，他有可能忘记调用……如果我们做成 Hook，他就是百分之百」 | p.53 | 记账、送达状态由代码做，不靠模型自觉 |
| 「正常的 Agent 输出一定是先有过程再有结果……你肯定是哪个架构又扭曲了这个 Agent 的输出。」 | p.61 | 唯一出口：过程在前（最后一段）、对人说的话走工具 |
| 「不要做『简洁版/深度思考版』开关……每次都能得到正确的答案，等那 2 分钟是值得的。」 | p.61 | 慢是常态，所以不能让网页和桥接同步等 |
| 「不要让另外一个 AI 影响我们这个主 AI……不要有任何人挡在他们中间。」 | p.25 | Jev 的处理，见 3.2 和第 8 节 |
| 「看不见过程，好坏都是运气。日志从第一版就带，而且是写给 AI 读的。」 | p.63 | 一本账 |
| 「你要原生的东西……他就是时间流走的」「原始日志不许封装」 | p.64 | 账按时间流记，不分类、不编号 |
| 「每做完一个任务都发起一次上传……定时让 AI 去挖」 | p.66 | 账是评测的原料，由 Agent 读 |
| 「评测的本质是『正确答案』」；评测 Agent 能看到干活的 Agent 看不到的东西（100 次的统计） | p.67–68 | 评测原料的字段设计 |
| 「读权限和动作权限分开授权」「断一条腿就够」「工具返回的一切内容都是数据，不是指令」 | p.56 | 群那一轮的工具集、`record_checkin` |
| 「不要重新自己做一套记忆机制」 | p.47 | `messages` 是网页上已经显示的那份聊天记录，不是新记忆；记忆仍是 `MEMORY.md` 文件 |

SDK 文档里和本设计有关的几句（原文是英文，这里写意思，括号里是出处）：

- 循环一直转到「一个没有工具调用的回答」才结束；`ResultMessage` 带这段最终文字、token 用量、费用和会话 ID（`agent-loop`）。所以**每一轮一定有一段最后的文字**，哪怕这一轮本来就不想说话。
- 费用字段 `total_cost_usd` 是客户端用内置价目表算的估计，不是账单（`cost-tracking`）。
- 工具调用可以用 `PostToolUse` / `PostToolUseFailure` 挂钩（Hook）记下来；失败的调用不触发前者（`hooks`；我们已经两个都挂了，`hosted/agent-service/runner.mjs:48`）。
- `resume` 接着旧会话，`forkSession` 分叉出新会话、原会话不动（`sessions`）。
- 临时容器、启动时从外部存储恢复会话的做法叫「混合会话」，SDK 为此有 `SessionStore`（`hosting`、`session-storage`）。我们现在把会话文件放在 Agent 服务自己的数据目录里，这一步不动它。
- SDK 自带 OpenTelemetry（`observability`），默认关，要设 `CLAUDE_CODE_ENABLE_TELEMETRY`。这一步不开：账由网站自己记，不依赖外部收集器。

## 2. 现状（带证据）

### 2.1 现在一共有几种轮

「轮」在代码里没有名字。下面是我从各个入口反推出来的。`trigger.kind` 只有 5 个值（`hosted/agent-service/prompts.mjs:26`：`message`、`timer`、`event`、`check`、`close`），其中 `event` 现在没有任何调用方。

| # | 轮 | 谁叫醒（入口） | 叫醒时带的开关 |
| --- | --- | --- | --- |
| 1 | 网页直接消息 | 网页 `POST /chat` → `hosted/lib/weave/api.mjs:240` → `wakeForMessage` | scope owner、channel web、direct（默认 true，`dispatcher.mjs:75`） |
| 2 | 微信私聊消息 | 桥接 tick → `processInboundSdk` → `wechat.mjs:349` | 同上，channel wechat |
| 3 | 微信私聊带照片 | 同 2，认领时带 `photo`（`wechat.mjs:289`、`345`） | 多一个 `image`：模型换成能看图的（`dispatcher.mjs:101`、`server.mjs:164`），会话不存（`runner.mjs:43`、`server.mjs:207`） |
| 4 | 群里 @ 它 | `wechat.mjs:355` → `wakeForGroup`（`dispatcher.mjs:147`） | scope group、channel wechat、trigger.channel `group` |
| 5 | 群里 @ 它，带照片 | 同 4，带 `image` | 同 3 |
| 6 | 定时跟进 | 闹钟 → `runProactive` → `claimFor` 的 `begin('timer', …)`（`proactive.mjs:236`） | `background: true`、`direct: false`、kind `timer`（`proactive.mjs:332-336`） |
| 7 | 定期看看 | 同上，`begin('check', …)`（`proactive.mjs:250`） | kind `check` |
| 8 | 换日收尾 | 闹钟 → `runDayClose`（`day-close.mjs:77-79`） | `background: true`、`direct: false`、`purpose: 'close'`、`sessionDate`（前一天）、kind `close` |
| 9 | 到点提醒（现状：不叫醒，代码原样发一句） | `deliverReminders`（`domain.mjs:126`）、`deliverRoutines`（`proactive.mjs:184-202`）、`queueReminderMessages`（`scheduler.mjs:17-33`） | 不是一轮。分支 `feat/reminders-by-weave` 要把它变成 `reminder` 轮、`purpose: 'reminder'` |
| 10 | 绑定成功（现状：代码发一句） | `ingestPrivate`（`wechat.mjs:133` 的 `queueOut`） | 不是一轮。分支 `feat/bind-greeting-by-weave` 要把它变成 kind `event` 的直接轮 |
| 11 | 旧路线（`chatFor`、Hermes、朋友协商） | `scheduler.mjs:70-77`、`api.mjs:40` 的 `/query` | 分支 `chore/delete-legacy-paths` 在删，设计不再考虑 |

所以**现在是 8 种真正叫醒 Agent 的轮（1–8），加上 2 种马上要变成轮的（9、10）**。下一个（群里没 @ 的照片记成打卡）又是一种。

### 2.2 同一个事实，开关在哪定义、在哪判断

| 开关 | 在哪定义 | 在哪判断 |
| --- | --- | --- |
| `direct`（有人直接找它） | 调用方：`dispatcher.mjs:75`（默认 true）；后台调用方写 `direct: false`：`proactive.mjs:335`、`day-close.mjs:79` | ① `dispatcher.mjs:91` 写进通行证；② `dispatcher.mjs:100` 写进 `/wake` 请求；③ `prompts.mjs:36` 写进 `<trigger direct=…>`；④ `runner.mjs:71` 决定取不取最后一段话；⑤ `dispatcher.mjs:118` 决定算不算「结果不确定」；⑥ `agent-tools.mjs:52`、`:55`、`:90`、`:103`、`:120` 五处工具后端判断；⑦ `wechat.mjs:266` 群里再判断一次；⑧ `prompts.mjs:9` 系统提示里两句话 |
| `background` | `dispatcher.mjs:70` 参数；`proactive.mjs:333`、`day-close.mjs:43` 传 true | `dispatcher.mjs:102` 转给 Agent 服务；`server.mjs:71`、`:74` 校验；`server.mjs:196` 决定分叉；`server.mjs:209` 决定出错清不清会话 |
| `purpose` | `capability.mjs:25`（只认 `close`） | `agent-tools.mjs:50` 一处；`server.mjs:73` 另用 `trigger.kind === 'close'` 又判断一次（同一件事两种写法） |
| `sessionDate` | `dispatcher.mjs:70` | `dispatcher.mjs:87`（决定 `localDate`）；`server.mjs:173`、`:190` |
| `image` | `dispatcher.mjs:70` | `dispatcher.mjs:101`（换模型）；`server.mjs:164`、`:207`；`runner.mjs:43`、`:53` |
| `scope`（owner / group） | 调用方 | `scopes.mjs:9-33`（工具、内置、熔断额度）；`agent-tools.mjs:16-25` 又写一份工具表；`agent-service/mcp/tools.mjs` 再写一份定义；`agent-snapshot.mjs:26`；`wechat.mjs:259` |
| `channel`（web / wechat） | 调用方 | `agent-tools.mjs:73`（发到哪）；`capability.mjs:7` |
| 「这是哪种轮」本身 | 没有 | 通行证（`capability.mjs:30`）、`/wake` 请求（`dispatcher.mjs:98-103`）、`<trigger>`（`prompts.mjs:32`）三处各存一份 |

「该有哪些工具」也是两层：`scopes.mjs` 按范围给，轮和轮之间的差别靠「调了再拒」（`agent-tools.mjs:90`、`:120`），违背自己写的规则「这一轮不给的工具就不存在」（`docs/ARCHITECTURE.md:177`）。

### 2.3 两个说话出口，在代码里怎么走

**出口 A：最后一段话。** 只在 `direct` 的轮。
`runner.mjs:71` 取 `last.result` → `server.mjs:210` 回给网站 → `dispatcher.mjs:111` 取成 `reply` → 网页：`dispatcher.mjs:139` 记进聊天；微信私聊：`wechat.mjs:352` 排进发送队列；群：`wechat.mjs:360` 排进发送队列并 @ 提问的人。

**出口 B：`send_message` 工具。** 只在非 `direct` 的轮。
`agent-tools.mjs:48-78`：`direct` 就拒（`:52`，回「把话写在最后一段就行。」，`dispatcher.mjs:30`）；收尾轮也拒（`:50`）；然后查档位是否关（`:56`）、安静时段（`:57`）、今天主动条数（`:58`）、每天 20 条（`:65`）、24 小时内同一句（`:66`），都过了才 `record` 进聊天（`:72`）并排队（`:75`）。群里是 `wechat.mjs:259-278`，同样 `direct` 就拒（`:266`）。

这两个出口造成的问题：

- 最后一段话是循环的自然收尾，后台轮也一定会有。后台轮写在最后一段的话不会发出去，直接轮多调一次工具就是两条。#43 就是群里真的出现了两条，才加了 `DIRECT_SEND_TEXT` 这道保险（`dispatcher.mjs:28-30`）。
- 直接轮的回复**绕过**所有发送规则，规则只管后台轮。这是两个出口各自带规则的结果，不是设计出来的。
- 系统提示里「底线」要同时讲两套（`prompts.mjs:9` 的「有人直接找你的那一轮」「其他时候」）。

### 2.4 请求链

一句私聊微信，现在要过：

```text
wx（微信小号）→ 桥接（wechat-bridge）→ nginx → 网站 /api/internal/wechat/events（入队，wechat.mjs:503）
  ……等下一次 tick……
桥接 tick（bridge.mjs:239，最多等 170 秒）→ 网站 /wechat/tick（wechat.mjs:486）→ runScheduled（scheduler.mjs:52）
  → processInboundSdk（wechat.mjs:318）→ wakeForMessage（dispatcher.mjs:130）
  → POST Agent 服务 /wake（dispatcher.mjs:95，最多等 180 秒）→ 取快照（server.mjs:180）→ docker 一次性容器 → SDK query()
  → 容器里每次调工具：Agent 服务 → 网站 /api/internal/agent/tools/*（rpc.mjs，15 秒）
  回到 wakeForMessage → 存聊天（dispatcher.mjs:139）→ 排发送队列（wechat.mjs:352）
桥接 delivery 轮询（每 20 秒，bridge.mjs:274）→ /wechat/claim → wx 发出 → /wechat/receipt
```

网页是另一条：浏览器 `POST /chat` 一直挂着（`api.mjs:240`）→ nginx（`proxy_read_timeout 200s`，`deploy/tencent/weave.nginx.conf:36`）→ 网站 → `wakeForMessage` → Agent 服务 `/wake`。网页同时每 5 秒拉一次整份状态（`hosted/app/workspace/Workspace.jsx:142`）。

三个时钟：Cloudflare Cron（`hosted/worker/index.ts:9-14`，生产用 `wrangler dev`，Cron 不响，`api.mjs:89` 的注释）；Agent 服务每 60 秒敲网站（`server.mjs:93-129`、`:261`、`:282`）；桥接每 60 秒敲网站（`bridge.mjs:270-272`，要 `WEAVE_TICK=1`）。

「回过了」的记法：`wechat.mjs:351` 在回复**排进队**时就记 `replied`，不等真送到。

### 2.5 所有超时、租约和「过期」规则

| 值 | 位置 | 管什么 |
| --- | --- | --- |
| 5 秒 | `Workspace.jsx:142` | 网页拉整份状态 |
| 200 秒 | `weave.nginx.conf:36` | nginx 读超时（注释写「一轮 Agent 最长约 3 分钟」） |
| 170 秒 | `bridge.mjs:239` | 桥接等一次 tick |
| 60 秒 | `bridge.mjs:271` | 桥接 tick 周期 |
| 20 秒 | `bridge.mjs:274` | 桥接取发送任务周期 |
| 170 秒 / 60 秒 | `server.mjs:85` / `:282` | Agent 服务敲网站的超时 / 周期 |
| 150 秒 / 60 秒 | `dispatcher.mjs:17` / `:18` | 一拍总预算 / 60 秒后不再开新的一轮 |
| 180 秒（上限）| `dispatcher.mjs:19`；`wechat.mjs:343`、`proactive.mjs:334`、`day-close.mjs:78` 各抄一份公式 `max(5s, min(180s, 预算剩余))` | 网站等一轮 |
| 10 分钟 | `runner.mjs:8` | Agent 一轮最长 |
| 15 秒 | `snapshot.mjs:83`；`rpc.mjs:6` | 取快照；工具回调 |
| 300 秒 | `model-proxy.mjs:98` | 模型上游 |
| 15 分钟 | `capability.mjs:30` | 通行证有效期 |
| 10 分钟 | `wechat.mjs:19`（`ORPHAN_MS`） | 微信收件处理中超过这个就算丢了，记「不确定」 |
| 5 分钟 | `wechat.mjs:14`（`LEASE_MS`） | 发送任务租约 |
| 15 分钟 / 15 分钟 | `proactive.mjs:26` / `day-close.mjs:15` | 后台轮租约 / 收尾租约 |
| 30 秒 | `wechat.mjs:22`；`bridge.mjs:302`（60 秒配对 / 10 秒观察）；`bridge.mjs:494`（60 秒上传）；`wechat-photos.mjs:9`（10 分钟存活） | 照片配对和暂存 |
| 8 秒 / 30 秒 / 10 秒 | `jev.mjs:20` / `dispatcher.mjs:159` / `agent-memory.mjs:12` | Jev、忘记工作目录、读 MEMORY |
| **过期规则（晚了还发不发）** | | |
| 6 小时 | `wechat.mjs:14`（`STALE_MS`） | 微信收件太旧就不回 |
| 2 小时 | `wechat.mjs:17`（`LATE_MS`）；`proactive.mjs:25`（`GRACE_MS`） | 带 `dueAt` 的发送任务；后台轮和重复提醒 |
| 10 分钟 | `bridge.mjs:88` 的 `maxHoldMs` | 桥接限速时最多压多久 |

数一下：**至少 20 个时间值，分在十多个文件和 4 个进程里**，靠手工对齐（比如「一拍不能超过 170 秒」靠 150 / 170 / 200 三个数互相让）。5 套「晚了还发不发」的规则各写各的。

### 2.6 模型现在看得到什么、看不到什么

看得到：系统提示（`prompts.mjs:9`）、`MEMORY.md`、`HANDOFF.md`（只有本人，`server.mjs:189`）、`<trigger>`（这一句话）、`weave/weave.db` 快照（`agent-snapshot.mjs:27-33`：习惯、完成记录、目标、提醒、排期、档位）、会话历史（`resume`，按天切，`workspace.mjs:51-66`）、群里是 `group_messages`（最近 50 条，`agent-snapshot.mjs:50`）。

看不到：

- **她看到的那份聊天记录**。本人的快照里没有消息（`agent-snapshot.mjs:21-35`）。网页上显示的是 `person.messages`（`domain.mjs:12`），模型只能靠会话历史。会话按天切、出错就清（`server.mjs:209`）、带照片的轮不存（`server.mjs:207`）、后台轮没发出去的话留在主会话里、提醒只进聊天记录，这些情况都会让「她看到的」和「模型看到的」对不上。
- 自己的回复**有没有送到**（微信的送达状态只写在 `world.wechat` 里，`wechat.mjs:248-252`）。
- 前几轮自己做了什么（`person.proactive.log` 只有 30 条，在人的文档里，不在快照里，`proactive.mjs:30`）。
- 没有任何运行记录。`runner.mjs:18` 收集了这一轮调过的工具名，`dispatcher.mjs:111` 只取了结果和回复，其余丢掉。

## 3. 目标设计

### 3.1 总图

```text
门（网页 / 微信桥接 / 闹钟 / 事件）
   │  只做一件事：在账上记一行（inbox + rounds），马上返回
   ▼
网站（唯一写账的人）
   rounds: queued ──取走──▶ running ──回报──▶ finished / expired / lost
                │                │
   闹钟（网站进程里，只有这一个）：  工具后端：每次调工具，规则检查、
   到点的提醒/跟进/看看/收尾 → 建 rounds   效果、记账在同一个事务里
   过期、租约、清理                 send_message → messages + deliveries
   ▲
Agent 服务：有空位就来取工作单 ── 跑一次性容器 ── 按 runId 回报
桥接：只搬运（收件信封 → 网站；取发送任务 → 发出 → 回执）
网页：只拉「这个游标之后的新消息」
```

三个角色分清：

- **网站**说了算：账在它这里，规则在它这里，时钟在它这里。
- **Agent 服务**只管把一轮跑完。它不判断该不该醒、不存业务状态。
- **桥接 / 网页**是门和搬运工。

### 3.2 轮次类型表

这张表是**数据**，放在网站的一个文件里（建议 `hosted/lib/weave/rounds/types.mjs`，冻结的对象，和 `scopes.mjs` 一个写法）。代码里所有「这是哪种轮、该怎么办」都读它，不再看 `direct`、`background`、`purpose`、`sessionDate` 这些散开关。账的每一行记 `type` 和 `type_hash`（这一行表内容的摘要），评测时能知道当时是哪一版规则。

它是第 21 页自查里「Agent 启动之前的预处理」和「基础设施」：只回答「该不该醒、给它什么、什么不允许」，不回答「醒了做什么」。

每种轮在表里的字段：

| 字段 | 含义 |
| --- | --- |
| `trigger` | 谁创建这一轮、`<trigger kind=…>` 写什么 |
| `scope` | `owner`（本人）或 `group` |
| `direct` | 有人在等回复吗（只用来告诉模型，和决定发送规则宽不宽） |
| `toolset` | 工具集的名字（下面第二张表） |
| `speak` | 能不能说话；说话必须经 `send_message`（见 3.4） |
| `gate` | 启动前的规则：该不该建这一轮 |
| `send_rules` | 发送时的规则：工具后端在 `send_message` 里查 |
| `session` | 读哪天的会话、接着用还是分叉、成功后存不存 |
| `retry` | 失败后能不能重试 |
| `valid_for` | 建出来多久还有意义，过了就 `expired`（取代 5 套「晚了还发不发」） |
| `fallback` | 这一轮该做的事没做成时，代码保证的那一件事（只有「提醒」有） |
| `delivery` | 说出去的话怎么记送达 |

**表 A：触发、范围、工具**

| 类型 | 触发 | 范围 | 直接找它 | 工具集 |
| --- | --- | --- | --- | --- |
| `chat`（网页或私聊消息，可带照片） | 网页 `POST /chat`；微信私聊收件 | owner | 是 | `owner-talk` |
| `group-ask`（群里 @ 它） | 已开启的群里有成员 @ | group | 是 | `group-talk` |
| `follow-up`（定时跟进） | 闹钟：`schedules` 里 kind `wake` 到点 | owner | 否 | `owner-background` |
| `check-in`（定期看看） | 闹钟：档位决定的钟点到了 | owner | 否 | `owner-background` |
| `day-close`（换日收尾） | 闹钟：前一天她找过它，那一天已过完 | owner | 否 | `owner-close` |
| `reminder`（提醒，在 `feat/reminders-by-weave` 做） | 闹钟：提醒到点 | owner | 否 | `owner-reminder` |
| `bind-greeting`（绑定成功，在 `feat/bind-greeting-by-weave` 做） | 事件：绑定成功 | owner | 是 | `owner-talk` |
| `group-checkin`（第三步预留：群里没 @ 的照片） | 群收件：成员发了照片 | group | 否 | `group-silent` |

提醒、绑定那两行以那两条分支的设计为准，这里只占位，说明表装得下它们。它们的 `purpose: 'reminder'` 和 kind `event` 并进表的 `type`。

**工具集**（「按轮建的工具」：这一轮不在集里的工具就不存在，不是「调了再拒」）：

| 工具集 | 里面有什么 |
| --- | --- |
| `owner-talk` | `send_message`、`save_habit`、`log_completion`、`save_goal`、`set_reminder`、`schedule_wake`、`cancel_schedule`、`set_proactivity` |
| `owner-background` | `send_message`、`schedule_wake`（**没有 `repeat` 参数**，只能排一次性的）、`cancel_schedule` |
| `owner-close` | `schedule_wake`（同上，一次性）。没有 `send_message` |
| `owner-reminder` | `send_message`；其余以提醒那条分支为准 |
| `group-talk` | `send_message`（收件人是这个群，由账决定） |
| `group-silent` | `record_checkin`（第三步定义，成员编号和日期由代码填） |

对照现在：`owner-background` 比现在**窄**。现在后台轮还能调 `save_habit`、`log_completion`、`save_goal`（`agent-tools.mjs:16-25` 没有拦），但「对方不在场」的理由同样适用（`agent-tools.mjs:38` 的 `reminderBackground`）。第一阶段的影子记账（4.1）会告诉我们现实里有没有后台轮调过这三个；有真实用途就加回去，没有就按窄的上。

内置工具（Bash、Read、Write、Edit、Glob、Grep、Skill、WebSearch）、禁用清单、网络、熔断额度仍按**范围**放在 `scopes.mjs`，不进类型表。理由：这是「Agent 的电脑能做什么」，是安全边界，放在 Agent 服务这一侧，网站出错也越不了界。类型表只能在范围允许的里面挑工具，两把锁。

**表 B：说话和规则**

| 类型 | 说话 | 启动前规则（`gate`） | 发送时规则（`send_rules`） |
| --- | --- | --- | --- |
| `chat` | 能，经 `send_message`，可以多条（先说「我看看」，再说结果） | 无（有人找就醒）。模型代理的每日 token 额度照旧管（`model-proxy.mjs:90`） | 长度 1–700；每轮最多 5 条（草稿，防失控）。**不受**档位、安静时段、每天 20 条、24 小时同句冷却（有人在等就要回） |
| `group-ask` | 能；第一条 @ 提问的人 | 群已开启、提问人是成员（收件层已查） | 长度；收件人是通行证里那个群；每轮最多 5 条 |
| `follow-up` | 能，但没有值得说的就不说 | 档位不是 `off`；在允许时段；今天后台醒的次数没到档位上限；Jev（见下） | 档位不是 `off`；在允许时段；今天主动说的条数没到档位上限；每天总共 20 条；24 小时内同一句不重发（就是现在 `agent-tools.mjs:56-66` 那几条） |
| `check-in` | 同上 | 同上，再加：今天这个钟点还没看过；没有「连着两句主动消息没回」；7 天内她来过（`proactive.mjs:28-29`、`:238`） | 同上 |
| `day-close` | **不能**（工具集里没有） | 前一天她找过它（`agentDay`）；那一天已过完（按她的时区，`day-close.mjs:26-30`） | 无。不受档位、安静时段、次数管（`day-close.mjs:10` 的原话） |
| `reminder` | 能，而且**必须说**（她要求的） | 无（答应过的事，不看档位和安静时段，和现在一次性提醒一样，`domain.mjs:126`） | 长度；每轮最多 5 条 |
| `bind-greeting` | 能 | 无 | 同 `chat` |
| `group-checkin` | 不能 | 群已开启；不是「别记」；成员同意过 | 无 |

**表 C：会话、失败、送达、有效期**

| 类型 | 会话 | 失败了怎么办 | 送达怎么记 | `valid_for` |
| --- | --- | --- | --- | --- |
| `chat` | 读今天的，接着用；成功就换成新的；出错就清掉（现状 `server.mjs:207-209`）。**有图片的这一轮不存会话**（现状 `runner.mjs:43`），这条跟着「输入种类」走，不跟轮类型走 | 查账：这一轮没有说过话、没有写过东西，就重试 1 次；否则不重试，给对方一句系统话（沿用 `REPLIES.uncertain`，`dispatcher.mjs:26`） | 每条 `send_message` 一行 `deliveries`；网页那边消息一落库就算「已显示」 | 6 小时（现状 `wechat.mjs:14`） |
| `group-ask` | 读这个群今天的，接着用 | 同上；系统话发回群里 | 同上，带 @ | 6 小时 |
| `follow-up` | 读今天的，**分叉**；成功就把分叉出来的那段存为今天的（她回「走了」才接得上，现状 `server.mjs:208`）；失败原会话不动 | 没说过话、没写过东西就重试 1 次；否则记 `uncertain`，不重试 | 同 `chat` | 2 小时（现状 `proactive.mjs:25`）；过了记 `missed` |
| `check-in` | 同 `follow-up` | 同上 | 同上 | 2 小时 |
| `day-close` | 读**前一天**的，分叉；**不存**（现状 `server.mjs:207`）。前一天的会话已被新的一天盖掉就跳过（现状 `server.mjs:173`） | 同上 | 无（不说话） | 到前一天会话被盖掉为止 |
| `reminder` | 读今天的，分叉；成功存分叉 | 没说过话就重试，直到 `valid_for`；用完重试或「成功了但没说话」→ `fallback` | 同 `chat` | 2 小时（现状 `wechat.mjs:17`）；过了记 `missed`，不补发 |
| `bind-greeting` | 读今天的，接着用 | 重试 1 次；`fallback` 建议带原来那一句（`wechat.mjs:133`），以那条分支为准 | 同 `chat` | 10 分钟（草稿） |
| `group-checkin` | 不读、不存会话（每次新开） | 不重试 | 无 | 6 小时（草稿） |

补三点：

1. **「可以安全重试」不再是一个手写开关，而是查账的结果。** 网站的工具后端看得到这一轮的每一次工具调用（3.3），所以「这一轮有没有说过话、有没有写过东西」是事实。表里的 `retry` 只写「没有副作用才重试几次」。现在的规则是「出错一律不重试，因为可能已经发过消息」（`docs/ARCHITECTURE.md:126`），这是同一个原则，但更精确。
2. **`fallback` 是教材 p.53 说的那种「保证某个副作用一定发生」**。提醒是答应过的事：不能因为模型这一轮没说话就丢。所以兜底由代码原样发「提醒你：…」，并在账上标 `fallback_used`。这是表里唯一一个兜底，它是挂钩一类，不替模型做业务判断。
3. **Jev**（决策模型）现在挡在 `follow-up` 和 `check-in` 前面（`proactive.mjs:316-327`）。教材 p.25「不要让另外一个 AI 影响我们这个主 AI」，有张力。它现在没配 Key（审查报告）。这一步的建议：**先放成影子模式（Shadow mode）**：照样问、分数记进账，但不拦。等账里有了数据，再对着「该不该开口」的评测决定拦不拦。见第 8 节。

**`<trigger>` 也由表生成。** 现在 `prompts.mjs:26`、`:32-37` 自己写了一份固定值清单。改成：`kind` 取自表，`direct` 取自表。`direct="true"` 这个属性仍然留给模型看，它需要知道此刻有没有人在等。

**输入种类**（第三步的看图、引用、语音、文件走同一个入口；这里只把位置占好）。一张很小的表，和轮类型表同一个文件：

| 输入种类 | 给模型的方式 | 需要的模型 | 会话 | 留在聊天记录里的 |
| --- | --- | --- | --- | --- |
| 文字 | 写进 `<trigger>` | 任意 | 照类型 | 原文 |
| 照片 | 流式输入带图（`runner.mjs:53`） | 能看图的 | 不存 | 占位「[照片]」加模型的回复（见 3.6） |
| 引用 | 引用的原文写进 `<trigger>` | 任意 | 照类型 | 原文加被引用那条的 id |
| 语音 | 先转文字（要选转写服务，第三步定） | 任意 | 照类型 | 转写文字 |
| 文件 | 放进工作目录 `inbox/`，Agent 自己读 | 任意 | 照类型 | 文件名和大小 |
| 看不了的（视频等） | 占位文字 | — | 照类型 | 占位 |

### 3.3 一本账

#### 放在哪

放在第一步那个 SQLite 文件里，**用普通的表**，不放进 `weave_documents` 那种「一个人一个 JSON 文档」里。理由：`Store.load()` 每次读全部文档（`store.mjs:6-12`），`withWorld` 冲突要整个重来（`store.mjs:56-67`）。账每一轮都在长，放进去会越来越慢，还会和工具回调抢着写、互相 409（`store.mjs:35-48`）。

对第一步的假设，只有三条：① 同一个 SQLite 文件，只有网站进程写；② 事务是同步的、有 WAL；③ 每天备份。要是第一步没落地，这五张表在现在的 D1 上也能建（D1 就是 SQLite，`Store.save` 已经用 `db.batch`），**只有「网站进程里的闹钟」要等第一步**。那时的退路：闹钟先留在 Agent 服务那个 60 秒的敲钟上（`server.mjs:93`），删掉桥接的敲钟和 Cron 这两个，也仍然是「只留一个」。

#### 五张表

| 表 | 一行是什么 | 主要字段 |
| --- | --- | --- |
| `inbox`（收件） | 一条进来的东西（一条微信、一次网页发送、一个事件） | `id`（去重键，微信用 `hash(消息 id)`）、`channel`（`web` / `wx` / `ilink`）、`chat`（私聊是 owner，群是群的哈希）、`sender`（哈希，不是 wxid）、`kind`（文字 / 照片 / 引用 / 语音 / 文件 / 事件）、`received_at`、`sent_at`（对方发出的时间）、`status`（`accepted` / `ignored` / `stale`）、`message_id`、`round_id`、`attachment_ref`。**不放正文**：正文在 `messages`。不处理的东西只留去重标记，不留文字（保持 `wechat.mjs:124` 的做法） |
| `rounds`（一轮，账的主体） | 一轮 | 见下 |
| `round_events`（一轮里发生的事） | 一次工具调用、一次被拒的调用、一次状态变化 | `round_id`、`seq`、`at`、`kind`（`tool_call` / `tool_denied` / `builtin_call` / `state`）、`name`、`args`、`ok`、`result_text`、`rule`（被哪条规则拒的）、`ms`、`tool_use_id` |
| `messages`（聊天记录） | 一句话（她说的、Weave 说的、系统说的） | `seq`（递增游标）、`chat`、`role`、`source`（`web` / `wechat` / `agent` / `reminder` / `system`）、`text`、`created_at`、`round_id`（这句话由哪一轮产生；她说的话挂在它触发的那一轮上）、`reply_to`、`proactive`、`note`（照片「看到了什么」那一句）、`member`（群里的成员编号） |
| `deliveries`（送达） | 一条要发到微信的话 | `id`（就是发给桥接的幂等键）、`message_id`、`round_id`、`channel`、`target`（群目标是加密的，沿用 `seal`）、`mention`、`status`（`queued` / `sending` / `sent` / `failed` / `uncertain` / `expired`）、`expires_at`、`lease_until`、`created_at`、`sent_at` |

另外一张小表 `round_labels`（`round_id`、`label`、`value`、`by`：`human` / `agent` / `code`、`at`、`note`）留给评测，打标签不改事实。这一步只建表，不写评测。

**`rounds` 一行记什么：**

| 组 | 字段 |
| --- | --- |
| 身份 | `id`（就是 `runId`）、`owner_id`、`scope`、`group_id`、`type`、`type_hash`、`dedupe_key`（唯一，见下） |
| 触发 | `trigger_kind`、`channel`、`trigger_text`（原文）、`inbox_ids`（一轮可以挂多条收件） |
| 给模型的输入摘要 | `input_summary`：快照里各表的行数、快照摘要（hash）、`MEMORY.md` 和 `HANDOFF.md` 的字节数、附件种类、用的会话是哪一段（`session_before`）、系统提示的版本号 |
| 启动前规则的结果 | `gate`：每条规则当时算出来的值。例如 `{tier:'normal', active_hours:true, wakes:'1/4', jev:{score:0.31, threshold:0.4, mode:'shadow'}}`。这是评测「该不该开口」的核心 |
| 生命周期 | `status`（`queued` / `running` / `finished` / `expired` / `cancelled` / `lost`）、`attempt`、`created_at`、`not_before`、`valid_until`、`claimed_at`、`lease_until`、`started_at`、`finished_at`、`queue_ms`、`run_ms` |
| 结果 | `outcome`（`success` / `error` / `error_max_budget_usd` / `timeout` / `skipped` / `lost`）、`error_class`（只写类名，不写正文）、`spoke`（说了几条）、`side_effects`（有副作用的工具调用几次）、`fallback_used` |
| 用量 | `model`、`tokens`（SDK 报的 usage，加模型代理按这一轮数的 token）、`cost_usd`。**费用按我们自己的价目表算**，不直接用 SDK 的 `total_cost_usd`：它是内置 Claude 价目表的估计（`cost-tracking`），换成国产模型后不可信（推断，没核实）。要这样做，模型代理要加「按这一轮累计」的计数，现在只按账号累加（`model-proxy.mjs:112`） |
| 会话 | `session_after`、`forked` |
| 最后一段话 | `work_log`（最后一段文字，截断；它是工作记录，不是回复） |

**`dedupe_key` 让建轮幂等**，哪怕两个闹钟同时跑也不会建出两轮。例如：`chat:<inbox id>`、`timer:<schedule id>:<next_at>`、`check:<owner>:<日期>:<第几次>`、`close:<owner>:<日期>`、`reminder:<id>:<due_at>`、`bind:<owner>:<绑定时间>`。

#### 谁写账，什么时候写

- **门**：建 `inbox` 和 `rounds`（一个事务），马上返回。
- **闹钟**：建 `rounds`。
- **工具后端**：每次工具回调，**规则检查、效果（比如发一句话）、`round_events` 一行，同在一个事务里**。所以账和事实之间没有缝：账上说发了，就是发了。这也是 `send_message` 的幂等键（`runId:attempt:toolUseId`）的落脚处，取代现在放在人文档里的 `toolReceipts`（`agent-tools.mjs:156-167`，最多留 200 条）。
- **Agent 服务**：只在 `finish` 回报里交它独有的东西：内置工具调用清单（Bash、Read、Write 这些，网站看不到，来自 `PostToolUse` / `PostToolUseFailure` 挂钩，`runner.mjs:18`、`:48`）、最后一段话、会话 ID、usage、用时、结果。
- **投递**：桥接回执写 `deliveries.status`，聊天里「送到没有」是 `messages` 联 `deliveries` 查出来的，不再单独回写一遍（取代 `markDelivery`，`wechat.mjs:248-252`）。

SDK 的会话 JSONL（原始、按时间流）仍然在 Agent 服务的数据目录里（`workspace.mjs:7`），账里只存 `session_id` 指过去。教材 p.64 要原生日志，所以不在账里重新封装它。

#### 保留多久、隐私怎么处理

账里装的是她的话、她的习惯、工具参数。它和聊天记录是同一等级的敏感数据，规矩也一样：

- 只在这台服务器上，不上传任何第三方日志服务，不开 OTel 导出。
- **保留（草稿数字，待主人定）**：详细内容（`trigger_text`、`round_events` 的参数和结果、`work_log`、`input_summary`）保留 30 天；之后只留骨架（类型、`gate`、结果、工具名和次数、用时、token、费用、标签）一年。`messages` 本身的保留另算，沿用她现在能看到的聊天记录。
- **删除**：账号注销（`forgetAgentWorkspace`，`dispatcher.mjs:155`）连带删这个人所有账；关群时删这个群的收件、消息、轮（沿用 `wechat.mjs:163-166` 的做法）。「别记」的群消息在进账之前就丢掉（`wechat.mjs:172`），账里没有它。
- **备份**：第一步每天备份，备份保留多久，删除才真正生效多久。要在第一步的设计里写明，并且不超过账的保留期。
- 账里不放 wxid、昵称；群里只用成员编号（沿用 `wechat.mjs:174-177` 的约定）。群消息正文仍用 `seal` 加密存放。
- 错误只记类名，不记响应正文（沿用 `server.mjs:253` 的做法）。
- 公开仓库：测试和样例数据只用合成的，不放真实内容。

#### 评测原料：主人在意的四个问题，各靠账上的什么

| 问题 | 靠什么 | 谁来判 |
| --- | --- | --- |
| 该不该开口 | `rounds.gate`（当时的档位、时段、次数、Jev 分数）、`spoke`、这条消息之后她多久回、是不是被忽略（`messages` 联查） | Agent 评委看一批后台轮的整体规律（教材 p.68「评测 Agent 能看到统计数据」） |
| 记得对不对 | `input_summary`（快照摘要）、`messages` 里她的问题和 Weave 的回答、对得上的快照行。要复现需要快照副本：**只给开了开发者模式的账号存 7 天**（第 8 节） | 有正确答案的用代码评（p.68：「有客观正确答案，代码评」），没有的人评或 Agent 评 |
| 有没有说出不该说的 | `send_message` 的文字（在 `messages`）；离线检查（只检查、不拦）：有没有出现「醒来、叫醒、trigger、快照、工具」这些词（`prompts.mjs:9` 那条底线）；群里有没有点名批评 | 代码做词表，Agent 评委做其余 |
| 有没有声称做了其实没做 | 把 `messages` 里的话和同一轮 `round_events` 里**成功的写工具调用**对照：说「记下了 / 设好了提醒」，账上同一轮却没有对应成功的 `log_completion` / `set_reminder` | 这条几乎可以用代码判，是最适合先做的评测 |

出口：一个只读的导出脚本（建议 `scripts/rounds-export.mjs`），把账按时间流吐成 JSONL，让 Claude Code 会话直接读（教材 p.63「日志写给 AI 读」、p.64「按时间流」）。账不做 1234 分类，不做给人看的封装。

开发者模式和用户模式（教材 p.61）：别人的账号默认只有骨架指标可看，文字要在隐私页写明并得到同意才能读（第 8 节）。

### 3.4 唯一的说话出口：选 `send_message`

**选：所有轮，对人说的话只走 `send_message`。最后一段话降为工作记录，对方永远看不到。**

理由：

1. **SDK 的循环决定了「最后一段话」每一轮都有**（`agent-loop`：循环转到没有工具调用的回答才结束，结果里带这段话）。要让「这一轮不说话」成立，用最后一段话就得发明一个「没话说」的暗号或者空串约定，那是在轮外面再写死一条约定。工具出口天然有「不调用就是没说话」，不需要暗号（`docs/ARCHITECTURE.md:122` 的原话也是这个意思）。
2. **两个出口的问题是同一个根**（2.3）：所以才有 `DIRECT_SEND_TEXT`、直接轮绕过所有规则、系统提示讲两套话。统一成一个出口，三处一起消失。按教材 p.54 的判据，`DIRECT_SEND_TEXT` 那道保险是「防止 Agent 做蠢事」，应该删，前提是先把结构改对。
3. **工具是结构化的，规则只在一个地方管**：收件人由这一轮决定、模型选不了（`docs/ARCHITECTURE.md:188` 的工具表）；发送规则、`toolUseId` 幂等（规则 7）、记账都在工具后端，每一条发出去的话都有 `round_id` 和送达状态。
4. **一轮可以说多句**：几十秒的轮里先说一句「我先看看」，再说结果。这正是教材 p.61「先有过程再有结果」。最后一段话只能说一次，而且在最后。
5. **最后一段话有了新用处**：它是这一轮的工作记录，存进账的 `work_log`，也是「动态」里「为什么开口」的理由（审查报告 02 说现在没有给人看的理由）。

**没选的两条路：**

- *全用最后一段话*：后台轮没法表达「不说」，除非用暗号。后台轮的规则（档位、安静时段、上限）要挂在一个不是工具的东西上，只能在轮外面截取最后一段文字再检查，这就成了「在循环后面写死」的代码。
- *SDK 的结构化输出（`outputFormat`）*：结果里带一个校验过的 JSON（比如 `{say: 文字或 null}`，`structured-outputs`）。能表达「不说」。但：一轮只能说一次；多了 `error_max_structured_output_retries` 这种失败模式；国产模型走 Anthropic 格式的接口时支不支持**没有核实**，要花钱测。收益不比工具大，先不选。

**代价和兜底（直说）：**

- 最大的风险：模型在直接轮里**忘了调 `send_message`**。现状是最后一段话保证有回复。对策：
  1. 账里有指标：`direct` 的轮里 `spoke = 0` 的比例（叫 `direct_silent_rate`），一眼能看出。
  2. 兜底是**系统话**，不是最后一段话：直接轮成功结束但没有说话 → 记 `outcome: success`、`spoke: 0`，网站发一句系统话（沿用 `REPLIES.uncertain` 的意思，`dispatcher.mjs:26`），`messages.source = 'system'`。不用最后一段话兜底，因为那会把 #43 里「已回应问候」这种给自己看的总结又发给对方。现状里「直接轮成功却没有最后一段话」本来就算 `uncertain`（`dispatcher.mjs:118`），规则没变，只是换了判断依据。
  3. 上线前用真模型冒烟：`deepseek-flash` 在直接轮里调 `send_message` 的比例。要花钱，**先报价，主人点头再跑**。
- 提示词要改。`prompts.mjs:9` 里「底线」的两句话（「有人直接找你的那一轮……你最后一段话会原样发给对方」和「其他时候……只有调用 send_message 才有人看得到」）是主人确认过的原句，**我不改，只给草稿，等她确认**。草稿：

  > 只有调用 send_message，对方才看得到你说的话；你的最后一段话对方看不到，只是这一轮的工作记录，写你做了什么、看到了什么。有人直接找你的那一轮（direct="true"），要回对方就调用 send_message，可以分几次说；其他时候没有值得说的，就什么都不发。

  同时要改的还有 `docs/ARCHITECTURE.md` 第 5 节（`test/agent-prompts-sync.test.mjs` 保证提示词和文档一字不差）。`DIRECT_SEND_TEXT`（「把话写在最后一段就行。」）也是她确认过的原句，在切换完成后删掉。
- 过渡期两种说话方式要共存（旧路径还在，4.1）：工作单里带一个 `speech: 'tool' | 'final'`，`prompts.mjs` 按它选那句底线。这个开关只在迁移期存在，第 4.4 步删。

**群里 @ 它**：同样走 `send_message`，收件人是通行证里那个群。直接轮的第一条自动 @ 提问的人（`mention`，类型表 `group-ask` 的发送规则）。现在是在最后一段话这条路上加 @（`wechat.mjs:360`）。

### 3.5 异步：工作单、回报、租约、闹钟、桥接

#### 一轮的生命周期

```text
1 记进来   门在一个事务里写 inbox + messages(她说的) + rounds(queued, not_before, valid_until, dedupe_key) → 返回 202
2 取走     Agent 服务有空位 → POST /api/internal/rounds/claim
           网站在一个事务里挑最早的、够时间的、这个人（或这个群）没有别的轮在跑的 queued 轮，
           置 running、attempt+1、lease_until；发通行证；返回「工作单」
3 开跑     Agent 服务取快照、起容器、跑 query()（现有代码）
           工具回调 → 网站（规则 + 效果 + 记账，一个事务）；send_message 在这里写 messages + deliveries
4 回报     Agent 服务 POST /api/internal/rounds/:runId/finish（outcome、会话 id、usage、用时、最后一段话、内置工具清单）
           网站：写结果、按类型表收尾（排期结算、兜底、系统话）、置 finished
5 送达     桥接 claim 发送任务 → 发 → 回执 → deliveries.status
```

#### 工作单里有什么

`runId`、`attempt`、类型名和这一行的内容（工具集名字、会话规则、`speech`）、范围和 id、`<trigger>` 的各字段（`kind`、`channel`、`direct`、`at`、`text`、附件）、`localDate`、通行证、模型、用户自己的 Key（沿用现在 `dispatcher.mjs:86` 的做法）。

**Agent 服务不再自己存一份类型的定义**，工作单里带。这样「这一轮是哪种轮」只有账一处（现在是通行证、`/wake` 请求、`<trigger>` 三处，2.2）。通行证瘦下来：只写「是谁、哪个范围、哪个群、哪一轮、哪次尝试、过期时间」，这些是身份。类型、`direct`、`purpose` 这些事实，工具后端按 `runId` 去账里查。工具集只传名字；工具的定义（zod 形状、说明文字）仍在 Agent 服务的 `mcp/tools.mjs`，由一个同步测试保证两边的名字对得上（做法同 `agent-prompts-sync.test.mjs`）。

#### 为什么是 Agent 服务来取，而不是网站推

- 并发上限在 Agent 服务这一侧（`AGENT_MAX_CONCURRENCY`，`deploy/tencent/compose.yml:46`，现在是 1）。它只在有空位时来取，网站不用知道，也就没有 429 繁忙这条路（`dispatcher.mjs:106`、`REPLIES.busy`、`queue.mjs:14` 的第 6 个排队）。
- 取不到工作的时候什么都不会丢：轮就在账上等着，到 `valid_until` 变 `expired`。现在 Agent 服务不可用时是「回一句没有处理」（`dispatcher.mjs:107`）。
- 取活用短轮询加「叫一声」：网站在建出新轮后 `POST` 一下 Agent 服务的 `/nudge`（不等回、失败也没事）；Agent 服务空闲时每 2 秒自己来问一次（草稿数字）。叫一声负责快，轮询负责不丢。

#### 回报怎么保证不出事

- **按 `runId` 幂等**：同一个 `runId` + `attempt` 重复回报，原样返回上次的结果。
- **僵尸尝试被挡掉**：通行证里带 `attempt`。如果租约到期、这一轮已被重新排队（`attempt+1`），旧容器之后的工具调用和回报都会被拒（「这一轮已经结束」）。不然旧容器会重复发消息、重复记账。
- **网站重启没事**：轮在 SQLite 里，闹钟起来后接着扫。现在是请求挂在半空，网站一重启就丢（审查报告 01）。
- **Agent 服务重启**：容器没了，租约到期后网站把这轮标 `lost`，按 `retry` 和账上的副作用决定重试还是记 `uncertain`。
- **Agent 服务回报失败**：退避重试，最长到租约到期。到期后网站自己把它标 `lost`，而工具调用的账早已在网站写好了，所以信息不会丢，只会少一点用量。
- **取消**：账上标 `cancelled`，之后的工具回调都被拒，模型会看到错误并收尾。容器不会立刻被杀，要等下一次工具调用或 10 分钟超时。这一步够用，不加心跳。

#### 租约和超时：从 20 多个收成两三个

| 要保留的 | 值 | 说明 |
| --- | --- | --- |
| 一轮最长跑多久 | 10 分钟（沿用 `runner.mjs:8`） | Agent 服务内部的超时，不变 |
| 租约 | `RUN_TIMEOUT + 2 分钟` | 只在账里写一次，`lease_until`。取代微信 10 分钟（`wechat.mjs:19`）、后台 15 分钟（`proactive.mjs:26`）、收尾 15 分钟（`day-close.mjs:15`）、通行证 15 分钟（`capability.mjs:30`，改成同一个值） |
| 发送租约 | 5 分钟（沿用 `wechat.mjs:14`） | `deliveries.lease_until` |
| 过期 | 每种轮一个 `valid_for`（类型表） | 取代 5 套规则 |

没了：桥接 170 秒、nginx 200 秒要对齐的那一串（桥接不再等一轮）、`TICK_BUDGET_MS` / `START_BY_MS` / 三份 `max(5s, min(180s, …))`（没有「一拍」了）、`dispatcher.mjs:19` 的 180 秒。网页的 `POST /chat` 回 202，不再挂着。留下的纯基础设施超时（快照 15 秒、工具回调 15 秒、模型上游 300 秒、Jev 8 秒）是单个请求的超时，互相之间不用对齐。

#### 只留一个闹钟

- **在网站进程里**，一个 `setInterval`（草稿：15 秒一次）。它做的全是本地 SQLite 的索引查询，不碰网络：
  1. 到点的提醒、跟进、定期看看、换日收尾 → 按类型表的 `gate` 判断，通过的建 `rounds`（`dedupe_key` 保证不重复）。
  2. 超过 `valid_until` 的 `queued` 轮 → `expired`。
  3. 租约到期的 `running` 轮 → `lost` → 重试或 `uncertain`。
  4. 发送租约到期的 `deliveries` → 回到 `queued`（同一个幂等键，不会重发，沿用 `wechat.mjs:375`）。
  5. 保留期清理。
- 删掉：桥接的敲钟（`bridge.mjs:235-240`、`:270-272`、`/api/internal/wechat/tick`）、Agent 服务的敲钟（`server.mjs:93-129`、`:261`）、Cloudflare Cron（`worker/index.ts:9-14`）。
- 桥接取发送任务的 20 秒轮询（`bridge.mjs:274`）和 Agent 服务取活的轮询不是闹钟，它们是「搬运」：没有判断「该不该」的逻辑，判断都在网站。
- 为什么这是合法的：「到点了该不该叫醒」是 p.20 的「Agent 启动之前」；过期、租约、清理是「基础设施」。

#### 桥接只当搬运工

桥接只做：连 wx 或 iLink、管游标、把原始信封送给网站、取发送任务、幂等地发出去、回执、限速和 @ 被拒时刷新成员（审查报告 01「哪些换不掉」）。

删掉：定时（上面）、看图配对（`bridge.mjs:295-539`，约 245 行，是 `PHOTO_PAIR_MS` 和照片上传那套）、`X-Weave-Photos` 心跳、判断谁绑定了。信封里带上类型、文字、引用、附件清单，由网站决定要不要。iLink 那条分支（`feat/ilink-private`）已经让照片成为单独一条消息、带 `channel` 区分桥接，和这里的 `inbox.channel`、`deliveries.channel` 对得上，不冲突。

「一轮 = 同一个人在同一个聊天里一阵子连着发的几条」（审查报告 01）：`rounds` 可以挂多条 `inbox`，`not_before` 等于「最后一条之后停几秒」。这一步 **只留好位置，默认等待 0 秒，行为和现在一样**；打开它是第三步的事（第 8 节）。

#### 网页变成「门」

- `POST /chat`：写 `inbox` + `messages` + `rounds`，回 `202 {messageId, roundId}`。不再等回复（取代 `api.mjs:240`、`dispatcher.mjs:130-143`）。
- 页面拉 `GET /api/messages?after=<seq>`：只要游标之后的新消息，带每条的送达状态，以及当前这一轮的状态（`queued` / `running`），用来显示「Weave 在想」。有轮在跑时 2 秒一次，没有时沿用 5 秒（草稿）。
- 现在的「按文字一样对上服务器那条」（审查报告 01）不再需要：本地气泡用 `messageId` 对。
- 页面要同时认得新旧两种回复形状（旧的 `{reply}`，新的 `{accepted}`），这样回退只需要关开关。

### 3.6 聊天记录进快照

- 快照里加两张表，格式由快照自己带建表语句（审查报告 02 第 5 点：现在表结构在 `agent-service/snapshot.mjs:23` 和 `lib/weave/agent-snapshot.mjs:12` 各写一份，漏改一边每一轮都回 503）。
  - `messages`：`seq`、`role`、`source`、`text`、`at`、`proactive`、`delivery`（`shown` / `queued` / `sent` / `failed` / `uncertain` / `expired`）、`round_id`、`reply_to`、`note`。窗口：最近 14 天、最多 500 条（草稿；群的上下文现在是 14 天 50 条，`wechat.mjs:13`）。
  - `rounds`：最近 7 天，只有 `type`、`at`、`outcome`、`spoke`、`work_log`（截短）。这样跟进或定期看看那一轮能自己查到「我上一次看过、没说话」，不用靠 `person.proactive.log`（30 条，在人的文档里）。
- 群那一轮的 `messages` 就是群的聊天（用成员编号），取代 `group_messages`（`agent-snapshot.mjs:50`）。群那一轮永远看不到本人的任何东西（沿用 `agent-snapshot.mjs:26` 的原则）。
- `mirroringRpc`（`snapshot.mjs:224`）今天在写工具成功后把变化同步进快照。`send_message` 成功时也要把这一句追加进 `messages`，这样模型在同一轮里看得到自己刚说的话。
- 这不是新记忆：教材 p.47「不要重新自己做一套记忆机制」，记忆仍然是工作目录里的 `MEMORY.md`。`messages` 是网页上已经在显示的那份记录。教材 p.16「查数留 SQL」：模型自己写 SQL 查它。
- 会话仍然可以按天切来省钱。切了也不丢东西，因为聊天记录一直在表里。**这一步不动「按天切」和 `HANDOFF.md`**，它们不再是承重墙，要不要换成 SDK 的自动压缩留到有评测以后。
- 照片那一轮的「看到了什么」：这一轮不存会话（`runner.mjs:43`），下一轮靠 `messages` 接上。做法：提示词让最后一段话（工作记录）写「看到了什么」，网站把它存进那条「[照片]」消息的 `note`。是否可行要第三步用真模型验证（第 8 节不列，先记在风险里）。

### 3.7 自查：每段传统代码属于哪个合法位置（教材 p.21）

| 目标设计里的代码 | 属于哪个位置（p.20） | 说明 |
| --- | --- | --- |
| 门写 `inbox` / `rounds`、闹钟建轮、`gate`（档位、时段、次数、Jev、过期） | ① 启动之前（预处理） | 只回答「该不该醒」，不在循环里 |
| 取工作单、租约、回报、重试、`dedupe_key`、保留期清理 | ② 基础设施 | 网关、计费、鉴权同类 |
| `send_message` 的长度、安静时段、每天上限、收件人由通行证定 | ② 基础设施（工具后端） | 规则在后端，模型不听话也成立（`docs/ARCHITECTURE.md` 规则 1） |
| 写账（工具调用记账、`deliveries` 状态） | ③ Hook / 副作用：审计 | 代码百分之百做，不靠模型自觉（p.53） |
| `fallback`：提醒必须送到 | ③ 保证某个副作用一定发生 | p.54 的判据：这是「保证」，不是「防止蠢事」 |
| 直接轮没说话 → 发系统话 | ② 基础设施（通知） | 说的是系统话，不替模型说话 |
| 群 / 本人范围、工具集、`scopes.mjs` 的内置工具 | ② 基础设施（权限） | p.56「读权限和动作权限分开授权」 |
| `DIRECT_SEND_TEXT` 这类保险、直接轮绕过规则、最后一段话兜底 | **都不属于四个位置 → 删** | p.21「不属于的，为什么存在？」 |
| 类型表里**没有**的东西 | — | 没有「第一步做 A、第二步做 B」，没有轮数上限（p.15、p.22），工具集里没有流程 |
| 人把关前的暂存（p.20 位置 ④） | 不是新增 | 她在网页确认的事（共享时间、确认活动、确认计划）仍然是 Agent 没有工具可调的，不动 |

留一个要诚实说的：「每轮最多 5 条」是我加的防失控上限，属于基础设施里的限流，不是「轮数上限」（那个指的是模型循环的次数，p.22）。如果她觉得这条也不该有，去掉对别的设计没有影响（第 8 节）。

### 3.8 这一步不做

- 看图、引用、语音、文件（第三步，这里只占好位置）。
- 评测本身（只建账和标签表，不写评委）。
- 群里照片记成打卡（第三步，类型表里已经预留一行）。
- 改「按天切会话」和 `HANDOFF.md`。
- 改 SDK 的会话存放（`SessionStore`）。
- 改 Jev 的实现（只改成「记分不拦」的建议）。
- 网页上「运行记录」页面（开发者模式的页面，等账里有数据再说）。

## 4. 迁移

原则：**放在开关后面，先切私聊，再切群，最后切网页；旧代码到最后才删。**

### 4.1 开关

一个设置 `WEAVE_ROUNDS`，值是名单，不是布尔：`off` 或 `private`（私聊）、`group`、`web` 的组合，加一个账号白名单。先只有主人自己的测试账号。开关读的地方只有一处：门在写账之前决定走新路还是旧路。

### 4.2 阶段

| 阶段 | 做什么 | 怎么验证 | 怎么回退 |
| --- | --- | --- | --- |
| **0 影子记账** | 旧路径照常跑，同时往 `rounds` / `round_events` 记一份（类型按旧开关反推）。不改任何行为 | ① 每一轮旧路径都有一行账；② 反推出的类型和表对比：看有没有工具被调过却不在该类型的工具集里（正好验证 `owner-background` 的窄表）；③ 看了一周的 `rounds`：有没有卡住的、没有结果的；④ `messages` 表和 `person.messages` 对账 | 关记账即可，没有行为变化 |
| **A 私聊** | 主人自己的账号：私聊（微信 + 网页以外）的轮走新路：门记账 → 取工作单 → 回报；说话改 `send_message`；`deliveries` 接管微信发送回执。`speech: 'tool'` | 自动：类型表、状态机、幂等、僵尸尝试、过期、送达、系统话兜底（第 5 节）。真机清单（主人跑）：发一句；连发三句；发照片；让它设提醒再等到点；等一次跟进；杀掉容器（`docker kill`）看 `lost` 和重试；重启网站和 Agent 服务各一次。账上的检查：无 `running` 超过租约、每个直接轮要么有 `spoke ≥ 1` 要么有系统话、`deliveries` 都落到终态。稳定 7 天且没有卡住的才进下一阶段（天数第 8 节定） | 先等队列排空（`queued` 为 0），再关开关；紧急回退：关开关，剩下的 `queued` 直接轮用一个脚本发系统话「这条没有处理，请再发一次」。旧路径代码一直在，`person.messages` 一直在写，所以不丢数据 |
| **B 群** | 白名单里的群走新路：`group-ask` 走 `send_message`，第一条 @ 提问的人；群消息进 `messages`（正文仍 `seal`） | 重现 #43：一次 @ 只出一条回复；@ 谁；关群后收件、消息、轮、账全删；「别记」没进账；开启的群、没开启的群各一个；群的快照看不到任何本人数据 | 按群关开关 |
| **C 网页** | `POST /chat` 回 202，页面按游标拉；同时认新旧两种形状 | 浏览器端到端（教材 p.66 用浏览器验证）：发送后立刻出气泡；「在想」状态；回复出现；刷新不丢；等回复时能发下一句（现在不能，`chat-send.mjs:22`）；断网重连 | 关开关，页面照旧走旧形状 |
| **D 清理** | 稳定 14 天（草稿）后删旧代码（4.3） | 全部测试；账上无异常；`grep` 确认 `DIRECT_SEND_TEXT`、`processInboundSdk`、`/wechat/tick` 等都没了 | 靠 git 回滚这一个 PR；开关已经没有「旧」可回 |

### 4.3 阶段 D 要删的

`processInboundSdk`、`claimNext`、`markUncertain`、`ORPHAN_MS`（`wechat.mjs:283-369`）；`dispatcher.mjs` 里同步的 `wake` / `wakeForMessage` / `wakeForGroup`、`REPLIES.busy`、`DIRECT_SEND_TEXT`、`NOT_STARTED`；Agent 服务的 `/wake` 同步接口和 `queue.mjs` 的 429；`TICK_BUDGET_MS`、`START_BY_MS`、三份超时公式；桥接的 tick、看图配对、`X-Weave-Photos`；Agent 服务的敲钟；Cloudflare Cron；`runScheduledSdk` 的拼装（`scheduler.mjs:43-61`）；人文档里的 `proactive.{sent,wakes,checksDone,running,log}`、`closing`、`closedDay`、`agentDay`、`toolReceipts`（计数改从账里算：今天后台醒了几次 = 今天这个人 `follow-up` / `check-in` 且计数的轮的个数；今天主动说了几句 = 今天 `proactive` 的 `messages`。少一份可以漂移的真相）；通行证的 `direct`、`purpose`；`prompts.mjs` 的 `speech` 开关和 `KINDS`；`person.messages`（读它的地方改读 `messages`：`proactive.mjs:91-102`、`:373-388`、网页状态）。

### 4.4 和其他分支的顺序

正在进行的四条分支和我们碰同一批文件（`dispatcher.mjs`、`wechat.mjs`、`capability.mjs`、`agent-tools.mjs`、`scheduler.mjs`）。顺序：

1. 先合：`chore/delete-legacy-paths`（越早越好，少一块要迁的）、`feat/reminders-by-weave`、`feat/bind-greeting-by-weave`。
2. 阶段 0 和快照加 `messages` 是**加法**，放在新目录 `hosted/lib/weave/rounds/` 和新表里，基本不改这些文件，可以和它们并行。
3. `feat/ilink-private`（暂停中）：阶段 A 的私聊切换要和它协调。它的 `channel` 概念直接对应账里的 `inbox.channel`、`deliveries.channel`。建议它先落地到私聊能跑，再切新路；也可以反过来。
4. 第一步（SQLite）：阶段 0 之后的各步要它。快照加 `messages`（5.7 的 PR 1）不依赖它：可以先从 `person.messages` 读。

## 5. 测试计划

沿用现有的做法：`test/*.test.mjs` 是网站这一侧的，`hosted/agent-service/test/` 是 Agent 服务的，假模型（`queryFn`）不花钱（`hosted/agent-service/test/helpers/harness.mjs`）。

**类型表**（数据测试）
- 每种类型的每个字段都在；工具集里的名字都是 `TOOL_DEFS` 里有的（和 Agent 服务那边的同步测试）；`direct: true` 的类型工具集里一定有 `send_message`；不存在「能说话但没有 `send_message`」的类型；`gate` 和 `send_rules` 引用的规则名都存在。
- 「按表重放」：把现有的 `proactive.test.mjs`、`day-close.test.mjs`、`wechat-late-delivery.test.mjs` 的用例改成对类型表参数化，行为数字（2 小时、6 小时、档位上限）不变。

**状态机和幂等**（网站）
- 取工作单：先到先得；同一个人同一时间只有一个 `running`；`not_before` 没到不取；过期的不取。
- 租约到期 → `lost` → 有副作用不重试，没有副作用重试一次；重试后旧尝试的工具回调和回报被拒。
- `finish` 重复调用返回同样结果；`attempt` 不对的被拒。
- 两个闹钟同时建轮：只有一行（`dedupe_key`）。
- 网站在中途重启：`running` 的轮恢复成「等租约」。

**工具后端**
- 每种类型：不在工具集里的工具回 403；`send_message` 的规则按类型生效（直接轮不受上限，后台轮受档位 / 时段 / 上限 / 冷却）；每次调用的规则检查、效果、`round_events` 在一个事务里（人为让效果失败，账也不留）。
- 群 @：一次只有一条；第一条带 @；收件人只能是通行证里那个群。
- `reminder` 兜底：模型不说话 → 补发原句且 `fallback_used`；模型说了 → 不补发。
- 直接轮成功但没说话 → 系统话，`spoke = 0`。

**送达**
- 回执改 `deliveries.status`，聊天里的送达状态由联查得到；租约到期用同一个幂等键重领，不重发；`expires_at` 过了 → `expired`；失败和不确定在网页能看到。

**Agent 服务**
- 取活循环：有空位才取；`nudge` 能唤醒；网站不可达时退避；`finish` 失败重试，不重复执行这一轮。
- 带 `speech: 'tool'` 的提示词和文档第 5 节一致（同步测试）。
- 工作单里的工具集决定实际给模型的 MCP 工具（用假 `queryFn` 检查传进去的 `mcpServers`）。

**快照**
- `messages` 和 `rounds` 的建表语句由快照自带；行数和窗口；群那一轮没有任何本人数据（扩展 `agent-snapshot-group.test.mjs`）；`send_message` 成功后同一轮的快照里有这句话。

**迁移**
- 影子记账：用录下来的旧路径夹具跑一遍，每一轮都得到一行账，类型和预期一致。
- 开关：`off` 时和现在一模一样（跑现有全部测试）；白名单外的账号走旧路。
- 回退：中途关开关后，旧路径接得上。

**真模型冒烟**（要钱，**先报价，等主人点头**）
- 先跑最便宜、能下结论的一件事：`deepseek-flash` 在 `chat` 轮里，是否调用 `send_message`、是否只调一次、有没有把「给自己看的总结」也发出去。样本 20 句，覆盖问候、记录、设提醒、闲聊、群里 @。金额等我按 `usage.json` 里单轮的平均 token 算好再报，现在不假设。
- 再一件：同一个会话里，前一轮用过 `set_reminder`、这一轮的工具集里没有它，`resume` 之后 CLI 和模型会不会出问题（第 6 节）。这条用假模型先测 CLI 不报错，真模型的行为再花钱测。

## 6. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 模型在直接轮忘了调 `send_message` | 对方收不到回复 | 指标 `direct_silent_rate`；系统话兜底；上线前真模型冒烟；开关可回退。**这是最大的一条** |
| 每一轮的工具集不同，同一段会话 `resume` 时历史里调过现在没有的工具 | CLI 或模型可能出错。现在所有轮工具集相同，没碰过这个情况。`docs/ARCHITECTURE.md:177` 的实测只说「调没给的工具报 No such tool」，**`resume` 的情形没有核实** | 先用假模型验证；再真模型测；不行就让后台轮一律分叉（现状已经分叉，`runner.mjs:40`），直接轮的工具集保持一致 |
| 切换瞬间排队中的消息 | 丢或重复 | 阶段 A 等队列排空再切；按 `inbox.id` 去重；关开关前同样排空 |
| `finish` 回报丢了或重复 | 状态错乱 | 按 `runId` + `attempt` 幂等；僵尸尝试被拒；租约兜底 |
| 新旧双写漂移（`messages` 和 `person.messages`） | 两边对不上 | 阶段 0 起每天对账；阶段 D 才删旧的 |
| 网页变成 202 + 轮询 | 手感变化；等回复多了 ≤ 2 秒 | 「在想」状态；叫一声减少延迟；页面认两种形状，可回退；阶段 C 最后做 |
| 账变大、长期留存她的话 | 隐私和体积 | 30 天 / 1 年分层；注销、关群即删；备份保留期不超过账；只在本机 |
| 依赖第一步 | 第一步晚了，闹钟没处放 | 表在 D1 上也能建；闹钟退而放 Agent 服务那个敲钟；见 3.3 |
| 和四条在途分支冲突 | 合并麻烦 | 4.4 的顺序；新代码放新目录 |
| 费用记不准（SDK 的价目表是内置的） | 账里的费用不可信 | 按 token 和我们自己的价目表算；SDK 的 `total_cost_usd` 只作参考 |
| 「看到了什么」那句靠最后一段话写，模型不一定写 | 照片轮的下一轮记不住 | 第三步用真模型验证；不行就让 Agent 调一个很小的工具记它 |
| 把评测做大 | 偏离这一步 | 只建账和标签表；评委留到账里有数据 |
| 每轮最多 5 条是我加的数 | 可能误拦长对话里的合理多条 | 草稿数字；先观察账里的真实分布；可以不要 |

## 7. 实施顺序（分几个 PR）

每个 PR 都能单独合、单独回退。除 PR 3、4 有顺序外，其余可调。

| PR | 内容 | 依赖 | 风险 |
| --- | --- | --- | --- |
| 1 | **快照加 `messages`（和 `rounds` 的占位）**：先从 `person.messages` 读；快照自带建表语句。不依赖任何新东西，对模型的帮助最直接（审查报告 02 说这是「第二件，便宜」） | 无 | 低。模型看到的东西变多，要用真模型看一眼行为有没有变 |
| 2 | **类型表 + 五张表的建表 + 影子记账**：新目录 `hosted/lib/weave/rounds/`；旧路径同时记账；通行证先并存 `type`，不删 `purpose` | 提醒、绑定两条分支合了更好；第一步（SQLite）或先用 D1 | 低，不改行为 |
| 3 | **工作单接口 + Agent 服务取活 + 回报 + 租约 + 网站闹钟 + 导出脚本**：全在开关后面，默认关 | PR 2 | 中，新的主干，但不开就不影响 |
| 4 | **唯一出口 + 按轮建工具 + `deliveries` + 私聊切换（阶段 A）**：`speech: 'tool'`，提示词改（等主人确认原句）；桥接回执写 `deliveries` | PR 3；真模型冒烟 | **高**，每条私聊都走这里。先只开主人自己的账号 |
| 5 | **群切换（阶段 B）**：`group-ask`、群 `messages`、关群删账 | PR 4 稳定 | 中 |
| 6 | **网页切换（阶段 C）**：202 + 游标 + 页面改 | PR 5 稳定 | 中，页面手感 |
| 7 | **清理（阶段 D）**：删旧路径、计数改从账算、删通行证的 `direct` / `purpose`、删 `person.messages` | 稳定 14 天 | 中，删得多；全靠测试 |
| 8 | 第三步（另写设计）：看图、引用、语音、文件进同一个入口；连发合并打开；聊天记录和快照的细节；每轮记录攒评测 | PR 7 | — |

## 8. 需要主人定的事

每条后面是我的推荐。

1. **唯一出口选 `send_message`，最后一段话降为工作记录。** 推荐：选。这意味着 `prompts.mjs:9`「底线」里她确认过的两句话要改。我给了草稿（3.4），请她确认或改写；`DIRECT_SEND_TEXT`（「把话写在最后一段就行。」）在切换完成后删掉。
2. **直接轮没说话时的兜底是一句系统话，不用最后一段话。** 推荐：沿用 `REPLIES.uncertain` 的意思（`dispatcher.mjs:26`）。请她确认这句话。
3. **提醒到点由 Weave 说，但它这一轮没说话（或一直失败）时，代码补发原句「提醒你：…」。** 推荐：补发，因为这是答应过的事（教材 p.53 的「保证副作用」）。要和 `feat/reminders-by-weave` 的设计对齐。
4. **账的保留期。** 推荐：详细内容 30 天、骨架 1 年，注销和关群立即删；第一步的备份保留期不超过这个。数字是草稿，请她定。
5. **谁的账可以拿来评测。** 推荐：默认只看她自己的账号；别人的账号只看骨架指标，文字要在隐私页写明并得到同意（开发者模式）。群里别人的话默认不进评测。
6. **要不要存快照副本，用来复现「记得对不对」。** 推荐：只给开了开发者模式的账号存，7 天。
7. **切换节奏。** 推荐：私聊只开主人自己的测试账号，稳定 7 天且没有卡住的轮再开群，再开网页，全部稳定 14 天再清理。她定天数和第一批账号。
8. **连发几句合成一轮（等几秒）。** 推荐：这一步默认 0 秒（行为不变），第三步再打开，默认等 4 秒（草稿数字）。
9. **Jev 怎么办。** 推荐：先放成影子模式，照样问、分数记进账、不拦；等账里有「该不该开口」的数据再决定拦不拦（它和教材 p.25 有张力）。
10. **直接轮的发送规则宽到什么程度。** 推荐：直接轮不受档位、安静时段、每天 20 条、24 小时同句冷却（有人在等就要回），只留「每轮最多 5 条」防失控；数字是草稿，她也可以要求去掉。
11. **如果第一步（SQLite）晚了，要不要先在 D1 上建账。** 推荐：先做阶段 0 之前的两件事（PR 1、PR 2，在 D1 上建表也行），闹钟那一块等第一步，不为这个在旧底座上多做一套闹钟。
