#!/usr/bin/env bash
# 打开或关掉微信看图（默认关）。只动这台 Mac 上的桥接：
#   bash deploy/wechat-mac/images.sh on    重建桥接用的 wx 密钥，加上 media 权限（只用来读守护进程已经存好的照片副本），
#                                          在 bridge.env 里写 WEAVE_WECHAT_IMAGES=1，重启桥接
#   bash deploy/wechat-mac/images.sh off   重建密钥，去掉 media，把 bridge.env 里的 WEAVE_WECHAT_IMAGES 清空，重启桥接
# 重建密钥不会让小号掉线（agent-wechat 文档：撤销密钥不会登出微信）。新密钥只写进 bridge.env，不显示。
# 服务器那边要另外打开：web.env 里加 WEAVE_WECHAT_IMAGES=1 再部署，见 docs/WECHAT.md「看图（默认关闭）」。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

case "${1:-}" in
  on) want=1 ;;
  off) want="" ;;
  *) die "用法：bash $here/images.sh on（打开看图）或 bash $here/images.sh off（关掉）" ;;
esac

[ -x "$wx_bin" ] || die "还没装 wx：先跑 bash $here/install.sh"
wx_cli accounts list >/dev/null 2>&1 || die "连不上 wx 守护进程：先跑 bash $here/install.sh，或看日志 tail -n 30 $log_dir/daemon.log"
[ -n "$(env_get "$bridge_env" WECHAT_BRIDGE_TOKEN)" ] || die "还没配桥接令牌：先跑 bash $here/set-token.sh"
id=$(env_get "$bridge_env" WX_ACCOUNT)
[ -n "$id" ] || die "还没登录小号：先跑 bash $here/login.sh"

umask 077
if [ "$want" = 1 ]; then say "重建桥接用的密钥：读、发，加上看图用的 media……"; else say "重建桥接用的密钥：只能读和发，去掉 media……"; fi
bridge_key_renew "$id" "$want"
env_set "$bridge_env" WEAVE_WECHAT_IMAGES "$want"
say "已写入 ${bridge_env}（不显示内容）。"

agent_start bridge
if [ "$want" = 1 ]; then
  say "看图在这台 Mac 上打开了，桥接已重启。服务器那边也要打开：web.env 里 WEAVE_WECHAT_IMAGES=1，再部署（docs/WECHAT.md）。"
else
  say "看图在这台 Mac 上关掉了，桥接已重启。"
fi
