# Weave 搬到 43.162.107.53 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Weave（网站 + Agent 服务）能部署到 Azora 那台腾讯云服务器上，和 Azora 共用一台机器但互不干扰；把只存在于本地 checkout 的线上改动移植进仓库。

**Architecture:** Weave 用自己的 docker compose 项目，两个服务：`web`（`wrangler dev --local` 跑 Worker，和现在洛杉矶那台一样）和 `agent`（Agent 服务，通过宿主的 docker socket 起一次性容器）。`web` 只绑在宿主的 docker0 地址上，Azora 的 nginx 经 `host.docker.internal:4317` 转发 `weave.azorashopping.site`。Weave 不加入 Azora 的网络。

**Tech Stack:** Docker 27.5、docker compose、Node 22/24、wrangler dev、nginx（Azora 的）、certbot（Azora 的）。

**Spec:** `docs/ARCHITECTURE.md`（Agent 服务）、本对话里定的搬家方案、用户本地 `~/Weave-council` 未提交的线上改动（只读参考）。

## Global Constraints

- 不碰任何服务器；服务器命令写进 `deploy/tencent/README.md`，由用户跑。
- 不碰 `~/Weave-council` 主 checkout 和 `~/AIAzora-v3` 主 checkout。Azora 的改动另开工作目录，基于 `origin/feat/ai-styling`（线上部署分支）。
- Azora 只改 `nginx.conf`：加 Weave 的 server 块，原有内容一行不动；转发目标用 `host.docker.internal`，Weave 没起来时 nginx 照样能加载配置。
- 钥匙不进仓库；部署文件里只有环境变量引用。
- 移植线上改动要照原样（行为一致），不顺手「改进」；看不出原因的改动在 PR 里列出来。
- 这台机器内存紧：`AGENT_MAX_CONCURRENCY=1`，每轮容器内存上限 `768m`。
- 数据从零开始；洛杉矶那台 11-10 前不碰。
- 所有现有测试保持全绿；不设新开关时行为不变。

## Review Focus

1. 网站在 nginx 后面：浏览器的 Origin 是 `https://weave.azorashopping.site`，Worker 看到的请求地址是 `http://…:4317` —— POST 不能被当成跨站拒绝，真的跨站仍要拒绝。
2. 加了访问密码后：Agent 服务、微信桥接调 `/api/internal/*` 不能被密码挡住；其余页面和接口没密码就是 401。
3. Agent 服务在容器里起兄弟容器：挂载路径、插件路径、socket 路径都要是宿主机上的真实路径。
4. Azora 的 nginx：Weave 停掉时，Azora 的站点不受影响，nginx 能正常加载和重载。
5. 移植的 Notion 改动：不设代理变量时，行为和现在的 main 一样（直连 Notion）。

---

### Task 1: 移植线上改动

**Files:** `hosted/app/weave-auth.ts`、`hosted/lib/weave/api.mjs`、`hosted/lib/weave/notion.mjs`、`hosted/lib/weave/scheduler.mjs`、`hosted/app/workspace/Workspace.jsx`、`hosted/app/globals.css`、`hosted/cloudflare-env.d.ts`；Test: `test/vps-proxy.test.mjs`

- 单用户模式（`WEAVE_VPS_MODE=true` + `WEAVE_VPS_USER_ID` + `WEAVE_VPS_EMAIL`）照搬。
- 跨站检查：POST 要求有 Origin 和 Host，且 `new URL(origin).host === host`。
- Notion 回调：跳转地址按 `x-forwarded-proto` 和 `host` 拼；`detail` 参数；搜索页面失败时用空列表。
- `/query` 的 `redirect:'error'`；Notion 的 `apiProxy` / `exchangeUrl`（不设就直连）、Notion-Version `2022-06-28`；scheduler 把 `apiProxy` 传给 `chatFor`。
- 页面：`api()` 的 GET 名单；快捷提示挪到输入框上方；导航按钮颜色。

测试：
- `'nginx 后面的 POST：Origin 的 host 等于 Host 头就放行'`
- `'Origin 和 Host 不一致、缺 Origin 都是 403'`
- `'Notion 回调在代理后面跳回 https 的同一个域名'`
- `'不设 NOTION_API_PROXY_URL 时直连 api.notion.com'`

### Task 2: 访问密码

**Files:** Create `hosted/lib/weave/basic-auth.mjs`；Modify `hosted/worker/index.ts`、`hosted/cloudflare-env.d.ts`；Test `test/basic-auth.test.mjs`

- `basicAuthGate(request, setting) → Promise<Response|null>`：`setting` 是 `用户名:密码`，空就不拦；`/api/internal/` 开头的不拦（它们有自己的令牌）；其余没带对的 `Authorization: Basic` 回 401 + `WWW-Authenticate: Basic realm="Weave", charset="UTF-8"`。比较用 SHA-256 摘要。
- Worker 的 `fetch` 最前面调用，环境变量 `WEAVE_BASIC_AUTH`。

测试：`'没设密码不拦'`、`'内部接口不拦'`、`'没带或带错是 401 且有 WWW-Authenticate'`、`'带对放行'`、`'冒号在密码里也能对上'`。

### Task 3: Agent 服务的部署选项

**Files:** `hosted/agent-service/{sandbox,server}.mjs`、`hosted/lib/weave/dispatcher.mjs`；Tests 各自的测试文件

- `dockerArgs` 增加 `memory`（默认 `1g`），`AGENT_CONTAINER_MEMORY` 设置。
- `AGENT_PLUGIN_DIR`：插件目录可以指到宿主路径。
- `agentServiceConfig`：除了 https 和本机 http，再接受单段主机名的 http（如 `http://agent:4320`，只在 docker 网络里能解析）。

测试：`'dockerArgs 用传入的内存上限'`、`'单段主机名的 http 可以，带点的外网 http 不行'`。

### Task 4: 部署文件

**Files:** `hosted/Dockerfile.vps`（多阶段：容器里 build）、`hosted/.dockerignore`、`hosted/scripts/start-vps.sh`（变量清单更新：去掉 Gewechat，加 `WECHAT_BRIDGE_TOKEN`、`WEAVE_AGENT_RUNTIME`、`WEAVE_BASIC_AUTH`、`AGENT_DAILY_CALLS_*`）、`hosted/scripts/notion-oauth-proxy.mjs`、`hosted/agent-service/Dockerfile`（带 docker CLI，启动时把插件拷到数据目录）、`deploy/tencent/{compose.yml,.env.example,README.md}`、`.github/workflows/ci.yml`（建 `Dockerfile.vps` 和 Agent 服务镜像，`docker compose config` 校验）

- compose：`web` 端口 `${WEAVE_BIND_IP:-172.17.0.1}:4317:4317`，状态放命名卷；`agent` 挂 docker socket、`group_add` docker 组、数据目录宿主和容器同一路径、不对外开端口。
- README：按顺序的命令（DNS → 建镜像 → 容器测试 → 起服务 → 证书扩名 → Azora nginx → 验证），每步怎么看对错、怎么回退。

### Task 5: Azora 的 nginx

**Repo:** `~/AIAzora-v3`，新工作目录，分支 `feat/weave-subdomain` 基于 `origin/feat/ai-styling`

- `nginx.conf` 加两个 server 块（80 跳转 + 证书校验；443 转发到 `http://host.docker.internal:4317`，证书用扩名后的 `azorashopping.site`）。
- 校验：本机用 `nginx:alpine` 镜像跑 `nginx -t` 做不到（没有 Docker），所以在 Azora 的 CI 里加不了也不强求；PR 描述写明在服务器上先 `nginx -t` 再 reload。

### 收尾

两个 PR 都开好后，请独立审查员看 Weave 这条分支和 Azora 的改动；修完再请用户合并。
