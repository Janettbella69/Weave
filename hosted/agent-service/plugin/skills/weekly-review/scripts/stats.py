#!/usr/bin/env python3
"""weekly-review 的参考代码：数完成次数和连续天数。数字以这里为准，Agent 不要自己心算。

用法：python3 stats.py <记录文件.json> [--today YYYY-MM-DD]

记录文件是 query_completions 的结果（{"today": ..., "completions": [...]}），也可以直接是一个列表。
今天依次取 --today、文件里的 today、系统日期。今天还没记不打断连续天数，昨天也没记才断。
只用标准库，兼容 Python 3.9。
"""
import json
import sys
from datetime import date, timedelta


def parse_args(argv):
    path, today = None, None
    i = 0
    while i < len(argv):
        if argv[i] == '--today' and i + 1 < len(argv):
            today = argv[i + 1]
            i += 2
            continue
        path = argv[i]
        i += 1
    return path, today


def main(argv):
    path, today_arg = parse_args(argv)
    if not path:
        print('用法：python3 stats.py <记录文件.json> [--today YYYY-MM-DD]', file=sys.stderr)
        return 2
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    rows = data.get('completions', []) if isinstance(data, dict) else data
    today_text = today_arg or (data.get('today') if isinstance(data, dict) else None)
    today = date.fromisoformat(today_text) if today_text else date.today()

    days_by_habit = {}
    for row in rows:
        try:
            day = date.fromisoformat(str(row['date']))
        except (KeyError, TypeError, ValueError):
            continue
        days_by_habit.setdefault(str(row.get('habit_id', '')), set()).add(day)

    habits = {}
    for habit, days in sorted(days_by_habit.items()):
        last7 = sum(1 for d in days if today - timedelta(days=6) <= d <= today)
        prev7 = sum(1 for d in days if today - timedelta(days=13) <= d <= today - timedelta(days=7))
        cursor = today if today in days else today - timedelta(days=1)
        streak = 0
        while cursor in days:
            streak += 1
            cursor -= timedelta(days=1)
        habits[habit] = {'last7': last7, 'prev7': prev7, 'streak': streak}

    print(json.dumps({'today': today.isoformat(), 'habits': habits}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
