#!/usr/bin/env bash
# 开始 iLink 测试：还没连上就先扫码，然后在后台起测试程序。重复跑没关系：已经在跑就只显示结果。
#   ssh -t <服务器> 'bash ~/ilink-probe/scripts/ilink-probe/start.sh'
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
refuse_root
need_docker

if running; then
  say "测试已经在跑了，下面是现在的结果："
  probe_status
  exit 0
fi

if ! has_account; then
  interactive || die "扫码要在能显示二维码的终端里做：在 Mac 的终端里用 ssh -t 跑这个脚本。什么都没启动。"
  say "第 1 步：用你自己的微信扫码连上（二维码 8 分钟内有效，过期会自动换一张）。"
  # 画二维码的小工具 qrcode-terminal（官方插件用的就是这一版）只装进这个一次性容器的 /tmp，用完跟着容器一起删掉。
  docker run --rm -it "${flags[@]}" --tmpfs /tmp:rw,noexec,nosuid,size=32m \
    -e npm_config_cache=/tmp/npm -e npm_config_update_notifier=false -e NODE_PATH=/tmp/q/node_modules \
    "$IMAGE" sh -c 'npm install --silent --no-audit --no-fund --prefix /tmp/q qrcode-terminal@0.12.0 >/dev/null 2>&1 || echo "（没装上画二维码的小工具，下面只给链接）"; exec node /app/probe.mjs login' \
    || die "没连上，什么都没启动。可以再跑一次。"
  has_account || die "没连上，什么都没启动。可以再跑一次。"
fi

# 留着的旧容器（停着的）先正常停掉再删；钥匙和记录在卷里，不受影响。
if exists; then
  docker stop -t 15 "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null
fi
docker run -d --name "$CONTAINER" --restart unless-stopped "${flags[@]}" --tmpfs /tmp:rw,noexec,nosuid,size=8m \
  --memory 96m --memory-swap 96m --oom-score-adj 600 --log-opt max-size=5m --log-opt max-file=2 \
  "$IMAGE" node /app/probe.mjs run >/dev/null
sleep "$settle_seconds"
if ! running; then
  docker logs --tail 20 "$CONTAINER" >&2 || true
  die "测试程序没跑起来，上面是它最后的输出。"
fi

say ""
say "测试开始了 ✅ 程序在后台跑，关掉这个终端也不影响。接下来用刚才扫码的微信做三件事："
say "  1. 现在给它发一句话，再发一张照片（随手拍一张就行）。它会马上回你。"
say "  2. 之后先别回它。它会隔几个小时发一条「测试 #N」，不用理。可以把这个对话设成「消息免打扰」，半夜就不会吵到你。"
say "  3. 第 3 天、第 7 天各给它发一句话。"
say ""
say "看结果：bash $probe_dir/status.sh"
say "不测了：bash $probe_dir/stop.sh --delete-data"
