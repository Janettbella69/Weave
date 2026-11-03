#!/usr/bin/env bash
# 手动对服务器上的 wx 守护进程下命令用：在 wx 容器里跑 wx，自动带上地址和主令牌文件（令牌不离开容器），参数原样交给 wx。
# 例（在你 Mac 的终端里）：
#   ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/wx.sh --json accounts list'
#   ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/wx.sh --json --account weave account settings'
# 注意：有的命令会打印密钥（比如 tokens create），那是你自己要的，别贴给别人。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

refuse_root
need docker
container_running "$wx_container" || die "wx 守护进程没在跑：先跑 bash $here/up.sh"
# 有终端就给容器也开一个（能按 Ctrl-C、能画二维码），没有就不开。
if [ -t 0 ] && [ -t 1 ]; then
  exec docker exec -it "$wx_container" wx --server "$wx_url" --token-file "$wx_token_in_container" "$@"
fi
exec docker exec "$wx_container" wx --server "$wx_url" --token-file "$wx_token_in_container" "$@"
