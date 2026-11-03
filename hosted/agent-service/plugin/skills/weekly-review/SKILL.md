---
name: weekly-review
description: 复盘一周的习惯完成情况时使用。
---
1. 运行 python3 ${CLAUDE_SKILL_DIR}/scripts/stats.py weave/weave.db，得到每个习惯最近 7 天、前 7 天的完成次数和连续天数（今天按 weave.db 里 meta 表的 today 算）。
   数字以脚本为准，不要自己心算。
2. 想看具体是哪几天、备注写了什么，自己写 SQL 查 weave/weave.db 的 completions 表。
3. 讲法：先说做到的，再说一个最容易改的地方。断了不算失败，
   重点是不要连续错过两次。缺少记录不等于没做。
