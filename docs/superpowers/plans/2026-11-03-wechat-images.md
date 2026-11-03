# 微信看图（默认关闭）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 有人 @ 它（私聊里是发一句话）时，把同一个人刚发的一张照片交给模型看；两个开关默认都关，关着时行为一字不变。

**Architecture:** 桥接在内存里配对照片和 @，只在 Weave 要的时候读守护进程的缓存副本、上传字节；Weave 把要回复的那句话压住等照片（最多 30 秒），照片加密暂存在 D1（最多 10 分钟），这一轮开始时取出就删；Agent 服务用流式输入把 `[文字, 图片]` 交给 `deepseek-flash`，这一轮不写会话记录。

**Tech Stack:** Node 24（CI）/ 26（本机）、Claude Agent SDK 0.3.316、Cloudflare Worker（`wrangler dev`）+ D1、agent-wechat v1.3.3、bash 3.2。

**Spec:** `docs/superpowers/specs/2026-11-03-wechat-images-design.md`；调研报告；`AGENTS.md`（教材原则、先读 SDK 文档）。

## Global Constraints

- 开关：服务器 `WEAVE_WECHAT_IMAGES=1`（还要 `WEAVE_AGENT_RUNTIME=sdk`），桥接 `WEAVE_WECHAT_IMAGES=1`。任何一个关着就和现在一样。
- 照片：JPEG/PNG/GIF/WebP，按字节认；原始大小 ≤ 2 MiB；一轮一张。
- 配对：照片在 @ 之前 60 秒内，或之后 10 秒内；同一个聊天、同一个人；用微信的 `createdAt`。
- 只读缓存副本：`standard`，没有就 `thumbnail`，`state === 'available'`；不调用 `media-transfers`。
- 暂存：D1 `weave_wechat_photos`，加密，≤ 10 分钟，取出即删；world、群记录、`person.messages`、记忆、会话、回执、日志里都没有照片。
- 新文字都是草稿，标 `草稿文案，待确认`，PR 里列原句。
- 不合并、不推 `main` 和 `feat/deploy-tencent`、不 ssh、不部署、不跑 wx、不读这台 Mac 的设备状态、不调付费接口、不派子 Agent。

## Review Focus

1. 开关关着时：`/events` 的回答字段、叫醒的内容、开启群的原话、隐私页都和以前一样；没有表、没有 `/photo` 路由。
2. 没配上的群照片：连 id 都不离开 Mac；没开启的群和「别记」什么都不存。
3. 照片的生命周期：存之前过门槛，这一轮开始就删，失败也删，过期清理不依赖开关。
4. 真 CLI 上 `resume` + 生成器 prompt + `persistSession: false`：会话文件不变，磁盘上没有照片。
5. 选了 v4-pro 的人，照片那一轮一定是 `deepseek-flash`。

## Tasks

### Task 0：准备

- [x] `git fetch origin`，`git switch -c feat/wechat-images origin/feat/deploy-tencent`，确认 `dc35278`；去掉对 `feat/deploy-tencent` 的上游跟踪，免得推错。
- [x] 读调研报告、`AGENTS.md`、教材（PDF 用 PDFKit 取文字，p.20、p.30、p.38、p.56、p.57）、SDK 文档（`streaming-vs-single-mode`、`sessions`）、0.3.316 的 `sdk.d.ts` 和 `streamInput`。
- [x] 读 agent-wechat 源码：`GET /messages/{id}/media` 回 `{items}`，`media_content` 只读本机且要 `available`，OpenClaw 插件把 `type` 3 当图片、选副本用 `actualVariant ?? variant`。
- [x] 看 PR #31（去掉每日上限）和 PR #32（看门狗）改了哪些行，避开：不碰 `wechat.mjs` 第 12 行和 `groupTool`，不改它们改的测试文件，文档改动不放在它们改的位置。

### Task 1：Agent 服务收照片（`hosted/agent-service`）

- [x] `images.mjs`：`sniffImage`、`checkImage`、上限常量。
- [x] `prompts.mjs`：`IMAGE_NOTE`（草稿）、`imageMessage(trigger, image)`。
- [x] `runner.mjs`：有照片时 prompt 是只产出一条消息的生成器，`persistSession: false`；没有照片完全照旧。
- [x] `providers.mjs`：DeepSeek 的 `vision: 'deepseek-flash'`。
- [x] `server.mjs`：只有 `/wake` 放大上限；`checkWake` 查照片；带照片用 `provider.vision`；带照片的一轮不动 `sessions.json`。
- [x] 测试（真 CLI + 假模型）：`test/images.test.mjs`（图片块原样到模型；`resume` + 生成器能用；会话文件不变、磁盘上没有照片；下一轮看不到照片；工具和 hook 照常；`query()` 拿到的参数）、`test/server-images.test.mjs`（v4-pro 强制 flash、坏照片 400、上限只对 `/wake` 放大、`sessions.json` 不变）。
- [x] 提交 `feat(agent-service): ...`。

### Task 2：Weave 收照片、压住那一轮、叫醒时带上（`hosted/lib/weave`）

- [x] `crypto.mjs`：`sealBytes`、`unsealBytes`。
- [x] `wechat-photos.mjs`：建表（第一次用时）、加密分行存、取出即删、过期清理。
- [x] `wechat.mjs`：`wechatConfig.images`；`normalize` 读 `photo`；`holdForPhoto`（`awaiting-photo`，30 秒）；`GROUP_PHOTO_TEXT`（草稿，只在开着时接上）；`/photo` 接口（存之前查还在等、同一个人、格式大小）；`claimNext` 带出照片 id、等过头的照常开始；`processInboundSdk` 取照片、叫醒；关群删照片；旧路线也放行等过头的。
- [x] `dispatcher.mjs`：`wake`、`wakeForMessage`、`wakeForGroup` 接 `image`，带照片用 `IMAGE_MODEL`；`model.mjs` 加 `IMAGE_MODEL`。
- [x] `api.mjs`：只在 `agentRuntime === 'sdk'` 时把开关交给 `wechatQueue`；`scheduler.mjs`：每次定时任务清过期照片。
- [x] `app/privacy/page.tsx`：开着时多一条（草稿）；`cloudflare-env.d.ts`、`scripts/start-vps.sh` 加变量。
- [x] 测试 `test/wechat-images.test.mjs`（20 条），`test/helpers/wechat-sdk.mjs` 加 `images` 和 `photo()`。
- [x] `npx tsc --noEmit`、`npm run build` 通过；提交 `feat(wechat): ...`。

### Task 3：桥接配对和上传（`hosted/wechat-bridge`）

- [x] `createDaemon` 加 `media`、`content`（只读）；`createWeave` 能发原始字节（信息放请求头）；`withHints` 也看 `/photo` 的回答。
- [x] `createPhotos`（`seen`、`extraFor`、`answered`）、`readPhoto`、`sniffImage`；`handleEvent` 收 `photos`，没有时和以前一样；`main` 按开关创建。
- [x] `.env.example` 写明开关和 `media` 权限。
- [x] 测试 `test/wechat-bridge-images.test.mjs`（12 条）、`test/wechat-images-sync.test.mjs`（三处一致）；提交 `feat(wechat-bridge): ...`。

### Task 4：端到端和容器

- [x] `hosted/agent-service/test/e2e-wechat-images.test.mjs`：群和私聊，Weave 进程内 + 真 Agent 服务 + 真 CLI；之后 D1、world、Agent 目录里都没有照片。
- [x] `test/container.test.mjs` 加一条带照片的一轮（只在 CI 跑）。
- [x] 提交 `test(wechat): ...`。

### Task 5：Mac 脚本（`deploy/wechat-mac`）

- [x] `lib.sh` 的 `bridge_key_renew`；`login.sh` 用它，开着时保留 `media`；新的 `images.sh on|off`。
- [x] 测试（假 wx）：`on` 建带 `media` 的密钥、写开关、不显示密钥、不碰登录；`off` 去掉；`login.sh` 开着时保留；参数不对或没登录时什么都不改；`bash -n` 和可执行。
- [x] 提交 `feat(deploy): ...`。

### Task 6：文档

- [x] `docs/WECHAT.md`：手动建密钥那一步加一句、「目前的限制」那一句改成两种状态、文末加「看图（默认关闭）」（草稿）。
- [x] `deploy/wechat-mac/README.md` 第 8 节、`deploy/tencent/README.md` 微信那段加一句。
- [x] 这份计划和设计文档；提交 `docs(wechat): ...`。

### Task 7：推送、草稿 PR、检查

- [x] 根目录 `node --test 'test/*.test.mjs'`、`hosted/agent-service` 的 `npm ci && npm test`、`hosted` 的 `npm ci && npx tsc --noEmit && npm run build` 全部通过。
- [x] 推 `feat/wechat-images`，开草稿 PR 到 `feat/deploy-tencent`；PR 正文写在工作区里被忽略的 `.data/`，用完删掉。
- [x] `git merge-tree --write-tree` 检查和 `origin/fix/wechat-group-no-daily-cap`（PR #31）、`origin/fix/web-watchdog`（PR #32）能不能干净合并。
- [x] 等 CI（最多 20 分钟），报告结果。
