---
name: weekly-review
description: 复盘一周的习惯完成情况时使用。
---
1. 用 mcp__weave__query_completions 取最近 7 天和前 7 天的记录，存成 JSON。
2. 运行 python3 ${CLAUDE_SKILL_DIR}/scripts/stats.py <文件> 得到完成次数和连续天数。
   数字以脚本为准，不要自己心算。
3. 讲法：先说做到的，再说一个最容易改的地方。断了不算失败，
   重点是不要连续错过两次。缺少记录不等于没做。
