#!/usr/bin/env bash
# 共用的小函数，给同目录的脚本 source，不单独运行。macOS 自带的 bash 是 3.2，所以不用新语法。
#
# 路径都可以用环境变量改（测试用，平时不用管）：
#   WEAVE_WECHAT_HOME        数据和配置放哪，默认 ~/.weave-wechat
#   WEAVE_WECHAT_LAUNCH_DIR  launchd 的 plist 放哪，默认 ~/Library/LaunchAgents
#   WEAVE_WECHAT_LABEL       launchd 任务名前缀，默认 com.weave.wechat
#   WEAVE_WECHAT_PORT        守护进程只听 127.0.0.1 的哪个端口，默认 6179（避开 agent-wechat 默认的 6174，免得和桌面版撞车）

# agent-wechat 的版本和 macOS Apple 芯片版的 SHA-256。升级时两个一起改，并且先跑 scripts/agent-wechat-e2e。
# 校验值来自 https://github.com/thisnick/agent-wechat/releases/download/v1.3.3/wx-v1.3.3-checksums.json
WX_VERSION=1.3.3
WX_SHA256_DARWIN_ARM64=64d9098cbe329069f73b0ddecc22c6e57d388f2c47b593412d9dc80d15fcc394

WEAVE_ORIGIN_DEFAULT=https://weave.azorashopping.site
WX_PORT="${WEAVE_WECHAT_PORT:-6179}"

home_dir="${WEAVE_WECHAT_HOME:-$HOME/.weave-wechat}"
launch_dir="${WEAVE_WECHAT_LAUNCH_DIR:-$HOME/Library/LaunchAgents}"
label_prefix="${WEAVE_WECHAT_LABEL:-com.weave.wechat}"
wx_bin="$home_dir/bin/wx"
data_dir="$home_dir/data"
log_dir="$home_dir/logs"
state_dir="$home_dir/state"
bridge_env="$home_dir/bridge.env"
wx_url="http://127.0.0.1:$WX_PORT"

# 对本机守护进程（127.0.0.1）的调用不该走代理。curl 和 wx 都会照 shell 里的 http_proxy / https_proxy / all_proxy 办事，
# 而 curl 不会自己放过 127.0.0.1，守护进程明明在跑也会被报成连不上。系统设置里的代理它们都不看。
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# 微信的服务器域名现在解析到哪个 IPv4。WEAVE_WECHAT_FAKE_DNS_IP 只给测试用。
resolve_ipv4() {
  if [ -n "${WEAVE_WECHAT_FAKE_DNS_IP:-}" ]; then printf '%s' "$WEAVE_WECHAT_FAKE_DNS_IP"; return 0; fi
  node -e 'require("node:dns").lookup(process.argv[1],{family:4},(e,a)=>process.stdout.write(e?"":a))' "$1" 2>/dev/null || true
}
# 代理软件的虚拟 IP 模式（TUN + fake-ip，Clash 一类）会把每个域名解析成 198.18.x.x，再由它转发。wx 不能设代理，
# 但会被它悄悄带上：微信看到的是代理的出口，不是家里的网络。解析到 198.18/15 就返回 0；解析不出来、或是真 IP 就返回 1。
proxy_fake_ip() {
  case "$(resolve_ipv4 long.weixin.qq.com)" in 198.18.*|198.19.*) return 0 ;; esac
  return 1
}

# 对 agent-wechat 守护进程说话：固定带上地址和令牌文件，输出是 JSON。
wx_cli() { "$wx_bin" --json --server "$wx_url" --token-file "$data_dir/api-token" "$@"; }

# 从标准输入读 JSON，打印其中一个字段（点号分隔的路径）。读不到就什么都不打印。
json_get() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];if(v!==undefined&&v!==null)process.stdout.write(String(v));}catch{}})' "$1"
}

# env 文件里设一个值：有就换掉，没有就加在最后，别的行原样不动；整个文件原子替换，权限 600。
# 值只在 shell 变量里传，不进命令行参数，所以 ps 看不到，也不会被打印。
env_set() {
  local file="$1" key="$2" value="$3" tmp line found=0
  mkdir -p "$(dirname "$file")"
  tmp=$(umask 077; mktemp "$file.XXXXXX")
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$key="*) if [ "$found" = 0 ]; then printf '%s=%s\n' "$key" "$value" >> "$tmp"; found=1; fi ;;
        *) printf '%s\n' "$line" >> "$tmp" ;;
      esac
    done < "$file"
  fi
  [ "$found" = 1 ] || printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# 读 env 文件里的一个值；没有就是空。
env_get() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$key="*) printf '%s' "${line#"$key="}"; return 0 ;; esac
  done < "$file"
}

# ── launchd ──────────────────────────────────────────────────────────────────────────────
launch_domain() { printf 'gui/%s' "$(id -u)"; }
label_of() { printf '%s.%s' "$label_prefix" "$1"; }          # daemon / bridge / awake
plist_of() { printf '%s/%s.plist' "$launch_dir" "$(label_of "$1")"; }
# WEAVE_WECHAT_NO_LAUNCHD=1：一概不碰 launchd（测试用）。
agent_loaded() { [ "${WEAVE_WECHAT_NO_LAUNCHD:-}" = 1 ] && return 1; launchctl print "$(launch_domain)/$(label_of "$1")" >/dev/null 2>&1; }
agent_start() {   # 没加载就加载；已经加载就重启，让新配置生效
  [ "${WEAVE_WECHAT_NO_LAUNCHD:-}" = 1 ] && { say "（没有碰 launchd：$1）"; return 0; }
  if agent_loaded "$1"; then launchctl kickstart -k "$(launch_domain)/$(label_of "$1")" >/dev/null
  else launchctl bootstrap "$(launch_domain)" "$(plist_of "$1")"; fi
}
agent_stop() { if agent_loaded "$1"; then launchctl bootout "$(launch_domain)/$(label_of "$1")" 2>/dev/null || true; fi; }

# 把 & < > 换成 XML 的写法（先换 &）。用 sed，不用 ${s//</&lt;}：bash 5.2 起 patsub_replacement 默认打开，替换串里没加引号的 &
# 会被换成「匹配到的字符」，${s//</&lt;} 就写出 "<lt;"；macOS 自带的 bash 3.2 没有这个选项，所以只在 Linux 上错。
# sed 里 \& 是字面的 &，GNU 和 BSD 的 sed 一样；LC_ALL=C 让它按字节处理，路径里有中文也原样放过。
xml_escape() { printf '%s' "$1" | LC_ALL=C sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# 生成 plist。参数：label、日志文件、工作目录（可空）、然后是命令和参数。
plist_text() {
  local label="$1" log="$2" cwd="$3" arg; shift 3
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0">' '<dict>'
  printf '  <key>Label</key><string>%s</string>\n' "$(xml_escape "$label")"
  printf '  <key>ProgramArguments</key>\n  <array>\n'
  for arg in "$@"; do printf '    <string>%s</string>\n' "$(xml_escape "$arg")"; done
  printf '  </array>\n'
  [ -z "$cwd" ] || printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$(xml_escape "$cwd")"
  printf '  <key>RunAtLoad</key><true/>\n'
  # 退出就重启，但至少隔 30 秒：配置不对时不会一秒钟重启几十次。
  printf '  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>30</integer>\n'
  printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$log")"
  printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$log")"
  printf '</dict>\n</plist>\n'
}

# 桥接的固定配置（不含密钥）。没有就建，有就只补缺的，不动已有的值。
write_bridge_defaults() {
  local origin="${WEAVE_ORIGIN:-$WEAVE_ORIGIN_DEFAULT}"
  [ -f "$bridge_env" ] || {
    (umask 077; cat > "$bridge_env" <<EOT
# 微信桥接的配置（权限 600，别发给任何人）。WECHAT_BRIDGE_TOKEN 由 set-token.sh 写，WX_TOKEN 和 WX_ACCOUNT 由 login.sh 写。
# 发送上限（默认值是保守的猜测，微信的风控规则没有公开数据）。要改就取消注释：
# WECHAT_SEND_PER_CHAT_PER_MIN=6
# WECHAT_SEND_TOTAL_PER_MIN=12
# WECHAT_SEND_PER_DAY=200
# WECHAT_SEND_MIN_GAP_MS=1500
EOT
    )
  }
  [ -n "$(env_get "$bridge_env" WEAVE_ORIGIN)" ] || env_set "$bridge_env" WEAVE_ORIGIN "$origin"
  [ -n "$(env_get "$bridge_env" WX_BASE_URL)" ] || env_set "$bridge_env" WX_BASE_URL "$wx_url/v1"
  [ -n "$(env_get "$bridge_env" WEAVE_TICK)" ] || env_set "$bridge_env" WEAVE_TICK 1
  [ -n "$(env_get "$bridge_env" WECHAT_BRIDGE_STATE)" ] || env_set "$bridge_env" WECHAT_BRIDGE_STATE "$state_dir/cursor.json"
}

# 三个 launchd 任务的 plist。repo 是本仓库的绝对路径，node 是 node 的绝对路径。
write_plists() {
  local repo="$1" node="$2" keep_awake="${3:-0}"
  mkdir -p "$launch_dir" "$log_dir"
  plist_text "$(label_of daemon)" "$log_dir/daemon.log" "" "$wx_bin" serve --data-dir "$data_dir" --listen "127.0.0.1:$WX_PORT" > "$(plist_of daemon)"
  plist_text "$(label_of bridge)" "$log_dir/bridge.log" "$repo/hosted/wechat-bridge" "$node" "--env-file=$bridge_env" "$repo/hosted/wechat-bridge/bridge.mjs" > "$(plist_of bridge)"
  if [ "$keep_awake" = 1 ]; then
    # 插着电时不让这台 Mac 睡着（屏幕仍然可以熄）。合上笔记本盖子还是会睡。
    plist_text "$(label_of awake)" "$log_dir/awake.log" "" /usr/bin/caffeinate -s > "$(plist_of awake)"
  fi
  if command -v plutil >/dev/null 2>&1; then
    local f; for f in daemon bridge awake; do [ ! -f "$(plist_of $f)" ] || plutil -lint "$(plist_of $f)" >/dev/null || die "生成的 $(plist_of $f) 格式不对。"; done
  fi
}
