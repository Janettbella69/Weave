#!/bin/sh
# 网站容器的入口：把容器的环境变量写成 wrangler 读的 .dev.vars，第一次启动时建 D1 表，
# 再起 Notion 本地代理和 wrangler dev。只用环境变量，不写死任何钥匙。
set -eu

state_dir="/app/.wrangler/state"
marker0="$state_dir/.weave-schema-0000"
marker1="$state_dir/.weave-schema-0001"
mkdir -p "$state_dir"

umask 077
cat > /app/.dev.vars <<ENV
WEAVE_ENCRYPTION_KEY=${WEAVE_ENCRYPTION_KEY-}
WEAVE_VPS_MODE=${WEAVE_VPS_MODE-}
WEAVE_VPS_USER_ID=${WEAVE_VPS_USER_ID-}
WEAVE_VPS_EMAIL=${WEAVE_VPS_EMAIL-}
WEAVE_VPS_NAME=${WEAVE_VPS_NAME-}
WEAVE_BASIC_AUTH=${WEAVE_BASIC_AUTH-}
WEAVE_AGENT_RUNTIME=${WEAVE_AGENT_RUNTIME-}
AGENT_SERVICE_URL=${AGENT_SERVICE_URL-}
AGENT_SERVICE_TOKEN=${AGENT_SERVICE_TOKEN-}
AGENT_PROVIDER_API_KEY=${AGENT_PROVIDER_API_KEY-}
AGENT_DAILY_CALLS_PER_ACCOUNT=${AGENT_DAILY_CALLS_PER_ACCOUNT-}
AGENT_DAILY_CALLS_TOTAL=${AGENT_DAILY_CALLS_TOTAL-}
HERMES_RUNNER_TOKEN=${HERMES_RUNNER_TOKEN-}
WECHAT_BRIDGE_TOKEN=${WECHAT_BRIDGE_TOKEN-}
WEAVE_WECHAT_IMAGES=${WEAVE_WECHAT_IMAGES-}
TYPESAFE_API_KEY=${TYPESAFE_API_KEY-}
JEV_MODEL=${JEV_MODEL-}
JEV_THRESHOLD=${JEV_THRESHOLD-}
NOTION_OAUTH_CLIENT_ID=${NOTION_OAUTH_CLIENT_ID-}
NOTION_OAUTH_CLIENT_SECRET=${NOTION_OAUTH_CLIENT_SECRET-}
NOTION_OAUTH_REDIRECT_URI=${NOTION_OAUTH_REDIRECT_URI-}
NOTION_PUBLIC_ORIGIN=${NOTION_PUBLIC_ORIGIN-}
NOTION_OAUTH_EXCHANGE_URL=${NOTION_OAUTH_EXCHANGE_URL:-http://127.0.0.1:4319/exchange}
NOTION_API_PROXY_URL=${NOTION_API_PROXY_URL:-http://127.0.0.1:4319/api}
ENV

if [ ! -f "$marker0" ]; then
  echo "Initializing local D1 database..."
  node ./node_modules/wrangler/bin/wrangler.js \
    d1 execute DB --local --env-file /app/.dev.vars --config dist/server/wrangler.json \
    --persist-to "$state_dir" --file drizzle/0000_aromatic_slapstick.sql
  touch "$marker0"
fi

if [ ! -f "$marker1" ]; then
  echo "Applying guest sessions migration..."
  node ./node_modules/wrangler/bin/wrangler.js \
    d1 execute DB --local --env-file /app/.dev.vars --config dist/server/wrangler.json \
    --persist-to "$state_dir" --file drizzle/0001_guest_sessions.sql
  touch "$marker1"
fi

node ./scripts/notion-oauth-proxy.mjs &

# wrangler 的补丁没打上时，在日志里说清楚（不拦着启动：拦住只会让网站整个起不来）。
node ./scripts/patch-wrangler-proxy.mjs --check || echo "警告：wrangler 没有打补丁，页面轮询可能偶尔卡 5 到 25 秒，内存会一直涨到被内核杀掉（见 scripts/patch-wrangler-proxy.mjs）。" >&2

# workerd 被内存杀掉时 wrangler 不会跟着退出，网站会一直 502。看门狗发现网站连续不回答，就让 wrangler 退出，
# 由 Docker 重启容器（见 scripts/web-watchdog.sh）。"$$" 在 exec 之后就是 wrangler 的进程号。
./scripts/web-watchdog.sh "$$" &

exec node ./node_modules/wrangler/bin/wrangler.js \
  dev --env-file /app/.dev.vars --config dist/server/wrangler.json --local --persist-to "$state_dir" \
  --ip 0.0.0.0 --port "${PORT:-4317}" --inspector-port 0
