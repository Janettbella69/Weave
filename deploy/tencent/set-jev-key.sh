#!/usr/bin/env bash
# 在服务器上跑：从标准输入读一行 Jev 的 Key，写进 web.env，然后重新部署网站。
# 默认当成 OpenRouter 的 Key：同时写 TYPESAFE_BASE_URL=https://openrouter.ai/api，经 OpenRouter 调 TypeSafe 的 Jev
# （hosted/lib/weave/jev.mjs）。加 --typesafe 就当成 TypeSafe 自己的 Key（console.typesafe.ai），直连，不写 TYPESAFE_BASE_URL。
#
# Key 只走标准输入：不出现在命令行、shell 历史、输出里。web.env 只动 TYPESAFE_API_KEY 和 TYPESAFE_BASE_URL 这两行，
# 其他行一行不动；改之前先备份到 ~/weave-data/env-backups/（权限 600）。输入一个空行 = 关掉 Jev（两行都删掉）。
#
# 目录默认 ~/weave/deploy/tencent，可以用 WEAVE_DEPLOY_DIR 改。WEAVE_SKIP_DEPLOY=1 只写配置、不重新部署（测试用）。
set -euo pipefail
dir="${WEAVE_DEPLOY_DIR:-$HOME/weave/deploy/tencent}"
env_file="$dir/web.env"
base="https://openrouter.ai/api"
case "${1:-}" in
  "") ;;
  --typesafe) base="" ;;
  *) echo "用法：set-jev-key.sh [--typesafe]，Key 从标准输入读。没有改任何东西。"; exit 1 ;;
esac
[ -f "$env_file" ] || { echo "找不到 ${env_file}，先跑 setup-env.sh。没有改任何东西。"; exit 1; }

key=""
IFS= read -r key || true
key=${key%$'\r'}
# 长度单独判断：macOS 自带的 bash 正则重复次数最多 255，写成 {12,512} 会编译失败。
if [ -n "$key" ] && { [ "${#key}" -lt 12 ] || [ "${#key}" -gt 512 ] || ! [[ "$key" =~ ^[A-Za-z0-9_-]+$ ]]; }; then
  echo "Key 格式不对（要 12 到 512 位的字母、数字、- 或 _）。没有改任何东西。"
  exit 1
fi

umask 077
backups="$HOME/weave-data/env-backups"
mkdir -p "$backups"
backup="$backups/web.env.$(date +%Y%m%d-%H%M%S)"
cp "$env_file" "$backup"

tmp=$(mktemp "$dir/.web.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    TYPESAFE_API_KEY=*|TYPESAFE_BASE_URL=*) ;;
    *) printf '%s\n' "$line" >> "$tmp" ;;
  esac
done < "$env_file"
if [ -n "$key" ]; then
  printf 'TYPESAFE_API_KEY=%s\n' "$key" >> "$tmp"
  [ -z "$base" ] || printf 'TYPESAFE_BASE_URL=%s\n' "$base" >> "$tmp"
fi
chmod 600 "$tmp"
mv "$tmp" "$env_file"
trap - EXIT

if [ -z "$key" ]; then
  echo "已删掉 web.env 的 TYPESAFE_API_KEY 和 TYPESAFE_BASE_URL，Jev 关闭。旧文件备份在 $backup"
elif [ -n "$base" ]; then
  echo "已写入 web.env 的 TYPESAFE_API_KEY（${#key} 位，不显示内容）和 TYPESAFE_BASE_URL=${base}，经 OpenRouter 调 Jev。旧文件备份在 $backup"
else
  echo "已写入 web.env 的 TYPESAFE_API_KEY（${#key} 位，不显示内容），直连 TypeSafe。旧文件备份在 $backup"
fi

# 经 OpenRouter 时模型名要带 typesafe/ 前缀。web.env 里另外写了不带前缀的 JEV_MODEL，就提醒一句。
if [ -n "$key" ] && [ -n "$base" ] && grep -Eq '^JEV_MODEL=jev-' "$env_file"; then
  echo "注意：web.env 里的 JEV_MODEL 没有 typesafe/ 前缀，经 OpenRouter 可能调不通。删掉那一行，就用默认的 typesafe/jev-1.14。"
fi

if [ "${WEAVE_SKIP_DEPLOY:-}" = 1 ]; then echo "（WEAVE_SKIP_DEPLOY=1，没有重新部署。）"; exit 0; fi
bash "$dir/deploy.sh"
