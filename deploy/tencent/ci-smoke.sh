#!/usr/bin/env bash
# CI 用：拿测试配置把整套 compose 起一遍，检查完拆掉。用假的 DeepSeek Key，不花钱。
set -euo pipefail
# 它会覆盖本目录的配置文件，结束时删掉数据卷和配置：只许在 CI 里跑，绝不能在服务器上跑。
[ "${CI:-}" = "true" ] || { echo "ci-smoke.sh 只给 CI 用，会删掉本目录的配置和数据。服务器上请用 deploy.sh。"; exit 1; }
cd "$(dirname "$0")"
for f in .env web.env agent.env; do
  [ ! -e "$f" ] || { echo "已经有 $f 了，ci-smoke.sh 不会覆盖它。"; exit 1; }
done
data=$(mktemp -d)
token=$(openssl rand -hex 24)
cat > .env <<EOF
HOST_UID=$(id -u)
HOST_GID=$(id -g)
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
WEAVE_BIND_IP=$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)
WEAVE_AGENT_DATA=$data
EOF
cat > web.env <<EOF
WEAVE_ENCRYPTION_KEY=$(openssl rand -hex 32)
WEAVE_VPS_MODE=true
WEAVE_VPS_USER_ID=ci@example.test
WEAVE_VPS_EMAIL=ci@example.test
WEAVE_VPS_NAME=CI
WEAVE_BASIC_AUTH=weave:ci-password
WEAVE_AGENT_RUNTIME=sdk
AGENT_SERVICE_TOKEN=$token
EOF
printf 'AGENT_SERVICE_TOKEN=%s\nDEEPSEEK_API_KEY=sk-ci-not-a-real-key\n' "$token" > agent.env
trap 'docker compose logs --tail 60 || true; docker compose down -v || true; rm -f .env web.env agent.env' EXIT
set -a; . ./.env; set +a

docker build -q -f ../../hosted/agent-service/Dockerfile.agent -t weave-agent:0.3.316 ../../hosted/agent-service
docker compose up -d --build
url="http://$WEAVE_BIND_IP:4317"
code=000
for _ in $(seq 1 90); do
  code=$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' "$url/" || true)
  [ "$code" = 401 ] && break
  sleep 2
done
[ "$code" = 401 ] || { echo "FAIL 网站没有要访问密码：HTTP $code"; exit 1; }
echo "PASS 没带密码是 401"

status=$(curl -s --max-time 20 -u weave:ci-password "$url/api/status")
echo "$status" | grep -q '"personId":"u:' || { echo "FAIL 带上密码后单用户模式没进去：$status"; exit 1; }
echo "PASS 带上密码进得去，单用户模式认出了本人"

internal=$(curl -s --max-time 20 -X POST -H 'Content-Type: application/json' -d '{"args":{"name":"x"},"toolUseId":"t"}' "$url/api/internal/agent/tools/save_habit")
echo "$internal" | grep -q '通行证' || { echo "FAIL 内部接口应该由通行证把关：$internal"; exit 1; }
echo "PASS 内部接口不被访问密码挡住，由通行证把关"

snapshot=$(curl -s --max-time 20 "$url/api/internal/agent/snapshot")
echo "$snapshot" | grep -q '通行证' || { echo "FAIL 快照接口应该由通行证把关：$snapshot"; exit 1; }
echo "PASS 快照接口不被访问密码挡住，由通行证把关"

unknown=$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$url/api/internal/x")
[ "$unknown" = 401 ] || { echo "FAIL 别的 /api/internal/ 地址没带密码应该是 401：HTTP $unknown"; exit 1; }
echo "PASS 别的内部地址照样要密码"

# Worker 没读完请求体就回答时，wrangler dev 的代理转发会失败：POST 收到 503，路径是 / 时 wrangler 直接退出。
# 网站入口先读完请求体（hosted/lib/weave/request-body.mjs）。修之前本机每次约两到三成失败，60 次几乎必然露馅。
bad=0
for _ in $(seq 30); do
  for p in /api/internal/x /; do
    c=$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"x":1}' "$url$p" || true)
    [ "$c" = 401 ] || bad=$((bad + 1))
  done
done
alive=$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' "$url/" || true)
[ "$bad" = 0 ] && [ "$alive" = 401 ] || { echo "FAIL 带请求体的 POST 有 $bad 次不是 401，网站现在回 HTTP $alive"; exit 1; }
echo "PASS 带请求体的 POST 连发 60 次都是 401，网站还在"

# 页面每 5 秒拉一次 /api/status。wrangler dev 的代理和网站程序之间有一条闲了约 5 秒就被关掉的连接，轮询正好撞上时转发会失败；
# 没打补丁的 wrangler 4.92.0 把这个 GET 挂起来，等下一个请求才放出去（Chrome 还把后续轮询扣 20 秒，合起来就是 25 秒）。
# 按浏览器的节奏轮询 20 次，任何一次超过 1 秒都算没修好（补丁在 hosted/scripts/patch-wrangler-proxy.mjs）。
# 没打补丁时本机大约三分之一的轮询会卡 5 秒，20 次几乎必然露馅。
node ../../hosted/scripts/check-status-stall.mjs --url "$url" --auth weave:ci-password --polls 20 || { echo "FAIL 页面轮询 /api/status 出现卡顿"; exit 1; }

# 关掉后这个地址交给网站本身（没带密码就是 401）。只要不返回 200（不吐数据）就算关着；短超时是为了出问题时不卡住 CI。
explorer=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H 'Host: localhost' "$url/cdn-cgi/explorer/api/d1/database" || true)
[ "$explorer" != 200 ] || { echo "FAIL wrangler 的本机数据浏览器还开着"; exit 1; }
echo "PASS 本机数据浏览器不返回数据（HTTP $explorer，000 = 没有回答）"

docker compose exec -T agent node -e "fetch('http://127.0.0.1:4320/health').then(r=>r.json()).then(j=>{if(!j.ok)process.exit(1)})"
echo "PASS Agent 服务健康"

reply=$(curl -s --max-time 200 -u weave:ci-password -X POST -H 'Content-Type: application/json' -H "Origin: $url" -d '{"text":"你好"}' "$url/api/chat")
echo "chat: $reply"
echo "$reply" | grep -q '"reply"' || { echo "FAIL 聊天没有回复"; exit 1; }
if echo "$reply" | grep -q '还没有配置好\|暂时不可用'; then echo "FAIL 网站没连上 Agent 服务"; exit 1; fi
# 假 Key 会被 DeepSeek 拒绝，所以回复是「结果不确定」；要确认的是一次性容器真的起来过：CLI 会在配置目录里写东西。
find "$data/owner" -path '*/claude/*' -type f | head -3 | grep -q . || { echo "FAIL 一次性容器没有起来（配置目录是空的）"; exit 1; }
echo "PASS 网站 → Agent 服务 → 一次性容器整条链路走通了"

# workerd 被内核按内存杀掉时 wrangler 不会跟着退出：网站一直 502，Docker 也不重启它（2026-11-03 线上出过一次，持续约一个半小时）。
# 网站容器里的看门狗（hosted/scripts/web-watchdog.sh）发现网站连续 3 次没有正常回答，就让 wrangler 退出，由 Docker 重启容器。
# 这里在容器里杀掉占内存最多的那个 workerd（-9，和内核 OOM 一样），看容器是不是自己重启、网站是不是重新回答 401。
logs=$(docker logs weave-web-1 2>&1)
[[ $logs == *看门狗开始盯着* ]] || { echo "FAIL 网站容器里的看门狗没有开始盯着"; exit 1; }
echo "PASS 网站容器里的看门狗已经开始盯着"
before=$(docker inspect -f '{{.RestartCount}}' weave-web-1)
# 单引号里的这段在网站容器里跑，$ 由容器里的 bash 展开。
# shellcheck disable=SC2016
victim=$(docker compose exec -T web bash -c '
  best= most=0
  for f in /proc/[0-9]*/status; do
    name= rss=0
    while read -r k v _; do
      [ "$k" = Name: ] && name=$v
      [ "$k" = VmRSS: ] && rss=$v
    done < "$f"
    if [ "$name" = workerd ] && [ "$rss" -gt "$most" ]; then best=${f#/proc/}; best=${best%/status}; most=$rss; fi
  done 2>/dev/null
  [ -n "$best" ] && kill -9 "$best" && echo "$best $((most / 1024))"' || true)
[ -n "$victim" ] || { echo "FAIL 网站容器里找不到 workerd"; exit 1; }
echo "杀掉了网站容器里占内存最多的 workerd（进程号 ${victim% *}，${victim#* } MiB），等看门狗让容器重启……"
start=$SECONDS
restarts=$before
code=000
while [ $((SECONDS - start)) -lt 120 ]; do
  sleep 2
  restarts=$(docker inspect -f '{{.RestartCount}}' weave-web-1)
  [ "$restarts" -gt "$before" ] || continue
  code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$url/" || true)
  [ "$code" = 401 ] && break
done
took=$((SECONDS - start))
logs=$(docker logs weave-web-1 2>&1)
grep 'weave watchdog\|weave memory' <<<"$logs" || true
[ "$restarts" -ge 1 ] && [ "$restarts" -gt "$before" ] && [ "$code" = 401 ] || { echo "FAIL workerd 被杀以后 120 秒内网站没有自己恢复：RestartCount 从 ${before} 到 ${restarts}，网站回 HTTP ${code}"; exit 1; }
[[ $logs == *看门狗正在重启网站容器* ]] || { echo "FAIL 容器重启了，但日志里没有看门狗重启它的那一行"; exit 1; }
echo "PASS workerd 被杀以后约 ${took} 秒，看门狗让容器重启（RestartCount 从 ${before} 到 ${restarts}），网站重新回答 401"
