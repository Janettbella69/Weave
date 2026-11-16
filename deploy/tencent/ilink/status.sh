#!/usr/bin/env bash
# 看 iLink 桥接的状态。只看，不改任何东西，不显示消息内容。
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need_docker

if running; then
  say "iLink 桥接：在跑（$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER") 起，重启过 $(docker inspect -f '{{.RestartCount}}' "$CONTAINER") 次）"
elif exists; then
  say "iLink 桥接：停着"
else
  say "iLink 桥接：没在跑"
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$PROBE_CONTAINER" 2>/dev/null || true)" = true ]; then
  say "注意：实验容器 $PROBE_CONTAINER 也在跑，它占着 iLink 绑定，正式的桥接起不来。"
fi
if has_data; then
  bridge_status
else
  say "还没有数据：先跑 login.sh 扫码。"
fi
