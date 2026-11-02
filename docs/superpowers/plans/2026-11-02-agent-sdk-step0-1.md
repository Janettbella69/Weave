# Weave 第 0–1 步：Agent SDK 核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做完架构文档第 15 节的第 0 步（真接口冒烟脚本）和第 1 步：重写 Agent 服务，接上消息和习惯两组工具和一个 Skill；网页聊天放在开关后面走新路，旧路先留着。

**Architecture:** 全仓库只有 Agent 服务（Node）调用 `query()`。每次唤醒，它按范围表建一个进程内 MCP 实例和一份 SDK 配置。CLI 在一次性容器里跑（本机开发改用 SDK 的 sandbox）。模型请求经同一进程里的模型代理，由代理换成真 Key。Weave 服务（Worker）只做四件事：叫醒、签发短期通行证、在工具后端守规则、存数据。网页聊天由 `WEAVE_AGENT_RUNTIME=sdk` 打开，不设就是旧路。

**Tech Stack:** Node ≥22.13（CI 用 24），`@anthropic-ai/claude-agent-sdk` 0.3.316（自带 CLI 2.1.316），zod 4.6.7，Cloudflare Worker + D1（vinext），`node:test`，Python 3.9+ 标准库，Docker（CI 的 ubuntu-latest）。

**Spec:** `docs/ARCHITECTURE.md`（下文的「文档」，§ 是节号）。动手前两份都读。

## Global Constraints

- SDK 版本钉死 `0.3.316`。不引入 LangGraph、LangChain、Dify，也不手写流程。代码只做三件事：叫醒 Agent、在工具后端守规则、记账（文档「硬性要求」）。
- 每次 `query()` 都带这些配置：自定义 `systemPrompt`（不用预设），`settingSources: []`，`strictMcpConfig: true`，`settings: {attribution: false}`，`permissionMode: 'dontAsk'`，`thinking: {type: 'disabled'}`（文档 §2）。
- MCP 工具只返回文字，从不返回 `structuredContent`。失败时用 `isError: true` 加一句能照做的中文。幂等键是 `extra._meta['claudecode/toolUseId']`（文档 §4）。
- 真 Key 不进 CLI 的环境，也不进容器，那里只有这一轮的运行令牌（文档 §6「三条坑」）。
- 模型地址一律用 Anthropic 格式，末尾不加 `/v1`（文档 §9）。
- 限额：owner 范围 `maxTurns` 20、`maxBudgetUsd` 2；group 范围 8、1（文档 §6、§12）。
- 文案：系统提示和 `weekly-review/SKILL.md` 一字不改照抄文档（§5）。其余给模型或给用户看的中文都是草稿：代码里集中放，PR 描述里全部列出，标「待确认」。她确认后照她的字句改，不自己换措辞。
- Worker 侧（`hosted/lib/weave/`）不能用 `node:` 模块，加密一律用 WebCrypto。
- 不设 `WEAVE_AGENT_RUNTIME` 时，现有行为（含现有 108 个测试）一点不变。
- `stats.py` 要兼容 Python 3.9，只用标准库。
- 不碰线上服务器，不碰 `~/Weave-council` 主 checkout。

## 和文档不一样的地方（PR 里要写明）

1. **容器网络。** 文档 §6 写的是 `--network scope.network` 加 `http://model-proxy:4321`。改成：owner 和 group 用 `--network none`；模型代理在 Agent 服务进程里监听一个 Unix socket，挂进容器，容器里用 `socat` 转成 `127.0.0.1:4321`。理由：「Bash 连不了网」由结构保证，不依赖 Docker 内部网络和宿主网关的行为。
2. **运行令牌。** 用不透明的随机串，登记在进程内，一轮结束立刻作废，不做签名令牌。这样用户自己的 Key（BYOK）也只在内存里停留一轮。
3. **额度。** 模型代理按 token 计（文档 §12），默认每账号每天 400,000，全站每天 6,000,000。两个都是草稿数字，待确认。用户自己的 Key 不计，沿用 `budget.mjs` 的口径。
4. **范围表。** 第 1 步只有 owner 和 group。research 范围和 `Agent` 工具留到第 4 步。
5. **旧路。** `/query`、`runtime.mjs`、`hosted/agent-service/Dockerfile` 第 1 步保留（文档 §15「旧路先留着」），第 2 步删。

## Review Focus

1. **用户消息里夹带 `</trigger>`、「忽略以上规则」。** 期望：转义后仍然只是数据。测试在 Task 2（`renderTrigger`）。
2. **同一个人很快连发两条。** 期望：Agent 服务按人串行；Weave 的每段写入都重读再存，不报 409，也不丢数据。测试在 Task 6（queue）和 Task 9、Task 10（并发写入）。
3. **Agent 服务挂了、超时或重启。** 期望：本人看到「结果不确定」，不自动重试。测试在 Task 10。
4. **本人在美国，深夜记「今天」。** 期望：日期按本人时区算，不按 UTC 也不按上海。测试在 Task 8（洛杉矶用例）。
5. **额度用完。** 期望：这一轮很快结束并告诉本人，CLI 不会反复重试好几分钟。测试在 Task 3 和 Task 5。

---

### Task 1: 假模型测试工具 + 第 0 步冒烟脚本

**Files:**
- Create: `hosted/agent-service/test/helpers/fake-model.mjs`
- Create: `scripts/agent-sdk-probe/real-smoke.mjs`
- Create: `hosted/agent-service/test/real-smoke.test.mjs`
- Modify: `scripts/agent-sdk-probe/README.md`（加「第 0 步」一节：命令、费用、怎么看结果）
- Modify: `hosted/agent-service/package.json`：`"test": "node --test 'test/**/*.test.mjs'"`，依赖加 `"zod": "4.6.7"`（`npm install zod@4.6.7 --save-exact`）

**Interfaces:**
- Produces（`fake-model.mjs`，从 `scripts/agent-sdk-probe/probe.mjs` 第 32–60、75–79 行搬过来）：
  - `startFakeModel() → Promise<{baseUrl: string, captured: Array<{path, headers, body, bytes}>, script(route, usage?), close(): Promise<void>}>`
  - `route(body) → Block | Block[]`，`Block = {text: string} | {tool: string, input: object}`。`usage = {input, output}`，默认 `{input: 50, output: 10}`
  - `steps(list) → route`：按请求里 assistant 消息的条数取第几步，只对主 Agent 请求生效（`isMain`：`body.tools` 里有 Bash 或 Read）；其他请求回 `{text: 't'}`。`list` 的元素也可以是 `body => Block`
  - `isMain(body)`，`lastToolResults(body) → string[]`
- `real-smoke.mjs` 命令行约定：
  - `SMOKE_PROVIDER`，默认 `deepseek`
  - Key 依次取 `DEEPSEEK_API_KEY`、`AGENT_PROVIDER_API_KEY`；都没有就在终端隐藏输入
  - `SMOKE_BASE_URL` 只给测试用
  - `--websearch` 多查一项 WebSearch
  - 全部 PASS 退出码 0，否则 1

- [ ] **Step 1: 写失败的测试** `real-smoke.test.mjs`：`'冒烟脚本对假接口全部 PASS'`。
  - 用 `startFakeModel()` 按步骤脚本：`mcp__weave__log_completion` → `Skill {skill:'weave:weekly-review'}` → `Bash python3 <从消息里取到的 stats.py 路径>` → `Bash python3 -c "print(6*7)"` → `{text:'完成'}`。
  - 用 `SMOKE_BASE_URL` 和 `DEEPSEEK_API_KEY=fake-key-123456` 跑 `node scripts/agent-sdk-probe/real-smoke.mjs`。
  - 断言：`exitCode === 0`，stdout 里有 4 行 `PASS`。
  - 断言：假接口收到的 `authorization` 等于 `Bearer fake-key-123456`。

- [ ] **Step 2: 运行确认失败**
  - Run: `cd hosted/agent-service && node --test test/real-smoke.test.mjs`
  - Expected: FAIL（脚本不存在）

- [ ] **Step 3: 实现 `real-smoke.mjs`**
  - 配置和文档 §2 一致，只有两处不同：`env` 直接用真地址和真 Key（第 0 步还没有代理），`maxTurns: 8`。
  - 临时插件里放 `weekly-review`（`SKILL.md` 照抄文档 §5，`stats.py` 只输出 `streak=3`）。
  - 进程内只给一个假的 `log_completion` 工具。
  - 固定 prompt：「请依次做三件事：调用 log_completion 记一次散步；用 weave:weekly-review 这个 Skill；用 Bash 算 6*7。最后回复『完成』。」
  - 四项 PASS/FAIL：
    1. 接口接受这份配置：`result.subtype === 'success'`
    2. 调到了 weave 工具
    3. Skill 加载了，参考代码跑出了 `streak=3`
    4. Bash 跑出了 `42`
  - 两项 INFO：
    - 第二轮 `resume` 问「你是谁？」，打印回答，用来人工看它是否自称 Weave
    - 带 `--websearch` 时打印 WebSearch 的结果或报错
  - 最后打印 `result.usage` 的 token 数，再按 `deepseek-flash` 官方价区间（输入 $0.15–0.30、输出 $0.60–1.20，每百万 token）估一个费用区间。

- [ ] **Step 4: 运行确认通过**
  - Run: `cd hosted/agent-service && node --test test/real-smoke.test.mjs`
  - Expected: PASS

- [ ] **Step 5: Commit** `test: add fake model helper and step-0 real-endpoint smoke script`

---

### Task 2: 范围、模型、提示词三张表

**Files:**
- Create: `hosted/agent-service/scopes.mjs`, `providers.mjs`, `prompts.mjs`
- Test: `hosted/agent-service/test/tables.test.mjs`
- Test: `test/agent-prompts-sync.test.mjs`（根目录，Worker 侧测试）

**Interfaces:**
- Produces `scopes.mjs`：
  - `SCOPES`，`scopeFor(kind) → Scope`，未知的 kind 直接抛错
  - `Scope = {kind, builtins: string[], denied: string[], tools: string[], skills: string[], maxTurns: number, circuitBreakerUsd: number, network: 'none'|'bridge'}`
  - owner：
    - `builtins` = `['Bash','Read','Write','Edit','Glob','Grep','Skill','WebSearch']`
    - `denied` = `['WebFetch','Agent']`
    - `tools` = `['send_message','list_habits','save_habit','log_completion','query_completions']`
    - `skills` = `['weave:weekly-review']`
    - `maxTurns` 20，`circuitBreakerUsd` 2，`network` `'none'`
  - group：
    - `builtins` = `['Bash','Read','Write','Edit','Glob','Grep','Skill']`
    - `denied` = `['WebSearch','WebFetch','Agent']`
    - `tools` = `['send_message']`
    - `skills` = `[]`
    - `maxTurns` 8，`circuitBreakerUsd` 1，`network` `'none'`
- Produces `providers.mjs`：
  - `PROVIDERS`，每家 `{name, baseUrl, models, main, fast, keyEnv}`：
    - deepseek：`https://api.deepseek.com/anthropic`，models `['deepseek-flash','deepseek-v4-pro']`，main 和 fast 都是 `deepseek-flash`，`DEEPSEEK_API_KEY`
    - kimi：`https://api.moonshot.cn/anthropic`，`['kimi-k3[1m]','kimi-k2.7-code']`，`KIMI_API_KEY`
    - glm：`https://open.bigmodel.cn/api/anthropic`，`['glm-5.2[1m]','glm-4.7']`，`GLM_API_KEY`
    - qwen：`https://dashscope.aliyuncs.com/apps/anthropic`，`['qwen3.7-max','qwen3.6-flash']`，`QWEN_API_KEY`
    - kimi、glm、qwen 的 main 是各自第一个模型，fast 是第二个
  - `providerFor(name)`
  - `modelAllowed(provider, model) → boolean`：去掉末尾的 `[1m]` 再比较
  - `cliEnv({provider, model, runToken, baseUrl, home, configDir, path}) → Record<string,string>`，只包含文档 §9 那些键：
    - `PATH`、`HOME`、`CLAUDE_CONFIG_DIR`、`ANTHROPIC_BASE_URL`
    - `ANTHROPIC_AUTH_TOKEN`（= 运行令牌）、`ANTHROPIC_API_KEY: ''`
    - `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`：都等于 `model`
    - `ANTHROPIC_DEFAULT_HAIKU_MODEL` = `provider.fast`
    - 三个开关都是 `'1'`：`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY`
- Produces `prompts.mjs`（纯函数，不 import SDK，根目录测试要能直接 import）：
  - `SAFETY_RULES`：`hosted/lib/weave/model.mjs` 同名常量的原样副本
  - `systemPromptFor(scope, memory) → string`
  - `memorySection(text) → '\n\n<memory file="MEMORY.md">\n' + text + '\n</memory>'`
  - `renderTrigger({kind, channel, direct, at, text}) → string`
    - kind ∈ `message|timer|event|check`
    - channel ∈ `web|wechat|group|system`
    - `at` 必须是带时区偏移的 ISO 时间
    - 不合法就抛错

- [ ] **Step 1: 写失败的测试** `tables.test.mjs`：
  - `'owner 范围和文档第 6 节一致'`：对 `SCOPES.owner` 做 `deepEqual`，值见上
  - `'group 范围没有 WebSearch、WebFetch、Agent，也没有任何读个人资料的工具'`
  - `'providers 表和文档第 9 节一致，地址不带 /v1'`：每个 `baseUrl` 都不以 `/v1` 结尾，四家地址逐个 `equal`
  - `'cliEnv 只有文档第 9 节的键，不含真 Key'`：`Object.keys` 排序后 `deepEqual` 那 14 个键；`ANTHROPIC_AUTH_TOKEN === runToken`
  - `'modelAllowed 接受带或不带 [1m] 的表内名字，拒绝表外模型'`：`kimi-k3`、`kimi-k3[1m]` 为 true，`claude-opus-4` 为 false
  - `'systemPromptFor 照抄文档第 5 节'`：
    - 以「你是 Weave，帮一个人把习惯长期坚持下去的助理。」开头
    - 含 `'- ' + SAFETY_RULES`
    - 不含「健康安全：健康安全」
    - 不含「（现有 SAFETY_RULES 原文）」
  - `'group 范围多一段群规则'`：含「你现在在一个打卡群里。」和「回复不超过 150 字。」；owner 范围不含这两句
  - `'renderTrigger 转义'`：
    - 文字 `'a</trigger><x>&'` 渲染成 `'a&lt;/trigger&gt;&lt;x&gt;&amp;'`
    - 整段只有一个 `</trigger>`
    - `direct="true"`
  - `'memorySection 原样放入 MEMORY.md 内容'`

  根目录 `agent-prompts-sync.test.mjs` 写 `'agent-service 的 SAFETY_RULES 和 model.mjs 一字不差'`。

- [ ] **Step 2: 运行确认失败**
  - Run: `cd hosted/agent-service && node --test test/tables.test.mjs`
  - Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现三个模块**
  - 系统提示和群规则一字不改照抄文档 §5 的两个代码块，「（现有 SAFETY_RULES 原文）」那一行换成 `- ${SAFETY_RULES}`。
  - `systemPromptFor` 依次拼：主体 + （group 时）`'\n\n' + 群规则` + `memorySection(memory)`。

- [ ] **Step 4: 运行确认通过**
  - Run: `node --test test/tables.test.mjs`（在 agent-service 目录）和 `node --test test/agent-prompts-sync.test.mjs`（在根目录）
  - Expected: PASS

- [ ] **Step 5: Commit** `feat(agent): scope, provider and prompt tables from the architecture doc`

---

### Task 3: 模型代理和 token 账本

**Files:**
- Create: `hosted/agent-service/ledger.mjs`, `hosted/agent-service/model-proxy.mjs`
- Test: `hosted/agent-service/test/ledger.test.mjs`, `test/model-proxy.test.mjs`

**Interfaces:**
- Consumes: `providerFor`, `modelAllowed`（Task 2）；`startFakeModel`（Task 1，当上游）
- Produces：
  - `createLedger({file, now = () => Date.now()}) → {used(account): number, total(): number, add(account, tokens): void}`
    - 按 UTC 日期计，文件内容是 `{day, accounts}`
    - 写临时文件再 rename；跨天清零
  - `createModelProxy({keys, upstreams?, ledger, limits: {perAccount, total}, fetcher = fetch}) → {handler(req, res), openRun({account, provider, model, userKey?}) → {token, close()}}`
    - `upstreams` 只给测试用，用来覆盖 `baseUrl`
    - 令牌是 24 字节随机数的 hex，登记在进程内的 `Map` 里；`close()` 之后立即失效
  - 错误一律用 Anthropic 格式：`{type: 'error', error: {type, message}}`
- 规则按顺序：
  1. 只接受 `POST /v1/messages` 和 `POST /v1/messages/count_tokens`，允许带查询串。其他请求 404 `not_found_error`。
  2. 令牌从 `authorization: Bearer …` 或 `x-api-key` 取，必须是一轮正开着的令牌，否则 401 `authentication_error`。
  3. `body.model` 必须过 `modelAllowed`，否则 400 `invalid_request_error`。
  4. 计费的一轮（没有 `userKey`），本账号或全站已经到额度时，返回 429 `rate_limit_error`，带响应头 `x-should-retry: false`。文案草稿：「今天的模型额度用完了，明天再来。」
  5. 请求体超过 8 MB 返回 413。
  6. 转发到 `上游地址 + 原路径`。只带 `content-type`、`anthropic-version`、`anthropic-beta` 三个头，再加 `authorization: Bearer <真 Key 或 userKey>`；进来的其他头一律丢掉。状态码和响应体原样流回。
  7. 计 token：SSE 取 `message_start.message.usage` 的 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，加上 `message_delta.usage.output_tokens`；非流式取 `usage`。计费的一轮写进账本。
  8. 上游连不上返回 502 `api_error`。

- [ ] **Step 1: 写失败的测试**
  - `ledger.test.mjs`：
    - `'新实例读同一个文件，用量还在'`
    - `'换了 UTC 日期从零开始'`
  - `model-proxy.test.mjs`：
    - `'没有令牌、乱写的令牌、已经 close 的令牌都返回 401，上游一次没被请求'`
    - `'只转发 /v1/messages 和 count_tokens，其他路径 404'`
    - `'上游看到真 Key，看不到运行令牌'`：`captured[0].headers.authorization === 'Bearer real-key'`，且整份 headers 里找不到运行令牌
    - `'表外模型 400，带 [1m] 的表内模型放行'`
    - `'SSE 原样流回，token 记进账本'`：假接口 usage 是 `{input: 120, output: 30}`，事后 `ledger.used('u:a') === 150`
    - `'本账号或全站到额度返回 429，带 x-should-retry: false，上游一次没被请求'`
    - `'用户自己的 Key：转发用这把 Key，不记账'`

- [ ] **Step 2: 运行确认失败**
  - Run: `cd hosted/agent-service && node --test test/ledger.test.mjs test/model-proxy.test.mjs`
  - Expected: FAIL

- [ ] **Step 3: 实现** `ledger.mjs` 和 `model-proxy.mjs`。用 `node:http` 的 `(req, res)` 签名；流式转发用 `Readable.fromWeb(response.body)` 边转发边解析。

- [ ] **Step 4: 运行确认通过**
  - Run: 同 Step 2
  - Expected: PASS

- [ ] **Step 5: Commit** `feat(agent): model proxy that swaps run tokens for real keys and meters tokens`

---

### Task 4: weave MCP 工具薄壳

**Files:**
- Create: `hosted/agent-service/mcp/rpc.mjs`, `hosted/agent-service/mcp/tools.mjs`
- Test: `hosted/agent-service/test/mcp.test.mjs`

**Interfaces:**
- Produces：
  - `toolBackend({weaveUrl, capability, fetcher = fetch, timeoutMs = 15000}) → rpc`
  - `rpc(name, args, toolUseId) → Promise<{ok: boolean, text: string}>`
    - 发 `POST ${weaveUrl}/api/internal/agent/tools/${name}`，头带 `Authorization: Bearer ${capability}`，body 是 `{args, toolUseId}`
    - 200 时原样返回 `{ok, text}`
    - 其他状态码、网络错误、超时都返回 `{ok: false, text: UNCERTAIN}`
    - `UNCERTAIN`（草稿）：「这一步的结果不确定（可能没有执行，也可能已经执行），不要重复调用，如实告诉对方。」
  - `TOOL_DEFS: Record<string, {description, shape, annotations}>`
  - `makeHandler(name, rpc) → (args, extra) => Promise<CallToolResult>`
    - `rpc(name, args, extra?._meta?.['claudecode/toolUseId'] ?? '')`
    - 返回 `{isError: !out.ok, content: [{type: 'text', text: out.text}]}`
  - `weaveServer(toolNames, rpc) → createSdkMcpServer({name: 'weave', version: '1.0.0', alwaysLoad: true, tools})`：名字不在 `TOOL_DEFS` 里就抛错
- 五个工具的 zod 参数：
  - `send_message`：`{text: z.string().min(1).max(700)}`
  - `list_habits`：`{}`
  - `save_habit`：`{habit_id: z.string().optional(), name: z.string().min(1).max(30), identity: z.string().max(200).optional(), trigger: z.string().max(200).optional(), minimum_action: z.string().max(200).optional()}`
  - `log_completion`：照抄文档 §4，`{habit_id: z.string(), date: z.string().describe('用户当地日期，YYYY-MM-DD'), note: z.string().max(500).optional()}`
  - `query_completions`：`{from: z.string().describe('YYYY-MM-DD'), to: z.string().describe('YYYY-MM-DD'), habit_id: z.string().optional()}`
- 说明文字：`log_completion` 照抄文档「记录用户完成了一次习惯。只记用户明确说做了的，猜测不要记。」。其余四条是草稿：
  - `send_message`：「说一句话给这一轮的对象。不是有人直接找你的那一轮，只有调用它才有人看得到。收件人由系统决定。」
  - `list_habits`：「读这个人的习惯：名字、身份句、触发、最小动作。」
  - `save_habit`：「新建或修改一个习惯的身份句、触发和最小动作。改已有的要带 habit_id。」
  - `query_completions`：「查这个人在一段日期内的完成记录，返回 JSON，里面带本人当地的今天。」
- annotations：
  - `list_habits`、`query_completions`：`readOnlyHint: true`
  - 其余三个：`readOnlyHint: false`、`destructiveHint: false`
  - 全部：`openWorldHint: false`

- [ ] **Step 1: 写失败的测试** `mcp.test.mjs`：
  - `'weaveServer 只建给定名字的工具，不认识的名字报错'`
  - `'makeHandler 把参数和 toolUseId 原样交给 rpc，失败时 isError 为 true，只有文字没有 structuredContent'`
  - `'rpc 带上通行证 POST 到 /api/internal/agent/tools/<name>'`：用本地 http server 收请求，核对路径、头和 body
  - `'Weave 返回 500 或超时，rpc 返回「结果不确定」，不假装成功'`
  - `'log_completion 的说明和参数和文档第 4 节一致'`

- [ ] **Step 2: 运行确认失败**
  - Run: `cd hosted/agent-service && node --test test/mcp.test.mjs`
  - Expected: FAIL

- [ ] **Step 3: 实现** `rpc.mjs` 和 `tools.mjs`，草稿文案集中写在 `tools.mjs` 开头。

- [ ] **Step 4: 运行确认通过**
  - Run: 同 Step 2
  - Expected: PASS

- [ ] **Step 5: Commit** `feat(agent): weave MCP tools as thin shells over the Weave tool backend`

---

### Task 5: 唤醒（runner）、隔离和 weekly-review Skill

**Files:**
- Create: `hosted/agent-service/runner.mjs`, `hosted/agent-service/sandbox.mjs`
- Create: `hosted/agent-service/plugin/.claude-plugin/plugin.json`、`plugin/skills/weekly-review/SKILL.md`、`plugin/skills/weekly-review/scripts/stats.py`
- Test: `hosted/agent-service/test/runner.test.mjs`（契约测试，由探针改写而来）、`test/sandbox.test.mjs`、`test/stats.test.mjs`
- Create: `hosted/agent-service/test/helpers/harness.mjs`：起假模型和模型代理，建临时租户目录，返回 `wakeOnce(...)`

**Interfaces:**
- Consumes: Task 2 的 `scopeFor`、`providerFor`、`cliEnv`、`systemPromptFor`、`renderTrigger`；Task 3 的 `createModelProxy`；Task 4 的 `weaveServer`
- Produces `sandbox.mjs`：
  - `isolationFor({mode: 'docker'|'local', scope, dirs: {workspace, config, home}, pluginDir, proxy: {socketDir, url}, image, name, uid, gid, sandbox = true})`
  - 返回 `{cwd, pluginPath, baseUrl, home, configDir, allowedTools, sandbox?, spawnClaudeCodeProcess?}`
  - docker 模式：
    - `cwd: '/workspace'`、`pluginPath: '/opt/weave/plugin'`、`baseUrl: 'http://127.0.0.1:4321'`
    - `home: '/home/agent'`、`configDir: '/home/agent/.claude'`
    - `allowedTools: [...scope.builtins, 'mcp__weave__*']`
    - `spawnClaudeCodeProcess` 用 `spawn('docker', dockerArgs(...), {stdio: ['pipe','pipe','inherit'], signal})`
  - local 模式：
    - `cwd`、`home`、`configDir` 用真实目录；`baseUrl = proxy.url`
    - `allowedTools`：Read 换成 `'Read(./**)'`，Write 去掉，Edit 换成 `'Edit(./**)'`，其余照旧，再加 `'mcp__weave__*'`
    - 当 `sandbox === true` 时加 `sandbox: {enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: {allowedDomains: []}}`
    - 生产只传 `true`；测试为了能在 CI 跑，可以传 `false`
- `dockerArgs({scope, dirs, pluginDir, socketDir, image, name, uid, gid, env, cliArgs}) → string[]`，按顺序是：
  ```
  run -i --rm --init --name <name> --user <uid>:<gid> --network <scope.network>
  --memory 1g --cpus 1 --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges
  --read-only --tmpfs /tmp --tmpfs /home/agent:uid=<uid>,gid=<gid>
  -w /workspace -v <workspace>:/workspace -v <config>:/home/agent/.claude
  -v <pluginDir>:/opt/weave/plugin:ro -v <socketDir>:/run/weave
  -e K=V（env 里值不是 undefined 的每一项）
  <image> claude <cliArgs...>
  ```
- Produces `runner.mjs`：
  - `wake({scope, trigger, memory, provider, model, runToken, isolation, rpc, sessionId, queryFn = query}) → Promise<{outcome, reply, sessionId, tools, costUsd}>`
  - `outcome` ∈ `'success'|'error_max_turns'|'error_max_budget_usd'|'error'`
  - 配置逐项对应文档 §2：
    - `systemPrompt: systemPromptFor(scope, memory)`
    - `tools: scope.builtins`、`allowedTools: isolation.allowedTools`、`disallowedTools: scope.denied`、`permissionMode: 'dontAsk'`
    - `mcpServers: {weave: weaveServer(scope.tools, rpc)}`、`plugins: [{type: 'local', path: isolation.pluginPath}]`、`skills: scope.skills`
    - `settingSources: []`、`strictMcpConfig: true`、`settings: {attribution: false}`
    - `cwd`、`env: cliEnv(...)`，以及 isolation 给的 `spawnClaudeCodeProcess` 和 `sandbox`
    - `resume: sessionId`、`maxTurns`、`maxBudgetUsd`、`thinking: {type: 'disabled'}`
    - `hooks: {PostToolUse: [{hooks: [audit]}]}`：`audit` 把工具名记进 `tools`
    - `abortController` 10 分钟超时
  - 一直读到 `query()` 结束，取最后一个 `result`。
  - `subtype === 'success'` 但 `is_error === true` 时（接口报错，比如额度用完），`outcome` 记 `'error'`。
  - `reply`：`trigger.direct` 并且 `outcome === 'success'` 时等于 `result.result.trim()`，否则为 `''`。
  - 出异常时：如果最后一个 result 的 subtype 是 `error_*`，`outcome` 就用它，否则是 `'error'`。不重试。
- 插件文件：
  - `plugin.json`：`{"name": "weave", "version": "1.0.0", "description": "Weave 的习惯方法"}`
  - `SKILL.md`：一字不改照抄文档 §5 的 weekly-review 代码块
- `stats.py <file>`：
  - 输入是 `{"today": "YYYY-MM-DD", "completions": [{habit_id, date, ...}]}`，或者直接是一个列表；今天依次取 `--today` 参数、数据里的 `today`、`date.today()`
  - 输出 `{"today": …, "habits": {"<habit_id>": {"last7": n, "prev7": n, "streak": n}}}`
    - `last7` 统计 [today−6, today]
    - `prev7` 统计 [today−13, today−7]
    - `streak`：从今天往回数连续有记录的天数；今天还没记就从昨天开始数

- [ ] **Step 1: 写失败的测试**
  - `stats.test.mjs`：
    - `'用数据里的 today 算最近 7 天、前 7 天和连续天数'`
    - `'今天还没记不打断连续天数，昨天也没记才断'`
  - `sandbox.test.mjs`：
    - `'dockerArgs 逐项等于上面的列表，网络是 none，挂了 socket，env 里没有真 Key'`
    - `'local 模式用路径规则；sandbox 为 true 时 failIfUnavailable 也为 true'`
  - `runner.test.mjs`：local 模式，`sandbox: false`，假模型 + 真代理，`rpc` 是记录调用的桩。每条对应探针的哪一项写在括号里：
    1. `'一轮请求只带 owner 范围的内置工具和 weave 工具，Skill 只有 weave:weekly-review'`（探针 1）
    2. `'系统提示是自定义的：没有 You are Claude Code；SDK 前缀之后就是 Weave 那句'`（探针 1）
    3. `'weave 工具在 Agent 服务进程里执行，拿到 toolUseId，失败文字回到模型'`（探针 2）
    4. `'group 范围调 log_completion 得到 No such tool，rpc 没被调用'`（探针 3）
    5. `'有人直接找的那一轮，最后一段话是 reply；direct=false 时 reply 为空'`（探针 2）
    6. `'Skill 加载后能用 Bash 跑 stats.py，输出里有 last7'`（探针 2）
    7. `'Agent 用 Bash 写的 .claude/settings.json Hook，下一轮不执行'`（探针 4）
    8. `'maxTurns 到了 outcome 是 error_max_turns；熔断到了是 error_max_budget_usd；假模型只被请求预期的次数'`（探针 6）
    9. `'传入上一轮的 sessionId，能接上上一轮的对话'`（探针 7）
    10. `'Bash 读不到 Agent 服务进程环境里的真 Key；Write 写不到工作目录外'`：先在 `process.env.DEEPSEEK_API_KEY` 里放一个哨兵值，再用 Bash 跑 `env`
    11. `'额度用完时一轮在 20 秒内结束，outcome 为 error，上游一次没被请求'`
    12. `'本机 sandbox：Bash 连不了网'`：只在 macOS 或设了 `WEAVE_TEST_SANDBOX=1` 时跑，其他环境 skip

- [ ] **Step 2: 运行确认失败**
  - Run: `cd hosted/agent-service && node --test test/stats.test.mjs test/sandbox.test.mjs test/runner.test.mjs`
  - Expected: FAIL

- [ ] **Step 3: 实现** `stats.py`、`sandbox.mjs`、插件文件、`runner.mjs`。如果第 11 条显示 CLI 不理会 `x-should-retry` 仍然重试，就把代理的额度响应改成 403 `permission_error`，同时改 Task 3 的测试，并在 PR 里写明。

- [ ] **Step 4: 运行确认通过**
  - Run: 同 Step 2
  - Expected: PASS（非 macOS 上第 12 条是 skip）

- [ ] **Step 5: Commit** `feat(agent): wake() runner, isolation and the weekly-review skill`

---

### Task 6: Agent 服务 HTTP（/wake、/forget）

**Files:**
- Create: `hosted/agent-service/workspace.mjs`, `hosted/agent-service/queue.mjs`
- Modify: `hosted/agent-service/server.mjs`：重写；`/query` 照旧交给 `runtime.mjs`
- Modify: `hosted/agent-service/.env.example`
- Modify: `hosted/agent-service/Dockerfile`：`COPY` 改成整个服务目录（不含 test），保证旧路的镜像还能建
- Test: `hosted/agent-service/test/workspace.test.mjs`, `test/queue.test.mjs`, `test/server.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `createModelProxy`、`createLedger`；Task 4 的 `toolBackend`；Task 5 的 `wake`、`isolationFor`
- Produces `workspace.mjs`：
  - `scopeDirs(dataDir, kind, id) → {root, workspace, config, home}`，其中 `root = join(dataDir, kind, sha256(id).slice(0, 32))`
  - `prepare(dirs)`
  - `readMemory(dirs) → string`：文件不存在时返回 `''`；只取前 20,000 字
  - `sessionFor(dirs, localDate) → string | null`、`saveSession(dirs, localDate, sessionId)`：都读写 `root/sessions.json` 里的 `{localDate, sessionId}`
  - `forget(dataDir, kind, id)`：删掉整个 root
- Produces `queue.mjs`：
  - `createRunQueue({maxConcurrent = 3, maxPerKey = 5}) → {run(key, fn): Promise}`
  - 同一个 key 先进先出；总并发不超过 `maxConcurrent`
  - 同一个 key 排队已经到 `maxPerKey` 时，抛 `Object.assign(Error('busy'), {status: 429})`
- Produces `server.mjs`：
  - `createAgentService(config) → Promise<{server, url, close()}>`
  - config 字段：`{token, dataDir, isolation, image, weaveUrl, keys, limits, maxConcurrent, pluginDir, sandbox, fetcher, queryFn}`
  - 直接运行时从环境变量读配置（判断方式：`process.argv[1] === fileURLToPath(import.meta.url)`）
  - `POST /wake`，Bearer 是 `AGENT_SERVICE_TOKEN`，JSON 不超过 64 KB：
    ```
    {scope: 'owner'|'group', id, capability, localDate: 'YYYY-MM-DD',
     trigger: {kind, channel, direct, at, text},
     provider: 'deepseek'|'kimi'|'glm'|'qwen', model, userKey?}
    ```
    - 返回 200 `{outcome, reply, sessionId, tools}`
    - 400：参数不对，或 `model` 不在这家的表里
    - 401：令牌不对
    - 429：排队满了
    - 503：没有托管 Key，也没有 userKey；或者 docker 模式下进程是 root
  - 一次 /wake 的流程：
    1. `queue.run(scope + ':' + id)`
    2. `prepare` 目录，读 `readMemory`，取 `sessionFor`
    3. `openRun` 拿运行令牌，执行 `wake`；成功才 `saveSession`
    4. `finally` 里 `close()` 掉令牌；docker 模式下再尽力执行一次 `docker rm -f <name>`
  - `POST /forget {scope, id}`：先排进同一个 key 的队，再 `forget`，返回 `{ok: true}`
  - `GET /health` 返回 `{ok: true}`；`POST /query` 走旧路，不改
  - 模型代理：docker 模式监听 `dataDir/run/proxy.sock`（权限 0600）；local 模式监听 `127.0.0.1:0`
  - 容器名：`weave-run-<runId 前 12 位>`
  - 环境变量：
    - `AGENT_SERVICE_TOKEN`：至少 32 位
    - `AGENT_DATA_DIR`：默认 `./data`
    - `AGENT_ISOLATION`：默认 `docker`
    - `AGENT_IMAGE`：默认 `weave-agent:0.3.316`
    - `WEAVE_API_URL`：/wake 必需
    - `DEEPSEEK_API_KEY`：没有时退回 `AGENT_PROVIDER_API_KEY`
    - `KIMI_API_KEY`、`GLM_API_KEY`、`QWEN_API_KEY`
    - `AGENT_DAILY_TOKENS_PER_ACCOUNT`：默认 400000
    - `AGENT_DAILY_TOKENS_TOTAL`：默认 6000000
    - `AGENT_MAX_CONCURRENCY`：默认 3
    - `HOST`、`PORT`

- [ ] **Step 1: 写失败的测试**
  - `workspace.test.mjs`：
    - `'不同 id 的目录不重叠，id 里有 ../ 也跑不出数据目录'`
    - `'没有 MEMORY.md 时是空字符串，超长时截断'`
    - `'同一天拿到同一个 sessionId，换一天是 null'`
    - `'forget 删掉整个目录'`
  - `queue.test.mjs`：
    - `'同一个 key 串行，不同 key 并行'`
    - `'总并发不超过上限'`
    - `'同一个 key 排队满了抛 429'`
  - `server.test.mjs`（local 模式、假模型、假 Weave 后端）：
    - `'/wake 没有令牌或令牌错误时 401'`
    - `'未知范围、日期格式不对、trigger 缺字段、模型不在表里都是 400'`
    - `'/wake 跑通：假模型调 log_completion，假 Weave 后端收到带通行证的请求，返回 reply 和 sessionId'`
    - `'同一个人同一天第二次 /wake 接上会话'`
    - `'/forget 删除这个人的目录'`
    - `'没有托管 Key 也没有 userKey 时 503，CLI 没有启动'`

- [ ] **Step 2: 运行确认失败**
  - Run: `cd hosted/agent-service && node --test test/workspace.test.mjs test/queue.test.mjs test/server.test.mjs`
  - Expected: FAIL

- [ ] **Step 3: 实现** 三个模块，并更新 `.env.example` 和 `Dockerfile`。

- [ ] **Step 4: 运行确认通过**
  - Run: `cd hosted/agent-service && npm test`
  - Expected: 全部 PASS

- [ ] **Step 5: Commit** `feat(agent): /wake and /forget with per-person queue, sessions and MEMORY.md`

---

### Task 7: 容器镜像、容器契约测试、CI

**Files:**
- Create: `hosted/agent-service/Dockerfile.agent`, `hosted/agent-service/container/entrypoint.sh`
- Test: `hosted/agent-service/test/container.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: 根目录 `package.json`：`"test": "node --test 'test/*.test.mjs'"`。不改的话，根目录的 `node --test` 会把 `hosted/agent-service/test` 也扫进来

**Interfaces:**
- Consumes: Task 6 的 `createAgentService`（docker 模式）
- 镜像 `weave-agent:0.3.316`：
  - 基础镜像 `node:24-bookworm-slim`
  - apt 装 `python3 sqlite3 jq socat ca-certificates`
  - `npm install -g @anthropic-ai/claude-agent-sdk@0.3.316`，再把平台包里的 `claude` 链接到 `/usr/local/bin/claude`
  - 建用户 `agent`（uid 1000），建目录 `/workspace /opt/weave/plugin /run/weave /home/agent`
  - `ENTRYPOINT ["/usr/local/bin/weave-entrypoint"]`
- `entrypoint.sh`：
  - 后台起 `socat TCP-LISTEN:4321,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/weave/proxy.sock`
  - `sleep 0.2`
  - `exec "$@"`

- [ ] **Step 1: 写失败的测试** `container.test.mjs`。没设 `WEAVE_TEST_DOCKER_IMAGE` 就整体 skip。用 docker 模式的 Agent 服务、宿主上的假模型和假 Weave 后端：
  - `'容器里 Bash 连不了网'`：`python3 -c "import urllib.request;urllib.request.urlopen('https://example.com',timeout=4)"` 失败
  - `'容器里读不到真 Key，ANTHROPIC_AUTH_TOKEN 是运行令牌'`：Bash 跑 `env`，输出里没有真 Key
  - `'模型请求经 socket 到代理，上游看到真 Key'`
  - `'Write 进 /workspace 的文件在宿主目录里看得到；写 /etc 失败'`
  - `'一轮结束容器已删除'`：`docker ps -a --filter name=weave-run-` 为空

- [ ] **Step 2: 本机确认 skip，CI 才真跑**
  - Run: `cd hosted/agent-service && node --test test/container.test.mjs`
  - Expected: 全部 skip（本机没有 Docker）

- [ ] **Step 3: 实现** 镜像和入口脚本。CI 在根目录 `npm test` 之后加这几步：
  ```yaml
  - name: Agent service install
    working-directory: hosted/agent-service
    run: npm ci --no-audit --no-fund
  - name: Agent service contract tests (fake model, no key)
    working-directory: hosted/agent-service
    run: npm test
  - name: SDK probe
    run: node scripts/agent-sdk-probe/probe.mjs
  - name: Build agent image
    run: docker build -f hosted/agent-service/Dockerfile.agent -t weave-agent:ci hosted/agent-service
  - name: Container contract tests
    working-directory: hosted/agent-service
    env:
      WEAVE_TEST_DOCKER_IMAGE: weave-agent:ci
    run: node --test test/container.test.mjs
  ```
  `setup-node` 的 `cache-dependency-path` 加上 `hosted/agent-service/package-lock.json`。

- [ ] **Step 4: 确认根目录测试数量不变**
  - Run: `npm test`（根目录）
  - Expected: 108 个旧测试加上本计划新增的根目录测试，全部 PASS，不包含 agent-service 的测试

- [ ] **Step 5: Commit** `ci: build the agent image and run container contract tests`

---

### Task 8: Weave 服务：通行证和习惯数据

**Files:**
- Create: `hosted/lib/weave/capability.mjs`, `hosted/lib/weave/habits.mjs`
- Test: `test/capability.test.mjs`, `test/habits.test.mjs`

**Interfaces:**
- Produces `capability.mjs`（WebCrypto）：
  - `issueCapability(secret, {owner, scope, runId, channel, direct}, now, ttlMs = 900000) → Promise<string>`
    - 格式：`wcap1.<base64url(JSON {...claims, exp})>.<base64url(HMAC-SHA256)>`
    - HMAC 的 key 是字符串 `'weave-agent-capability-v1:' + secret` 的 UTF-8 字节
  - `verifyCapability(secret, token, now) → Promise<{owner, scope, runId, channel, direct, exp}>`
    - 用 `crypto.subtle.verify` 校验
    - 格式不对、签名不对、过期，一律 `fail('通行证无效或已过期', 401)`
- Produces `habits.mjs`（数据放在 person 文档的 `habits`、`completions` 两个字段）：
  - `listHabits(person) → {habits: [{habit_id, name, identity, trigger, minimum_action}]}`
  - `saveHabit(person, args, now) → {habit}`
    - 不带 `habit_id` 是新建：每人最多 20 个，id 为 `'h:' + uuid`
    - 带 `habit_id` 是修改：必须是这个人自己的
    - `name` trim 后 1–30 字；`identity`、`trigger`、`minimum_action` 各不超过 200 字
  - `logCompletion(person, args, now) → {completion, duplicate}`
    - 习惯必须存在
    - `date` 是合法的 `YYYY-MM-DD`
    - `date` 不晚于 `localClock(person, now).day`（`proactivity.mjs` 里的函数，按本人时区）
    - 同一习惯同一天已经有记录时，`duplicate: true`，不新增
    - `note` 不超过 500 字
  - `queryCompletions(person, args, now) → {today, completions: [{habit_id, date, note}]}`
    - `from ≤ to`，跨度不超过 366 天
    - 可以按 `habit_id` 过滤
    - 按日期升序；`today` 是本人当地日期
- 失败都用 `fail(<中文>, 400)`，文案是草稿，集中放在文件开头。

- [ ] **Step 1: 写失败的测试**
  - `habits.test.mjs`：
    - `'新建习惯最多 20 个，名字 1–30 字，其他字段不超过 200 字'`
    - `'只能改自己的习惯，别人的 habit_id 当作不存在'`
    - `'不记未来日期，按本人时区算今天'`：`now` 设成 `Date.parse('2026-11-02T07:30:00Z')`。时区 `America/Los_Angeles` 的人记 `'2026-11-02'` 被拒、`'2026-11-01'` 通过；时区 `Asia/Shanghai` 的人记 `'2026-11-02'` 通过
    - `'同一习惯同一天只记一次，第二次 duplicate 为 true，completions 长度不变'`
    - `'2026-02-30、2026-1-5、空字符串都拒绝'`
    - `'queryCompletions 按日期排序、带 today，跨度超过 366 天拒绝'`
  - `capability.test.mjs`：
    - `'签发后能验证，拿回同样的 owner、scope、runId、channel、direct'`
    - `'改一个字符、换密钥、过期，都是 401'`

- [ ] **Step 2: 运行确认失败**
  - Run: `node --test test/capability.test.mjs test/habits.test.mjs`
  - Expected: FAIL

- [ ] **Step 3: 实现** 两个模块。

- [ ] **Step 4: 运行确认通过**
  - Run: 同 Step 2
  - Expected: PASS

- [ ] **Step 5: Commit** `feat(weave): agent capabilities and habit/completion records`

---

### Task 9: Weave 服务：工具后端接口

**Files:**
- Create: `hosted/lib/weave/agent-tools.mjs`
- Modify: `hosted/lib/weave/store.mjs`：加 `withWorld`
- Modify: `hosted/lib/weave/api.mjs`：在 hermes 和 wechat 两个内部路由旁边加一条路由
- Test: `test/agent-tools.test.mjs`

**Interfaces:**
- Consumes: Task 8 的 `verifyCapability` 和四个习惯函数；`domain.record`、`domain.notify`；`proactivity.mjs` 的 `activeNow`、`localClock`
- Produces：
  - `withWorld(db, fn, {attempts = 3} = {}) → Promise<T>`
    - 每次尝试都 `new Store(db)` → `load` → `fn(world)` → `save`
    - 遇到 `error.status === 409` 就重读重试
  - `TOOL_SCOPES = {send_message: ['owner'], list_habits: ['owner'], save_habit: ['owner'], log_completion: ['owner'], query_completions: ['owner']}`（group 在第 3 步加）
  - `handleAgentTool(request, {db, secret, readBody, now}) → Promise<Response>`
    - 只接受 POST，否则 405；路径是 `/api/internal/agent/tools/<name>`，未知工具 404
    - 通行证从 Bearer 取，验证失败 401
    - `TOOL_SCOPES[name]` 不含通行证上的 scope 时 403
    - body 必须是 `{args: object, toolUseId: string（1–200 字）}`，否则 400
    - 在 `withWorld` 里执行：
      - 找 `world.people[claims.owner]`，没有就 404
      - 回执键是 `` `${runId}:${toolUseId}` ``：`person.toolReceipts` 里已有就原样返回，不再执行
      - 否则执行对应后端，记一条 `{key, ok, text, at}`，只留最近 200 条
    - 规则失败（status 400）时返回 HTTP 200 加 `{ok: false, text: 原因}`，让模型看到原因
    - 意外错误返回 500，不记回执
  - 四个习惯工具：`{ok: true, text: JSON.stringify(结果)}`
  - `send_message`（第 1 步只有网页通道），参数 `{text}`，1–700 字，规则按顺序：
    1. 不是直接找它的那一轮（`!claims.direct`），并且 `!activeNow(person, now)`：不发，返回「现在是对方的安静时段，这条没有发出。」
    2. 本人当地今天已经发了 20 条：不发，返回「今天发的消息已经到上限了，这条没有发出。」
    3. trim 后同样的文字 24 小时内发过：不发，返回「这句话 24 小时内已经发过了，没有重复发送。」
    4. 否则发出：`domain.record(person, text, {source: 'agent', runId})` 加 `domain.notify(world, owner, text)`，返回 `{ok: true, text: '已发出。'}`
    - 计数放在 `person.agentOutbox = {day, count, recent: [{text, at}]}`
    - 三条拦截文案和上限 20 都是草稿

- [ ] **Step 1: 写失败的测试** `agent-tools.test.mjs`：用 `handleAPI`、`D1` 测试库和真的 `issueCapability`。
  - `'没有通行证、改过的通行证、过期的通行证都是 401，什么都没写'`
  - `'未知工具 404；group 通行证调 log_completion 是 403'`
  - `'log_completion 写进本人的 completions；同一个 toolUseId 重放只记一条，返回同样的文字'`
  - `'规则失败返回 200 加 ok:false，把中文原因交给模型（未来日期）'`
  - `'send_message 只发给通行证上的本人：进本人的 messages 和通知，另一个账号看不到'`
  - `'send_message：direct=false 在安静时段不发；同一句 24 小时内不重复；每天上限 20'`
  - `'同一个人两个工具调用同时到，两条都记上（Store 409 自动重读重试）'`：`Promise.all` 同时发两次 `log_completion`，用两个不同的习惯

- [ ] **Step 2: 运行确认失败**
  - Run: `node --test test/agent-tools.test.mjs`
  - Expected: FAIL

- [ ] **Step 3: 实现** `withWorld`、`agent-tools.mjs` 和 `api.mjs` 的这一条路由：`if(requestPath.startsWith('/api/internal/agent/tools/'))return handleAgentTool(request,{db,secret,readBody:body,now});`

- [ ] **Step 4: 运行确认通过**
  - Run: `npm test`（根目录）
  - Expected: 全部 PASS，旧测试不受影响

- [ ] **Step 5: Commit** `feat(weave): tool backend for agent MCP calls with capability checks and idempotency`

---

### Task 10: 网页聊天走新路（开关）、注销和导出、端到端、文档

**Files:**
- Create: `hosted/lib/weave/dispatcher.mjs`
- Modify: `hosted/lib/weave/api.mjs`：改 `chat`、`account/delete`、`export` 三处
- Modify: `hosted/app/api/[...path]/route.ts`：多传 `agentRuntime: config.WEAVE_AGENT_RUNTIME`
- Modify: `hosted/cloudflare-env.d.ts`：加 `WEAVE_AGENT_RUNTIME?: string;`
- Modify: `hosted/.env.example`：说明 `WEAVE_AGENT_RUNTIME=sdk`
- Create: `hosted/agent-service/README.md`：本机怎么跑、docker 模式怎么部署（宿主上用非 root 并且在 docker 组的用户跑 Agent 服务，不放进容器）、环境变量
- Modify: `docs/ARCHITECTURE.md`：
  - §6 的 `inContainer` 换成最终的 `dockerArgs`，写明为什么用 `--network none` 加 socket
  - §9 的 `ANTHROPIC_BASE_URL` 换成 `http://127.0.0.1:4321`
  - §12 写上 token 额度默认值（标草稿）
  - §15 标出第 0、1 步的状态
- Test: `test/agent-chat.test.mjs`, `test/agent-e2e.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `/wake` 和 `/forget` 契约；Task 8 的 `issueCapability`；Task 9 的 `withWorld`
- Produces `dispatcher.mjs`：
  - `agentServiceConfig(url, token) → {url, token} | null`：url 必须是 `https://` 或 `http://127.0.0.1`、`http://localhost`；token 至少 32 位
  - `localISO(timezone, now) → 'YYYY-MM-DDTHH:mm:ss+HH:MM'`
  - `wakeForMessage({db, secret, ownerId, text, service, fetcher = fetch, now = Date.now()}) → Promise<{reply, outcome}>`
    1. 在 `withWorld` 里：
       - 存用户消息 `{id, role: 'user', text, createdAt}`
       - 定下 `provider: 'deepseek'`、`model = person.settings.model ?? DEFAULT_MODEL`
       - 本人存了自己的 Key（`person.settings.deepseekKey`）就 `unseal` 出来当 `userKey`
       - 算 `localDate = localClock(person, now).day` 和 `at = localISO(person.profile.timezone, now)`
    2. 生成 `runId`，签发 `capability = issueCapability(secret, {owner: ownerId, scope: 'owner', runId, channel: 'web', direct: true}, now)`
    3. 请求 `POST ${service.url}/wake`（超时 180 秒），`scope: 'owner'`，`id: ownerId`，`trigger.kind: 'message'`
    4. 把结果翻成回复：
       - 200，`outcome === 'success'`，并且 `reply` 非空：用 `reply`
       - 429：BUSY「现在排队的人有点多，没有处理这条，请稍后再发一次。」
       - 503：UNAVAILABLE「Agent 暂时不可用，没有处理这条，请稍后再试。」
       - 其他情况（网络错误、超时、5xx、非 success、空回复）：UNCERTAIN「这次没有拿到完整结果，Weave 可能已经做了一部分（比如记了一条记录），请先看看再决定要不要重发。」，并标 `uncertain: true`
       - 三句都是草稿
    5. 再进一次 `withWorld`：`domain.record(person, reply, {source: 'agent', runId, outcome, uncertain?})`
    - 任何一步都不自动重试
- `api.mjs` 的三处改动：
  - `chat`：`agentRuntime === 'sdk'` 时，先取 `agentServiceConfig`，取不到就 `fail('新版 Agent 还没有配置好，请联系管理员', 503)`（草稿），然后 `return json(await wakeForMessage(...))`。必须在函数末尾的 `save()` 之前返回，因为这时请求开头读的 world 已经过期了。
  - `account/delete`：`agentRuntime === 'sdk'` 并且服务已配置时，先 `POST /forget {scope: 'owner', id}`；失败就 `fail('暂时删不掉 Agent 的工作目录，账号没有删除，请稍后重试', 503)`（草稿）。
  - `export`：多返回 `habits: person.habits ?? []`、`completions: person.completions ?? []`。

- [ ] **Step 1: 写失败的测试**
  - `agent-chat.test.mjs`（`handleAPI`，`/wake` 用 fetcher 桩代替）：
    - `'开关关着时 /api/chat 走旧路，一次 /wake 都不请求'`
    - `'开关打开：先存用户消息，再叫醒，回来重读再存回复；Agent 中途记的完成记录不被覆盖，也不报 409'`：桩在收到 /wake 时，用请求体里的 capability 调一次 `handleAPI` 的 `log_completion`，再返回 `{outcome: 'success', reply: '记好了'}`。断言：响应是 200 `{reply: '记好了'}`；messages 依次是 user、assistant；completions 有 1 条
    - `'/wake 超时或 500：回复「结果不确定」并标 uncertain，/wake 只被请求一次'`
    - `'/wake 429：回复排队的那句'`
    - `'叫醒时带本人当地日期和带时区的 at；本人存了自己的 Key 时作为 userKey 传过去'`
    - `'注销：先请求 /forget，成功才删账号；/forget 失败返回 503，账号还在'`
    - `'导出里有 habits 和 completions'`
  - `agent-e2e.test.mjs`：真的 Agent 服务（Task 6，local 模式，`sandbox: false`）+ 假模型 + 包在真 http server 里的 `handleAPI`：
    - `'网页聊天端到端：「今天走了 20 分钟」→ Agent 依次调 list_habits、save_habit、log_completion → 回复进 messages，完成记录在 D1 里'`：假模型从上一步的工具结果 JSON 里取 `habit_id`；日期用本人当地今天

- [ ] **Step 2: 运行确认失败**
  - Run: `node --test test/agent-chat.test.mjs test/agent-e2e.test.mjs`
  - Expected: FAIL

- [ ] **Step 3: 实现** `dispatcher.mjs`、`api.mjs` 三处、`route.ts`、`cloudflare-env.d.ts`、`.env.example`，然后写 README 和改文档。

- [ ] **Step 4: 全量验证**
  - Run: `npm test`（根目录），再在 `hosted/agent-service` 跑 `npm test`，再跑 `node scripts/agent-sdk-probe/probe.mjs`
  - Expected: 全部 PASS，探针 43/43
  - Run: `cd hosted && npm ci --no-audit --no-fund && npx tsc --noEmit && npm run build`
  - Expected: 没有类型错误，构建成功

- [ ] **Step 5: Commit** `feat(weave): web chat on the Agent SDK path behind WEAVE_AGENT_RUNTIME=sdk`

---

## 做完以后（不在本计划的任务里）

- **推送分支，开草稿 PR 到 main。** PR 描述写四块：「和文档不一样的地方」、全部草稿文案和数字、本机和 CI 各验证了什么、部署要加的环境变量。
- **第 0 步。** 她用自己的 Key 跑 `real-smoke.mjs`，花费按 DeepSeek flash 估在 $0.005–0.02。
- **服务器真机验证。** 给她三条命令：建镜像、跑容器契约测试、看结果。她跑，我看输出。先确认 Weave 和 AML 是不是同一台机器（11-10 前那两台都不动）。
- **第 2–4 步各自另写计划。** 文档 §10 要求 MEMORY.md 本人能在网页上看、改、删，导出时也要带上，这些放第 2 步，因为要先给 Agent 服务加读写接口。第 1 步已经做到：注销时整个工作目录一起删。
