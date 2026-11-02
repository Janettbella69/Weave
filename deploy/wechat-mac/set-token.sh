#!/usr/bin/env bash
# 生成微信桥接令牌（WECHAT_BRIDGE_TOKEN），同时写到两处，再重新部署网站：
#   1. 服务器的 web.env：经 ssh 的标准输入传过去，由 deploy/tencent/set-wechat-token.sh 写好并重新部署；
#   2. 这台 Mac 的桥接配置 ~/.weave-wechat/bridge.env。
# 令牌从头到尾不显示、不进命令行参数、不进 shell 历史；两个文件里其他的行都原样保留。
# 服务器那边的脚本是连同令牌一起从这里送过去的，所以服务器上不用先 git pull。
#
# 用法：bash set-token.sh            生成新令牌，写好，重新部署，检查
#       bash set-token.sh --remove   关掉微信通道：服务器上的令牌清空并重新部署，桥接停掉
# 每次跑都换一个新令牌；跑到一半断了，直接重跑就行。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
repo="$(cd "$here/../.." && pwd)"
server_script="$repo/deploy/tencent/set-wechat-token.sh"
key="${WEAVE_SSH_KEY:-$HOME/.ssh/id_ed25519_43_162_99_246}"
host="${WEAVE_SSH_HOST:-ubuntu@43.162.107.53}"
origin="${WEAVE_ORIGIN:-$WEAVE_ORIGIN_DEFAULT}"

mode=set
[ "${1:-}" != "--remove" ] || mode=remove
[ -f "$server_script" ] || die "找不到 ${server_script}。"
[ -f "$key" ] || die "找不到 ssh 钥匙 ${key}（deploy/tencent/README.md 里用的那把）。"
command -v openssl >/dev/null 2>&1 || die "缺少 openssl。"

token=""
[ "$mode" = remove ] || token=$(openssl rand -hex 32)

say "== 1/3 把令牌交给服务器，并重新部署网站（要几十秒到几分钟）"
payload=$(base64 < "$server_script" | tr -d '\n')
# 令牌走 ssh 的标准输入；命令行里只有服务器脚本的文字（不是秘密）。
if ! printf '%s\n' "$token" | ssh -i "$key" -o ConnectTimeout=15 "$host" "bash -c \"\$(printf %s '$payload' | base64 -d)\""; then
  die "服务器那一步没有成功，上面有原因。这台 Mac 的配置没有动。排查后直接重跑这个脚本。"
fi

say ""
say "== 2/3 写这台 Mac 的桥接配置"
umask 077
mkdir -p "$home_dir" "$state_dir"
write_bridge_defaults
env_set "$bridge_env" WECHAT_BRIDGE_TOKEN "$token"
if [ "$mode" = remove ]; then
  agent_stop bridge
  say "桥接已停掉，令牌已清空。"
else
  say "已写入 ${bridge_env}（不显示内容）。"
  if agent_loaded bridge; then agent_start bridge; say "桥接已用新令牌重启。"; fi
fi

say ""
say "== 3/3 检查服务器认不认这个令牌"
ask() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'Content-Type: application/json' -d '{}' "$@" "$origin/api/internal/wechat/events" || true; }
without=$(ask)
if [ "$without" = 401 ]; then say "没带令牌：HTTP 401（对，要求令牌）"; else say "没带令牌：HTTP ${without:-没有回应}（应该是 401）。如果是 000，多半是网络或代理的问题：先关掉代理再试。"; fi
if [ "$mode" = set ]; then
  # 令牌放进 curl 的配置（标准输入），不放命令行参数。
  with=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | ask -K -)
  if [ "$with" = 200 ]; then say "带令牌：HTTP 200（对，服务器认这个令牌）"; else die "带令牌：HTTP ${with:-没有回应}（应该是 200）。服务器可能还没用上新配置：看上面 deploy.sh 的输出，修好后重跑本脚本。"; fi
  say ""
  say "下一步：bash $here/login.sh"
fi
