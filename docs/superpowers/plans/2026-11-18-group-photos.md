# 打卡群看照片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开启的打卡群里每张照片 Weave 都看一次（不用 @），自己记、自己决定说不说；群里的照片不留；本人私聊的照片存进工作目录的 `user/`；去掉看图开关和 60 秒配对。

**Architecture:** 小号桥接把每张收到的照片（`type 3`）读已下载的副本、去掉附加信息，按顺序交给 `/api/internal/wechat/image`。网站在 #54 的 `receiveImage` 上加群这一路：照片加密暂存，排一条 `direct: false` 的群照片轮，这一轮开始时把照片交给 Agent。Agent 服务对群照片不落盘、不写会话（#54 已有）。每个群先由 Weave 用自己的话说一声，回执 `sent` 以后才开始看。

**Tech Stack:** Node 22 ESM、`node:test`；桥接零依赖；网站代码跑在 wrangler dev（D1）；Agent 服务 = Claude Agent SDK；部署脚本是 bash。

**Spec:** `docs/superpowers/specs/2026-11-18-group-photos-design.md`

## Global Constraints

- 桥接只用 Node 自带模块（`hosted/wechat-bridge` 没有依赖）。
- 照片只收 `image/jpeg`、`image/png`、`image/gif`、`image/webp`，最大 `PHOTO_MAX_BYTES`（2 MiB）；带照片的一轮 `model` 是 `IMAGE_MODEL`（`deepseek-flash`）。
- 超过 `STALE_MS`（6 小时）才到的照片不叫醒。
- 只读守护进程已下载的副本：`GET /messages/{id}/media`、`GET /media/{id}/content`；永远不调用 `media-transfers`。
- 代码不替 Weave 说话。新的给人看或给模型看的文字都标 `// 草稿文案，待确认`，原句列进 PR 的「新文字（请确认）」。
- 公开仓库：代码、测试、提交说明不写负责人的个人情况（所在地、时区、姓名）。
- 群记录不变：最多 50 条（`CONTEXT_LIMIT`）、14 天（`CONTEXT_MS`）。
- 每个任务结束时根目录 `npm test` 全过；动了 Agent 服务的任务再跑 `npm --prefix hosted/agent-service test`（容器测试本地跳过，CI 上跑）。
- 提交说明末尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

1. 一次发好几张照片（相册多选）：每张一轮、按发出的顺序、哪一张都不自动发话。→ Task 1 `several photos in a row: one turn each, in order, none said aloud`。
2. 先发照片、几秒后 @ 它问这张照片：照片那一轮先跑完，@ 那一轮照常回一次。→ Task 1 `a photo then an @ about it: the photo turn runs first; the @ is answered once`；Task 4 `a photo is handed over before the text that follows it`。
3. 照片还在等的时候群被关闭：照片删掉，什么都不说。→ Task 1 `closing the group while a photo waits deletes it and nothing is said about it`。
4. 说明没发出去（失败、取消）时来了照片：不看、不存；说明第二天再试，不更早。→ Task 2 `a notice that did not go out is tried again the next Beijing day, not sooner`。
5. 桥接的钥匙没有 `media` 权限：每张照片都读不出来 → 交一个空的 `/image` → Weave 被告知照片打不开；日志点明是 `media` 权限。→ Task 4 `a photo that cannot be read goes as an empty /image, and the log names the media scope when that is why`；Task 1 `an empty /image ... is treated the same way`。

---

### Task 1: 网站——群照片这一路

**Files:**
- Modify: `hosted/lib/weave/wechat.mjs`（`receiveImage` 加群分支；`claimNext` 带出 `turn` 和群的 `photoProblem`；`processInboundSdk` 群分支；新常量 `GROUP_PHOTO_TRIGGER`）
- Modify: `hosted/lib/weave/dispatcher.mjs`（`wakeForGroup` 加 `direct`、`kind`）
- Modify: `test/helpers/wechat-sdk.mjs`（`image()` 加 `thread` 选项，发 `X-Weave-Thread`；不给时等于 `sender`）
- Create: `test/wechat-group-photos.test.mjs`

**Interfaces:**
- Produces: `export const GROUP_PHOTO_TRIGGER = label => \`${label} 在群里发了一张照片，没有 @ 你。这张照片你只能看这一次，之后不会保存。\``（草稿文案）。
- Produces: 群照片的入站条目 `{id: 'in:' + hash(messageId), direction: 'inbound', source: 'group', turn: 'photo', groupAad, ownerId: group.ownerId, payload: seal(JSON.stringify({sender, threadId, label})), photo?, photoProblem?, status: 'queued', createdAt}`。没有 `turn` 的群条目就是 @ 它的那种（照旧）。
- Produces: `claimNext` 对群条目多返回 `turn`，并且群条目也带出 `photoProblem`。
- Produces: `wakeForGroup({..., direct = true, kind = 'message'})`，trigger 是 `{kind, channel: 'group', direct, text}`。
- Produces: `/image` 读新的请求头 `X-Weave-Thread`；不带时 `thread = sender`（私聊，和 #54 一样）。
- Rule: 群这一路只在 `thread` 以 `GROUP_SUFFIX` 结尾、且通道是 `wx` 时走；iLink 送来的群照片一律 `{accepted: true, ignored: true}`。
- Rule: 群记录的 `photosToldAt` 有值才看照片（Task 2 负责设它；本任务的测试直接在 world 里写上）。

- [ ] **Step 1: 写失败的测试** `test/wechat-group-photos.test.mjs`（用 `setup()`、`enableGroup()`；本地一个 `told(h)` 用 `Store` 读写 world，给 `wechat-group:` 那条记录写上 `photosToldAt`；发照片用 `h.image(id, bytes, {thread: ROOM, sender: 'wxid-bob', channel: 'wx'})`）：
  - `a photo in an enabled, told group is a turn of its own: the vision model sees it once, direct is false, and nothing is said for it`：回答 `{accepted: true, queued: true, wake: true}`；照片表 1 行；`h.tick()` 后最后一次 wake 的 `body.scope === 'group'`、`body.model === 'deepseek-flash'`、`body.trigger` 含 `{kind: 'message', channel: 'group', direct: false}`、`body.trigger.text === GROUP_PHOTO_TRIGGER('成员2')`、`body.image.data` 是照片的 base64；照片表 0 行；Agent 回「看到了」以后 `h.bridge('claim', {})` 的 `jobs` 为空。
  - `the group record gets one line for the photo, and the photo itself is in no document`：解开群记录，最后一条是 `{from: '成员2', text: '[照片]'}`；`weave_documents` 里找不到照片 base64 的前 64 个字符。
  - `a photo in a group that is not enabled leaves no trace: no row, no record, no marker`：开启前发 → `{accepted: true, ignored: true}`；照片表 0 行；`weave_documents` 前后完全一样。
  - `before the group was told, a photo is only a line in the record: not stored, no turn`：开启了、没 `told` → `{accepted: true, stored: true}`；照片表 0 行；`tick` 后没有群范围的 wake。
  - `the same photo delivered twice is looked at once`：同一个 id 第二次 → `{accepted: true, duplicate: true}`；只有一次 wake。
  - `a photo more than 6 hours late is only a line in the record`：`createdAt` 早 7 小时 → `{accepted: true, stale: true}`；没有 wake；照片表 0 行。
  - `too big or not an image: no row, but the turn still runs and Weave hears the photo did not open`：`PHOTO_MAX_BYTES + 1` 字节，和一张标成 `image/png` 的 JPEG → 都排队；wake 不带 `image`，`trigger.text === GROUP_PHOTO_TRIGGER('成员2') + '\n' + PHOTO_UNAVAILABLE_FACT`；没有群里的发送。
  - `an empty /image (the bridge could not read the photo) is treated the same way`：空请求体，同上。
  - `if the photo turn fails, nothing is said in the group`：Agent 回 500 → 没有发送；条目 `uncertain`。
  - `several photos in a row: one turn each, in order, none said aloud`：三张 → 三次 wake，顺序和发出顺序一样，都 `direct: false`；没有发送。
  - `a photo then an @ about it: the photo turn runs first; the @ is answered once`：先照片，再 `h.bridge('events', h.group('wxid-bob', '@助理 这顿多少卡', true))` → wake 依次是 `direct: false`、`direct: true`；只有一条发送，是 @ 那一轮的回答。
  - `closing the group while a photo waits deletes it and nothing is said about it`：照片排着，然后 `@助理 关闭打卡群` → 照片表 0 行；`tick` 后没有照片轮。
  - `a group photo from the iLink bridge is ignored`：`channel: 'ilink'`、`thread: ROOM` → `{accepted: true, ignored: true}`。
  - `a private photo through the alt-account bridge is a message of its own, like over iLink`：`h.bind()`（小号那一路绑定），`h.image(id, bytes, {sender: 'wxid-alice', channel: 'wx'})`（不带 `thread`）→ `{queued: true}`；wake 是本人范围、带照片、`trigger.text === PHOTO_MESSAGE_TEXT`。
  - `Weave may speak in a photo turn through send_message`：Agent 桩在这一轮用通行证调 `h.tool('send_message', {text: '收到，记下了'}, capability)` → `ok`；群里排了这一条。
- [ ] **Step 2: 跑测试，确认失败**　Run: `node --test test/wechat-group-photos.test.mjs`　Expected: FAIL（`/image` 把群当私聊、`ignored`）。
- [ ] **Step 3: 实现**　`receiveImage` 先按 `thread` 分两路；群这一路沿用 `ingestGroup` 的做法：`readContext` / `writeContext`、`context.members` 给标签、`context.seen` 去重（`hash(messageId)`），`putPhoto` 的 `owner` 用 `group.ownerId`，照片先存、world 没写进去就 `dropPhoto`（和私聊同一套 try/finally）。`processInboundSdk` 的群分支：`direct = claim.turn !== 'photo'`；照片轮的文字 = `GROUP_PHOTO_TRIGGER(label)`，照片打不开时再接 `'\n' + PHOTO_UNAVAILABLE_FACT`；照片轮的 `afterWake` 只改条目状态、不 `queueOut`。
- [ ] **Step 4: 跑测试，确认通过**　Run: `node --test test/wechat-group-photos.test.mjs && npm test`　Expected: PASS。
- [ ] **Step 5: 提交**　`git commit -m "feat(wechat): every photo in a told group is a turn of its own, looked at once"`

### Task 2: 网站——开始看照片之前先说一声

**Files:**
- Modify: `hosted/lib/weave/wechat.mjs`（新 `queueGroupPhotoNotices`、`GROUP_PHOTO_NOTICE_TRIGGER`；`claimNext` / `processInboundSdk` 认 `turn: 'notice'`；删 `GROUP_PHOTO_TEXT`，开启群的话不再接照片说明，`holdGroupForPhoto` 里发说明的部分删掉）
- Modify: `hosted/lib/weave/scheduler.mjs`（`runScheduledSdk` 第一个 `withWorld` 里，`enabled` 时调 `queueGroupPhotoNotices`）
- Test: `test/wechat-group-photos.test.mjs`（说明那一节）；删 `test/wechat-images-gates.test.mjs` 里讲旧说明的测试（第 57–107、151–177 行）

**Interfaces:**
- Produces: `export function queueGroupPhotoNotices(world, now): number`。对每个开启的群（`world.runtime` 里 `wechat-group:` 开头、开启的人还在）：没有 `photosToldAt`、没有待回执的 `photoNotice`、没有排着或在跑的说明条目、而且 `photoNoticeTriedOn` 不是今天（北京时间：`localClock({profile: {timezone: GROUP_TIMEZONE}}, now).day`）→ 加一条 `{id: 'in:notice:' + groupAad + ':' + day, direction: 'inbound', source: 'group', turn: 'notice', groupAad, ownerId, status: 'queued', createdAt}`，并写 `group.photoNoticeTriedOn = day`。返回排了几条。
- Produces: `export const GROUP_PHOTO_NOTICE_TRIGGER = '这个群从现在起，大家发的照片你也会看：每张只看一次，把看到的打卡内容记下来，照片本身不保存；看的时候照片会发给 DeepSeek。用你自己的话跟群里说一声。'`（草稿文案）。
- Rule: 说明那一轮 = `wakeForGroup({kind: 'event', direct: true, text: GROUP_PHOTO_NOTICE_TRIGGER})`。成功：`group.photoNotice = queueOut(world, {source: 'group', groupAad, text: done.reply.slice(0, 4000), target: group.target}, now)`（不 @ 任何人）；`done.uncertain` 时什么都不发。`receiveReceipt` 不用改：那一条 `sent` 时写 `photosToldAt`。

- [ ] **Step 1: 写失败的测试**（加在 `test/wechat-group-photos.test.mjs`，不再用 `told(h)`，走真的说明流程）：
  - `a newly enabled group is told once, in Weave's own words, and photos are looked at only after that went out`：`enableGroup()` → `deliverAll()` → `tick()`：wake 的 trigger 是 `{kind: 'event', channel: 'group', direct: true}`、`text === GROUP_PHOTO_NOTICE_TRIGGER`；Agent 回「大家好，以后照片我也会看一眼」→ 群里排的那条 `text` 就是这句、不带 `mentions`；回执之前发照片 → `{stored: true}`；回执 `accepted` 以后再发 → `{queued: true}`。
  - `a group enabled before this change is told at the next tick`：world 里放一条没有 `photosToldAt` 的旧群记录 → `tick()` → 说明那一轮。
  - `a notice that did not go out is tried again the next Beijing day, not sooner`：回执 `failed` → 同一天再 `tick()` 没有说明轮；`h.setNow(+24h)` → 有。
  - `a notice turn that failed says nothing, and is tried the next day`：Agent 回 500 → 没有发送；第二天重试。
  - `opening a group says exactly the opening text, with nothing about photos`：开启那条发送的 `text === GROUP_ENABLED_TEXT`。
- [ ] **Step 2: 跑测试，确认失败**　Run: `node --test test/wechat-group-photos.test.mjs`　Expected: FAIL（`queueGroupPhotoNotices` 不存在）。
- [ ] **Step 3: 实现**　照 Interfaces 写；`claimNext` 对 `turn: 'notice'` 不解 `payload`（没有），群没了或开启的人没了就 `drop()`。
- [ ] **Step 4: 跑测试**　Run: `node --test test/wechat-group-photos.test.mjs && npm test`　Expected: PASS。
- [ ] **Step 5: 提交**　`git commit -m "feat(wechat): Weave tells each group before it starts looking at photos"`

### Task 3: 网站——删掉 60 秒配对和看图开关

**Files:**
- Modify: `hosted/lib/weave/wechat.mjs`：删 `PHOTO_HOLD_MS`、`holdForPhoto`、`holdGroupForPhoto`、`overdue` 里 `awaiting-photo` 那一支（`claimNext` 只认 `queued` 和 `processing` 的超时）、`receivePhoto`、`PHOTO_HEADERS`、`fromSamePerson`、`waitingForPhoto`、`/api/internal/wechat/photo` 路由、`normalize` 的 `photo` 字段和 `images` 参数、`BRIDGE_PHOTOS` / `bridgeSaysPhotos` / `X-Weave-Photos`、`wechatConfig().images`、`wechatPhotosShown`、`ingest` / `ingestGroup` 的 `images`、每个事件顺手清照片的那一行。保留 `wechat-photos.mjs` 和 `scheduler.mjs` 的 `sweepPhotos`。
- Modify: `hosted/lib/weave/api.mjs:97`（`wechatQueue` 不再传 `images`，`agentPhotos` 保留）
- Modify: `hosted/app/privacy/page.tsx`（去掉 `wechatPhotosShown`；照片那段话在 Task 6 换）
- Modify: `test/helpers/wechat-sdk.mjs`（删 `images`、`bridgePhotos`、`photo()`、`images()`、`bridgePhotos()`）
- Create: `test/wechat-photo-store.test.mjs`，从旧文件搬过来、改成走 `/image` 群照片（先 `told`）：`the store: a photo is sealed, comes back once, and an unused one is gone after 10 minutes (swept on the next tick)`、`a big photo is split over several rows and comes back whole`、`deleting the account deletes its waiting photos at once, before they expire`、`if writing the world keeps failing after the photo was stored, the photo is deleted`、`the Agent service's server tick sweeps expired photos too`、`the photo goes to the Agent service only inside /wake, with the service token`、`the photo is deleted whatever the turn does: success, an Agent service error, busy, or a dropped connection`
- Delete: `test/wechat-images.test.mjs`、`test/wechat-images-gates.test.mjs`

**Interfaces:**
- 删掉：`wechatPhotosShown`、`wechatConfig().images`、`/api/internal/wechat/photo`、条目状态 `awaiting-photo`。

- [ ] **Step 1: 搬测试**：建 `test/wechat-photo-store.test.mjs`（上面 7 条）。Run: `node --test test/wechat-photo-store.test.mjs`　Expected: PASS（行为 Task 1/2 已有）。
- [ ] **Step 2: 写失败的测试**（同一个文件）：`/api/internal/wechat/photo is gone: it answers like any unknown path`；`X-Weave-Photos on /events changes nothing: no photo field, no hold`。Expected: FAIL。
- [ ] **Step 3: 删代码、改 helpers、删两个旧测试文件**。Run: `grep -rn -E "WEAVE_WECHAT_IMAGES|awaiting-photo|holdForPhoto|holdGroupForPhoto|receivePhoto|X-Weave-Photos|wechatPhotosShown|GROUP_PHOTO_TEXT|bridgePhotos" hosted test`　Expected: 没有输出。
- [ ] **Step 4: 跑测试**　Run: `npm test`　Expected: PASS。
- [ ] **Step 5: 提交**　`git commit -m "refactor(wechat): drop the 60-second photo pairing and the photo switch"`

### Task 4: 桥接——每张照片都交给网站

**Files:**
- Modify: `hosted/wechat-bridge/bridge.mjs`
- Test: `test/wechat-bridge-images.test.mjs`（重写：留第 187–235、274–319、342–359 行的读取 / 限制 / 去附加信息 / 日志隐私 / 等 standard 那几条；改写第 239 行「the Weave client sends a photo as its own bytes…」为 `/image` 的请求头；删配对那些：第 63–186、239–272、328–341 行）

**Interfaces:**
- Produces: `export async function deliverPhoto(message, {daemon, weave, log})`：`readPhoto(daemon, message.id)` → 有 `bytes` 就 `weave('image', {messageId, threadId, senderId, createdAt, bytes, mediaType})`；有 `problem` 就交一个空的：`bytes: new Uint8Array(0)`、`mediaType: 'application/octet-stream'`，日志写原因代码，原因是 `media_403` / `content_403` 时加「WX_TOKEN 可能没有 media 权限」。网站回 404（不是 SDK 路线）记一行、当作交完。
- Changes: `createWeave` 的照片请求发到 `/api/internal/wechat/image`，请求头 `X-Weave-Message`、`X-Weave-Thread`、`X-Weave-Sender`、`X-Weave-Created-At`；不再有 `X-Weave-For`、`X-Weave-Photos`、`photos` 选项。
- Changes: `handleEvent`：`type === 3 && direction === 'incoming'` → `await deliverPhoto(...)`，交完才存读取位置（和文字一样）；`withHints` 认 `events` 和 `image`（不再认 `photo`）。
- Changes: `main` 的地址规则：`https://…`，或者 `http://` + 内网 IPv4（127/8、10/8、172.16/12、192.168/16）+ `:端口`；不合就抛 `'WEAVE_ORIGIN 必须是 HTTPS，或服务器内部地址（http://<内网 IPv4>:<端口>）'`。
- 删掉：`createPhotos`、`PHOTO_PAIR_MS`、`PHOTO_WATCH_MS`、`pairs`、`mayStartTurn`、`follow` / `main` 里的 `photos` 和 `WEAVE_WECHAT_IMAGES`。

- [ ] **Step 1: 写失败的测试**：
  - `every incoming photo goes to /image on its own, in a group or a private chat, with who sent it, where and when`：假守护进程给一条群照片、一条私聊照片 → 假网站收到两次 `/image`，请求头四个都对，请求体是去掉附加信息后的字节。
  - `the cursor moves on only after Weave answered the photo; a failed upload is replayed`：网站第一次回 503 → 读取位置没动；第二次 200 → 动了。
  - `a photo that cannot be read goes as an empty /image, and the log names the media scope when that is why`：`/media` 回 403 → 空请求体的 `/image`；日志含「media 权限」，不含消息 id、wxid、聊天 id。
  - `a photo is handed over before the text that follows it`：同一批事件先照片后文字 → 假网站收到的顺序是 `image`、`events`。
  - `outgoing photos (the alt account's own) are never sent`。
  - `nothing ever asks the daemon to download: no media-transfers call`：所有测试的假守护进程记下路径，没有一条含 `media-transfers`。
  - `an image answer with wake:true runs a tick at once, like an events answer`。
  - `WEAVE_ORIGIN: https, or http to a private IPv4 address with a port; anything else is refused`：`https://weave.example`、`http://172.17.0.1:4317`、`http://127.0.0.1:4317` 通过；`http://weave.example`、`http://8.8.8.8:4317`、`http://172.17.0.1`（没端口）被拒。
  - `end to end: a phone photo with a GPS position in a told group reaches the turn without it`：桥接的 `handleEvent` 接真的网站代码（`createWeave` 的 `fetcher` 交给 `handleAPI`）→ `tick` → wake 的 `image.data` 解开以后没有 GPS 段。
- [ ] **Step 2: 跑测试，确认失败**　Run: `node --test test/wechat-bridge-images.test.mjs`　Expected: FAIL。
- [ ] **Step 3: 实现**（照 Interfaces）。
- [ ] **Step 4: 跑测试**　Run: `node --test test/wechat-bridge-images.test.mjs && npm test`　Expected: PASS。
- [ ] **Step 5: 提交**　`git commit -m "feat(bridge): hand every photo to Weave as a message of its own"`

### Task 5: 部署脚本——直连网站、钥匙总带 media

**Files:**
- Modify: `deploy/tencent/wechat/lib.sh`：`WEAVE_ORIGIN_DEFAULT` 从 `deploy/tencent/.env`（`setup-env.sh` 写的，相对 `lib.sh` 是 `$here/../.env`）读 `WEAVE_BIND_IP`，得 `http://$WEAVE_BIND_IP:4317`；读不到就 `die '找不到 deploy/tencent/.env 里的 WEAVE_BIND_IP：先跑 deploy/tencent/setup-env.sh。什么都没做。'`。`WEAVE_ORIGIN` 环境变量照样能覆盖。
- Modify: `deploy/tencent/wechat/login.sh`：建桥接钥匙总是 `--scopes read --scopes send --scopes media`；删 `WEAVE_WECHAT_IMAGES` 那一支和相关注释；开头第 3 步的说明跟着改。连通性检查不用改（用的就是 `$origin`）。
- Modify: `deploy/tencent/wechat/README.md`、`deploy/tencent/README.md`：网站地址是内部地址；看图默认开着；上线后重跑一次 `login.sh`（已登录不扫码）换一把带 `media` 的钥匙。
- Test: `test/wechat-deploy-scripts.test.mjs`、`test/wechat-server-deploy.test.mjs`
- 不动：`deploy/wechat-mac`（2026-11-04 起不用，留给清理旧路线的那次）。

- [ ] **Step 1: 改测试期望，确认失败**：`tokens create` 总带 `--scopes media`；`bridge.env` 里写的 `WEAVE_ORIGIN` 是 `http://<假 .env 里的 WEAVE_BIND_IP>:4317`；没有 `.env` 时 `login.sh` 拒绝、什么都没做。Run: `node --test test/wechat-deploy-scripts.test.mjs test/wechat-server-deploy.test.mjs`　Expected: FAIL。
- [ ] **Step 2: 实现**。
- [ ] **Step 3: 跑测试**　Run: 同上，再 `npm test`　Expected: PASS（本机没装 shellcheck 时那几条会跳过，CI 跑）。
- [ ] **Step 4: 提交**　`git commit -m "feat(deploy): the bridge talks to Weave on the internal address; its key always reads photos"`

### Task 6: Agent 服务——本人的照片存进 `user/`；修过时的容器测试

**Files:**
- Modify: `hosted/agent-service/server.mjs`（`keepPhoto` 的文件夹 `photos` → `user`，注释跟着改）
- Modify: `hosted/agent-service/prompts.mjs`（注释里的 `photos/`）
- Test: `hosted/agent-service/test/server-images.test.mjs:104-130`、`images.test.mjs:95,155`、`e2e-wechat-images.test.mjs:115-118`（路径改成 `user/`）；`container.test.mjs:94` 改成**群范围**（旧断言照旧成立：照片原样到模型、用 `deepseek-flash`、`sessions.json` 不变、挂进容器的目录里没有它），另加一条本人范围的容器测试：照片存在 `user/` 下、也在会话记录里。
- Modify: `hosted/app/privacy/page.tsx`：照片那段换成设计文档第 7 节第 4 句（草稿，标出）。

- [ ] **Step 1: 改测试里的路径为 `user/`，改容器测试**。Run: `npm --prefix hosted/agent-service test`　Expected: FAIL（还在写 `photos/`）。
- [ ] **Step 2: 改 `keepPhoto`**。Run: 同上　Expected: PASS（容器测试本地跳过）。
- [ ] **Step 3: 改隐私页**。Run: `npm test`　Expected: PASS。
- [ ] **Step 4: 提交**　`git commit -m "feat(agent): keep the owner's photos under user/, like Muse"`

### Task 7: 文档和草稿 PR

**Files:**
- Modify: `docs/WECHAT.md`（照片那几节换成新的做法：开启的群、先说一声、每张看一次、群照片不留、本人照片在 `user/`、没有开关、钥匙要 `media`、直连内部地址）；`docs/ARCHITECTURE.md` 里提到看图开关或配对的地方（`grep -n -E "看图|WEAVE_WECHAT_IMAGES|配对" docs/ARCHITECTURE.md`）。

- [ ] **Step 1: 查漏**　Run: `grep -rn -E "WEAVE_WECHAT_IMAGES|60 秒|配对|X-Weave-For|photos/" docs hosted deploy/tencent test | grep -v deploy/wechat-mac`　Expected: 只剩有意保留的（写清为什么）。
- [ ] **Step 2: 全量测试**　Run: `npm test && npm --prefix hosted/agent-service test`　Expected: PASS。
- [ ] **Step 3: 推送、开草稿 PR**：`git push`；`gh pr create --draft --base feat/ilink-private --head feat/group-photos`（叠在 #54 上，diff 只有这次的改动；#54 合并后改 base 为 `feat/deploy-tencent`）。PR 说明：做了什么、为什么（教材 p.20 / p.30 / p.46）、跑过的命令和结果、「新文字（请确认）」（设计第 7 节 5 句 + #54 的 4 处）、上线步骤（设计 6.8，带确切命令）、风险（设计第 10 节）。
- [ ] **Step 4: 等 CI**　Run: `gh pr checks <PR号> --watch`　Expected: `verify` 通过（含容器测试）。
