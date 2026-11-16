#!/usr/bin/env bash
# 扫码连上一个人的微信（私聊走 iLink）。每个人自己用自己的微信扫一次；要连几个人就跑几次。重复扫同一个人会换掉他旧的钥匙。
# 要在 Mac 的终端里用 ssh -t 跑，才画得出二维码：
#   ssh -t <服务器> 'bash ~/weave/deploy/tencent/ilink/login.sh'
# 扫完以后用 start.sh 起（已经在跑的话它会自己重启一次，读到新的人）。
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
refuse_root
need_docker
interactive || die "扫码要在能显示二维码的终端里做：在 Mac 的终端里用 ssh -t 跑这个脚本。什么都没改。"
refuse_while_probe
write_bridge_env

say "用要连上的那个微信扫码（二维码 8 分钟内有效，过期会自动换一张；微信可能还要你输入手机上显示的数字）。"
# 画二维码的小工具 qrcode-terminal（官方插件用的就是这一版）只装进这个一次性容器的 /tmp，用完跟着容器一起删掉。
docker run --rm -it "${flags[@]}" --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  -e npm_config_cache=/tmp/npm -e npm_config_update_notifier=false -e NODE_PATH=/tmp/q/node_modules \
  "$IMAGE" sh -c 'npm install --silent --no-audit --no-fund --prefix /tmp/q qrcode-terminal@0.12.0 >/dev/null 2>&1 || echo "（没装上画二维码的小工具，下面只给链接）"; exec node /app/bridge.mjs login' \
  || die "没连上。可以再跑一次。"
has_account || die "没连上。可以再跑一次。"
say "连上了 ✅ 接下来：bash $ilink_dir/start.sh"
