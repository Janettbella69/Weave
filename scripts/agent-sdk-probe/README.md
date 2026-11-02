# Agent SDK 探针

验证 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) 依赖的 SDK 行为。这是探针，不是产品代码。

```sh
(cd hosted/agent-service && npm ci)
node scripts/agent-sdk-probe/probe.mjs
```

- **不花钱：** 它在本机起一个按脚本回复的 Anthropic 格式假接口，不连真模型，不需要 Key。
- **不碰你的配置：** CLI 的 `HOME` 和 `CLAUDE_CONFIG_DIR` 都在临时目录。
- **不连外网：** 沙箱那组也只连本机假接口。
- **`NOTE` 行**是发给模型接口的实际请求形状，方便和各家文档对照。
- **升级 SDK 前跑一遍。** 出现 `FAIL` 说明架构文档要重看。

假模型只能证明 SDK 的机制，证明不了真实接口接不接受这些请求，也证明不了真实模型的判断力。这两件事见架构文档第 13 节。

最近一次结果：SDK 0.3.316，macOS，43/43 通过。

## 第 0 步：真接口冒烟（会花钱）

```sh
(cd hosted/agent-service && npm ci)
node scripts/agent-sdk-probe/real-smoke.mjs
```

- **用真 Key 把架构文档第 2 节的配置跑一次，不经过模型代理。** DeepSeek flash 估计 $0.005–0.02。跑完会打印实际 token 数和按官方价算的费用区间。
- **Key 从哪来：** 依次读 `DEEPSEEK_API_KEY`、`AGENT_PROVIDER_API_KEY`；都没有就在终端里隐藏输入，不会进命令历史。
- **换别家：** `SMOKE_PROVIDER=kimi`（或 `glm`、`qwen`），Key 读 `KIMI_API_KEY`、`GLM_API_KEY`、`QWEN_API_KEY`。
- **`--websearch`** 多试一次 WebSearch。国产接口不一定支持，结果只打印、不算通过与否。
- **怎么看结果：** 四项都 PASS，说明这份配置在真接口上能用。有 FAIL 时会打印接口返回的原话，拿去和文档第 9 节对照。
- **「你是谁」那行只给人看。** 模型的判断力要靠评测，这个脚本测不出来。
