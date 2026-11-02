#!/usr/bin/env bash
# 把 weave.azorashopping.site 的转发加进 Azora 的 nginx：只在 nginx.conf 末尾追加两个 server 块，别的一行不动。
# 先备份，再用正在跑的 nginx 检查：通过才重载（不中断访问）；不通过就原样恢复、不重载，Azora 不受影响。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
azora="${AZORA_DIR:-$HOME/AIAzora-v3}"
conf="$azora/nginx.conf"
compose=(docker compose -f "$azora/docker-compose.prod.yml")

if grep -q "server_name weave.azorashopping.site" "$conf"; then
  echo "nginx 里已经有 weave 了，没有改动。"
  exit 0
fi

# nginx 容器挂的是这个文件本身（单文件挂载）。文件要是被整个替换过（sed -i、编辑器、git checkout），
# 容器还在读旧的那份，这时改磁盘上的文件不会生效，下次重启才会加载一份没检查过的配置。所以先对一下。
live() { "${compose[@]}" exec -T nginx sha256sum /etc/nginx/nginx.conf 2>/dev/null | cut -d' ' -f1; }
if [ "$(sha256sum "$conf" | cut -d' ' -f1)" != "$(live)" ]; then
  echo "正在跑的 nginx 读的不是磁盘上这份 nginx.conf（文件被整个替换过）。没有做任何改动。"
  echo "先停在这里，把这段输出发给 Claude。"
  exit 1
fi

mkdir -p "$HOME/weave-data/nginx-backups"
backup="$HOME/weave-data/nginx-backups/nginx.conf.$(date +%Y%m%d-%H%M%S)"
cp "$conf" "$backup"
echo "已备份：$backup"

# 原地写回（同一个文件）：nginx 容器挂载的是这个文件本身，换成新文件它会看不到。
python3 - "$conf" "$here/weave.nginx.conf" <<'PY'
import sys
conf_path, blocks_path = sys.argv[1], sys.argv[2]
text = open(conf_path, encoding='utf-8').read()
blocks = open(blocks_path, encoding='utf-8').read()
end = text.rstrip().rfind('}')
if end < 0:
    sys.exit('nginx.conf 结尾找不到 }')
updated = text[:end].rstrip('\n') + '\n\n' + blocks.rstrip('\n') + '\n}\n'
with open(conf_path, 'r+', encoding='utf-8') as f:
    f.seek(0)
    f.write(updated)
    f.truncate()
PY

if ! "${compose[@]}" exec -T nginx grep -q "server_name weave.azorashopping.site" /etc/nginx/nginx.conf; then
  cat "$backup" > "$conf"
  echo "nginx 容器没看到新配置，已恢复原来的配置，没有重载。先停在这里，把这段输出发给 Claude。"
  exit 1
fi

if "${compose[@]}" exec -T nginx nginx -t; then
  "${compose[@]}" exec -T nginx nginx -s reload
  echo "已加上 weave，nginx 已重载。"
else
  cat "$backup" > "$conf"
  echo "nginx 检查没通过，已恢复原来的配置，没有重载，Azora 不受影响。"
  exit 1
fi
