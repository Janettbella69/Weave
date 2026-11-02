# Weave 项目规则

给所有在这个仓库里工作的 AI 编程助手（Claude Code、Codex 等）。

## 以《Agent Harness 教材》为原则

Weave 里和 Agent 有关的设计和改动（循环、工具、权限、沙箱、记忆、上下文、评测、主动性），一律以《Agent Harness 教材》为原则。

- 下结论前，先引教材原文和 PDF 页码，再说代码现在怎么做，最后给结论。
- 教材在项目负责人的电脑上：`~/Downloads/Agent Harness 教材.pdf`。引用前打开文件复制原句，不凭记忆写页码。
- 教材没写到的地方，或者 Anthropic 官方文档已经更新了的地方，要明说。
- 自己的看法单独写，标明「我的看法」，不要混进教材的结论里。
- 和教材不一致的设计，说清理由，由项目负责人决定。

## 开发 Agent 功能前，先查 Claude Agent SDK 的文档

任何 AI 在准备开发 agent 相关功能时，一定要先检查 Claude Agent SDK 的 doc，找相关文档，了解之后再开发。因为 SDK 是非常新的技术，在你的训练集里没有。不这么做的后果：AI 就会一直在那里重复造轮子。

文档入口：https://code.claude.com/docs/en/agent-sdk/overview.md （全部页面的索引：https://code.claude.com/docs/llms.txt ）
