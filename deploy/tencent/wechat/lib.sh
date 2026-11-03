#!/usr/bin/env bash
# 共用的小函数和路径，给同目录的脚本 source，不单独运行。测试在 Mac 上跑（macOS 自带 bash 3.2），所以不用新语法。
# 这里定义的变量给 source 它的脚本用，单看这个文件像是没用到：
# shellcheck disable=SC2034
#
# 版本、镜像和端口：下面的 WX_VERSION、WX_IMAGE_*、BRIDGE_IMAGE、端口 6179 要和 compose.yml 一致，WX_VERSION 还要和
# deploy/wechat-mac/lib.sh 一致，测试会核对。env_set、env_get 和 Mac 那套是同一份写法，测试核对两边结果一样。
#
# 测试用的环境变量（平时不用管）：
#   WEAVE_WEB_ENV                网站的配置 web.env 在哪，默认是上一层目录的 web.env（~/weave/deploy/tencent/web.env）
#   WEAVE_ORIGIN                 Weave 的地址，默认 https://weave.azorashopping.site
#   WEAVE_WECHAT_TTY=1           当作有终端（会问你、二维码画在终端里），不管实际有没有
#   WEAVE_WECHAT_SETTLE_SECONDS  桥接连上以后再看它多少秒才作废旧密钥，默认 10
#   WEAVE_WECHAT_CONTACT_SECONDS 最多等多少秒让桥接连上 wx 和 Weave，默认 30

WX_VERSION=1.3.3
WX_IMAGE_REPO=ghcr.io/thisnick/agent-wechat-native
WX_IMAGE_DIGEST=sha256:c08d38c949129e81408666c4f6d6ce7e6ae2fbaa61121a1a3c5a3d09c5650419
# 桥接用的 Node 镜像（compose.yml 里 bridge 的 image）。login.sh 也用它，在 wx 的网络里先试一下连不连得上 Weave。
BRIDGE_IMAGE=node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WX_PORT=6179
WX_ALIAS=weave
WEAVE_ORIGIN_DEFAULT=https://weave.azorashopping.site
ssh_hint='ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53'

wechat_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
origin="${WEAVE_ORIGIN:-$WEAVE_ORIGIN_DEFAULT}"
bridge_env="$wechat_dir/bridge.env"
compose_env="$wechat_dir/.env"
web_env="${WEAVE_WEB_ENV:-$(cd "$wechat_dir/.." && pwd)/web.env}"
wx_url="http://127.0.0.1:$WX_PORT"
wx_container=wechat-wx-1
bridge_container=wechat-bridge-1
# 守护进程第一次启动时自己生成的主令牌（权限 600，属于容器里的用户 10001）。只在容器里用，不拿出来。
wx_token_in_container=/var/lib/agent-wechat/api-token
# login.sh --png 时二维码图片先存在容器里，再拷到服务器的家目录，给你 scp 回 Mac。
qr_in_container=/var/lib/agent-wechat/weave-login-qr.png
qr_on_host="$HOME/weave-wechat-qr.png"
settle_seconds="${WEAVE_WECHAT_SETTLE_SECONDS:-10}"
case "$settle_seconds" in ''|*[!0-9]*) settle_seconds=10 ;; esac
contact_seconds="${WEAVE_WECHAT_CONTACT_SECONDS:-30}"
case "$contact_seconds" in ''|0|*[!0-9]*) contact_seconds=30 ;; esac

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# 有没有一个能问你话的终端（ssh -t 才有）。
interactive() { [ "${WEAVE_WECHAT_TTY:-}" = 1 ] || { [ -t 0 ] && [ -t 1 ]; }; }

refuse_root() {
  [ "$(id -u)" != 0 ] || die "别用 root 或 sudo 跑：用平时登录的 ubuntu 用户就行（它能直接用 docker）。没有改任何东西。"
}
need() {
  local tool
  for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || die "缺少 ${tool}。没有改任何东西。"; done
}
need_compose() {
  need docker
  docker compose version >/dev/null 2>&1 || die "这台机器的 docker 没有 compose 插件（docker compose）。没有改任何东西。"
}

# 只对 compose 项目 wechat 说话：-p 写死（不受 COMPOSE_PROJECT_NAME 影响），文件和目录都用绝对路径，在哪个目录跑都一样。
dc() { docker compose -p wechat --project-directory "$wechat_dir" -f "$wechat_dir/compose.yml" "$@"; }

container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = true ]; }

# 在 wx 容器里跑 wx：带上地址和主令牌文件，输出 JSON。docker exec 不带 -i，不会吃掉脚本的标准输入。
wx_cli() { docker exec "$wx_container" wx --json --server "$wx_url" --token-file "$wx_token_in_container" "$@"; }

# 机器上如果已经有一个别的 compose 项目也叫 wechat（不是这个目录建的），就什么都不做，免得碰到它。
check_project() {
  local name dir others=""
  while read -r name dir; do
    [ -n "$name" ] || continue
    [ "$dir" = "$wechat_dir" ] || others="$others $name"
  done <<EOF
$(docker ps -a --filter label=com.docker.compose.project=wechat --format '{{.Names}} {{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)
EOF
  [ -z "$others" ] || die "这台机器上已经有一个别的 compose 项目也叫 wechat（容器：${others# }），不是这个目录建的。为了不碰它，什么都没做。把这段话发给 Claude。"
}

# wx 的内存上限：128m 到 1024m 之间的整数 MB。
valid_mem() {
  [[ "$1" =~ ^[1-9][0-9]*m$ ]] || return 1
  [ "${1%m}" -ge 128 ] && [ "${1%m}" -le 1024 ]
}

# 从标准输入读 JSON，打印其中一个字段（点号分隔的路径）。读不到就什么都不打印。true/false 打印成小写。
json_get() {
  python3 -I -c '
import json, sys
try:
    v = json.load(sys.stdin)
    for k in sys.argv[1].split("."):
        v = v.get(k) if isinstance(v, dict) else None
    if isinstance(v, bool):
        v = "true" if v else "false"
    if v is not None:
        sys.stdout.write(str(v))
except Exception:
    pass
' "$1"
}

# 从标准输入读 wx accounts list 的 JSON，打印别名是第一个参数的账号 id。
account_id_of() {
  python3 -I -c '
import json, sys
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    items = []
for a in items:
    if isinstance(a, dict) and a.get("alias") == sys.argv[1] and a.get("id"):
        sys.stdout.write(str(a["id"]))
        break
' "$1"
}

# 从标准输入读 wx tokens list 的 JSON，一行一个：叫 weave-bridge、还没作废、又不是第一个参数（刚建的那把）的密钥 id。
old_bridge_keys() {
  python3 -I -c '
import json, sys
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    items = []
for t in items:
    if isinstance(t, dict) and t.get("name") == "weave-bridge" and not t.get("revoked") and t.get("id") and t["id"] != sys.argv[1]:
        print(t["id"])
' "$1"
}

# 从标准输入读 wx accounts list 的 JSON，一行一个账号，用制表符隔开：名字、登录了没有（yes/no）、连接、收消息方式、待处理批次。
account_lines() {
  python3 -I -c '
import json, sys
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    items = []
for a in items:
    if isinstance(a, dict):
        fields = (a.get("alias") or a.get("id") or "-", "yes" if a.get("authenticated") else "no",
                  a.get("connection", "-"), a.get("incomingTransport", "-"), a.get("pendingProjectionBatches", "-"))
        print("\t".join(str(x) for x in fields))
'
}

# env 文件里设一个值：有就换掉，没有就加在最后，别的行原样不动；整个文件原子替换，权限 600。
# 值只在 shell 变量里传，不进命令行参数，所以 ps 看不到，也不会被打印。（和 deploy/wechat-mac/lib.sh 的一样。）
env_set() {
  local file="$1" key="$2" value="$3" tmp line found=0
  mkdir -p "$(dirname "$file")"
  tmp=$(umask 077; mktemp "$file.XXXXXX")
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$key="*) if [ "$found" = 0 ]; then printf '%s=%s\n' "$key" "$value" >> "$tmp"; found=1; fi ;;
        *) printf '%s\n' "$line" >> "$tmp" ;;
      esac
    done < "$file"
  fi
  [ "$found" = 1 ] || printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# 读 env 文件里的一个值；没有就是空。（和 deploy/wechat-mac/lib.sh 的一样。）
env_get() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$key="*) printf '%s' "${line#"$key="}"; return 0 ;; esac
  done < "$file"
}

# 桥接配置里不保密的默认值。没有文件就建（权限 600），有就只补缺的，不动已有的值和令牌。
# compose 读配置时要求 bridge.env 存在，所以 up.sh 一开始就建它。
write_bridge_defaults() {
  [ -f "$bridge_env" ] || {
    (umask 077; cat > "$bridge_env" <<EOT
# 服务器上微信桥接的配置（权限 600，别发给任何人，不进 git）。up.sh 建它，login.sh 写进令牌：
#   WECHAT_BRIDGE_TOKEN 从 ../web.env 抄过来；WX_TOKEN、WX_ACCOUNT 是登录以后建的 wx 密钥和账号。
# 发送上限（默认值是保守的猜测，微信的风控规则没有公开数据）。要改就取消注释，改完重跑 login.sh（已经登录就不会再扫码）：
# WECHAT_SEND_PER_CHAT_PER_MIN=6
# WECHAT_SEND_TOTAL_PER_MIN=12
# WECHAT_SEND_PER_DAY=200
# WECHAT_SEND_MIN_GAP_MS=1500
EOT
    )
  }
  [ -n "$(env_get "$bridge_env" WEAVE_ORIGIN)" ] || env_set "$bridge_env" WEAVE_ORIGIN "$origin"
  [ -n "$(env_get "$bridge_env" WX_BASE_URL)" ] || env_set "$bridge_env" WX_BASE_URL "$wx_url/v1"
  [ -n "$(env_get "$bridge_env" WEAVE_TICK)" ] || env_set "$bridge_env" WEAVE_TICK 1
  chmod 600 "$bridge_env"
}

# 从 wx 的网络里（桥接走的就是这条路）问两次 Weave 的公网地址：先不带令牌，再带上标准输入里的那个令牌。
# 打印两个 HTTP 状态码，比如「401 200」；连不上是 0。令牌只走标准输入，不进命令行参数。
# 用桥接的镜像起一个用完就删的容器（只读、不给特权）。
weave_probe_js='let t="";process.stdin.on("data",d=>t+=d).on("end",async()=>{const u=process.argv[1]+"/api/internal/wechat/events";const ask=async h=>{try{const r=await fetch(u,{method:"POST",redirect:"manual",headers:Object.assign({"Content-Type":"application/json"},h),body:"{}",signal:AbortSignal.timeout(30000)});return r.status}catch(e){return 0}};const a=await ask({});const b=await ask({Authorization:"Bearer "+t.trim()});console.log(a+" "+b)})'
weave_probe() {
  docker run --rm -i --network "container:$wx_container" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user node --memory 128m "$BRIDGE_IMAGE" node -e "$weave_probe_js" "$origin" 2>/dev/null || true
}
