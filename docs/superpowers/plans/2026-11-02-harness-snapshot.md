# 查数留 SQL + 读得到 Agent 的记忆 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 自己写 SQL 查习惯数据（不再经只读 MCP 工具），并让网页后端能读出 Agent 真正记下的 `MEMORY.md`。

**Architecture:** 每次叫醒前，Agent 服务拿这一轮的通行证向 Weave 取一份快照，重建工作目录里的 `weave/`（`weave.db` 是 SQLite，另有可选文件，比如以后的 Notion 页面）。写入仍走 MCP 工具（规则在后端），写成功后 Agent 服务把结果同步进本地 `weave.db`。只读工具 `list_habits`、`query_completions` 删掉。

**Tech Stack:** Node 24（`node:sqlite`）、Claude Agent SDK 0.3.316、Cloudflare Worker（`wrangler dev`）、Python 3（Skill 参考代码）。

**Spec:** 教材对照（本会话 11-02 的结论，负责人回复「修！大修！」）；`AGENTS.md`；`docs/ARCHITECTURE.md` §4、§5、§10。

## 教材依据

- PDF p.16：「查数留SQL,不要封成MCP 一台电脑:代码能交叉编排,接口不能」。
- PDF p.20：代码合法的位置之一「Agent启动之前 预处理。不在循环中间,不影响灵活性」；「Hook 只管副作用:备份、审计、拦截」。
- PDF p.16：「记忆就是文件,不要造记忆系统」（`MEMORY.md` 保持是文件，只是让人看得到）。
- 我的看法：写入后同步本地快照属于「副作用」，放在 Agent 服务的工具外壳里，不进循环。

## Global Constraints

- 快照接口：`GET /api/internal/agent/snapshot`，`Authorization: Bearer <通行证>`；401 通行证无效或过期、404 账号不存在、405 不是 GET。加进 `basic-auth.mjs` 的 `SELF_AUTHENTICATED`。
- 快照格式：`{version: 1, today, timezone, tables: {...}, files: {...}}`。owner 范围给 `habits`、`completions`；group 范围给空的 `tables`、`files`（以后由微信分支填 `group_messages`）。
- 已知的表和列（写死，别的表名让整份快照无效）：
  - `habits(habit_id TEXT PRIMARY KEY, name, identity, trigger, minimum_action, created_at, updated_at)`
  - `completions(habit_id, date, note, source, created_at, PRIMARY KEY (habit_id, date))`
  - `group_messages(seq INTEGER PRIMARY KEY, member, text, at)`
  - 另有 `meta(key TEXT PRIMARY KEY, value)`：`today`、`timezone`、`generated_at`
- 文件路径规则：相对路径、`/` 分段，每段 1–100 字，不能是 `.`、`..`，不含 `\` 或 NUL，不能是 `weave.db`；最多 200 个文件、单个 1 MB、合计 5 MB。不合规的文件跳过并记日志，不让整轮失败。
- 每次叫醒前删掉再重建 `<工作目录>/weave/`（是链接就只删链接；先把权限改回来再删）。
- 取不到快照或格式不对：`/wake` 回 503，CLI 不启动（dispatcher 会当成「没有处理」）。
- 新加的给模型看的文字都是草稿，在 PR 里列出原句，等负责人确认（`AGENTS.md`；记忆「文案先确认再改」）。

## Review Focus

1. 上一轮 Agent 在 `weave/` 里留了指向外面的链接或 000 权限的目录：要重建干净，外面的文件不能被碰（Task 2 测试）。
2. 同一轮里先 `save_habit`、`log_completion`，再写 SQL 查：要查得到（Task 5 端到端测试）。
3. Weave 正在重启、快照接口 500：回 503，没有半截的叫醒（Task 3 测试）。
4. 多年的打卡记录（一万多行）：快照能写完，行数对得上（Task 2 测试）。
5. Notion 页面名带 `/`、`..` 或特别长：这个文件跳过，其他照常（Task 2 测试）。

---

### Task 1: Weave 的快照接口

**Files:**
- Create: `hosted/lib/weave/agent-snapshot.mjs`
- Modify: `hosted/lib/weave/api.mjs`（内部路由，`/api/internal/agent/tools/` 那一行旁边）、`hosted/lib/weave/basic-auth.mjs`（`SELF_AUTHENTICATED`）、`deploy/tencent/ci-smoke.sh`
- Test: `test/agent-snapshot.test.mjs`（新）、`test/basic-auth.test.mjs`

**Interfaces:**
- Produces: `snapshotFor(person, claims, now) → {version, today, timezone, tables, files}`；`handleAgentSnapshot(request, {db, secret, now}) → Response`。

- [ ] 测试 `owner 通行证拿到本人的习惯和完成记录，别人的拿不到`：Alice 存两条习惯、一条完成记录，Bob 存一条；Alice 的快照 `tables.habits` 只有她的两条（字段名和上面的列一致），`completions` 一条，`today` 是上海当地日期，`files` 是 `{}`。
- [ ] 测试 `没有通行证、过期、篡改都是 401；POST 是 405；group 通行证拿到空的 tables 和 files`。
- [ ] 测试（basic-auth）：`/api/internal/agent/snapshot` 不要密码；`/api/internal/agent/other` 仍要密码。
- [ ] 跑测试看到失败 → 实现 → `npm test` 全过。
- [ ] `ci-smoke.sh`：内部接口那条从 `list_habits` 改成 `save_habit`；再加一条 GET 快照不带通行证要回含「通行证」的 401。
- [ ] 提交 `feat(agent): snapshot endpoint for pre-wake data (textbook p.16, p.20)`。

### Task 2: Agent 服务把快照落成 `weave/`

**Files:**
- Create: `hosted/agent-service/snapshot.mjs`
- Modify: `hosted/agent-service/workspace.mjs`（导出 `makeRemovable`）
- Test: `hosted/agent-service/test/snapshot.test.mjs`（新）

**Interfaces:**
- Produces:
  - `validateSnapshot(value) → snapshot`（不合格就 throw）
  - `fetchSnapshot({weaveUrl, capability, fetcher, timeoutMs = 15000}) → Promise<snapshot>`（非 200 或格式不对就 throw）
  - `writeSnapshot(dirs, snapshot, now) → Promise<{dir, dbPath, skipped: string[]}>`
  - `applyWrite(dbPath, toolName, resultText) → void`（`save_habit` 按 `habit_id` 覆盖；`log_completion` 已有就忽略）
  - `mirroringRpc(rpc, dbPath) → rpc`（只在 `save_habit`、`log_completion` 成功时同步；同步失败只记日志，返回值不变）

- [ ] 测试：`写出 weave.db：meta 有 today/timezone，habits 和 completions 行数和内容对得上；group 快照只有 meta`。
- [ ] 测试：`weave/ 原来是指向外面的链接：只删链接，外面的文件还在；原来有 000 权限的子目录也能重建`。
- [ ] 测试：`files 写到 weave/ 下；../x、/abs、a/../b、空段、weave.db、超过 1 MB 的都跳过并出现在 skipped 里`。
- [ ] 测试：`不认识的表名、行不是对象、值是对象都让 validateSnapshot 报错`。
- [ ] 测试：`一万两千行完成记录也能写完`（行数对得上）。
- [ ] 测试：`applyWrite：save_habit 新建和修改都同步；log_completion 重复不报错；坏 JSON 不抛到外面（mirroringRpc 里）`。
- [ ] 测试：`fetchSnapshot 带 Bearer 通行证 GET /api/internal/agent/snapshot；500 或格式不对就 throw`。
- [ ] 失败 → 实现 → `cd hosted/agent-service && npm test` 全过 → 提交 `feat(agent): write the snapshot into the workspace as SQLite`。

### Task 3: 叫醒前取快照

**Files:**
- Modify: `hosted/agent-service/server.mjs`（`handleWake`：在 `workspace.prepare` 之后、`wake` 之前）
- Test: `hosted/agent-service/test/server.test.mjs`、`hosted/agent-service/test/container.test.mjs`（假 Weave 回快照）

**Interfaces:**
- Consumes: Task 2 的 `fetchSnapshot`、`writeSnapshot`、`mirroringRpc`。

- [ ] 假 Weave 服务：GET 快照路径回一份合格快照，其余照旧。
- [ ] 测试：`叫醒前快照已经在工作目录里：Agent 第一步就能用 Bash 查到 weave.db 里的习惯`（假模型跑 `python3 -c` 读 sqlite）。
- [ ] 测试：`快照接口 500 时 /wake 回 503，CLI 没启动`。
- [ ] 失败 → 实现 → 测试全过 → 提交 `feat(agent): fetch the snapshot before every wake`。

### Task 4: 去掉只读工具

**Files:**
- Modify: `hosted/agent-service/scopes.mjs`（owner `tools` = `['send_message', 'save_habit', 'log_completion']`）、`hosted/agent-service/mcp/tools.mjs`、`hosted/lib/weave/agent-tools.mjs`（删两个工具和 `READ_ONLY`）、`hosted/lib/weave/habits.mjs`（删 `listHabits`、`queryCompletions`；`notFound` 文案改指 `weave.db`）
- Test: `hosted/agent-service/test/tables.test.mjs`（只改 `PRIVATE_TOOLS`）、`runner.test.mjs`（工具名单那条）、`mcp.test.mjs`、`test/agent-tools.test.mjs`、`test/habits.test.mjs`

- [ ] 先改测试：工具名单只剩三个；`list_habits`、`query_completions` 打到工具后端是 404；`mcp.test` 里三个工具都不是只读。
- [ ] 失败 → 实现 → 两套测试全过 → 提交 `refactor(agent): drop read-only MCP tools, data comes from the snapshot (textbook p.16)`。

### Task 5: 提示词、Skill、端到端

**Files:**
- Modify: `hosted/agent-service/prompts.mjs`（SYSTEM 加一段，草稿）、`plugin/skills/weekly-review/SKILL.md`（草稿）、`plugin/skills/weekly-review/scripts/stats.py`（能直接读 `weave.db`）
- Test: `hosted/agent-service/test/stats.test.mjs`、`test/e2e-web-chat.test.mjs`、`tables.test.mjs`（新句子在、不提「打卡群」）

- [ ] `stats.py`：参数是 SQLite 文件时读 `completions` 和 `meta.today`，并带上 `habits.name`；JSON 仍可用。测试 `直接读 weave.db：今天取 meta 里的，结果带习惯名`。
- [ ] 端到端：「今天走了 20 分钟」→ 假模型先用 Bash 查 `weave.db`（空）→ `save_habit` → `log_completion` → 再用 Bash 查，看到今天这条 → 回复。断言 D1 里有、第二次 Bash 结果里有今天的日期。
- [ ] 失败 → 实现 → 全过 → 提交 `feat(agent): prompt and weekly-review read weave.db with SQL`。

### Task 6: 读得到 Agent 的 `MEMORY.md`

**Files:**
- Modify: `hosted/agent-service/server.mjs`（`POST /memory`，只收 owner）
- Create: `hosted/lib/weave/agent-memory.mjs`（`readAgentMemory({service, ownerId, fetcher}) → Promise<string>`）
- Modify: `hosted/lib/weave/api.mjs`（GET `agent-memory`）
- Test: `hosted/agent-service/test/server.test.mjs`、`test/agent-chat.test.mjs`

- [ ] 测试：`POST /memory 返回 MEMORY.md 原文；没有令牌 401；group 范围 400`。
- [ ] 测试：`GET /api/agent-memory 返回 {text}；新版 Agent 没配置或服务连不上时 503`。
- [ ] 失败 → 实现 → 全过 → 提交 `feat(agent): let the owner read the agent's MEMORY.md`。

### Task 7: 文档、全量验证、PR

- [ ] `docs/ARCHITECTURE.md`：§4 工具表删两行、加「快照」一段；§5 Skill 例子；§10 数据表的 D1 行改成「写经工具，读从快照」。
- [ ] 全量：根目录 `npm test`；`hosted/agent-service` `npm test`；`node scripts/agent-sdk-probe/probe.mjs`；`bash -n deploy/tencent/ci-smoke.sh`。
- [ ] 推送 `fix/harness-textbook`，草稿 PR 进 `feat/deploy-tencent`：按 `AGENTS.md` 写教材原文 + 页码 → 代码 → 结论；列出待确认的原句；说明和 `fix/no-turn-limit`、微信和 Notion 分支怎么合。
