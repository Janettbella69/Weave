#!/usr/bin/env bash
# 每次部署跑这个：建镜像、启动、检查。只碰 compose 项目 weave，不碰 Azora 的任何容器。
set -euo pipefail
cd "$(dirname "$0")"
for f in .env web.env agent.env; do
  [ -f "$f" ] || { echo "缺 $f，先跑 setup-env.sh"; exit 1; }
done
set -a; . ./.env; set +a

echo "== 1/4 一次性容器的镜像（第一次要下载约 300 MB 的 CLI）"
docker build -q -f ../../hosted/agent-service/Dockerfile.agent -t weave-agent:0.3.316 ../../hosted/agent-service
echo "== 2/4 网站和 Agent 服务的镜像（第一次要几分钟）"
docker compose build
echo "== 3/4 启动"
docker compose up -d
echo "== 4/4 检查"
code=000
for _ in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://$WEAVE_BIND_IP:4317/" || true)
  [ "$code" = 401 ] && break
  sleep 2
done
echo "网站：HTTP $code（401 = 正常，正在要访问密码）"
docker compose exec -T agent node -e "fetch('http://127.0.0.1:4320/health').then(r=>r.text()).then(t=>console.log('Agent 服务：'+t)).catch(e=>{console.log('Agent 服务没响应：'+e.message);process.exit(1)})"
docker compose ps
