#!/usr/bin/env python3
"""weekly-review 的参考代码：数完成次数和连续天数。数字以这里为准，Agent 不要自己心算。

用法：python3 stats.py <weave.db 或 记录文件.json> [--today YYYY-MM-DD]

weave.db 是叫醒前的数据快照（SQLite）：读 completions，习惯名取 habits，今天取 meta 表的 today，
没有完成记录的习惯也列出来。JSON 文件可以是 {"today": ..., "completions": [...]}，也可以直接是一个列表。
今天依次取 --today、数据里的 today、系统日期。今天还没记不打断连续天数，昨天也没记才断。
只用标准库，兼容 Python 3.9。
"""
import json
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

SQLITE_HEADER = b'SQLite format 3\x00'


def is_sqlite(path):
    with open(path, 'rb') as f:
        return f.read(16) == SQLITE_HEADER


def load_db(path):
    con = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    try:
        tables = {row[0] for row in con.execute("select name from sqlite_master where type = 'table'")}
        today = None
        if 'meta' in tables:
            row = con.execute("select value from meta where key = 'today'").fetchone()
            today = row[0] if row else None
        rows = [{'habit_id': h, 'date': d} for h, d in con.execute('select habit_id, date from completions')] if 'completions' in tables else []
        names = dict(con.execute('select habit_id, name from habits')) if 'habits' in tables else {}
    finally:
        con.close()
    return rows, today, names


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
        print('用法：python3 stats.py <weave.db 或 记录文件.json> [--today YYYY-MM-DD]', file=sys.stderr)
        return 2
    if is_sqlite(path):
        rows, data_today, names = load_db(path)
    else:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        rows = data.get('completions', []) if isinstance(data, dict) else data
        data_today = data.get('today') if isinstance(data, dict) else None
        names = {}
    today_text = today_arg or data_today
    today = date.fromisoformat(today_text) if today_text else date.today()

    days_by_habit = {habit: set() for habit in names}
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
        counts = {'last7': last7, 'prev7': prev7, 'streak': streak}
        habits[habit] = dict({'name': names[habit]}, **counts) if habit in names else counts

    print(json.dumps({'today': today.isoformat(), 'habits': habits}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
