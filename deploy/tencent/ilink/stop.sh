#!/usr/bin/env bash
# 停掉 iLink 桥接。默认数据留着（钥匙和读到哪儿了）；加 --delete-data 连数据一起删（要重新扫码才能用）。
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
refuse_root
need_docker
case "${1:-}" in ''|--delete-data) ;; *) die "用法：bash stop.sh [--delete-data]" ;; esac

if exists; then
  # 先正常停（桥接会告诉 iLink 它下线了），再删容器。
  docker stop -t 15 "$CONTAINER" >/dev/null
  docker rm "$CONTAINER" >/dev/null
  say "iLink 桥接停了。私聊在它停着的这段时间里不会有人回。"
else
  say "iLink 桥接本来就没在跑。"
fi

if [ "${1:-}" = --delete-data ]; then
  if docker volume rm "$VOLUME" >/dev/null 2>&1; then
    say "数据（钥匙和读到哪儿了）都删掉了。要再用就重新扫码。"
  else
    say "没有要删的数据。"
  fi
else
  say "数据还留着。确定不用了，加上 --delete-data 再跑一次就会删掉。"
fi
