#!/usr/bin/env bash
# 起 iLink 桥接（后台，随服务器重启自动起来）。已经在跑就先停掉再起，读到新连上的人。重复跑没关系。
#   bash ~/weave/deploy/tencent/ilink/start.sh
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
refuse_root
need_docker
refuse_while_probe
has_account || die "还没有人连上：先跑 login.sh 扫码。什么都没启动。"
write_bridge_env

# 留着的旧容器（在跑的或停着的）先正常停掉再删（桥接会告诉 iLink 它下线了）；钥匙和读到哪儿了都在卷里，不受影响。
if exists; then
  docker stop -t 15 "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null
fi
# --add-host：容器里的 host.docker.internal 指向宿主机（docker0 的地址），Weave 网站就绑在那里。
docker run -d --name "$CONTAINER" --restart unless-stopped "${flags[@]}" --tmpfs /tmp:rw,noexec,nosuid,size=8m \
  --add-host host.docker.internal:host-gateway --env-file "$bridge_env" \
  --memory 128m --memory-swap 128m --oom-score-adj 500 --log-opt max-size=10m --log-opt max-file=3 \
  "$IMAGE" node /app/bridge.mjs run >/dev/null
sleep "$settle_seconds"
if ! running; then
  docker logs --tail 20 "$CONTAINER" >&2 || true
  die "iLink 桥接没跑起来，上面是它最后的输出。"
fi
say "iLink 桥接在后台跑了 ✅ 看状态：bash $ilink_dir/status.sh"
