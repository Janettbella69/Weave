# Agent 服务

全仓库唯一调用 Claude Agent SDK `query()` 的地方。为什么这样设计，见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)。

| 文件 | 干什么 |
| --- | --- |
| `server.mjs` | `POST /wake`、`POST /forget`、`GET /health`；每人串行、全局并发。旧路 `POST /query` 第 2 步删 |
| `runner.mjs` | 一次唤醒，也就是架构文档第 2 节那段配置 |
| `scopes.mjs` | 本人（owner）和打卡群（group）两种范围 |
| `providers.mjs` | DeepSeek、Kimi、GLM、千问，都是 Anthropic 格式 |
| `prompts.mjs` | 系统提示和 `<trigger>`，系统提示照抄架构文档第 5 节 |
| `model-proxy.mjs`、`ledger.mjs` | CLI 只拿到一轮一换的运行令牌，代理换成真 Key，按 token 记额度 |
| `sandbox.mjs` | 隔离：`docker`（每次唤醒一个容器）或 `local`（只给本机开发） |
| `mcp/` | weave 工具的薄壳，规则在 Weave 服务的 `/api/internal/agent/tools/<name>` |
| `plugin/` | Skill 和参考代码（现在只有 `weekly-review`） |
| `workspace.mjs`、`queue.mjs` | 每人的目录、MEMORY.md、当天的会话；排队 |
| `Dockerfile.agent`、`container/` | 一次性容器的镜像和入口 |

## 本机测试（不花钱）

```sh
npm ci
npm test
```

用的是本地假模型，不连真模型，也不需要 Key。容器那组测试需要 Docker，本机没有就跳过，CI 里会跑。

## 部署（docker 模式）

Agent 服务要自己启动容器，所以它跑在宿主机上，不放进容器。用一个非 root、在 docker 组里的用户。

1. 建镜像：`docker build -f Dockerfile.agent -t weave-agent:0.3.316 .`
2. 先在这台服务器上验一次容器：`WEAVE_TEST_DOCKER_IMAGE=weave-agent:0.3.316 node --test test/container.test.mjs`，6 项都要通过。
3. 照 `.env.example` 写 `.env`，然后 `npm ci --omit=dev && npm start`。至少要设：
   - `AGENT_SERVICE_TOKEN`：至少 32 位，和 Weave 服务那边一致
   - `WEAVE_API_URL`：Weave 服务在本机的地址，MCP 工具回调用
   - `DEEPSEEK_API_KEY`：托管的模型 Key，只有模型代理读得到
   - `AGENT_DATA_DIR`：每个人的工作目录都在这里，要备份；注销时 Weave 会调 `/forget` 删掉对应目录
4. Weave 服务那边设 `WEAVE_AGENT_RUNTIME=sdk`、`AGENT_SERVICE_URL=http://127.0.0.1:4320`（同一台机器上可以用 http）、`AGENT_SERVICE_TOKEN`。不设 `WEAVE_AGENT_RUNTIME` 就还走旧路。

`AGENT_ISOLATION=local` 只用于没有 Docker 的本机开发：Bash 靠 SDK 的 sandbox 断网，文件工具靠路径规则限制在工作目录，没有容器那层。

## 已知的现象

- CLI 遇到非 Claude 的模型名会打印 `[claude-code:unrecognized_model]`，不影响运行。
- 设了 `maxBudgetUsd` 后，CLI 每轮会在工具结果后面加一条 `role: system` 消息。真实接口收不收，第 0 步（`scripts/agent-sdk-probe/real-smoke.mjs`）会测到。
- `maxBudgetUsd` 是按 SDK 估的价格算的熔断器，不是实际花费；实际额度看模型代理的 token 账（`AGENT_DATA_DIR/usage.json`）。
