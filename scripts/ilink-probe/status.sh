#!/usr/bin/env bash
# 看 iLink 测试的结果。只看，不改任何东西。
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need_docker

if running; then
  say "测试程序：在跑（$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER") 起，重启过 $(docker inspect -f '{{.RestartCount}}' "$CONTAINER") 次）"
elif exists; then
  say "测试程序：停着"
else
  say "测试程序：没在跑"
fi
if has_data; then
  probe_status
else
  say "还没有数据：先跑 start.sh。"
fi
