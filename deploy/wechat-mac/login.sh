#!/usr/bin/env bash
# 登录微信小号，然后启动桥接。到「用小号扫这个二维码」这一步只剩你扫码。
#   1. 确认 wx 守护进程在跑、桥接令牌已经配好（install.sh、set-token.sh 跑过）；
#   2. 建一个叫 weave 的账号（已有就用它）；
#   3. 在终端里画二维码，等你用小号扫、在手机上点登录；
#   4. 登录成功后，建一把只能读和发的密钥写进桥接配置（不显示），启动桥接。
# 扫不上就直接重跑，二维码 5 分钟内有效，会自动刷新 3 次。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

[ -x "$wx_bin" ] || die "还没装 wx：先跑 bash $here/install.sh"
wx_cli accounts list >/dev/null 2>&1 || die "连不上 wx 守护进程：先跑 bash $here/install.sh，或看日志 tail -n 30 $log_dir/daemon.log"
[ -n "$(env_get "$bridge_env" WECHAT_BRIDGE_TOKEN)" ] || die "还没配桥接令牌：先跑 bash $here/set-token.sh"

id=$(wx_cli accounts list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=(JSON.parse(s).items||[]).find(x=>x.alias==="weave");if(a)process.stdout.write(a.id)})')
if [ -z "$id" ]; then
  id=$(wx_cli accounts create --alias weave | json_get id)
  [ -n "$id" ] || die "建账号没成功。"
  say "已建好微信账号 weave。"
fi

authenticated=$(wx_cli --account "$id" account status | json_get authenticated)
if [ "$authenticated" = true ]; then
  say "小号已经登录着，跳过扫码。"
else
  say ""
  say "======================================================"
  say "  用小号扫这个二维码"
  say "======================================================"
  say "打开【小号】的微信 → 右上角「+」→「扫一扫」→ 扫下面的二维码 → 在手机上点「登录」。"
  say "一定要用小号，不要用主号。手机要和这台 Mac 连同一个 Wi-Fi。二维码 5 分钟内有效。"
  say ""
  # 不带 --json：终端里才会画出二维码。
  if ! "$wx_bin" --server "$wx_url" --token-file "$data_dir/api-token" --account "$id" auth login; then
    die "没有登录成功。二维码过期了或手机上没点登录：重跑这个脚本。手机一直转圈的话，看 deploy/wechat-mac/README.md 里「手机一直转圈」那一节。"
  fi
  authenticated=$(wx_cli --account "$id" account status | json_get authenticated)
  [ "$authenticated" = true ] || die "登录命令结束了，但小号还没登录上。重跑这个脚本。"
  say "小号登录成功。"
fi

say ""
say "建桥接用的密钥（只能读和发）……"
# 旧的同名密钥先作废，免得越攒越多。
wx_cli tokens list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const t of JSON.parse(s).items||[])if(t.name==="weave-bridge"&&!t.revoked)console.log(t.id)})' | while IFS= read -r old; do
  wx_cli tokens revoke "$old" >/dev/null || true
done
bridge_key=$(wx_cli tokens create weave-bridge --accounts "$id" --scopes read --scopes send | json_get token)
[ -n "$bridge_key" ] || die "建密钥没成功。"
umask 077
env_set "$bridge_env" WX_TOKEN "$bridge_key"
env_set "$bridge_env" WX_ACCOUNT "$id"
bridge_key=""
say "已写入 ${bridge_env}（不显示内容）。"

agent_start bridge
say "桥接已启动。"
say ""
bash "$here/status.sh" || true
say ""
say "下一步：在 Weave 里设置 → 渠道 → 微信 → 连接，照页面上的话用你的主号给小号发一句，见 deploy/wechat-mac/README.md 第 4 节。"
