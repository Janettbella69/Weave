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
