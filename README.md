# Habit Council · 习惯议会

第一版以 Chatbot 为主入口，是一个以 Notion 为长期记忆入口的 Personal Agent 黑客松原型。让运动、睡眠、饮食三个 Agent 协调当天的习惯计划，由用户确认后执行。

## 本地运行

要求 Node.js 22+，无需安装依赖。

```sh
npm run dev
```

访问 http://127.0.0.1:4317 。默认是明确标注的规则演示模式。

## 真实模型与 Notion

复制 `.env.example` 为 `.env`，填写：

- `ANTHROPIC_API_KEY` 和 `ANTHROPIC_MODEL`：使用你账号有权限的模型 ID。三个独立角色并行调用，再由第四次模型调用完成协调。失败会显示错误，不会悄悄退回演示。
- `NOTION_TOKEN`：Notion integration token。
- `NOTION_PAGE_ID`：一个普通父页面 ID（非 database ID）。在 Notion 页面菜单中将此页面连接到 integration，授予读写权限。

重启服务。协商时读取该父页面顶层文字块，结合本地最近七条反馈作为上下文；用户确认后点击同步，在父页面下新建计划子页面。反馈当前只保存本地，不自动回写。历史计划子页面尚未递归读取；下一阶段需要增加结构化记忆索引。

`.env` 和本地数据 `.data/` 均被 Git 忽略。密钥不传到浏览器。

## 两层协作

1. 内部协作：状态输入 → 三角色提案 → 冲突协调 → 用户确认 → Notion 同步。
2. 外部协作：本地模拟双方 Agent 交换自选空闲时间、求交集。尚未连接真实朋友、日历、餐厅或消息服务。

规则演示根据睡眠、忙碌、聚餐及午饭后偏好调整计划，不等于真实 LLM 推理。真实模式使用独立角色调用，不声称已经完成外部行动。

## 三分钟演示

1. 在聊天里说“今天很累，原计划练腿，晚上和朋友聚餐”。
2. Agent 追问睡眠，回答“5 小时”；系统保留上条上下文并生成计划。
3. 在回复中展开三个 Agent 的建议，查看冲突取舍，确认计划。
4. 在该消息内同步 Notion（配置后）或导出 Markdown。
5. 输入“反馈：午饭后散步更容易坚持”，下一次协商会参考。

聊天记录保存在本地 `.data/state.json`，刷新后恢复。聊天入口目前为规则意图识别，支持状态输入、缺少睡眠信息的追问与显式反馈记录；不是通用闲聊模型。Enter 发送，Shift+Enter 换行。聊天主界面不再展示第二层时间协商，原有 `/api/match` 模拟接口保留。

## 架构

- `public/`：中文响应式聊天界面，原生 HTML/CSS/JS。
- `chat.mjs`：聊天意图、睡眠提取与追问上下文。
- `council.mjs`：输入校验、规则策略、三角色模型编排、时间协商。
- `server.mjs`：本机 HTTP 服务、持久化、Notion 读取与写入。
- `test/`：输入边界、冲突处理、外部授权时间边界。

架构参考：Meta Muse 的主 Agent、子 Agent 和连接器思路（https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse）。当前未集成 Muse；cue、dots 的具体项目链接待确认。

## 验证

```sh
npm test
node --check server.mjs
node --check public/app.js
```

当前版本面向本机单人运行，不应直接暴露到公网。线上多用户版本需要身份验证、用户隔离和数据库迁移；当前不包含定时推送。

## API 参考

- [Notion block children](https://developers.notion.com/reference/get-block-children)
- [Notion create page](https://developers.notion.com/reference/post-page)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages)
