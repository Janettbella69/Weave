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

internal=$(curl -s --max-time 20 -X POST -H 'Content-Type: application/json' -d '{"args":{},"toolUseId":"t"}' "$url/api/internal/agent/tools/list_habits")
echo "$internal" | grep -q '通行证' || { echo "FAIL 内部接口应该由通行证把关：$internal"; exit 1; }
echo "PASS 内部接口不被访问密码挡住，由通行证把关"

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

# 关掉后 wrangler 对这个地址不回答（会一直挂着），所以设短超时；只要不返回 200（不吐数据）就算关着。
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
