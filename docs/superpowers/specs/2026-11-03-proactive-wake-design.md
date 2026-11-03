# Weave 主动服务（第二块）设计

状态：草稿（2026-11-03）。叠在 PR #34（前端 v3 第一块，`feat/frontend-v3`）上，分支 `feat/proactive-wake`。
目标：Weave 不只在你找它时回话，还会按你交代的时间提醒你，按它自己安排的时间来看看你，没有值得说的就不打扰。

## 1. 这次做什么、不做什么

**做：**

1. **重复提醒**：`set_reminder` 加 `repeat`（每天 / 每周 / 每月）。到点原样发一句「提醒你：…」，不叫醒模型、不花钱。
2. **跟进**：Agent 自己排「什么时候再来看看」（`schedule_wake`），到点在后台叫醒它，它决定说不说。
3. **定期看看**（心跳）：按档位每天固定几个时间叫醒它看看你的进展，没事就不说。
4. **档位**：多找我一点 / 少找我一点 / 别主动找我。网页上点，或者在聊天里跟它说（`set_proactivity`）。
5. **服务器自己的闹钟**：Agent 服务每分钟敲一次网站的 `/api/internal/tick`，不再依赖 Mac 桥接。
6. **后台那一轮不弄坏聊天**：从当天的会话分叉出去，成功了接上，失败了原会话不动。
7. 助理主页「提醒」栏：列出接下来的安排（只响一次 / 每天 / 每周 / 每月），可删除、可暂停；顶部是档位。

**不做（以后）：** 事件触发（朋友确认活动等）、打卡群里的定时、主动消息带快捷回复按钮、Jev 影子记分（第 7 节）、安静时段在网页上改、记忆「忘掉」。

## 2. 参考的产品怎么做

| | 什么时候醒 | 没事怎么闭嘴 | 用户怎么控制 | 防失控 |
| --- | --- | --- | --- | --- |
| Meta Muse | 定时 + 事件（日历连接器变化会通知它）；设置里有「Heartbeat — Every 30 minutes」 | 官方：「notifies you only when something is meaningfully new or needs your input」 | 一句话「turn it off, dial it down, or dial it up」；头像 → Upcoming 看排期 | 发邮件、买东西默认要批准 |
| OpenClaw | 心跳默认 30 分钟；10-22 起并入普通自动化任务 | 早期靠暗号 `HEARTBEAT_OK` / `NO_REPLY`，issue #142588：27 次心跳 26 次照样发了；改成结构化 `no_change` 一定不投递 | `activeHours`；模板写了开口 / 闭嘴的条件（23:00–08:00 除非紧急、距上次 <30 分钟不说） | 前台工作优先 |
| Hermes Agent | Agent 自己调 `cronjob_manage` 建任务，每 60 秒 tick；另有会话心跳（只在空闲时跑，在原会话里） | `[SILENT]` 标记 | 列出、暂停、恢复、删除 | 定时任务在新会话里跑，默认不能再建定时任务；漏跑有宽限，积压合并成一次；租约 + 执行账本保证每个时段最多一次 |
| Claude Tag | 计划任务（routine）、跟进某个 PR / 频道（7 天没动静就结束） | 写在任务指令里（「posts only when something changed」）；没被 @ 时「什么都不做是常态」 | `@Claude !scheduled` 列出，用自然语言改、停；「Respond automatically」开关 | 记下大家理不理它的主动回复，被忽略就少说；月度和按频道的花费上限 |
| Grok Bot | 定时或事件 routine（两次至少隔 5 分钟），主 Bot 自己来问 | 窄触发 + 每次运行都花额度 | 建 routine 时确认 6 件事 | 主动产生的邮件只能存草稿 |

出处：Muse、OpenClaw、Grok Bot 是 10-20 到 10-28 读过的官方页和源码（introducing.muse.ai、meta.com 帮助中心、docs.openclaw.ai/gateway/heartbeat、openclaw 仓库 #142588 / #179387 / #180192、docs.x.ai）；Hermes 和 Claude Tag 是 11-03 子 Agent 读的官方文档和源码（hermes-agent.nousresearch.com/docs 的 Cron、Cron Internals、Heartbeat 三页，NousResearch/hermes-agent 的 `cron/scheduler.py`；claude.com/docs/claude-tag 的 proactivity、when-claude-responds、how-it-works、set-spend-limit 几页），我没逐条复核。

**Weave 取了什么：**

- 三种主动方式和 Muse 的 Upcoming 一样摆在一起给人看（助理主页「提醒」栏）。
- 闭嘴不靠暗号：没人找它的一轮，只有调用 `send_message` 才发得出去（架构第 2 节，已实测），避开 OpenClaw #142588 那种坑。
- 一句话调档位（Muse），网页上也能点。
- 被忽略就少说（Claude Tag）：连着两条主动消息没回，就先停掉「定期看看」，等你下次说话。
- 每个时段最多跑一次、漏跑有宽限、积压只补一次、用租约防两个 tick 抢同一件事（Hermes）。
- 后台那一轮不能再排重复的跟进（Hermes 默认不让定时任务再建定时任务；我们放宽到「可以排一次性的」）。

## 3. 教材怎么说

- p.20：「相信 Agent 不等于没有代码。代码合法的位置有四个」，第一个是「Agent 启动之前 预处理。不在循环中间，不影响灵活性」，第二个是「基础设施 网关、计费、鉴权、多模型」。
  → 「到点了、该不该花这次钱叫醒它」放在叫醒前的代码里（tick 和 `proactive.mjs`），醒了做什么、说不说，交给 Agent。
- p.16：「查数留 SQL，不要封成 MCP」。
  → 不做 `list_schedule`，排期放进快照的 `schedules` 表，Agent 写 SQL 查。
- p.55：「判据：动作可逆、不碰生产数据，就全自动。动作不可逆、碰业务数据，就暂写 + 确认。」
- p.56 动作三级：「预览 展示将要做的事，用户不反对就做」；「确认 暂写，人点确认 写入业务数据、对外发消息、高风险决策」；「只有第三级是错的做法，它让 Agent 什么都要人点一下，那还叫什么 Agent。」
- p.55：「什么时候问人 动作不可逆时问；信息缺失时自己找；判断有分歧时给选项。问太多用户烦，问太少 Agent 错。」
- p.26：「一个 Agent 是最好的」；「兜底的正确方式不是 auditor Agent，是人把关。」
- p.71 提到「一个负责定时分析日志」的 Agent，产品形态「不叫定时任务，叫『端到端自动化 loop』」（讲的是评测平台）。
- **教材没写的：** 主动打扰、心跳、安静时段、打扰频率。这部分按上面几家产品的做法定，数字都是草稿。

**和教材不一致、要她定的一处：** p.56 把「对外发消息」放在「确认」档。主动消息是发给本人自己的，收件人由系统定、模型选不了，所以我按「预览」档做（直接发，有档位、安静时段和每日上限兜着）。**我的看法：** 发给本人不算「对外」；每条都要她点确认，主动提醒就没有意义了。设提醒、排跟进是她自己 Weave 里的数据，可删、可暂停，按 p.55 属于可逆，直接写。

## 4. 设计

### 4.1 三种主动方式

| | 谁排的 | 到点做什么 | 花不花钱 | 受不受档位、安静时段管 |
| --- | --- | --- | --- | --- |
| 提醒（只响一次 / 每天 / 每周 / 每月） | 她让 Weave 设的（`set_reminder`） | 原样发「提醒你：…」到聊天和微信 | 不花 | 不受（她交代的时间就是她要的时间，安静时段也照响） |
| 跟进 | Weave 自己排的（`schedule_wake`，只响一次 / 每天 / 每周） | 后台叫醒 Weave，它看了情况决定说不说 | 花一轮 | 受 |
| 定期看看 | 档位决定（不存成一条排期） | 后台叫醒 Weave，看看今天的进展 | 花一轮 | 受 |

只响一次的提醒照旧存在 `person.reminders`（#34 的样子不变）；重复提醒和跟进存在新的 `person.schedules`。

### 4.2 档位（数字是草稿，待她定）

| 档位 | 网页上叫 | 每天定期看看 | 时间（允许时段默认 09:00–21:00） | 每天最多主动说几句 | 每天最多后台醒几次 |
| --- | --- | --- | --- | --- | --- |
| `off` | 别主动找我 | 0 | — | 0 | 0 |
| `low` | 少找我一点 | 1 | 19:30 | 1 | 2 |
| `normal`（默认） | （默认） | 2 | 10:00、19:30 | 2 | 4 |
| `high` | 多找我一点 | 4 | 10:00、13:00、16:30、19:30 | 4 | 8 |

- 时间按本人时区（`profile.timezone`）。允许时段改了，时间按规则跟着变：早上那次 = 开始后 1 小时，晚上那次 = 结束前 1.5 小时，`high` 中间两次平均分。
- `off` 只关 Weave 自己找你（跟进和定期看看）；她让设的提醒照响。
- 「多找我一点」一次升一档，「少找我一点」一次降一档（最低到 `low`），「别主动找我」直接到 `off`。`off` 时点「多找我一点」到 `low`。
- 后台醒一次约 1.8 万 token（架构第 12 节），`normal` 一天最多 4 次约 7 万，占每账号每天 40 万额度的 18%。

### 4.3 什么时候醒（代码只判断该不该花这次钱）

每次 tick 对每个人：

1. 档位是 `off`：不醒。
2. 不在允许时段（`activeNow`）：不醒。到了允许时段再按下面的规则看。
3. 已经有一轮后台在跑（租约 15 分钟内）：不醒。租约过期没回来：记成结果不确定，放掉。
4. 今天后台醒的次数到上限：到点的跟进记成「今天次数用完」并跳过（重复的排到下一次），定期看看记成已做。
5. 先看到点的跟进（`schedules` 里 `kind: 'wake'`、`status: 'scheduled'`、`nextAt` 到了）。晚了 2 小时以上（服务器停过）就不补了：一次性的记成 `missed`，重复的排到下一次。
6. 再看定期看看：今天还没做过、时间到了、晚了不到 2 小时的那个时间点；漏了几个只补最近的一个。
7. **被忽略就少说**：从她最后一次说话（或在网页上打勾）以后，Weave 已经主动说了 2 句，就先不做定期看看，后台那一轮自己排的跟进也不跑；她在聊天里时 Weave 排的跟进照跑。她再说话就恢复。
8. **很久没来**：最后一次说话或打勾是 7 天前，就先不做定期看看（跟进照跑）。
9. 每次 tick 最多叫醒 2 轮，60 秒后不再开始新的一轮（沿用 `START_BY_MS`）；全站同一时间只跑 1 轮（服务器上 `AGENT_MAX_CONCURRENCY=1`）。

### 4.4 醒了以后（Agent 的事）

- 触发写进 prompt 当数据：`<trigger kind="timer" channel="system" direct="false" at="…">` 或 `kind="check"`（`prompts.mjs` 本来就收这两种）。
- 方法写在新 Skill `proactive-judgment` 里（架构第 5 节早就列了这个名字）。
- 只有调用 `send_message` 才算开口。没调用就是没说，这是常态。
- 后台那一轮能用的工具：`send_message`、`schedule_wake`（只能排一次性的）、`cancel_schedule`、`save_habit`、`log_completion`、`save_goal`。不能 `set_reminder`、不能 `set_proactivity`（这两件只在她亲口说的那一轮做）。

### 4.5 硬规则（工具后端，模型不听话也成立）

`send_message`，不是有人直接找它的那一轮：

- 档位 `off`：不发，告诉模型「对方关掉了主动消息」。
- 不在允许时段：不发（原有规则）。
- 今天主动说的句数到档位上限：不发。
- 原有的每天 20 条、24 小时内同一句不重发照旧。
- 发出的消息带 `proactive: true`（聊天里显示「HH:MM · Weave 主动来问」，#34 已经做好显示）；接了微信就发到微信，没接就进网页通知。

`schedule_wake`：时间必须在将来、30 天以内、落在允许时段里；一个人最多 10 条有效的跟进、排期总共最多 30 条；后台那一轮只能排一次性的。
`set_reminder`：`repeat` 不给或 `none` 时和 #34 完全一样；每天 / 每周 / 每月时存进 `schedules`。后台那一轮不能用。
`set_proactivity`：只在有人直接找它的那一轮能用。
`cancel_schedule`：能取消自己的跟进、重复提醒和只响一次的提醒。

### 4.6 会话：后台那一轮从当天会话分叉

架构第 10 节：同一个人同一个当地日期接着用同一段会话。现在一轮失败会清掉当天会话，后台那一轮要是失败（比如额度用完），她的聊天上下文就没了。

做法：`/wake` 加 `background: true`。Agent 服务对后台那一轮用 `resume` + `forkSession: true`。SDK 文档原文（code.claude.com/docs/en/agent-sdk/sessions.md）：「Fork … creates a new session that starts with a copy of the original's history. The original stays unchanged.」

- 成功：把分叉出来的会话存成当天的会话。她回「走了」，下一轮接得上 Weave 刚才问的话。
- 失败：当天的会话不动，不清。
- 每人串行（`queue.mjs`），后台那一轮和聊天不会同时跑同一段会话。

### 4.7 服务器自己的闹钟

- 网站加 `POST /api/internal/tick`：`Authorization: Bearer <AGENT_SERVICE_TOKEN>`（网站本来就有这个令牌，用来叫 Agent 服务）。做三件事：到点的提醒（只响一次的和重复的）、排进微信、后台叫醒。**不处理微信收到的消息**，那个还由 Mac 桥接的 tick 管，免得两边抢着回、回复变慢。
- Agent 服务每分钟调一次（`AGENT_TICK_SECONDS`，默认 60，0 = 关）。上一次没回来就不发下一次；超时 170 秒。
- Mac 桥接的 `/api/internal/wechat/tick` 照旧（提醒 + 微信消息），不做后台叫醒。
- Cloudflare 的 `scheduled()` 三样都做。
- **不用改服务器上的 `.env`**：令牌和地址都是现成的。合并后照常部署就生效。

### 4.8 数据和接口约定（三块代码以这里为准）

**`person.proactive`**

```js
{
  level: 'off' | 'low' | 'normal' | 'high',   // 默认 'normal'
  day: 'YYYY-MM-DD',                          // 下面几个计数的当地日期，换日清零
  sent: 0,                                    // 今天主动说了几句（不是有人直接找它的 send_message）
  wakes: 0,                                   // 今天后台醒了几次
  checksDone: ['10:00'],                      // 今天做过（或跳过）的定期看看
  running: null | {runId, kind: 'timer' | 'check', scheduleId?, since},
  log: [{at, kind, scheduleId?, outcome, spoke}],   // 最近 30 次后台醒来
}
```

**`person.schedules[]`**

```js
{
  id, kind: 'reminder' | 'wake',
  text,                         // 提醒：发给她的话（1–500 字）；跟进：Weave 写给自己的备忘（1–200 字）
  repeat: 'none' | 'daily' | 'weekly' | 'monthly',   // 提醒只有 daily / weekly / monthly；跟进只有 none / daily / weekly
  nextAt,                       // 下一次的 UTC ISO 时间
  localTime: 'HH:MM', anchorDay,   // 重复按当地钟点算（夏令时不漂）；每月按几号，那个月没有就用月底
  status: 'scheduled' | 'paused' | 'done' | 'cancelled' | 'missed',
  origin: 'chat' | 'background' | 'web',   // 在哪种轮次里排的
  createdAt, lastRunAt, lastOutcome, unsent,   // unsent：重复提醒这一次还没排进微信
}
```

**Agent 工具（本人范围）**

| 工具 | 参数 | 成功时返回的文字（JSON） |
| --- | --- | --- |
| `set_reminder` | `text`、`due_at`、`repeat?`（`none` / `daily` / `weekly` / `monthly`） | 不重复：`{"reminder":{reminder_id,text,due_at,status}}`（不变）；重复：`{"schedule":{…}}` |
| `schedule_wake` | `note`（1–200 字）、`at`（ISO，可以不写秒）、`repeat?`（`none` / `daily` / `weekly`） | `{"schedule":{schedule_id,kind,text,repeat,next_at,status}}` |
| `cancel_schedule` | `schedule_id` | `{"cancelled":{"schedule_id","table":"reminders" 或 "schedules"}}` |
| `set_proactivity` | `level`（`off` / `low` / `normal` / `high`） | `{"proactivity":{level,check_times,message_cap,wake_cap}}`，`check_times` 是 `"10:00,19:30"` 这样的文字 |

`schedule` 里的 `next_at` 是带时区偏移的当地时间（如 `2026-11-04T19:30:00-08:00`），和快照一致。

**快照（本人范围，新加两张表；群范围不给）**

- `schedules`：`schedule_id, kind, text, repeat, next_at, status, created_by, last_run_at, last_outcome`（`next_at` 带偏移的当地时间，`created_by` 就是 `origin`）。
- `proactive_settings`（一行）：`level, active_start, active_end, check_times, message_cap, sent_today, wake_cap, wakes_today`。
- 写工具成功后同步：`schedule_wake`、重复的 `set_reminder` 写进 `schedules`；`cancel_schedule` 按 `table` 改那张表的 `status`；`set_proactivity` 改 `proactive_settings` 的 `level, check_times, message_cap, wake_cap`。

**`/wake`**：请求体加可选的 `background: true`，行为见 4.6。触发是 `{kind: 'timer' | 'check', channel: 'system', direct: false, at, text}`。

**`/api/internal/tick`**：`POST`，`Authorization: Bearer <AGENT_SERVICE_TOKEN>`，请求体 `{}`。200 返回 `{delivered, routines, queued, proactive: {started}}`；令牌不对 401；网站没配 Agent 服务（不是 `WEAVE_AGENT_RUNTIME=sdk`）503。不走访问密码（和其他 `/api/internal/` 一样自己验令牌）。

**网页接口（要登录）**

- `GET /api/status` 多两个字段：`schedules`（有效的和最近 20 条结束的）、`proactive`：

```js
{
  level, activeStart: '09:00', activeEnd: '21:00', timezone,
  checkTimes: ['10:00', '19:30'], messageCap, sentToday, wakeCap, wakesToday,
  quietReason: null | 'ignored' | 'inactive',   // 为什么现在不做定期看看
}
```

  `schedules` 每条：`{id, kind, text, repeat, nextAt, status, origin, lastRunAt, lastOutcome}`。

- `POST /api/proactive/level` `{level}` → `{proactive}`。
- `POST /api/schedules/cancel` `{id}` → `{ok: true}`（只响一次的提醒照旧走 `reminders/cancel`）。
- `POST /api/schedules/pause` `{id, paused: true | false}` → `{schedule}`。恢复时排到下一个还没过的时间。

### 4.9 网页（助理主页「提醒」栏）

- 顶部：现在是哪一档、一句说明、三个按钮（多找我一点 / 少找我一点 / 别主动找我）。
- 「只响一次」：还没到点的提醒（#34 原样）+ 一次性的跟进。
- 「每天」：每天的提醒、每天的跟进，加一行「定期看看」（时间来自 `checkTimes`）。
- 「每周」「每月」：对应的提醒和跟进。
- 每条：提醒「到时候 Weave 会提醒你」、跟进「Weave 会来问问」；重复的有暂停 / 恢复；都能删。
- `quietReason` 不为空时，顶部多一句为什么现在没在定期看看。
- 去掉 #34 那句「主动提醒还没开通。…」。

## 5. 风险

- 后台一轮约 30–60 秒，全站同一时间只跑 1 轮：她刚好在那时发消息，要多等这么久。
- 每分钟多一次 tick，每次读一遍整个库（`store.mjs` 现状）。网站容器 768 MB 的内存问题原因还没查清，多出来的请求可能让它更快涨到上限（看门狗会重启）。
- 真实模型「该不该开口」判断得好不好，假模型测不了，要上线后看真实记录（`proactive.log`）。

## 6. 验收

- 根目录和 Agent 服务的测试全过，CI 绿。
- 假模型端到端：到点的跟进叫醒 Agent → 它调 `send_message` → 聊天里出现带 `proactive: true` 的一句；它不调就什么都没有。
- 两个 tick 同时跑，同一件事只醒一次。
- 后台那一轮失败，当天的聊天会话还在；成功，下一轮接上分叉后的会话。
- 上线后（她部署）：`docker logs weave-agent-1` 每分钟没有报错；助理主页能看到定期看看的时间；把档位调到「多找我一点」后一天内收到主动消息，或者在 `proactive.log` 里看到「看过、没说」。

## 7. Jev（决策模型）

现在没有用。全仓库只有架构文档第 7 节提到它，没有一行代码调用。原设计是放在 `send_message` 后端只记分不拦截（影子模式），因为教材 p.26 说兜底不该是 auditor Agent，没有标注数据也定不了阈值。要接，需要她：

1. 去 console.typesafe.ai 试能不能个人注册、拿到 Key（第三方说开放后两天就暂停了，没核实）；
2. 确认隐私说明加一句（主动消息的草稿会发给美国的评分服务），加一个单独的同意勾选。

这次的 `proactive.log` 会记下每次后台醒来「说了没有」，以后人工标注「该不该说」时就是现成的样本，Jev 有了 Key 可以直接拿这些数据比。

## 附录 A：待她确认的句子（都是草稿）

**给模型看的：**

1. Skill `proactive-judgment`（`hosted/agent-service/plugin/skills/proactive-judgment/SKILL.md`）全文。
2. `schedule_wake`、`cancel_schedule`、`set_proactivity` 的工具说明，`set_reminder` 新加的 `repeat` 说明（`hosted/agent-service/mcp/tools.mjs`）。
3. 后台叫醒时 `<trigger>` 里的两种写法（`hosted/lib/weave/proactive.mjs` 的 `TRIGGER_TEXT`）。
4. 工具后端新加的拒绝理由（`hosted/lib/weave/agent-tools.mjs` 的 `TEXT`）。

**给她看的（网页）：** `hosted/app/workspace/copy.mjs` 里标了「草稿文案，待确认。（第二块）」的句子：档位说明、三个按钮、每条的说明、暂停 / 恢复、为什么现在没在定期看看。

## 附录 B：待她定的数字和开关

| 项 | 草稿 |
| --- | --- |
| 默认档位 | `normal` |
| 各档每天看几次、几点、最多说几句、最多醒几次 | 见 4.2 |
| 被忽略几句就停 | 2 |
| 几天没来就停定期看看 | 7 |
| 漏跑多久不补 | 2 小时 |
| 跟进最远排多久 | 30 天 |
| 闹钟间隔 | 60 秒 |
| 主动消息算「预览」档还是「确认」档 | 预览（和教材 p.56 不一致，见第 3 节） |
