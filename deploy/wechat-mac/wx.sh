#!/usr/bin/env bash
# 手动对守护进程下命令用：自动带上地址和令牌文件，参数原样交给 wx。
# 例：bash wx.sh --json accounts list     bash wx.sh --account weave account status
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
[ -x "$wx_bin" ] || die "还没装 wx：先跑 bash $here/install.sh"
exec "$wx_bin" --server "$wx_url" --token-file "$data_dir/api-token" "$@"
