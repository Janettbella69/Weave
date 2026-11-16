#!/usr/bin/env bash
# iLink 桥接（hosted/ilink-bridge）的共用小函数和名字，给同目录的脚本 source，不单独运行。
# 只碰自己的容器 ilink-bridge 和卷 ilink-data，不碰 weave、wechat、Azora 的任何容器和卷。
# 测试在 Mac 上跑（macOS 自带 bash 3.2），所以不用新语法。这里的变量给 source 它的脚本用：
# shellcheck disable=SC2034
#
# 测试用的环境变量（平时不用管）：
#   WEAVE_WEB_ENV            网站的配置 web.env 在哪，默认是上一层目录的 web.env（~/weave/deploy/tencent/web.env）
#   WEAVE_ILINK_TTY=1        当作有终端（会问你、二维码画在终端里），不管实际有没有
#   WEAVE_ILINK_SETTLE_SECONDS  起来以后再看它多少秒，默认 5

# 和微信桥接用同一个 Node 镜像（deploy/tencent/wechat/lib.sh 的 BRIDGE_IMAGE）：服务器上已经有，不用再下载。测试会核对两边一样。
IMAGE=node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
CONTAINER=ilink-bridge
VOLUME=ilink-data
# 实验容器（分支 exp/ilink-probe）占着同一个微信的 iLink 绑定：它在跑的时候不能起正式的桥接。
PROBE_CONTAINER=ilink-probe
# 直连宿主机上的 Weave 网站（它绑在 docker0 的地址上，见 deploy/tencent/compose.yml）：不走公网和 nginx（nginx 限了请求体 1 MB，照片会被挡），令牌也不出这台机器。
ORIGIN_DEFAULT=http://host.docker.internal:4317
WEAVE_PORT=4317

ilink_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$ilink_dir/../../.." && pwd)"
web_env="${WEAVE_WEB_ENV:-$(cd "$ilink_dir/.." && pwd)/web.env}"
bridge_env="$ilink_dir/bridge.env"
settle_seconds="${WEAVE_ILINK_SETTLE_SECONDS:-5}"
case "$settle_seconds" in ''|*[!0-9]*) settle_seconds=5 ;; esac

# 每次 docker run 都带的：不给任何特权、根目录只读、用镜像里的 node 用户。数据卷挂在 node 的家目录（新卷会照搬镜像里这个目录的属主，
# 所以 node 能写）。程序和它借用的小号桥接的几个函数（stripMetadata 等）都从这份仓库只读挂进去，git pull 以后要重启才用上新代码。
flags=(--init --user node --read-only --cap-drop ALL --security-opt no-new-privileges:true
  -v "$VOLUME:/home/node" -v "$repo_dir/hosted/ilink-bridge:/app:ro" -v "$repo_dir/hosted/wechat-bridge:/wechat-bridge:ro")

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
interactive() { [ "${WEAVE_ILINK_TTY:-}" = 1 ] || { [ -t 0 ] && [ -t 1 ]; }; }
refuse_root() { [ "$(id -u)" != 0 ] || die "别用 root 或 sudo 跑，用平时登录的用户就行。什么都没改。"; }
need_docker() { command -v docker >/dev/null 2>&1 || die "这台机器上没有 docker。什么都没改。"; }

running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }
exists() { docker inspect "$CONTAINER" >/dev/null 2>&1; }
has_data() { docker volume inspect "$VOLUME" >/dev/null 2>&1; }
has_account() { docker run --rm "${flags[@]}" "$IMAGE" test -s /home/node/accounts.json >/dev/null 2>&1; }
bridge_status() { docker run --rm "${flags[@]}" --tmpfs /tmp:rw,noexec,nosuid,size=8m "$IMAGE" node /app/bridge.mjs status; }
# 实验容器在跑就不让往下走：两边同时连同一个微信的 iLink，会互相顶掉。
refuse_while_probe() {
  [ "$(docker inspect -f '{{.State.Running}}' "$PROBE_CONTAINER" 2>/dev/null || true)" != true ] \
    || die "实验容器 $PROBE_CONTAINER 还在跑，它占着同一个微信的 iLink 绑定。先停掉它：bash ~/ilink-probe/scripts/ilink-probe/stop.sh --delete-data。什么都没改。"
}

# env 文件里设一个值：有就换掉，没有就加在最后，别的行原样不动；整个文件原子替换，权限 600。
# 值只在 shell 变量里传，不进命令行参数，所以 ps 看不到，也不会被打印。（和 deploy/tencent/wechat/lib.sh 的一样。）
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
env_get() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$key="*) printf '%s' "${line#"$key="}"; return 0 ;; esac
  done < "$file"
}

# bridge.env（权限 600，不进 git）：令牌从网站的 web.env 抄过来，地址写成直连宿主机。已经有就只补缺的，不动已有的值。
write_bridge_env() {
  [ -f "$web_env" ] || die "找不到网站的配置 ${web_env}。Weave 还没在这台服务器上部署好？见 deploy/tencent/README.md。没有改任何东西。"
  local token
  token=$(env_get "$web_env" WECHAT_BRIDGE_TOKEN)
  [ -n "$token" ] || die "${web_env} 里还没有 WECHAT_BRIDGE_TOKEN，Weave 那边的微信通道是关着的。没有改任何东西。"
  [[ "$token" =~ ^[A-Za-z0-9]{32,128}$ ]] || die "${web_env} 里的 WECHAT_BRIDGE_TOKEN 格式不对（要 32 到 128 位的字母和数字）。没有改任何东西。"
  grep -q '^WEAVE_AGENT_RUNTIME=sdk$' "$web_env" || say "注意：${web_env} 里没有 WEAVE_AGENT_RUNTIME=sdk，私聊照片的接口只在 Agent SDK 路线上有。"
  env_set "$bridge_env" WECHAT_BRIDGE_TOKEN "$token"
  [ -n "$(env_get "$bridge_env" WEAVE_ORIGIN)" ] || env_set "$bridge_env" WEAVE_ORIGIN "$ORIGIN_DEFAULT"
  env_set "$bridge_env" ILINK_DATA /home/node
  chmod 600 "$bridge_env"
}
