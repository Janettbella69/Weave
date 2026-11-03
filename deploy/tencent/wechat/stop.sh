#!/usr/bin/env bash
# 停掉服务器上的微信桥接和 wx 守护进程（先停桥接，再停守护进程）。
#   bash stop.sh                只停。小号在微信里仍是登录状态，数据都留着；再跑 up.sh、login.sh 就能接着用（不用重新扫码）。
#   bash stop.sh --logout       先让小号在这台服务器上退出登录（手机上看这台设备已退出），再停。退回 Mac 时用这个。
#   bash stop.sh --delete-data  停掉，再删掉这台服务器上小号的全部数据：登录、聊天记录、联系人、收到的图片和文件、
#                               桥接读到哪儿了、bridge.env 和 .env。只删 compose 项目 wechat 的东西，网站和 Azora 的不碰。删了不能恢复。
# 可以一起用：bash stop.sh --logout --delete-data。网站那边 web.env 里的 WECHAT_BRIDGE_TOKEN 不会变。
# 停容器用的是 docker stop 加容器名，所以 compose 的配置坏了也停得掉。
#   ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/stop.sh --logout'
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

logout=0 delete=0
for arg in "$@"; do
  case "$arg" in
    --logout) logout=1 ;;
    --delete-data) delete=1 ;;
    *) die "不认识的参数 ${arg}。用法见脚本开头的说明。没有改任何东西。" ;;
  esac
done

refuse_root
need docker

if container_running "$bridge_container"; then docker stop "$bridge_container" >/dev/null; say "桥接已停。"
else say "桥接本来就没在跑。"; fi

device_hint="保险起见，在小号的手机微信里：我 → 设置 → 账号与安全 → 登录设备管理，把这台服务器删掉。"
if [ "$logout" = 1 ]; then
  if container_running "$wx_container"; then
    if wx_cli --account "$WX_ALIAS" auth logout >/dev/null 2>&1; then say "小号已在这台服务器上退出登录。${device_hint}"
    else say "退出登录没成功（可能本来就没登录）。${device_hint}"; fi
  else
    say "守护进程没在跑，没法替它退出登录。${device_hint}"
  fi
fi

if container_running "$wx_container"; then docker stop "$wx_container" >/dev/null; say "守护进程已停。"
else say "守护进程本来就没在跑。"; fi

if [ "$delete" = 1 ]; then
  need_compose
  check_project
  umask 077
  # compose 读配置时要 bridge.env 在；这里补一个只有默认值的，删完一起删掉。
  write_bridge_defaults
  dc down --volumes --remove-orphans
  rm -f "$bridge_env" "$compose_env"
  say "已删掉：容器 ${wx_container}、${bridge_container}，卷 wechat_wx-data、wechat_wx-scratch、wechat_bridge-state，配置 bridge.env 和 .env。"
  say "镜像还留着（占一些磁盘，不含任何人的数据）。要删：docker image rm ${WX_IMAGE_REPO}@${WX_IMAGE_DIGEST}"
fi
