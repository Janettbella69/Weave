#!/usr/bin/env bash
# 网站容器里的看门狗。为什么要有它：真正跑网站的 workerd 被内核按内存杀掉时，上面的 wrangler 不会跟着退出，
# Docker 看到容器还在跑，restart: unless-stopped 不起作用，网站就一直 502（2026-11-03 线上出过一次，持续约一个半小时）。
# 它做的事：每 10 秒请求一次本机的网站；网站第一次回答（500 以下的任何状态码，没带密码是 401）以后才开始盯着；
# 之后连续 3 次没有正常回答（连不上、被断开、10 秒内没回答，或者 500 以上），就让 wrangler 退出
# （先 SIGTERM，10 秒后还在就 SIGKILL），容器随之退出，由 Docker 重新拉起。每 5 分钟记一行内存（前缀 [weave memory]）。
# 它不管内存为什么涨。镜像里没有 curl 和 wget，只用 bash 自带的 /dev/tcp；常驻的只有这一个 bash 进程。
#
# 用法：web-watchdog.sh <要停的进程号>。start-vps.sh 传 "$$"，exec 之后就是 wrangler 的进程号。
# 下面的环境变量只给测试用，不设就是线上的默认值：
#   WEAVE_WATCHDOG_URL          请求的地址，只支持 http://（默认 http://127.0.0.1:${PORT:-4317}/）
#   WEAVE_WATCHDOG_INTERVAL     每次检查之间隔几秒（默认 10）
#   WEAVE_WATCHDOG_TIMEOUT      一次请求最多等几秒，连接和等回答都算在里面（默认 10）
#   WEAVE_WATCHDOG_THRESHOLD    连续几次没有正常回答就重启（默认 3）
#   WEAVE_WATCHDOG_KILL_AFTER   SIGTERM 之后等几秒再 SIGKILL（默认 10）
#   WEAVE_WATCHDOG_MEMORY_EVERY 每隔几秒记一行内存（默认 300）
#   WEAVE_WATCHDOG_CGROUP_FILE  容器内存从哪个文件读（默认 cgroup v2 的 /sys/fs/cgroup/memory.current，没有就读 v1 的）
#   WEAVE_WATCHDOG_PROC         进程信息从哪里读（默认 /proc）
# 要在 macOS 自带的 bash 3.2 和 Linux 的 bash 5 上都能跑：不用 wait -n、$BASHPID、read 的小数超时。
set -u

die() { echo "[weave watchdog] $*" >&2; exit 2; }

target=${1-}
case $target in ''|0*|*[!0-9]*) die "用法：web-watchdog.sh <要停的进程号>" ;; esac

url=${WEAVE_WATCHDOG_URL:-http://127.0.0.1:${PORT:-4317}/}
interval=${WEAVE_WATCHDOG_INTERVAL:-10}
timeout=${WEAVE_WATCHDOG_TIMEOUT:-10}
threshold=${WEAVE_WATCHDOG_THRESHOLD:-3}
kill_after=${WEAVE_WATCHDOG_KILL_AFTER:-10}
memory_every=${WEAVE_WATCHDOG_MEMORY_EVERY:-300}
proc=${WEAVE_WATCHDOG_PROC:-/proc}
cgroup=${WEAVE_WATCHDOG_CGROUP_FILE:-}
if [ -z "$cgroup" ]; then
  cgroup=/sys/fs/cgroup/memory.current
  [ -r "$cgroup" ] || cgroup=/sys/fs/cgroup/memory/memory.usage_in_bytes
fi
for n in "$threshold" "$kill_after" "$memory_every"; do
  case $n in ''|*[!0-9]*) die "THRESHOLD、KILL_AFTER、MEMORY_EVERY 要是整数：$n" ;; esac
done
for n in "$interval" "$timeout"; do
  case $n in ''|.|*[!0-9.]*|*.*.*) die "INTERVAL、TIMEOUT 要是秒数：$n" ;; esac
done

case $url in http://*) ;; *) die "只支持 http:// 地址：$url" ;; esac
rest=${url#http://}
case $rest in */*) hostport=${rest%%/*}; path=/${rest#*/} ;; *) hostport=$rest; path=/ ;; esac
case $hostport in *:*) host=${hostport%:*}; port=${hostport##*:} ;; *) host=$hostport; port=80 ;; esac

# 发一次 GET，打印「HTTP 401」这样的状态，没有状态码时打印原因；打印完就停掉计时器。
get_status() {
  local timer=$1 line= sent=
  trap '' PIPE
  { sent=1
    printf 'GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$path" "$hostport" >&3 &&
      IFS= read -r line <&3
  } 3<>"/dev/tcp/$host/$port"
  if [ -z "$sent" ]; then
    echo "连不上"
  elif [ -z "$line" ]; then
    echo "连上了但没有回答就断开了"
  else
    case $line in
      'HTTP/'*' '[1-5][0-9][0-9]*) line=${line#* }; echo "HTTP ${line:0:3}" ;;
      *) echo "回答不是 HTTP" ;;
    esac
  fi
  kill "$timer" 2>/dev/null
}

# 一次检查最多 $timeout 秒：计时器先到，就杀掉还卡在连接或等回答的那次请求（打印为空）。
check() {
  sleep "$timeout" >/dev/null 2>&1 &
  local timer=$!
  get_status "$timer" &
  local probe=$!
  if wait "$timer"; then kill -KILL "$probe"; fi
  wait "$probe"
}

# 一行内存：容器（cgroup 的数字，含文件缓存）和所有 workerd 进程的 VmRSS 之和；不止一个 workerd 时附上各自的。
log_memory() {
  local bytes= part= total=0 count=0 each= file name rss key value rest pid
  { IFS= read -r bytes <"$cgroup"; } 2>/dev/null
  case $bytes in ''|*[!0-9]*) ;; *) part="容器 $(((bytes + 524288) / 1048576)) MiB，" ;; esac
  for file in "$proc"/[0-9]*/status; do
    name= rss=
    { while read -r key value rest; do
        case $key in
          Name:) name=$value ;;
          VmRSS:) rss=$value; break ;;
        esac
      done <"$file"; } 2>/dev/null
    [ "$name" = workerd ] || continue
    case $rss in ''|*[!0-9]*) continue ;; esac
    pid=${file%/status}; pid=${pid##*/}
    total=$((total + rss)); count=$((count + 1))
    each="$each${each:+，}pid $pid: $(((rss + 512) / 1024)) MiB"
  done
  [ "$count" -ge 2 ] || each=
  echo "[weave memory] ${part}workerd $(((total + 512) / 1024)) MiB${each:+（${each}）}"
}

restart() {
  local waited=0
  echo "[weave watchdog] 网站连续 ${fails} 次没有正常回答（最后一次：${1}），看门狗正在重启网站容器。"
  log_memory
  kill -TERM "$target" 2>/dev/null
  while kill -0 "$target" 2>/dev/null; do
    if [ "$waited" -ge "$kill_after" ]; then
      echo "[weave watchdog] 进程 ${target} 收到 SIGTERM ${kill_after} 秒后还在，改用 SIGKILL。"
      kill -KILL "$target" 2>/dev/null
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  exit 1
}

armed=0 fails=0 memory_at=$SECONDS
# 要停的进程已经不在了（自己退出了），就没什么可看的了。
while kill -0 "$target" 2>/dev/null; do
  result=$(check 2>/dev/null)
  case $result in
    'HTTP '[1-4][0-9][0-9])
      if [ "$armed" = 0 ]; then
        armed=1
        echo "[weave watchdog] 网站开始回答了（${result}），看门狗开始盯着：之后连续 ${threshold} 次没有正常回答，就重启网站容器。"
      fi
      fails=0 ;;
    *)
      if [ "$armed" = 1 ]; then
        fails=$((fails + 1))
        [ "$fails" -lt "$threshold" ] || restart "${result:-$timeout 秒内没有回答}"
      fi ;;
  esac
  if [ $((SECONDS - memory_at)) -ge "$memory_every" ]; then
    log_memory
    memory_at=$SECONDS
  fi
  sleep "$interval"
done
exit 0
