#!/usr/bin/env bash
# 在服务器上跑：从标准输入读一行微信桥接令牌，写进 web.env 的 WECHAT_BRIDGE_TOKEN，然后重新部署网站。
# 平时不用手动跑，Mac 上的 deploy/wechat-mac/set-token.sh 会通过 ssh 调它。
#
# 令牌只走标准输入：不出现在命令行、shell 历史、输出里。web.env 的其他行一行不动；改之前先备份到
# ~/weave-data/env-backups/（权限 600）。输入一个空行 = 关掉微信通道（令牌清空）。
#
# 目录默认 ~/weave/deploy/tencent，可以用 WEAVE_DEPLOY_DIR 改。WEAVE_SKIP_DEPLOY=1 只写配置、不重新部署（测试用）。
set -euo pipefail
dir="${WEAVE_DEPLOY_DIR:-$HOME/weave/deploy/tencent}"
env_file="$dir/web.env"
[ -f "$env_file" ] || { echo "找不到 ${env_file}，先跑 setup-env.sh。没有改任何东西。"; exit 1; }

token=""
IFS= read -r token || true
token=${token%$'\r'}
if [ -n "$token" ] && ! [[ "$token" =~ ^[A-Za-z0-9]{32,128}$ ]]; then
  echo "令牌格式不对（要 32 到 128 位的字母和数字）。没有改任何东西。"
  exit 1
fi

umask 077
backups="$HOME/weave-data/env-backups"
mkdir -p "$backups"
backup="$backups/web.env.$(date +%Y%m%d-%H%M%S)"
cp "$env_file" "$backup"

tmp=$(mktemp "$dir/.web.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
found=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    WECHAT_BRIDGE_TOKEN=*) if [ "$found" = 0 ]; then printf 'WECHAT_BRIDGE_TOKEN=%s\n' "$token" >> "$tmp"; found=1; fi ;;
    *) printf '%s\n' "$line" >> "$tmp" ;;
  esac
done < "$env_file"
[ "$found" = 1 ] || printf 'WECHAT_BRIDGE_TOKEN=%s\n' "$token" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$env_file"
trap - EXIT

if [ -n "$token" ]; then echo "已写入 web.env 的 WECHAT_BRIDGE_TOKEN（${#token} 位，不显示内容）。旧文件备份在 $backup"
else echo "已清空 web.env 的 WECHAT_BRIDGE_TOKEN，微信通道关闭。旧文件备份在 $backup"; fi

# 微信消息只有 WEAVE_AGENT_RUNTIME=sdk 才走 Agent。没设的话网站会回到旧路，提醒一句。
grep -q '^WEAVE_AGENT_RUNTIME=sdk$' "$env_file" || echo "注意：web.env 里没有 WEAVE_AGENT_RUNTIME=sdk，微信消息会走旧路。要先加上这一行。"

if [ "${WEAVE_SKIP_DEPLOY:-}" = 1 ]; then echo "（WEAVE_SKIP_DEPLOY=1，没有重新部署。）"; exit 0; fi
bash "$dir/deploy.sh"
