#!/usr/bin/env bash
# 停掉微信桥接和 wx 守护进程（先停桥接，再停守护进程）。
#   bash stop.sh               只停。小号在微信里仍是登录状态，数据都留着；再跑 install.sh 就能重新开。
#   bash stop.sh --logout      先让小号退出登录（手机上看这台设备已退出），再停。
#   bash stop.sh --uninstall   停掉，并删掉 launchd 配置（数据和日志留着，见 README 的「彻底清掉」）。
# 不管用哪个，Weave 那边的开关（服务器上的令牌）不会变；要连它一起关，跑 set-token.sh --remove。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

logout=0 uninstall=0
for arg in "$@"; do
  case "$arg" in
    --logout) logout=1 ;;
    --uninstall) uninstall=1 ;;
    *) die "不认识的参数 ${arg}。用法见脚本开头的说明。" ;;
  esac
done

agent_stop bridge
say "桥接已停。"
if [ "$logout" = 1 ]; then
  if agent_loaded daemon && [ -x "$wx_bin" ]; then
    if wx_cli --account weave auth logout >/dev/null 2>&1; then say "小号已退出登录。"
    else say "退出登录没成功（可能本来就没登录）。要保险就在手机微信里：我 → 设置 → 账号与安全 → 登录设备管理，把这台设备踢掉。"; fi
  else
    say "守护进程没在跑，没法替它退出登录。请在手机微信里：我 → 设置 → 账号与安全 → 登录设备管理，把这台设备踢掉。"
  fi
fi
agent_stop daemon
agent_stop awake
say "守护进程已停。"
if [ "$uninstall" = 1 ]; then
  rm -f "$(plist_of bridge)" "$(plist_of daemon)" "$(plist_of awake)"
  say "launchd 配置已删除。数据和日志还在 $home_dir 和 ${data_dir}。"
fi
