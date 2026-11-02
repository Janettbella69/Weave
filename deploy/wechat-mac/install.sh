#!/usr/bin/env bash
# 在这台 Mac 上装好 agent-wechat 和 Weave 的微信桥接（还不登录微信）：
#   1. 下载钉死版本的 wx，核对 SHA-256，不对就不装；
#   2. 写两个 launchd 任务：wx 守护进程、微信桥接（桥接要等登录好才会启动）；
#   3. 启动守护进程，检查它回应。
# 可以重复跑：已经装好的不重复下载，配置会更新，守护进程会重启。
# 用法：bash install.sh            平常这样
#       bash install.sh --keep-awake   另外装一个「插着电时不让 Mac 睡着」的任务
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

install_wx() {
  local url="https://github.com/thisnick/agent-wechat/releases/download/v$WX_VERSION/wx-v$WX_VERSION-darwin-arm64" tmp got
  if [ -x "$wx_bin" ] && [ "$(shasum -a 256 "$wx_bin" | cut -d' ' -f1)" = "$WX_SHA256_DARWIN_ARM64" ]; then
    say "wx $WX_VERSION 已经装好了，跳过下载。"
    return 0
  fi
  say "下载 wx ${WX_VERSION}（约 29 MB，网慢的话要一两分钟）……"
  tmp=$(umask 077; mktemp "$home_dir/bin/.wx-download.XXXXXX")
  curl -fSL -# --retry 3 --max-time 900 -o "$tmp" "$url" || { rm -f "$tmp"; die "下载失败。检查网络（需要能打开 github.com），再重跑。"; }
  got=$(shasum -a 256 "$tmp" | cut -d' ' -f1)
  if [ "$got" != "$WX_SHA256_DARWIN_ARM64" ]; then
    rm -f "$tmp"
    die "校验没通过（拿到 ${got}，应该是 ${WX_SHA256_DARWIN_ARM64}）。文件已删除，什么都没装。把这段话发给 Claude。"
  fi
  chmod 755 "$tmp"
  mv "$tmp" "$wx_bin"
  say "校验通过，已装到 $wx_bin"
}

main() {
  local keep_awake=0 node major repo
  [ "${1:-}" != "--keep-awake" ] || keep_awake=1
  [ "$(uname -s)" = Darwin ] || die "这个脚本是给 Mac 用的。"
  [ "$(uname -m)" = arm64 ] || die "agent-wechat 的 macOS 版只有 Apple 芯片（M 系列）的，这台是 $(uname -m)。"
  node=$(command -v node) || die "找不到 node（要 22 以上）。先装：brew install node"
  major=$("$node" -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || die "node 太旧（$("$node" -v)），要 22 以上。"
  local tool; for tool in curl shasum plutil launchctl; do command -v "$tool" >/dev/null 2>&1 || die "缺少 ${tool}。"; done
  repo="$(cd "$here/../.." && pwd)"
  [ -f "$repo/hosted/wechat-bridge/bridge.mjs" ] || die "在 $repo 里找不到 hosted/wechat-bridge/bridge.mjs，是不是拿错了代码？"

  umask 077
  mkdir -p "$home_dir/bin" "$data_dir" "$log_dir" "$state_dir"
  chmod 700 "$home_dir" "$home_dir/bin" "$data_dir" "$log_dir" "$state_dir"
  install_wx
  say "wx 版本：$("$wx_bin" --json version | json_get version)（目标 $("$wx_bin" --json version | json_get target)）"

  write_bridge_defaults
  write_plists "$repo" "$node" "$keep_awake"
  say "已写好 launchd 配置：$launch_dir"

  agent_start daemon
  [ "$keep_awake" = 0 ] || agent_start awake
  say "等 wx 守护进程起来……"
  curl -s -o /dev/null --retry 30 --retry-connrefused --retry-delay 1 "$wx_url/v1/" || die "wx 没有起来。看日志：tail -n 30 $log_dir/daemon.log"
  wx_cli accounts list >/dev/null || die "wx 起来了，但令牌对不上。看日志：tail -n 30 $log_dir/daemon.log"
  say "守护进程正常（只听 127.0.0.1:${WX_PORT}，外面连不到）。"
  say ""
  say "下一步：bash $here/set-token.sh"
}

# 被 source 时（测试）不执行 main。
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
