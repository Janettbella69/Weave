# 换底座：网站直接跑在 Node 上，数据存成一个 SQLite 文件

日期：2026-11-16
状态：设计稿，等主人定第 9 节的事。只写设计，没有改任何实现代码。
对应审查：2026-11-04 代码体检，03-foundation.md「如果只改一件事」。这是三步重建的第一步。

## 0. 一句话

网站现在用开发工具 `wrangler dev --local` 在容器里模拟整个 Cloudflare 平台。平台早就换成了自己的服务器，这层模拟没有存在的理由。

这一步只做一件事：**把网站换成一个普通的 Node 进程，数据存成一个 SQLite 文件，每天备份。** 表结构原样搬过去，业务代码（`hosted/lib/weave/`）一行逻辑都不改。

## 1. 现状（带证据）

行号都是在 `origin/feat/deploy-tencent` 的 9ef71f9 上数的。

### 1.1 网站是怎么起来的

容器入口是 `hosted/scripts/start-vps.sh`（67 行）。它依次做这些事：

1. 把容器的环境变量抄成 `/app/.dev.vars`，一共 25 个变量（第 10–36 行）。这是 wrangler 读配置的方式。
2. 第一次启动时，用 `wrangler d1 execute` 建表，用标记文件记住建过了（第 5–6、38–51 行）。
3. 在后台起 Notion 本地代理，监听 127.0.0.1:4319（第 53 行）。
4. 检查 wrangler 的补丁有没有打上（第 55–56 行）。
5. 在后台起看门狗（第 58–62 行）。
6. 最后 `exec wrangler dev --local ... --port 4317`（第 64–67 行）。

镜像在 `hosted/Dockerfile.vps`（31 行）里构建。第 1 行就写着「Worker 用 `wrangler dev --local` 跑，D1 存在 /app/.wrangler/state」。第 8–11 行在构建时给 wrangler 的两个源文件打补丁。第 22–29 行用两个环境变量关掉 wrangler 自带的数据浏览器和调试日志文件。

于是一个网站容器里常驻 5 个进程：wrangler、两个 workerd、Notion 代理、看门狗。容器上限 768 MB（`deploy/tencent/compose.yml:24`）。

一次请求的路径：nginx → wrangler 的代理 workerd → 网站 workerd → `worker/index.ts`（先把请求体读完，再查访问密码）→ vinext → `app/api/[...path]/route.ts` → `handleAPI`（`lib/weave/api.mjs`）。

在 `handleAPI` 里，每个请求都：读全库（`api.mjs:106`）、替所有人投递提醒（`:109`、`:110`），然后才轮到真正的路由。

### 1.2 哪些文件依赖 Cloudflare

`cloudflare:workers`（这个模块在 Node 里不存在）：

| 文件 | 行 | 用来做什么 |
| --- | --- | --- |
| `hosted/app/api/[...path]/route.ts` | 1、10–11 | 拿 `env`（数据库和所有配置），传给 `handleAPI` |
| `hosted/app/weave-auth.ts` | 43 | 读单用户模式的环境变量 |
| `hosted/app/privacy/page.tsx` | 17、32 | 读照片开关和 Jev 配置，决定隐私页多显示哪几条 |
| `hosted/app/api/auth/guest/start/route.ts` | 1、57 | 访客模式，往 `weave_guest_sessions` 写一行 |
| `hosted/db/index.ts` | 1 | drizzle 的包装，没有任何地方引用 |
| `hosted/scripts/connector-preview/worker.mjs` | 1 | Sites 的连接器预览，只在开发时用 |

另外 `hosted/worker/index.ts`（44 行）是 Worker 入口：`scheduled`（Cron，线上不跑）、`fetch`（读完请求体、查访问密码、套连接器绑定、交给 vinext）。类型 `Cloudflare.Env`、`ExecutionContext`、`D1Database` 散在上面这些文件里，声明在 `hosted/cloudflare-env.d.ts`。

### 1.3 数据库怎么被用（D1 风格的接口）

业务代码拿到的 `db` 是 D1 的样子：`db.prepare(sql).bind(...).run() / .all()`，以及 `db.batch([...])`，返回值取 `.results` 和 `.meta.changes`。全仓库一共 5 个文件、20 来处：

| 文件 | 用法 |
| --- | --- |
| `lib/weave/store.mjs:6–34` | 读：`prepare().run()` 一次加 `batch` 两条 SELECT。写：一条 `batch`，第一条是 `UPDATE weave_commits ... WHERE revision=?`（抢版本号），后面是带 `WHERE EXISTS (... token=?)` 的 INSERT 和 DELETE。用 `result[0].meta.changes !== 1` 判断有没有抢到 |
| `lib/weave/wechat-photos.mjs:41–80` | `weave_wechat_photos` 表：运行时 `CREATE TABLE IF NOT EXISTS`、`batch` 插入、`.all()` 读、`.run()` 删（一行最多 900,000 字符，注释说是为了躲 D1 的单值 2 MB 上限） |
| `lib/weave/wechat.mjs:94` | 隐私页用：读桥接心跳那一份文档 |
| `lib/weave/api.mjs:269` | 删账号时清访客会话 |
| `app/api/auth/guest/start/route.ts` | 访客会话 INSERT |

`Store` / `withWorld` 又被 11 个文件用（`api.mjs`、`scheduler.mjs`、`dispatcher.mjs`、`proactive.mjs`、`day-close.mjs`、`wechat.mjs`、`agent-tools.mjs`、`agent-snapshot.mjs`、`notion-connect.mjs`、`hermes-queue.mjs`）。它们都只通过上面这个接口碰数据库。

好消息：测试里的假 D1（`test/helpers/product-db.mjs`，4 行 `prepare`/`run`/`all`/`batch`）是用 `node:sqlite` 做的，而且有 10 个测试文件在用。也就是说，**这个接口在 `node:sqlite` 上已经被 663 个用例天天验证。**

库里 3 张表（`hosted/drizzle/0000_*.sql`、`0001_guest_sessions.sql`）：

- `weave_documents(id, kind, document)`：一行一份整个 JSON。`kind` 是 people / negotiations / invites / links / runtime / wechat 六类之一。
- `weave_commits(id, revision, token)`：只有一行 `'world'`，全站唯一的版本号。
- `weave_guest_sessions(id, created_at)`：访客。
- `weave_wechat_photos`：运行时才建。

### 1.4 依赖 Next / Vinext 的东西

只有 7 个文件，都在服务端页面这一层：

| 文件 | 用到的 | 行 |
| --- | --- | --- |
| `app/chatgpt-auth.ts` | `next/headers`（读请求头里的 `oai-authenticated-user-*`）、`next/navigation` | 1–2 |
| `app/weave-auth.ts` | `next/headers` 的 `cookies()`（访客 Cookie） | 1 |
| `app/layout.tsx` | `next` 的 `Metadata` 类型 | 1 |
| `app/privacy/page.tsx` | `Metadata` 类型、`next/link` | 1–2 |
| `app/LandingMarketing.tsx` | `next/link` | 1 |
| `app/page.tsx` | 没有 import，但用了 Next 的 `searchParams` 约定和 `dynamic` 导出 | 1–14 |
| `worker/index.ts` | `vinext/server/fetch-handler` | 1 |

重要的一点：**工作台（`app/workspace/`，一个 `'use client'` 的 React 应用，约 20 个文件）没有任何地方 import Next。** 它用自己的 `view-route.mjs` 做路由，用 `api-client.mjs` 调接口。`lib/weave/` 里也没有任何 npm 依赖，只有相对路径和 Node 内置模块。

所以服务端页面一共只有三个：首页（根据有没有登录选工作台还是落地页）、隐私页、两个访客接口。真正的页面全在浏览器里跑。

### 1.5 垫层清单

「垫层」是指：为了在一个不用的平台上继续跑而存在的代码。按教材 p.21 的自查，每一段都要说清它属于「合法位置」里的哪一个。下面这些一个都不属于。

| 垫层 | 行数 | 做什么 | 为什么存在 |
| --- | --- | --- | --- |
| `scripts/start-vps.sh` | 67 | 抄环境变量成 `.dev.vars`、建表、起三个后台进程 | wrangler 只读 `.dev.vars`；没有迁移机制 |
| `scripts/patch-wrangler-proxy.mjs` | 195 | 构建时改 wrangler 4.92.0 的两个源文件 | #24：开发代理会把 GET 挂起 25 秒；#41：调试代理把每次 D1 回答存着，内存涨到被杀 |
| `scripts/web-watchdog.sh` | 145 | 每 10 秒请求一次网站，连续 3 次不回就让 wrangler 退出 | workerd 被杀时 wrangler 不退出，Docker 不知道要重启（11-03 出过一次，502 持续一个半小时） |
| `worker/index.ts` | 44 | Worker 入口：Cron、读完请求体、访问密码、连接器绑定 | Worker 的入口约定；`scheduled` 在线上从不触发 |
| `lib/weave/request-body.mjs` | 11 | 在任何回答之前把请求体读完 | wrangler 代理复用连接，没读完的字节会让下一次转发失败（503 或整个进程退出） |
| `scripts/notion-oauth-proxy.mjs` | 167 | 本机 4319 端口的 HTTP 代理，替 Worker 换 Notion token、转发 Notion API | 见第 3.4 节：当初为什么要加，仓库里没有写 |
| `db/index.ts`、`db/schema.ts`、`drizzle.config.ts`、`drizzle/meta/` | 28 + 7 + 元数据 | drizzle 封装 D1，生成迁移 | 没有任何地方引用 `getDb`；迁移 SQL 本身要留 |
| `cloudflare-env.d.ts` | 21 | `Cloudflare.Env` 类型（已经比实际少了 9 个变量） | 给 `cloudflare:workers` 的 `env` 配类型 |
| `vite.config.ts` | 93 | Cloudflare 的 Vite 插件、假的 D1 绑定、Cron 触发器、连接器预览服务 | 把 vinext 的构建产物做成 Worker |
| `app/weave-auth.ts` 里的访客和 ChatGPT 两条分支、`chatgpt-auth.ts`、`app/api/auth/guest/*` | 117 + 90 + 123 | 单用户之外的身份：Sites 的请求头、访客 Cookie | OpenAI Sites 平台的身份约定。VPS 上 `WEAVE_VPS_MODE=true`，这两条永远走不到；而关掉单用户后会相信 `oai-authenticated-user-*` 请求头，nginx 会原样转发它（推断，见审查报告） |
| `ci-smoke.sh` 里的 6 项检查 | 约 30 | 检查补丁、日志文件、请求体、轮询卡顿 | 专门测上面这些垫层 |
| 测试：`vps-proxy`、`web-watchdog`、`request-body` | 65 + 214 + 38 | 测上面三个垫层 | 同上 |

合计：运行垫层约 790 行，测试和 CI 约 350 行。另外还有一类「Sites 脚手架」（第 5 节），约 2,560 行，是为 OpenAI Sites 的开发流程生成的，换底座后没有任何东西再引用它们。

### 1.6 为什么它一直在出事

三件已经发生过的事，根在同一处：

- 页面卡 25 秒（#24 #32）：wrangler 内部两个 workerd 之间有一条闲了 5 秒就被关的连接。
- 内存涨到被杀（#41）：wrangler 的调试代理存着每一次 D1 回答，而 `Store.load()` 每次的回答就是整个世界。
- 502 一个半小时：workerd 死了，wrangler 没死。

补丁和看门狗压住了症状。`wrangler` 钉死在 4.92.0（`package.json`），因为 vinext 还是 beta；一升级补丁就对不上，构建会失败。底座本身没有变。

## 2. 目标

```
nginx ──► Node 进程（一个）──► SQLite 文件（/data/weave.db）
              │
              ├─ 静态页面（Vite 打好的前端）
              ├─ handleAPI（原样）
              └─ 访问密码（原样）
Agent 服务 ──每分钟 POST /api/internal/tick──► 同一个进程
```

要点：

- 一个容器、一个进程。进程退出，Docker 重启它。不需要看门狗。
- 运行时没有任何 npm 依赖（`lib/weave/` 本来就没有），镜像里只有 Node 和我们自己的文件。
- 对外的端口、路径、接口、请求头都不变。Agent 服务、微信桥接、nginx、浏览器都不用改。

## 3. 设计

### 3.1 网站怎么跑：A 还是 B

**A：普通 Node 程序。** 一个 `server/main.mjs`（约 150–250 行），用 Node 内置的 `http` 收请求，转成 `Request` 交给 `handleAPI`，把 `Response` 写回去；其余路径发 Vite 打出来的静态文件。前端是一个浏览器端 React 应用，入口一个 `index.html`。

**B：正版 Next.js（或 vinext）跑在 Node 上。** 页面、路由、`next/headers` 都保留。

| 比较 | A 普通 Node | B Next / vinext 跑在 Node 上 |
| --- | --- | --- |
| 要改的页面 | 隐私页和首页要改写（第 3.6 节）；工作台不动 | 几乎不动 |
| 运行时依赖 | 0 个 | next、react-server-dom-webpack、vinext（beta）、两层 Vite 构建环境 |
| 还剩没剩下垫层 | 没有 | 有：`next/headers` 在这里只是为了读我们自己本可以直接读的请求头；`weave-auth.ts:41` 的注释写着「必须在 Next 的异步上下文绑定之前读 env」，说明这层已经有行为上的坑 |
| 上游风险 | 只有 Node 和 Vite | vinext 钉在 1.0.0-beta.5；我在 npm 上看到最新版已经是 1.4.5，要追上也是一次升级（我没有验证它的 Node 服务器 `vinext start` 能不能直接用） |
| 内存（推断，没测） | 一两百 MB 以内 | 要多一整套服务端渲染运行时，大概更高 |
| 进程自己能管的事 | 全部：优雅退出、健康检查、请求体上限、日志、启动时跑迁移 | 一部分在框架手里 |

**推荐 A。** 依据：

1. 教材 p.20 说代码合法的位置有四个，p.21 要求每一段传统代码说清属于哪一个。服务端渲染框架不属于其中任何一个——它不是启动前预处理、不是基础设施、不管副作用、也不是人把关前的暂存。我们的页面也并不需要服务端渲染：工作台已经是 `'use client'`，数据全从 `/api/status` 来。留着它，只是把「不用的平台的垫层」换成「不需要的框架的垫层」。
2. 真正依赖框架的只有 7 个文件、不到 700 行，而且其中 `chatgpt-auth.ts`、访客那几个是要删的（见 3.5）。要重写的只有隐私页（150 行）。
3. `handleAPI(Request) → Response` 本来就是标准写法，在 Node 24 上直接能用，没有适配层。

B 的唯一好处是少改几个页面。这个好处是一次性的，代价是长期的，所以不选。

**不选 C**（继续调 wrangler）：它就是补丁。

### 3.2 数据怎么存

一个 SQLite 文件 `/data/weave.db`，用 Node 内置的 `node:sqlite`（测试里已经在用，不加依赖）。

- 一个很薄的适配器 `hosted/server/sqlite-db.mjs`（约 50–60 行），**对外保持现在的 `prepare/bind/run/all/batch` 形状**，这样 `lib/weave/` 一行不动。
  - `batch` = `BEGIN IMMEDIATE … COMMIT`，出错 `ROLLBACK`。`node:sqlite` 是同步的，所以 batch 里没有任何 `await`，真正原子。
  - 打开时设 `PRAGMA journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`、`synchronous=NORMAL`。
- 这个适配器是「基础设施」（教材四个合法位置的第 2 个）：它在业务代码和真实数据库之间，没有模拟任何别的东西。D1 风格的 `.results`、`.meta.changes` 是留下来的旧习惯，第二步重写 `store.mjs` 时一起换成直接的接口。
- 测试里的假 D1（`test/helpers/product-db.mjs`）改成直接 `import` 这个适配器，打开 `:memory:`。以后测试测的就是线上跑的那份代码，不再是另一份。
- 建表用编号的 SQL 文件加一张版本表：`hosted/migrations/0001_init.sql`（就是现在的 0000 和 0001 合并）、`0002_wechat_photos.sql`（把「运行时才建」的照片表变成正式的一张）。启动时按编号跑没跑过的，放在一个事务里；失败就退出，容器起不来，部署脚本的检查会发现。**第一步的迁移只许加，不许改和删**，这样回退到旧镜像总是安全的。

### 3.3 要不要顺手拆表（「一整份世界」）

**推荐：这一步不拆。** 拆表放进第三步，和「一轮」做成一等公民一起做。理由：

1. **拆了表，现在的业务代码还是要「整个世界」。** `handleAPI`、`scheduler`、`dispatcher`、`proactive` 等 11 个文件都是拿一个 `world` 对象来读来写的（第 1.3 节）。不改它们而只拆表，`load()` 只是把拆开的表再拼回去，比现在还多一步，什么好处也没有。真正的好处（只读本人的数据、按人加锁）要求业务代码改成「按人取数据」，那是第三步的事。
2. **第一步要能逐行验证。** 表结构不变，迁移就是把每一行原样复制，核对「行数一样、每行文档的 SHA-256 一样、版本号一样」就能说迁对了。一旦同时拆表，这个验证就没了，出了问题分不清是底座还是拆表。
3. **回退要简单。** 表结构不变，回退到旧版本时把行复制回去就行（第 6.4 节）。拆了表，回退就要写反向转换。
4. **一次只换一样东西。** 已经有三个已知的底座风险（Node 版本、`node:sqlite` 的稳定性、前端改写），再加一个数据模型改动会把风险叠在一起。

这一步为拆表预先做好的只有一件事：有了迁移机制（第 3.2 节），第三步加新表只是加一个 SQL 文件。

**什么时候会推翻这个建议：** 如果主人在第一步的预演里发现 world 已经很大（第 6.1 节的命令会给出数字），一次读写要几百毫秒以上，那就应该把第三步提前，而不是在第一步里塞拆表。

### 3.4 全局锁怎么处理

先说它现在为什么存在。`store.mjs:1–2` 的注释说是为了「防止多个 Worker 实例之间丢失确认和重复预订」。换成一个进程之后，**多实例这个前提消失了**，但另一个前提还在：一个请求在 `load()` 和 `save()` 之间会 `await` 别的东西（Notion、Agent 服务、模型），这时别的请求可以插进来写。

所以第一步：

- **版本号这一套（`weave_commits.revision` + 重试 + 409）原样保留，语义不变。** 它在 SQLite 上同样正确：`UPDATE … WHERE revision=?` 受影响行数不是 1，就说明有别人先写了。
- 变化的只有底下：`batch` 现在是一个真正的 `BEGIN IMMEDIATE` 事务，没有网络往返；每次 `load()` 从本机文件读，不再是 workerd 之间的 HTTP。#41 那种「每次查询的回答被存着」不存在了。
- 不加进程内互斥锁。「在请求外面套一把锁，让所有请求排队」又是一个补丁：它掩盖「一次读写整个世界」这个根，而根在第三步（按人拆、按人加锁）才会真正解决。

诚实地说：第一步之后，**每个请求仍然读全部数据、全站仍然一个版本号**。变快、变稳定的只是底下那一层。这是故意的，不是漏掉了。

### 3.5 身份和访问密码

- **访问密码保留**：`lib/weave/basic-auth.mjs`（39 行，已有测试 `test/basic-auth.test.mjs`）原样用，在 `main.mjs` 里最先调用。`WEAVE_BASIC_AUTH` 不设就不拦（和现在一样）。免密码的路径照旧：`/api/internal/agent/tools/`、`/api/internal/hermes/`、`/api/internal/wechat/`、`/api/internal/agent/snapshot`、`/api/internal/tick`，它们各自有令牌。再多一个 `/healthz`（只回 200 和 `{"ok":true}`，不碰任何数据）。
- **身份只留单用户**：`getWeaveUser` 缩成约 25 行，没有 `next/headers`、没有 `cloudflare:workers`：`WEAVE_VPS_MODE=true` 就用环境变量里的那个人，否则返回 null（接口回 401）。
  - **删掉 ChatGPT 请求头分支。** 线上走不到，而且是个洞：不是单用户模式时会相信请求头里的 `oai-authenticated-user-id`，谁都能伪造。
  - **删掉访客模式。** 线上走不到。多人要的是真登录，那是第三步。库里的 `weave_guest_sessions` 表留着不动（数据不丢，以后要清再说）。
  - `api.mjs:269` 那句「删账号时清访客会话」随之删掉。

### 3.6 页面

- **工作台**：`app/workspace/` 不动。新增一个客户端入口 `hosted/client/main.jsx`（约 30 行）：挂上 `ErrorBoundary` 和 `Workspace`。`Workspace` 现在从服务端收一个 `authKind` 属性，单用户下恒为 `"single"`，改成常量。样式 `globals.css` 照旧，Vite 用现有的 `postcss.config.mjs` 处理 Tailwind。
- **隐私页**：从服务端渲染改成客户端页面（路径 `/privacy`，同一个包里按路径显示）。多显示哪几条（照片、Jev）的开关，由一个新接口 `GET /api/privacy-flags` 给出，规则和现在的 `photosOn()`、`jevText()` 一样。**页面上的字一个都不改**，包括 `JEV_PRIVACY` 那句 2026-11-16 确认过的原句。
- **落地页**（`LandingMarketing.tsx`，174 行）：单用户 + 访问密码下，没有人会走到它（没登录根本过不了密码）。第一步不迁移，文件留在仓库里（不再被构建），第三步做真登录时再决定。
- 静态文件：带哈希的文件名，`Cache-Control: public, max-age=31536000, immutable`；`index.html` 用 `no-cache`。其余路径（没有 `.` 的、不是 `/api/` 的）回 `index.html`。

### 3.7 配置

环境变量只读一次：`server/config.mjs` 约 40 行，一个对象，原样传给 `handleAPI`。现在的 6 份抄写（`web.env` → `start-vps.sh` 白名单 → `.dev.vars` → `cloudflare-env.d.ts` → `route.ts` → `handleAPI` 参数）去掉中间 3 份。

新增的变量就两个：`WEAVE_DB_PATH`（默认 `/data/weave.db`）、`PORT`（已有）。其余全部沿用 `web.env` 里已有的名字，**`web.env` 不需要改。**

### 3.8 Notion 本地代理

事实：`scripts/notion-oauth-proxy.mjs`（167 行）是 `03baadf`（「run Weave on the Tencent box」）加的，提交信息和仓库文档都没有写它为什么存在。`NotionClient`（`lib/weave/notion.mjs:5–15`）有两条路：配了 `apiProxy` 就把请求 POST 给代理，没配就直接 `fetch('https://api.notion.com/v1/…')`。我的判断（推断，没有证据）是：当初 workerd 里的出站请求在这台机器上有问题，用一个 Node 代理绕开了。**换成 Node 以后，这个理由不再成立。**

设计：删掉这个独立进程。保留它做对的三件事（`test/notion-proxy.test.mjs` 钉着它们），放进 `NotionClient` 的直连这一条路：

1. 对 Notion 的每个请求都有超时（现在是 20 秒）：`AbortSignal.timeout(20_000)`。
2. 报错里不带请求里的东西（token、client secret、授权码）。
3. 只往 `https://api.notion.com/v1/` 下面发。

`NOTION_API_PROXY_URL` 和 `NOTION_OAUTH_EXCHANGE_URL` 两个变量在 `config.mjs` 里不再默认指向 127.0.0.1:4319（`start-vps.sh:35–36` 现在的默认值）。`apiProxy` 参数留着不动（`scripts/notion-oauth-e2e` 的假 Notion 要用它测试）。

这一条是整个设计里唯一不确定的地方：**上线前要在服务器上证明 Node 直连 api.notion.com 通。** 办法见第 6.1 节的命令 4。通不了的话，就留着这个代理文件但不再由网站容器的启动脚本起它——到时候再说，不是现在预先写的补丁。

### 3.9 定时任务

`/api/internal/tick`：Agent 服务每分钟 POST 一次（`agent-service/server.mjs:90–120`，`AGENT_TICK_SECONDS`，默认 60），带 `Authorization: Bearer <AGENT_SERVICE_TOKEN>`。`api.mjs:69–77` 校验令牌，跑 `runScheduled`。

第一步**完全不动**：路径、令牌、返回值都一样，Agent 服务不用改一个字。`worker/index.ts` 里的 `scheduled`（Cron）直接删掉，它在线上从来不触发。

不属于这一步、记在这里：（a）每个网页请求还在替所有人投递提醒（`api.mjs:109–110`）——审查建议「只留一个闹钟」，它依赖第三步；（b）微信桥接也有自己的闹钟。这两处本步不动，不让改动面变大。

## 4. 要删的垫层

### 4.1 运行垫层（PR 2 删）

| 文件 | 约行数 |
| --- | --- |
| `scripts/start-vps.sh` | 67 |
| `scripts/patch-wrangler-proxy.mjs` | 195 |
| `scripts/web-watchdog.sh` | 145 |
| `worker/index.ts` | 44 |
| `lib/weave/request-body.mjs` | 11 |
| `scripts/notion-oauth-proxy.mjs`（三件事并入 `notion.mjs`，约 +25） | 167 |
| `db/index.ts`、`db/schema.ts`、`drizzle.config.ts`、`drizzle/meta/` | 35 + 元数据 |
| `cloudflare-env.d.ts` | 21 |
| `next.config.ts`、`.openai/hosting.json` | 12 |
| `app/chatgpt-auth.ts`、`app/api/auth/guest/*` | 213 |
| `app/weave-auth.ts` 重写（117 → 约 25） | 净 -92 |
| `vite.config.ts` 重写（93 → 约 25） | 净 -68 |
| `app/page.tsx`、`app/layout.tsx`、`app/privacy/page.tsx` 改成客户端版本 | 约持平 |
| `test/vps-proxy.test.mjs`、`web-watchdog.test.mjs`、`request-body.test.mjs` | 317 |
| `ci-smoke.sh` 里 6 项垫层检查（第 61–90 行一带） | 约 30 |
| 小计 | 约 1,350 行（运行 1,000 + 测试和 CI 350） |

新增：`server/main.mjs` 约 200、`server/sqlite-db.mjs` 约 60、`server/config.mjs` 约 40、`server/migrate.mjs` 约 40、`client/main.jsx` 约 30、迁移 SQL 约 20、备份和迁移脚本约 300（第 5、6 节）、新测试约 400。**净删除约 1,350 行，新增约 1,100 行**，其中一半是备份、迁移和测试，这些是现在完全没有的东西。

### 4.2 Sites 脚手架（PR 5 删）

这些是为 OpenAI Sites 的开发流程生成的，PR 2 改完 `vite.config.ts` 之后没有任何东西再引用它们：

| 文件 | 约行数 |
| --- | --- |
| `scripts/vite/`（sites 插件、连接器预览插件） | 428 |
| `scripts/connector-preview/` | 508 |
| `scripts/install-ci.mjs`、`install-ci.sh`、`install-pnpm.sh`、`npm-install.mjs`、`pnpm-install.mjs` | 950 |
| `scripts/sites-env.mjs`、`sites-env.sh`、`execution-profile.mjs`、`tool-environment.mjs`、`run-framework.mjs`、`check-status-stall.mjs`、`build-verified.sh` | 约 280 |
| `lib/connector-*.{ts,mts}`、`connector-context.ts`、`components/connector-error.tsx`、`examples/d1/` | 约 400 |
| 小计 | 约 2,560 行 |

分开成单独的一个 PR，是因为它们和换底座没有依赖关系：删不删都不影响上线，放在最后删，出问题时好分辨。`package.json` 同时去掉 `next`、`vinext`、`wrangler`、`@cloudflare/*`、`drizzle-orm`、`drizzle-kit`、`@vitejs/plugin-rsc`、`react-server-dom-webpack`、`raw-body`、`json-rpc-2.0`。

`components/ui/`（7,334 行，没有任何页面引用，审查已确认）和旧原型、Hermes 旧路径是「死代码」，不是垫层，不在这份设计的范围。这一步完成后，它们不会比现在更难删。

两处文档要改：`hosted/README.md`（还写着「Sites 管理登录、Vinext、Cloudflare Worker 与 D1」）和 `deploy/tencent/README.md`、仓库根 `README.md:220–228`（讲 wrangler 和 Cron 的那几段）。

## 5. 备份（主人选了 B）

**要保的东西：** SQLite 文件、`web.env`、`agent.env`、`.env`（`web.env` 里的 `WEAVE_ENCRYPTION_KEY` 丢了，库里存的钥匙全解不开，所以它必须和库一起备份）。`~/weave-data/agent`（Agent 的工作目录、`MEMORY.md`、额度账本）也没有备份，见第 9 节第 6 条，要先量大小。

### 5.1 每天一次，服务器上

由宿主机的 systemd 定时器触发（`deploy/tencent/backup.sh`，约 80 行），步骤：

1. `docker exec weave-web-1 node scripts/backup-db.mjs`：用 SQLite 的 `VACUUM INTO` 在 `/backups/weave-<时间>.db` 做一份一致的快照（网站不停，WAL 下也安全）。紧接着对这份快照跑 `PRAGMA integrity_check`，数每张表的行数和每类文档的数量，算整个文件的 SHA-256，写进同名的 `.json` 清单。清单里还有 `weave_commits.revision`。
2. 把快照、清单、三个配置文件打成一个 tar，用 **age** 加密：`age -r <公钥> -o weave-<时间>.tar.age`。
3. 上传到 COS（第 5.2 节）。
4. 本机 `~/weave-data/backups/` 只留 14 天（按文件时间删）。目录权限 700，文件 600。
5. 写 `~/weave-data/backups/last-success.json`（时间、大小、清单摘要）。

部署前也会跑一次第 1 步（`deploy.sh`，第 7 节），不上传。

### 5.2 加密和 COS

- **age，公钥放服务器，私钥只在主人手里。** 服务器被入侵最多能让人写新备份，解不开旧的。私钥生成在主人自己的电脑上（`age-keygen`），存两份：密码管理器一份，离线（打印或 U 盘）一份。私钥丢了，所有备份都成了废纸，所以这一条要在上线前演练时确认两份都能用。
- **COS 只写子账号。** 在腾讯云访问管理里新建一个子用户，只给下面这些动作，资源只限这一个桶的 `weave/` 前缀：`name/cos:PutObject`、`name/cos:InitiateMultipartUpload`、`name/cos:UploadPart`、`name/cos:CompleteMultipartUpload`、`name/cos:AbortMultipartUpload`。**不给** GetObject、DeleteObject、ListBucket、任何桶设置的权限（具体策略 JSON 在建的时候对着控制台写，我没有访问腾讯云，这里只定原则）。它的密钥存在服务器 `~/weave-data/backup.env`（权限 600），只有 `backup.sh` 读。
- **开版本控制。** 万一密钥泄露，攻击者也只能「覆盖」同名对象，旧版本还在。文件名带时间戳，正常情况下不会重名。
- **生命周期 30 天**：当前版本和历史版本都在 30 天后自动过期。因为子账号不能删，清理只能靠生命周期。
- **桶和服务器放在不同的地域**（见第 9 节第 5 条）。

### 5.3 每次自动校验

只写密钥读不了东西，所以校验分两段：

1. **服务器上、每次备份都做**：快照的 `integrity_check` 必须是 `ok`；用快照新建一个临时库，行数和清单对得上；`age` 加密成功、输出非空；上传命令带 COS 的校验（CRC64）并且退出码为 0。任何一步失败，`backup.sh` 退出码非 0，`systemd` 记入日志，`last-success.json` 不更新。
2. **主人的电脑上、每周一次**（`deploy/tencent/restore-drill.sh`，约 60 行）：用另一把**只读**的 COS 密钥（只在主人电脑上）下载最新的备份，用私钥解密，在临时目录里恢复，核对清单里的行数、版本号和文件 SHA-256，检查「最新备份不超过 36 小时」。这是整个备份唯一的「有人在看」的一环：服务器上的脚本悄悄失败，没人会知道，直到这一周的演练报错。

### 5.4 上线前演练一次恢复

迁移当天（第 6 节）切换之前，必须完整走一遍：备份 → 上传 → 在主人电脑上下载、解密 → 起一个临时容器用恢复出来的库启动网站 → 用 `/api/status` 之类的只读接口看数据在不在。**演练没通过，不切换。** 这同时验证了私钥、COS 密钥、清单三样东西。

恢复的命令也写进 `deploy/tencent/README.md`（一条：停网站、把解出来的库放回卷里、起网站）。

## 6. 数据迁移

原则：不上服务器看数据，不读生产内容。需要服务器上的事实，写成只读命令，由主人在自己的 Terminal 里跑、把输出贴回来。

### 6.1 上线前请主人先跑的只读命令

下面是服务器登录写法（和 `deploy/tencent/README.md` 里一样）。这些命令只读，不改任何东西，只输出文件大小和行数，不输出内容。

1. Node 版本（决定 `node:sqlite` 能不能用；需要 22.13 以上）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker exec weave-web-1 node --version'
```

2. 数据库文件在哪、多大（含 WAL 文件）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker exec weave-web-1 sh -c "find /app/.wrangler/state -type f -exec ls -l {} + ; du -sh /app/.wrangler/state"'
```

3. 每类文档有多少份、总共多大、最大一份多大，和版本号（不输出内容，只读打开）。这一条把查询用管道交给远端的 Node，不用嵌套引号：

```
cat <<'JS' | ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker exec -i weave-web-1 node --input-type=module -'
import {DatabaseSync} from "node:sqlite";
import {execSync} from "node:child_process";
const f = execSync("find /app/.wrangler/state -name '*.sqlite' -path '*d1*'").toString().trim().split("\n")[0];
console.log(f);
const d = new DatabaseSync(f, {readOnly: true});
for (const r of d.prepare("select kind, count(*) n, sum(length(document)) bytes, max(length(document)) biggest from weave_documents group by kind").all()) console.log(JSON.stringify(r));
console.log(JSON.stringify(d.prepare("select id, revision from weave_commits").all()));
JS
```

（我在本机用一个假库试过这段查询，能跑。Node 22 要 22.13 以上才不用加 `--experimental-sqlite`，命令 1 会告诉我们。）

4. Node 直连 Notion 通不通（只请求公开的根地址，不带任何密钥，用一个一次性的新容器，不碰现有容器）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker run --rm node:24-bookworm-slim node -e "fetch(\"https://api.notion.com/v1/users/me\").then(r=>console.log(r.status)).catch(e=>console.log(\"FAIL\",e.message))"'
```

期望输出 `401`（没带令牌，Notion 认得这个地址就回 401；打不通会输出 `FAIL`）。

5. 机器上还剩多少内存、磁盘（决定第 7.4 节的内存上限和本地保留天数）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'free -m; df -h /; docker stats --no-stream --format "{{.Name}} {{.MemUsage}}"'
```

6. Agent 工作目录多大（第 9 节第 6 条要用）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'du -sh ~/weave-data/agent'
```

命令 2 同时给出 wrangler 本地 D1 的文件路径。按 miniflare 的惯例，它在 `…/v3/d1/miniflare-D1DatabaseObject/<一串哈希>.sqlite`，但这一点我没有核实，以命令 2 的输出为准。

### 6.2 迁移脚本

`hosted/scripts/migrate-from-wrangler.mjs`（约 120 行，在 PR 3 里写、用合成数据测）：

- 输入：旧库文件路径（以只读方式打开）、新库路径。
- 做的事：在新库上跑迁移；把 `weave_documents`、`weave_commits`、`weave_guest_sessions` 三张表的行原样复制；**不复制** `weave_wechat_photos`（照片只保留 10 分钟，切换时早已过期，新库里是空的）。
- 校验，全部通过才算成功，否则退出码非 0、新库文件删掉：每张表行数相等；每一行文档的 SHA-256 相等（按 id 排序比对）；`weave_commits.revision` 相等；新库 `integrity_check` 是 `ok`；新库每类文档数量和旧库相等。
- 输出一行摘要（各表行数、总字节、耗时），不输出任何文档内容。
- 可以重复跑（目标库已存在就拒绝，要手动删）。

### 6.3 切换步骤（停机约 10–20 分钟）

先决条件：PR 1–4 已合并；第 5.4 节的恢复演练通过；主人确认的时间点，选没人用的时段；由负责部署的那个会话执行（一个项目只一个会话部署）。

1. **预演一次**（不停机）：`docker cp` 把旧库文件拷出来，在一台临时容器里跑迁移脚本，看耗时和校验。同时这份拷贝就是第一份备份。
2. 给旧镜像留标签：`docker tag weave-web:local weave-web:wrangler-last`。
3. **停写**：`docker compose stop web`。所有写都经过网站（Agent 服务、微信桥接、浏览器都只是它的客户），停了它就没有任何东西能写库。Agent 服务每分钟的 tick 会失败几次，无害。
4. **导出**：`docker cp weave-web-1:/app/.wrangler/state/<路径> /tmp/old-d1/`（连 `-wal` 文件一起拷）。
5. **导入**：在新镜像里跑迁移脚本，目标是新卷 `weave_web-data` 里的 `/data/weave.db`。
6. **校验**：脚本自己校验；主人再对一遍命令 3 的数字。
7. **切换**：`deploy.sh` 起新版网站；检查 `/healthz`、带密码的 `/api/status`、等一个 tick 出现在日志里。
8. **旧卷 `weave_web-state` 不删，至少留 14 天。**
9. 过了第一个自动备份，才算完成。

### 6.4 回退

- **切换后 30 分钟内、没有新数据：** `docker compose down`；换回旧版本的代码（`git checkout` 切换前的提交）；`docker tag weave-web:wrangler-last weave-web:local`；`deploy.sh`。旧卷原封未动，直接继续用。
- **新版跑了一段时间、已经写了数据，再要回退：** 因为表结构和旧库一样，用一个反向的脚本（同一个文件里的 `--reverse`，把新库的三张表复制回旧库文件，同样做行级校验）把数据写回旧卷，再按上面的步骤切回旧镜像。这个反向路径在 PR 3 里一起写、一起测，不是临时想的。
- 新版起不来（迁移失败、内存超限）：它在第 7 步的检查里就会暴露，这时还没有任何新数据，按第一条回退。

## 7. 部署文件怎么改

### 7.1 `hosted/Dockerfile.vps`

```
构建阶段   node:24-bookworm-slim
           npm ci → vite build（只打浏览器端的包，到 dist/client）
运行阶段   node:24-bookworm-slim
           COPY server/ lib/ migrations/ scripts/backup-db.mjs dist/client/
           没有 node_modules（运行时零依赖）
           USER node，EXPOSE 4317，CMD ["node","server/main.mjs"]
```

- Node 从 22 升到 24，和 CI（`ci.yml` 用 24）、`agent-service/Dockerfile`（24）一致。审查报告里「Dockerfile 用 22、CI 用 24，用 `node:sqlite` 之前要先确认」就是这一条。
- 去掉所有 wrangler 补丁、`X_LOCAL_EXPLORER`、`WRANGLER_WRITE_LOGS`、`/app/.wrangler`。
- 不再需要的 `scripts/*.sh` 不拷进镜像。

### 7.2 `deploy/tencent/compose.yml`

- `web.volumes`：`web-state:/app/.wrangler/state` → `web-data:/data` 和 `${HOME}/weave-data/backups:/backups`。`volumes:` 里加 `web-data`。旧的 `web-state` 保留声明到旧卷确认可以删为止。
- `web.environment`：去掉 `X_LOCAL_EXPLORER`，加 `WEAVE_DB_PATH: /data/weave.db`。
- 加 `healthcheck`：每 10 秒请求 `/healthz`，连续 3 次失败标为 unhealthy；`restart: unless-stopped` 保留。
- 端口绑定不变：`${WEAVE_BIND_IP}:4317:4317`。
- `image: weave-web:${WEAVE_VERSION:-local}`。

### 7.3 `deploy/tencent/deploy.sh` 和 `start-vps.sh`

- `start-vps.sh` 整个删掉（`CMD` 直接起 Node）。
- `deploy.sh`：
  1. 部署前先跑一次本地备份（`backup.sh --no-upload`）；失败就不部署。
  2. 构建前把当前镜像标成 `weave-web:previous`；构建后标成 `weave-web:<提交号>` 和 `local`。回退就是把 `previous` 改回 `local` 再 `up -d`，不用重新构建。
  3. 检查从「等到 401」改成：先 `/healthz` 返回 200，再带密码请求 `/api/status` 返回 200 且有 `personId`。
- 构建仍然在服务器上做（共用机器）。构建比现在轻：没有 wrangler 补丁、没有 workerd，只是一个 Vite 前端包。CI 构建镜像再拉取是后续改进，不在这一步。
- 备份的 systemd 定时器：`deploy/tencent/install-backup-timer.sh`（只做一次，在 README 里列步骤），加 `backup.sh`、`backup.env.example`、`restore-drill.sh`。

### 7.4 内存预期（推断，没有测量）

现在：网站容器上限 768 MB，实际一两百 MB 起、涨到被杀。新版：一个 Node 进程，没有 workerd、没有 wrangler、没有代理，审查估计一两百 MB 就够（报告里也标了「推断」）。

这一步的做法是**先测、再定**：

- PR 2 的 CI 冒烟里加一项：起网站、按浏览器的节奏连续轮询 `/api/status` 几分钟、读 `/proc/<pid>/status` 的 RSS，写进日志。上线前在服务器上连跑 24 小时，每 5 分钟记一行。
- 初始上限：`mem_limit: 384m`、`memswap_limit: 384m`（比现在的 768 MB 省一半），`oom_score_adj: 500` 保留，仍然是内存紧时先杀 Weave、不杀 Azora。如果 24 小时 RSS 稳在 150 MB 以下，可以降到 256m；如果出现要涨到 300 MB 以上的趋势，就先查原因、不抬上限。
- 备份时 `VACUUM INTO` 会短暂多用一些内存和磁盘（和库一样大），库小的时候可以忽略；命令 3 的输出会告诉我们库有多大。

## 8. 测试计划、风险、实施顺序

### 8.1 测试

1. **现有 663 个用例全过**，而且跑在真适配器上（`test/helpers/product-db.mjs` 改成 import 它）。这是第一步最有力的证据：业务代码没动，行为没变。
2. **适配器自己的测试**：`batch` 全成功或全回滚；`meta.changes` 的值对；WAL 下两个连接并发读写；`BEGIN IMMEDIATE` 下读不被阻塞；打开不存在的路径就创建。
3. **迁移测试**：用一个合成的「wrangler 格式」库（用同样的三张表，加上 miniflare 会有的额外表）跑迁移脚本，校验通过；故意改一行文档，校验必须报错并删掉目标库；`--reverse` 也测一遍。
4. **服务器测试**（不需要容器）：没带密码 401、带了 200；内部路径免密码但仍要令牌；`/healthz` 免密码；请求体超过 1 MB 回 413；静态文件的缓存头；找不到的 `/api/…` 回 404 而不是回 `index.html`；收到 `SIGTERM` 后在 10 秒内退出并关库；未捕获的异常让进程退出（交给 Docker 重启）。
5. **`ci-smoke.sh` 重写**：保留 401、带密码进得去、内部路径各自要令牌那些（它们测的是行为，不是垫层）；删掉那 6 项垫层检查；新增：容器重启后数据还在（写一条、`docker restart`、读回来）、跑一次备份并在临时目录里恢复、迁移幂等（启动两次）、轮询 5 分钟没有一次超过 1 秒、RSS 记录。
6. **前端**：现有 `frontend-*.test.mjs` 测的是纯函数模块，不受影响。工作台页面在 Vite 构建里能打包是第一道检查（CI 的 `npm run build`）。上线前主人（或负责的会话）手动过 6 个视图（聊天、待办、目标、记录、提醒、设置）加隐私页，对照现在线上的样子。
7. **不测的**：真正的微信、真正的 Notion、真正的模型。它们不经过这一层改动，除了 Notion 直连（第 3.8 节，用命令 4 在服务器上验证）。

### 8.2 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 迁移丢数据或改数据 | 最严重 | 逐行 SHA-256 校验；预演；旧卷保留 14 天；备份先上线并演练恢复；不通过不切换 |
| 前端改写后和现在的样子不一致 | 页面坏 | 工作台代码不动，只换入口；手动过 6 个视图；先在不对外的端口上起一份新的对照 |
| Node 24 上的 `node:sqlite` 行为和 22 不同（它还在发展中） | 适配器出错 | 现有用例本来就跑在 CI 的 Node 24 上；适配器只用最基础的功能（`prepare`、`run`、`all`、`exec`） |
| Notion 直连不通 | Notion 连接坏 | 命令 4 上线前验证；不通就先留代理 |
| 一个进程出问题影响整个站 | 同现在 | 现在也是一个站；加了 `/healthz` 和 `restart`，比看门狗简单 |
| 单个文件的损坏 | 全部数据 | WAL、每日备份、恢复演练；`integrity_check` 每次备份都跑 |
| 备份私钥丢失 | 备份全废 | 两份保存，演练时验证；这是第 9 节第 3 条要主人确认的 |
| 全站仍然是一把锁、每个请求仍然读全部数据 | 同现在（性能不会更差，但也没有根治） | 明说：根在第三步。这一步只换了运行方式 |
| 访问密码换了实现 | 门没关好 | 复用同一个模块和测试，不重写 |
| 删掉 Sites 身份分支后，将来要多人登录时要从头做 | 无 | 本来就要做真登录，现在这条路是个洞 |

没有核实的事（会影响数字，不影响结论）：真实库有多大、world 有多大；Node 直连 Notion 通不通；进程的真实 RSS；wrangler 本地 D1 的文件路径。命令 1–6 会把它们补上。

### 8.3 实施顺序（5 个 PR）

每一步单独合并、单独能回退。PR 1–3 合并以后不影响线上，因为线上还在跑旧镜像。

1. **PR 1：数据访问层。** `server/sqlite-db.mjs`、`migrations/`、迁移运行器；把测试辅助换成真适配器；全部现有用例通过。不改任何线上行为。
2. **PR 2：Node 进程和静态前端。** `server/main.mjs`、`config.mjs`、客户端入口、隐私页和接口、身份简化、Notion 三件事并入、新 `Dockerfile.vps`、`compose.yml`、`ci-smoke.sh` 重写，删运行垫层（第 4.1 节）。此时还没有备份和迁移脚本，所以**不部署**：`feat/deploy-tencent` 是服务器拉取的分支，PR 2 合并后、切换完成前，不要在服务器上 `git pull`。
3. **PR 3：备份和迁移工具。** `backup-db.mjs`、`backup.sh`、`restore-drill.sh`、定时器安装脚本、`migrate-from-wrangler.mjs`（含 `--reverse`）、各自的测试、README 里的恢复和迁移步骤。
4. **（不是 PR）上线。** 主人跑第 6.1 节的命令；建 COS 桶和子账号、生成 age 密钥；恢复演练；按第 6.3 节切换。由负责部署的会话做。
5. **PR 4：部署脚本和文档收尾。** `deploy.sh` 改造、`deploy/tencent/README.md`、`hosted/README.md`、根 `README.md` 里关于 wrangler 和 Cron 的几段；切换成功后再合，因为它描述的是切换后的样子。
6. **PR 5：删 Sites 脚手架**（第 4.2 节）和不用的依赖。

## 9. 需要主人定的事

1. **网站怎么跑：A 普通 Node 程序。** 推荐 A。理由：工作台本来就是浏览器端的 React，服务端渲染框架在这里不属于教材说的任何一个合法位置，而且去掉它运行时依赖是 0 个（B 要带一整套 beta 的框架）。代价是隐私页要改写、落地页先不迁。
2. **这一步不拆表，放到第三步。** 推荐不拆。理由：拆了表而业务代码还要整个世界，只会多一步；不拆才能逐行验证迁移、简单回退。如果第 6.1 命令 3 显示 world 已经大到每次读写要几百毫秒，再把第三步提前。
3. **备份私钥谁存、存几份。** 推荐：主人自己的电脑生成，密码管理器一份、离线（打印或 U 盘）一份，上线前演练时两份都解一次。
4. **删掉访客模式和 ChatGPT 请求头登录。** 推荐删。线上用不到，后者还是个洞（关掉单用户后会相信可伪造的请求头）。多人登录放第三步，做真登录。
5. **COS 桶放哪个地域。** 推荐和服务器不同的地域（防整个地域出事），主人建桶时选；需要主人在腾讯云建桶、建只写子账号、再建一把只读密钥放自己电脑上（第 5.2、5.3 节）。
6. **Agent 工作目录（`~/weave-data/agent`，含 `MEMORY.md`）要不要一起备份。** 推荐要。先跑第 6.1 节命令 6 看大小；小于 200 MB 就每天一起加密上传，更大就只备份 `MEMORY.md` 和额度账本，其余每周一次。
7. **备份失败谁知道。** 推荐：主人电脑上的每周恢复演练当作唯一的告警（第 5.3 节），超过 36 小时没有新备份就报错。要不要再加一条（比如失败时发一条微信消息），由主人定；我不建议在服务器上自己造一套告警。
8. **落地页（`LandingMarketing.tsx`）这一步不迁。** 推荐不迁。单用户加访问密码下没人能走到它；第三步做真登录时一起决定要不要、长什么样。
9. **旧卷 `weave_web-state` 保留多久。** 推荐 14 天（和本机备份的保留天数一致），之后手动删，不放进脚本。
10. **切换窗口。** 推荐选一个预计没人用的 20 分钟，提前在微信里说一声。具体时间由主人定。
11. **内存上限从 384 MB 开始。** 推荐先 384 MB，24 小时实测后再决定降不降。要给 Azora 多留的话告诉我目标数字。
