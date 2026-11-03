#!/usr/bin/env bash
# 看一眼服务器上的微信这条线现在怎么样：两个容器在不在跑、被内存上限杀过没有、小号登没登录、内存用了多少、最近的日志。
# 只读，随时可以跑，不显示任何令牌。
#   ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/status.sh'
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

refuse_root
need docker

mib() { case "$1" in ''|*[!0-9]*) printf '%s' "-" ;; *) printf '%s MiB' "$(($1 / 1048576))" ;; esac; }

show_container() {   # 容器名 说明
  local info status restarts oom limit
  info=$(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{.State.OOMKilled}} {{.HostConfig.Memory}}' "$1" 2>/dev/null || true)
  if [ -z "$info" ]; then say "${2}（${1}）：还没建（先跑 up.sh）"; return 0; fi
  read -r status restarts oom limit <<EOF
$info
EOF
  case "$status" in running) status="运行中" ;; exited) status="停着" ;; restarting) status="正在重启" ;; esac
  case "$oom" in true) oom="被杀过（最近一次是因为内存超了上限）" ;; *) oom="没有" ;; esac
  say "${2}（${1}）：${status}，自动重启过 ${restarts} 次，内存上限 $(mib "$limit")，因为内存超了被杀：${oom}"
}

# 容器启动以来用过的最多内存（cgroup v2 的 memory.peak，Ubuntu 24.04 有）。读不到就不显示。
peak() {
  local bytes
  container_running "$1" || return 0
  bytes=$(docker exec "$1" cat /sys/fs/cgroup/memory.peak 2>/dev/null || true)
  case "$bytes" in ''|*[!0-9]*) return 0 ;; esac
  say "${2} 启动以来最多用过：$(mib "$bytes")"
}

say "== 容器"
show_container "$wx_container" "wx 守护进程"
show_container "$bridge_container" "微信桥接"

say ""
say "== 微信小号"
if ! container_running "$wx_container"; then say "wx 守护进程没在跑，看不了。"
elif ! accounts=$(wx_cli accounts list 2>/dev/null); then say "连不上 wx 守护进程。看日志：docker logs --tail 30 ${wx_container}"
else
  lines=$(printf '%s' "$accounts" | account_lines)
  if [ -z "$lines" ]; then say "还没有账号：跑 login.sh。"; fi
  while IFS="$(printf '\t')" read -r name logged connection transport pending; do
    [ -n "$name" ] || continue
    case "$logged" in yes) logged="已登录" ;; *) logged="没登录" ;; esac
    # agent-wechat 报的连接状态只有这三种（account status 的 connection）。
    case "$connection" in online) connection="在线" ;; reconnecting) connection="正在重连" ;; disconnected) connection="断开" ;; esac
    say "${name}：${logged}，连接：${connection}，收消息方式 ${transport}，待处理批次 ${pending}"
  done <<EOF
$lines
EOF
fi

say ""
say "== 内存（这几个容器的上限各算各的；这台机器同时还跑着 Azora）"
running=""
for name in "$wx_container" "$bridge_container" weave-web-1 weave-agent-1; do
  if container_running "$name"; then running="$running $name"; fi
done
if [ -n "$running" ]; then
  # 容器名里没有空格，这里就是要按空格拆成几个参数：
  # shellcheck disable=SC2086
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' $running 2>/dev/null || say "（docker stats 没有结果）"
else
  say "（一个都没在跑）"
fi
peak "$wx_container" "wx 守护进程"
peak "$bridge_container" "微信桥接"
if command -v free >/dev/null 2>&1; then
  free -m | awk '/^Mem:/ {print "整台机器：总共 " $2 " MB，还能用 " $7 " MB"} /^Swap:/ {print "swap：用了 " $3 " MB（总共 " $2 " MB）"}'
fi

for name in "$bridge_container" "$wx_container"; do
  say ""
  say "== 最近的日志：${name}"
  if docker inspect "$name" >/dev/null 2>&1; then docker logs --tail 8 "$name" 2>&1 || true; else say "（还没有）"; fi
done
