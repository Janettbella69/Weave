#!/usr/bin/env bash
# 看一眼现在怎么样：守护进程和桥接有没有在跑、小号登没登录、最近的日志。只读，随时可以跑。
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

show_agent() {   # 名字 说明
  local out pid
  if ! agent_loaded "$1"; then say "$2：没有运行"; return; fi
  out=$(launchctl print "$(launch_domain)/$(label_of "$1")" 2>/dev/null)
  pid=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*pid = \([0-9]*\)$/\1/p' | head -1)
  if [ -n "$pid" ]; then say "$2：运行中（pid ${pid}）"
  else say "$2：已加载但没在跑（上次退出码 $(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*last exit code = \(.*\)$/\1/p' | head -1)），看日志"; fi
}

say "== 进程"
show_agent daemon "wx 守护进程"
show_agent bridge "微信桥接"
if agent_loaded awake; then show_agent awake "插电不睡"; fi

say ""
say "== 微信小号"
if [ ! -x "$wx_bin" ]; then say "还没装 wx。"
elif ! accounts=$(wx_cli accounts list 2>/dev/null); then say "连不上 wx 守护进程。"
else
  printf '%s' "$accounts" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const items=JSON.parse(s).items||[];
      if(!items.length)return console.log("还没有账号，跑 login.sh。");
      for(const a of items)console.log(`${a.alias||a.id}：${a.authenticated?"已登录":"没登录"}，连接 ${a.connection}，收消息方式 ${a.incomingTransport}，待处理批次 ${a.pendingProjectionBatches}`);
    })'
  # 「没登录」的原因只记在守护进程的事件日志里（daemon.log 里没有），所以把最近一条连接事件也摆出来。
  if [ "$(printf '%s' "$accounts" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String((JSON.parse(s).items||[]).length)))' 2>/dev/null)" != 0 ]; then
    say ""
    say "== 最近一次连接事件（微信那头最近说了什么；不含消息内容）"
    if last=$(node "$here/last-connection-event.mjs" "$wx_bin" "$wx_url" "$data_dir/api-token" weave 2>/dev/null); then
      if [ -n "$last" ]; then say "$last"; else say "（还没有）"; fi
    else
      say "（读不到）"
    fi
  fi
fi

for name in daemon bridge; do
  say ""
  say "== 最近的日志：$log_dir/$name.log"
  if [ -f "$log_dir/$name.log" ]; then tail -n 6 "$log_dir/$name.log"; else say "（还没有）"; fi
done
