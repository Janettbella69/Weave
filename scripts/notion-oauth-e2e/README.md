# Notion 连接的端到端演练

把线上的形状在本机完整跑一遍，Notion 那一头换成本机的假服务。**不连任何真实服务，不需要真实钥匙。**

```text
浏览器替身（node:http，带 Host / X-Forwarded-Proto，和 nginx 转发来的一样，再带上访问密码）
   │
   ▼
网站  wrangler dev --local（单用户模式 + Basic 认证，hosted/dist，和 Dockerfile.vps 里跑的是同一个构建）   :4502
   │  NOTION_OAUTH_EXCHANGE_URL / NOTION_API_PROXY_URL
   ▼
hosted/scripts/notion-oauth-proxy.mjs（真的那个文件；NOTION_UPSTREAM_BASE 指向假 Notion，线上不设）     :4513
   ▼
假 Notion  fake-notion.mjs（/v1/oauth/token、/v1/search、/v1/pages、/v1/blocks/:id/children）           :4512
```

网站用的环境变量只能是 `hosted/scripts/start-vps.sh` 会写进 `.dev.vars` 的那些（`stack.mjs` 会对照检查），所以演练里有的配置线上一定也有。

## 跑一遍

```sh
cd hosted && npm ci --no-audit --no-fund && WRANGLER_SEND_METRICS=false npm run build && cd ..
node scripts/notion-oauth-e2e/run.mjs
```

第一次约一分钟（初始化本地数据库、起 wrangler）。全部通过时退出码是 0；有失败项会列出来，并保留临时目录（里面有网站和代理的日志）。

| 选项 | 作用 |
| --- | --- |
| `--only <正则>` | 只跑名字匹配的场景，比如 `--only 没勾选` |
| `--report <文件>` | 把每个请求和回应写成 Markdown 表格（给前端看每种情况会收到什么） |
| `--keep` | 跑完保留临时目录 |
| `--serve` | 不跑场景，把三个服务起好留着，自己在浏览器里点（见下） |

端口：网站 `E2E_SITE_PORT`（4502）、假 Notion `E2E_NOTION_PORT`（4512）、代理 `E2E_PROXY_PORT`（4513）。端口被占会直接报错，不会去抢。

## 它检查什么

- **开始连接**：授权地址里的 `client_id`、`redirect_uri`（公开域名上的回调）、`owner=user`、`state`；没带 Origin 的 POST 被拒；没带访问密码的回调是 401。
- **一键连接**：只分享一个页面 → 回调直接 303 到 `?connection=notion&status=connected`，状态、`/api/status`、计划同步写到假 Notion 的那个页面下面（用的是这个用户的 token）。分享了好几个页面 → 自动选默认页，`pages` 列出可选的，`select` 换页面。
- **每一种回来的路径都不空白**：用户点取消、缺参数、state 不认识/过期/重复打开、换 token 失败（被拒、500、乱码、没有 token、Notion 不回话、代理挂了）、搜索失败、一个页面都没勾选、搜索索引有延迟、网站没配置。每种都记下 303 的 `Location` 和接口返回的 JSON。
- **跳回的地址**：经 nginx（有/没有 `X-Forwarded-Proto`）、直连本机、配没配 `NOTION_PUBLIC_ORIGIN`。
- **旧接口**：`connections/notion/pending`、`complete` 的返回形状不变。
- **代理加固**：坏请求不回显、超时是 504、想跳出 `/v1/` 的路径被拒。
- **泄露检查**：所有回应、网站和代理的日志、数据库里，都不能出现 client secret 或任何 token。

细节更多的单元测试在 `test/notion-connect.test.mjs`、`test/notion-proxy.test.mjs`（`npm test` 会跑）。

## 自己在浏览器里点：`--serve`

```sh
node scripts/notion-oauth-e2e/run.mjs --serve
```

会打印网站地址、访问密码和一组可用的授权码（`demo-one`、`demo-many`、`demo-none`、`demo-search-fail`、`demo-exchange-fail`）。真正的授权页在 Notion 那边，所以用两步代替：先用 `curl` 取一个 `state`，再在登录过网站的浏览器里打开 `…/api/connections/notion/callback?code=demo-many&state=…`，就会像用户从 Notion 回来一样被带回网站。这个模式里回调落回本机（`http://127.0.0.1:4502`），不会跳到线上域名。

## 它改不了什么

- 授权页本身（`https://api.notion.com/v1/oauth/authorize`）是写死的，演练只检查地址的参数，不会真的打开它。
- 真实 Notion 的行为（搜索索引的延迟有多久、授权页上用户到底能不能一个页面都不勾）只能照文档推测，演练里用假服务模拟了这些情况，但没法证明真实服务就是这样。
- 前端有没有把每种状态画出来，这里看不到：演练只确认 `/?connection=notion&…` 能打开（200 的 HTML）。
