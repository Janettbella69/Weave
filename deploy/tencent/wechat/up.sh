#!/usr/bin/env bash
# 在服务器上把 wx 守护进程（agent-wechat 1.3.3 的官方镜像）起来，还不登录微信：
#   1. 检查：不是 root、有 docker compose、机器上没有别的 compose 项目也叫 wechat、127.0.0.1:6179 没被别的程序占着；
#   2. 没有桥接配置 bridge.env 就建一个（权限 600，只有不保密的默认值；令牌由 login.sh 写）；
#   3. 拉镜像（wx 钉死了版本，第一次一共约 260 MB），只启动 wx，等它回应，核对版本。桥接由 login.sh 启动。
# 可以重复跑：已经拉过、已经在跑就什么都不变；小号的登录和数据都在 docker 卷里，不会动。
# 这一步不影响 Mac 上正在跑的那套：没登录的守护进程不连微信。
#
# 在你 Mac 的终端里：
#   ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/up.sh'
# 用法：bash up.sh                 平常这样
#       bash up.sh --wx-mem 384m   把 wx 的内存上限改成 384 MB（写进同目录的 .env），再重建 wx（小号不用重新登录）
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

set_mem=0 wx_mem=""
while [ $# -gt 0 ]; do
  case "$1" in
    --wx-mem) [ $# -ge 2 ] || die "--wx-mem 后面要跟大小，比如 --wx-mem 384m。没有改任何东西。"; set_mem=1; wx_mem="$2"; shift 2 ;;
    *) die "不认识的参数 ${1}。用法见脚本开头的说明。没有改任何东西。" ;;
  esac
done

refuse_root
need_compose
need python3
check_project
if [ "$set_mem" = 1 ] && ! valid_mem "$wx_mem"; then
  die "内存上限要写成 128m 到 1024m 之间的整数 MB，比如 384m。拿到的是「${wx_mem}」，没有改任何东西。"
fi
if ! container_running "$wx_container" && port_busy; then
  die "127.0.0.1:${WX_PORT} 已经被这台机器上别的程序占着，wx 用不了这个端口。没有改任何东西。把这段话发给 Claude（可以先看是谁：ss -ltnp 'sport = :${WX_PORT}'）。"
fi

umask 077
write_bridge_defaults
if [ "$set_mem" = 1 ]; then
  env_set "$compose_env" WEAVE_WECHAT_WX_MEM "$wx_mem"
  say "wx 的内存上限改成 ${wx_mem}（写在 ${compose_env}）。"
fi

say "== 1/3 拉镜像：agent-wechat ${WX_VERSION}（钉死了 digest）和桥接用的 node:22-alpine（第一次一共约 260 MB，要一两分钟）"
# 桥接的镜像也现在拉好，login.sh 启动桥接时就不用等下载（那时 Mac 已经停了）。
# 重跑时 ghcr.io 暂时连不上也不要紧：本机已经有钉死的那个镜像就照用；真的没有，下一步启动时会报错。
dc pull --ignore-pull-failures wx bridge
say "== 2/3 启动 wx 守护进程（已经在跑、配置没变就不动它）"
dc up -d wx
say "== 3/3 等它回应"
ok=0
for _ in $(seq 1 30); do
  if wx_cli accounts list >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || die "wx 没有回应。看日志：docker logs --tail 30 ${wx_container}"
version=$(docker exec "$wx_container" wx --json version | json_get version)
[ "$version" = "$WX_VERSION" ] || die "wx 的版本是「${version}」，应该是 ${WX_VERSION}。先别往下做，把这段话发给 Claude。"
limit=$(docker inspect -f '{{.HostConfig.Memory}}' "$wx_container" 2>/dev/null || true)
case "$limit" in ''|*[!0-9]*) limit_text="不知道" ;; *) limit_text="$((limit / 1048576)) MB" ;; esac
say "wx 守护进程正常：版本 ${version}，只听 127.0.0.1:${WX_PORT}（外面连不到），内存上限 ${limit_text}。"
say ""
say "下一步（照 README 第 1 节的顺序）：先在 Mac 上停掉那一套，再跑 login.sh 扫码："
say "  bash ~/weave-wechat/deploy/wechat-mac/stop.sh                （在 Mac 上跑，不加 --logout）"
say "  ssh -t -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/login.sh'"
