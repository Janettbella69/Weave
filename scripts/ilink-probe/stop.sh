#!/usr/bin/env bash
# 停掉 iLink 测试。默认数据留着（钥匙、记录、照片）；加 --delete-data 连数据一起删。
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
refuse_root
need_docker
case "${1:-}" in ''|--delete-data) ;; *) die "用法：bash stop.sh [--delete-data]" ;; esac

if exists; then
  # 先正常停（程序会告诉 iLink 它下线了），再删容器。
  docker stop -t 15 "$CONTAINER" >/dev/null
  docker rm "$CONTAINER" >/dev/null
  say "测试程序停了。"
else
  say "测试程序本来就没在跑。"
fi

if [ "${1:-}" = --delete-data ]; then
  if docker volume rm "$VOLUME" >/dev/null 2>&1; then
    say "数据（钥匙、记录、照片）都删掉了。微信里那个对话可以自己删掉。"
  else
    say "没有要删的数据。"
  fi
else
  say "数据还留着（钥匙、记录、照片）。确定不测了，加上 --delete-data 再跑一次就会删掉。"
fi
