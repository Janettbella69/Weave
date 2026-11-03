#!/usr/bin/env bash
# 在服务器上登录微信小号，然后启动桥接。到「用小号扫这个二维码」这一步只剩你扫码。
#   0. 先要你确认 Mac 上的桥接和 wx 已经停了（有终端就问你，你输入「已停」；没有终端就要加 --mac-stopped）；
#   1. 检查：wx 在跑；网站的 web.env 里有桥接令牌；从 wx 的网络里连得上 Weave 的公网地址，而且 Weave 认这个令牌；
#   2. 建一个叫 weave 的账号（已有就用它）；没登录就给二维码，等你用小号扫、在手机上点登录；
#   3. 建一把新的桥接密钥（只能读和发；bridge.env 里有 WEAVE_WECHAT_IMAGES=1 时再加看图用的 media），先试它能用，
#      写进 bridge.env（权限 600，不显示）；
#   4. 用新配置启动桥接，等它真的连上 wx 和 Weave、又稳稳跑了 10 秒，才作废旧的同名密钥；最后打印状态。
# 可以重复跑：已经登录就不再扫码；每次换一把新密钥（先建新的，再作废旧的），桥接用新配置和仓库里现在的代码重启。
#
# 在你 Mac 的终端里（-t 才能问你、才能在终端里画二维码）：
#   ssh -t -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/login.sh'
# 终端里画不出二维码时加 --png：二维码存成服务器上的 ~/weave-wechat-qr.png，脚本会打印把它拿回 Mac 的 scp 命令。
# 没有终端时（ssh 没加 -t），二维码自动用 --png 的做法，而且必须加 --mac-stopped，表示你确认 Mac 上已经停了。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

mode="" mac_stopped=0
for arg in "$@"; do
  case "$arg" in
    --png) mode=png ;;
    --mac-stopped) mac_stopped=1 ;;
    *) die "不认识的参数 ${arg}。用法见脚本开头的说明。没有改任何东西。" ;;
  esac
done
if [ -z "$mode" ]; then
  if interactive; then mode=terminal; else mode=png; fi
fi

login_state="" login_code="" login_out=""
# 不管怎么结束，都删掉拷出来的二维码和临时文件。
trap 'rm -f "$qr_on_host"; [ -z "$login_out" ] || rm -f "$login_out"' EXIT

# 两套桥接同时跑会抢同一个发送队列、各自叫醒 Agent。服务器看不到你的 Mac，所以要你亲口确认。
# 不用 Weave 记的「桥接最近一次出现」来判断：下面第 1 步的检查本身就会刷新它。
confirm_mac_stopped() {
  local answer=""
  if [ "$mac_stopped" = 1 ]; then say "（你用 --mac-stopped 确认了 Mac 上的桥接和 wx 已经停了。）"; return 0; fi
  interactive || die "没有终端，没法问你 Mac 那边停了没有。确认 Mac 上已经跑过 bash ~/weave-wechat/deploy/wechat-mac/stop.sh 以后，加 --mac-stopped 重跑（或者用 ssh -t）。什么都没做。"
  say "开始之前确认一件事：你的 Mac 上已经跑过 bash ~/weave-wechat/deploy/wechat-mac/stop.sh 了吗？"
  say "（Mac 上的桥接和 wx 都要停掉，不然两边会抢着收发同一个小号的消息。）"
  printf '%s' "停了就输入「已停」再回车，别的输入都算没停："
  IFS= read -r answer || answer=""
  [ "$answer" = "已停" ] || die "没有输入「已停」，什么都没做。先在 Mac 上跑 bash ~/weave-wechat/deploy/wechat-mac/stop.sh，再重跑这个脚本。"
}

scan_banner() {
  say ""
  say "======================================================"
  say "  用小号扫这个二维码"
  say "======================================================"
  say "打开【小号】的微信 → 右上角「+」→「扫一扫」→ 扫二维码 → 在手机上点「登录」。"
  say "一定要用小号，不要用主号。二维码 5 分钟内有效，过期了会自动换新的（最多换 3 次）。"
  say "手机上要你做身份验证、提示「设备网络环境异常」或「安全保护中」，或者点了登录以后一直转圈："
  say "  别再扫，按 Ctrl-C 停下，照 README 第 2 节退回 Mac。"
  if [ "$mode" = terminal ]; then
    say "二维码下面那行「QR PNG: …」是服务器容器里的图片路径，不用管。终端里的二维码扫不出来，就按 Ctrl-C，改用 --png（README 第 1 节第 4 步）。"
  fi
  say ""
}

# --png：二维码不画在终端里，wx 把它存成容器里的图片；每出一张新的，就拷到服务器家目录，打印取图的命令。
copy_qr() {
  if docker cp "$wx_container:$1" "$qr_on_host" >/dev/null 2>&1; then
    chmod 600 "$qr_on_host"
    say ""
    say "二维码存好了。在你的 Mac 上另开一个终端窗口，跑这条把它拿回来打开，再用小号扫："
    say "  scp -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53:weave-wechat-qr.png ~/Desktop/ && open ~/Desktop/weave-wechat-qr.png"
    say "（二维码 5 分钟内有效；换了新的会再提示一次，到时候重跑这条。登录完把 Mac 桌面上的这张图删掉。）"
    say ""
  else
    say "二维码拷不出来（在 wx 容器里的 ${1}）。按 Ctrl-C，再用 ssh -t、不加 --png 重跑。"
  fi
}
# 登录用过的二维码图片（这个脚本存的，和 wx 自己默认存的那份）都删掉，过期了也别留在卷里。
remove_qr_in_container() {
  docker exec "$wx_container" sh -c 'rm -f /var/lib/agent-wechat/weave-login-qr*.png /var/lib/agent-wechat/.config/agent-wechat/qr/*.png' >/dev/null 2>&1 || true
}
login_png() {
  local id="$1" line code
  login_out=$(mktemp "${TMPDIR:-/tmp}/weave-wechat-login.XXXXXX")
  rm -f "$qr_on_host"
  remove_qr_in_container
  say "这次二维码不画在终端里，存成图片。"
  # docker exec 不带 -t 时不会把 Ctrl-C 传进容器，容器里这次登录（和同一局域网检查开的端口）会一直等到二维码过期。
  # 所以这个脚本收到 Ctrl-C 时，重启 wx 来取消它（小号还没登录上，重启不丢东西）。
  trap 'say ""; say "按了 Ctrl-C：重启 wx，取消服务器上的这次登录……"; docker restart "$wx_container" >/dev/null 2>&1 || true; exit 130' INT TERM HUP
  set +e
  # 结果（JSON）进临时文件；进度、「QR PNG: 路径」和提示走 stderr，一行一行读。
  { docker exec "$wx_container" wx --server "$wx_url" --token-file "$wx_token_in_container" --account "$id" auth login --qr-output "$qr_in_container" >"$login_out"; } 2>&1 |
    while IFS= read -r line; do
      case "$line" in
        "QR PNG: "*) copy_qr "${line#QR PNG: }" ;;
        *"local network check"*)
          say "$line"
          say "（这是「同一局域网」检查：服务器和你的手机不在一个网络里，过不了。按 Ctrl-C 停下，照 README 第 2 节退回 Mac。）" ;;
        *) say "$line" ;;
      esac
    done
  code=${PIPESTATUS[0]}
  set -e
  trap - INT TERM HUP
  login_state=$(json_get state < "$login_out")
  login_code=$(json_get result.code < "$login_out")
  rm -f "$qr_on_host"
  return "$code"
}

# 登录命令的退出码（agent-wechat 文档的 CLI reference）：0 成功，6 要你在手机上批准或验证，7 等到时间还没结束，
# 9 失败、过期、被拒绝或取消，130 按了 Ctrl-C。
login_outcome() {
  local code="$1"
  [ "$code" != 0 ] || return 0
  case "$login_code" in
    login_lan_challenge_failed) die "没有登录成功：微信要求手机和服务器在同一个局域网里（同一局域网检查），服务器过不了。这是停的信号：别再重试，照 README 第 2 节退回 Mac。" ;;
    login_poll_failed) die "没有登录成功：微信拒绝了这次登录。这是停的信号：别再重试，照 README 第 2 节退回 Mac，24 小时内别再登录。" ;;
  esac
  case "$code" in
    130) die "你按了 Ctrl-C，这次登录已经取消。要重来就重跑这个脚本。" ;;
    6) die "微信要你在手机上多做一步（批准这次登录，或者验证身份）。这是 README 第 2 节说的停的信号：别再扫，照那一节退回 Mac。" ;;
    7) die "等了太久还没登录上（二维码可能已经过期）。最多再重跑一次；还不行就照 README 第 2 节退回 Mac。" ;;
    9) die "没有登录成功：二维码过期了、手机上点了取消，或者微信拒绝了（状态：${login_state:-见上面的输出}）。最多再重跑一次；如果出现过「local network check」、手机上一直转圈，或者要你做身份验证，就别再试了，照 README 第 2 节退回 Mac。" ;;
    *) die "登录命令出错了（退出码 ${code}），原因在上面。没有建密钥，桥接没动。把这段话和上面的输出发给 Claude。" ;;
  esac
}

# 问 wx 一件事，拿到 JSON；问不到就停下，说清楚是哪一步。
ask_wx() {   # 说明 wx 的参数……
  local what="$1" out
  shift
  out=$(wx_cli "$@") || die "问 wx「${what}」没成功，原因在上面。看日志：docker logs --tail 30 ${wx_container}"
  printf '%s' "$out"
}

refuse_root
need_compose
need python3
check_project
container_running "$wx_container" || die "wx 守护进程没在跑：先跑 bash $here/up.sh（见 README 第 1 节）。没有改任何东西。"
wx_cli accounts list >/dev/null 2>&1 || die "连不上 wx 守护进程。看日志：docker logs --tail 30 ${wx_container}"
confirm_mac_stopped

say ""
say "== 1/4 检查网站那边"
[ -f "$web_env" ] || die "找不到网站的配置 ${web_env}。Weave 还没在这台服务器上部署好？见 deploy/tencent/README.md。没有改任何东西。"
bridge_token=$(env_get "$web_env" WECHAT_BRIDGE_TOKEN)
if [ -z "$bridge_token" ]; then
  say "${web_env} 里还没有 WECHAT_BRIDGE_TOKEN，Weave 那边的微信通道是关着的。没有改任何东西。" >&2
  say "先生成一个（令牌不显示；网站会重新部署，一两分钟），在你的 Mac 上跑：" >&2
  say "  ${ssh_hint} 'openssl rand -hex 32 | bash ~/weave/deploy/tencent/set-wechat-token.sh'" >&2
  die "然后重跑这个脚本。"
fi
[[ "$bridge_token" =~ ^[A-Za-z0-9]{32,128}$ ]] || die "${web_env} 里的 WECHAT_BRIDGE_TOKEN 格式不对（要 32 到 128 位的字母和数字）。没有改任何东西。"
grep -q '^WEAVE_AGENT_RUNTIME=sdk$' "$web_env" || say "注意：${web_env} 里没有 WEAVE_AGENT_RUNTIME=sdk，微信消息会走旧路（见 docs/WECHAT.md「谁来回答」）。"
# 桥接从 wx 的网络经公网地址连 Weave（bridge.mjs 只认 HTTPS），这里走同一条路先试一下。
probe=$(printf '%s\n' "$bridge_token" | weave_probe)
without="${probe% *}" with="${probe#* }"
[ "$without" = 401 ] || die "从 wx 的网络连 ${origin}：没带令牌应该是 HTTP 401，拿到的是 ${without:-没有回应}（0 是连不上）。桥接要从这里经公网地址连 Weave，现在连不上。没有改任何东西，把这段话发给 Claude。"
[ "$with" = 200 ] || die "从 wx 的网络连 ${origin}：带上 web.env 里的桥接令牌应该是 HTTP 200，拿到的是 ${with:-没有回应}。网站可能还没用上这个令牌（改过 web.env 要跑 deploy.sh）。没有改任何东西。"
say "从 wx 的网络连得上 ${origin}，Weave 认 web.env 里的桥接令牌。"

say ""
say "== 2/4 小号"
accounts=$(ask_wx "账号列表" accounts list)
id=$(printf '%s' "$accounts" | account_id_of "$WX_ALIAS")
if [ -z "$id" ]; then
  id=$(ask_wx "建账号" accounts create --alias "$WX_ALIAS" | json_get id)
  [ -n "$id" ] || die "建账号没成功。看日志：docker logs --tail 30 ${wx_container}"
  say "已建好微信账号 ${WX_ALIAS}。"
fi
authenticated=$(ask_wx "小号登录了没有" --account "$id" account status | json_get authenticated)
if [ "$authenticated" = true ]; then
  say "小号已经登录着，跳过扫码。"
else
  scan_banner
  code=0
  if [ "$mode" = terminal ]; then
    # 不带 --json：终端里才会画出二维码。-it：按 Ctrl-C 会传进容器，取消这次登录。
    docker exec -it "$wx_container" wx --server "$wx_url" --token-file "$wx_token_in_container" --account "$id" auth login || code=$?
  else
    login_png "$id" || code=$?
  fi
  remove_qr_in_container
  login_outcome "$code"
  authenticated=$(ask_wx "小号登录了没有" --account "$id" account status | json_get authenticated)
  [ "$authenticated" = true ] || die "登录命令结束了，但小号还没登录上。最多再重跑一次这个脚本；还不行就照 README 第 2 节退回 Mac。"
  say "小号登录成功。（Mac 上原来那次登录多半会被微信顶下线，没关系，Mac 那边已经停了。）"
fi

say ""
say "== 3/4 桥接用的密钥和配置"
# 看图（PR #33，默认关）要 media 权限：bridge.env 里 WEAVE_WECHAT_IMAGES=1 时才加，免得重新登录以后照片读不出来。
images=$(env_get "$bridge_env" WEAVE_WECHAT_IMAGES)
if [ "$images" = 1 ]; then
  say "建一把新的桥接密钥（读、发，和看图用的 media）……"
  created=$(ask_wx "建桥接密钥" tokens create weave-bridge --accounts "$id" --scopes read --scopes send --scopes media)
else
  say "建一把新的桥接密钥（只能读和发）……"
  created=$(ask_wx "建桥接密钥" tokens create weave-bridge --accounts "$id" --scopes read --scopes send)
fi
new_key=$(printf '%s' "$created" | json_get token)
new_id=$(printf '%s' "$created" | json_get grant.id)
created=""
if [ -z "$new_key" ] || [ -z "$new_id" ]; then die "建密钥没成功。旧的配置和密钥都没动。"; fi
# 先试新密钥能不能用：在 wx 的容器里用它问一次小号的状态，密钥走标准输入，不进命令行参数。
if ! printf '%s\n' "$new_key" | docker exec -i "$wx_container" wx --json --server "$wx_url" --token-stdin --account "$id" account status >/dev/null 2>&1; then
  wx_cli tokens revoke "$new_id" >/dev/null 2>&1 || true
  die "新密钥试用没通过，已经作废它。旧的配置和密钥都没动。把这段话发给 Claude。"
fi
umask 077
write_bridge_defaults
env_set "$bridge_env" WECHAT_BRIDGE_TOKEN "$bridge_token"
env_set "$bridge_env" WX_TOKEN "$new_key"
env_set "$bridge_env" WX_ACCOUNT "$id"
env_set "$bridge_env" WX_BASE_URL "$wx_url/v1"
env_set "$bridge_env" WEAVE_ORIGIN "$origin"
env_set "$bridge_env" WEAVE_TICK 1
new_key="" bridge_token=""
say "已写入 ${bridge_env}（权限 600，不显示内容）：网站的桥接令牌、新密钥、账号、两个地址、WEAVE_TICK=1。"

say ""
say "== 4/4 启动桥接"
dc up -d --force-recreate bridge
# 桥接外面那层 bridge-guard.mjs 在第一次连上 wx、第一次连上 Weave 时各打一行。两行都等到（最多 30 秒），
# 再看它稳稳跑 10 秒、没有重启，才作废旧密钥。不然旧密钥留着，前一套还能用。
reached_wx=0 reached_weave=0
for _ in $(seq 1 "$contact_seconds"); do
  logs=$(docker logs --tail 50 "$bridge_container" 2>&1 || true)
  case "$logs" in *"桥接已连上 wx 守护进程"*) reached_wx=1 ;; esac
  case "$logs" in *"桥接已连上 Weave"*) reached_weave=1 ;; esac
  if [ "$reached_wx" = 1 ] && [ "$reached_weave" = 1 ]; then break; fi
  container_running "$bridge_container" || break
  sleep 1
done
restarts=$(docker inspect -f '{{.RestartCount}}' "$bridge_container" 2>/dev/null || echo "?")
if [ "$reached_wx" = 1 ] && [ "$reached_weave" = 1 ]; then
  say "桥接连上了 wx 和 Weave。再看它 ${settle_seconds} 秒……"
  sleep "$settle_seconds"
fi
problem=""
if [ "$reached_wx" != 1 ]; then problem="桥接连不上 wx（它和 wx 共用网络，在 127.0.0.1:${WX_PORT} 找 wx）"
elif [ "$reached_weave" != 1 ]; then problem="桥接连不上 ${origin}"
elif ! container_running "$bridge_container"; then problem="桥接连上以后又停了"
elif [ "$(docker inspect -f '{{.RestartCount}}' "$bridge_container" 2>/dev/null || echo "?")" != "$restarts" ]; then problem="桥接连上以后自己重启了"
fi
if [ -n "$problem" ]; then
  say "${problem}。最近的日志（桥接的日志里没有令牌，也没有消息内容）："
  docker logs --tail 30 "$bridge_container" 2>&1 || true
  say "" >&2
  say "旧的桥接密钥没有作废（第一次登录时本来就没有旧的）。可以这样做：" >&2
  say "  1. 看上面的日志；修好以后重跑这个脚本（已经登录就不会再扫码）。" >&2
  say "  2. 一时修不好，就照 README 第 2 节先退回 Mac，助理不会一直离线。" >&2
  die "把这段话和上面的日志发给 Claude。"
fi
say "桥接已启动，连上了 wx 和 Weave。"
olds=$(ask_wx "密钥列表" tokens list | old_bridge_keys "$new_id")
revoked=0
while IFS= read -r old; do
  [ -n "$old" ] || continue
  if wx_cli tokens revoke "$old" >/dev/null; then revoked=$((revoked + 1)); else say "作废旧密钥 ${old} 没成功，下次跑这个脚本会再试。"; fi
done <<EOF
$olds
EOF
say "旧的桥接密钥作废了 ${revoked} 把，新的那把留着。"
say ""
bash "$here/status.sh" || true
say ""
say "下一步：用你的主号给小号发一句「你好」，一两分钟内应该有回复（README 第 1 节第 6 步）。绑定不用重做。"
