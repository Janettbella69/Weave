#!/usr/bin/env bash
# iLink 测试程序（probe.mjs）的共用小函数和名字，给同目录的脚本 source，不单独运行。
# 只碰自己的容器 ilink-probe 和卷 ilink-probe-data，不碰 weave、wechat、Azora 的任何容器和卷。
# 测试在 Mac 上跑（macOS 自带 bash 3.2），所以不用新语法。这里的变量给 source 它的脚本用：
# shellcheck disable=SC2034

# 和微信桥接用同一个 Node 镜像（deploy/tencent/wechat/lib.sh 的 BRIDGE_IMAGE）：服务器上已经有，不用再下载。测试会核对两边一样。
IMAGE=node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
CONTAINER=ilink-probe
VOLUME=ilink-probe-data
probe_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
settle_seconds="${PROBE_SETTLE_SECONDS:-3}"
case "$settle_seconds" in ''|*[!0-9]*) settle_seconds=3 ;; esac

# 每次 docker run 都带的：不给任何特权、根目录只读、用镜像里的 node 用户。数据卷挂在 node 的家目录
# （新卷会照搬镜像里这个目录的属主，所以 node 能写），程序从这个目录只读挂进去。
flags=(--init --user node --read-only --cap-drop ALL --security-opt no-new-privileges:true
  -v "$VOLUME:/home/node" -v "$probe_dir:/app:ro" -e PROBE_DATA=/home/node)

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
# 有没有能显示二维码、能输入的终端（ssh -t 才有）。PROBE_TTY=1 给测试用。
interactive() { [ "${PROBE_TTY:-}" = 1 ] || { [ -t 0 ] && [ -t 1 ]; }; }
refuse_root() { [ "$(id -u)" != 0 ] || die "别用 root 或 sudo 跑，用平时登录的用户就行。什么都没改。"; }
need_docker() { command -v docker >/dev/null 2>&1 || die "这台机器上没有 docker。什么都没改。"; }

running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }
exists() { docker inspect "$CONTAINER" >/dev/null 2>&1; }
has_data() { docker volume inspect "$VOLUME" >/dev/null 2>&1; }
has_account() { docker run --rm "${flags[@]}" "$IMAGE" test -f /home/node/account.json >/dev/null 2>&1; }
probe_status() { docker run --rm "${flags[@]}" --tmpfs /tmp:rw,noexec,nosuid,size=8m "$IMAGE" node /app/probe.mjs status; }
