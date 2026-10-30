# Habit Council · 习惯议会

一个以 Notion 为长期记忆入口的 Personal Agent 黑客松原型。让运动、睡眠、饮食三个 Agent 协调当天的习惯计划，由用户确认后执行。

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

1. 使用默认“睡眠五小时、计划练腿、晚上聚餐”输入，召集 Agent。
2. 展示各角色建议、冲突取舍和轻量计划，点击确认。
3. 同步 Notion（配置后）或导出 Markdown。
4. 记录“午饭后活动更容易坚持”，再召集团队，展示记忆对计划的影响。
5. 切换 Agent 连接，展示时间交集和无共同空闲的情况。

## 架构

- `public/`：中文响应式工作台，原生 HTML/CSS/JS。
- `council.mjs`：输入校验、规则策略、三角色模型编排、时间协商。
- `server.mjs`：本机 HTTP 服务、持久化、Notion 读取与写入。
- `test/`：输入边界、冲突处理、外部授权时间边界。

Muse、cue、dots：用户提出的待研究架构参考，具体项目链接待确认。当前未集成或复用这些项目，不预先假定同名产品的实现方式。

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
