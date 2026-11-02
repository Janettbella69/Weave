#!/usr/bin/env bash
# 第一次部署前在服务器上跑一次：生成本目录的 .env、web.env、agent.env（权限 600）。
# 已经有了就不覆盖：WEAVE_ENCRYPTION_KEY 一换，之前存进去的钥匙就解不开了。
set -euo pipefail
cd "$(dirname "$0")"
for f in .env web.env agent.env; do
  if [ -e "$f" ]; then echo "已经有 $f 了，没有覆盖。要重来，先自己备份再删掉。"; exit 1; fi
done
read -r -p "你的邮箱（单用户模式用它当身份）：" email
read -r -p "你的名字（页面上显示）：" name
read -r -s -p "DeepSeek API Key（输入时不显示）：" deepseek; echo
if [ -z "$email" ] || [ -z "$deepseek" ]; then echo "邮箱和 DeepSeek Key 都要填。"; exit 1; fi

docker_gid=$(stat -c %g /var/run/docker.sock)
bind_ip=$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)
if [ -z "$bind_ip" ]; then echo "找不到 docker0 的地址。"; exit 1; fi
data_dir="$HOME/weave-data/agent"
mkdir -p "$data_dir"
password=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 20)
token=$(openssl rand -hex 24)

umask 077
cat > .env <<EOF
HOST_UID=$(id -u)
HOST_GID=$(id -g)
DOCKER_GID=$docker_gid
WEAVE_BIND_IP=$bind_ip
WEAVE_AGENT_DATA=$data_dir
EOF
cat > web.env <<EOF
WEAVE_ENCRYPTION_KEY=$(openssl rand -hex 32)
WEAVE_VPS_MODE=true
WEAVE_VPS_USER_ID=$email
WEAVE_VPS_EMAIL=$email
WEAVE_VPS_NAME=$name
WEAVE_BASIC_AUTH=weave:$password
WEAVE_AGENT_RUNTIME=sdk
AGENT_SERVICE_TOKEN=$token
AGENT_PROVIDER_API_KEY=$deepseek
EOF
cat > agent.env <<EOF
AGENT_SERVICE_TOKEN=$token
DEEPSEEK_API_KEY=$deepseek
EOF
echo
echo "配置写好了。打开网站时浏览器会问账号密码："
echo "  账号：weave"
echo "  密码：$password"
echo "（记到密码管理器里。以后忘了可以在 web.env 的 WEAVE_BASIC_AUTH 里看到。）"
