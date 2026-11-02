#!/bin/sh
# Agent 服务在容器里跑时，一次性容器要挂插件目录，而 docker 只认宿主机上的路径，
# 所以先把镜像里的插件放到数据目录（宿主和容器同一路径）再启动。
set -eu
: "${AGENT_DATA_DIR:?需要 AGENT_DATA_DIR}"
rm -rf "$AGENT_DATA_DIR/plugin"
cp -R /app/plugin "$AGENT_DATA_DIR/plugin"
export AGENT_PLUGIN_DIR="$AGENT_DATA_DIR/plugin"
exec node /app/server.mjs
