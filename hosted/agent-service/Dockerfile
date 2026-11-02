# Agent 服务（POST /wake、/forget）。它用宿主的 Docker 给每次唤醒起一个一次性容器（镜像见 Dockerfile.agent），
# 所以运行时要挂 /var/run/docker.sock，数据目录在宿主和容器里用同一个路径（见 deploy/tencent/compose.yml）。
FROM docker:27-cli AS docker-cli

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY *.mjs ./
COPY mcp ./mcp
COPY plugin ./plugin
COPY container/service-entrypoint.sh /usr/local/bin/weave-agent-service
RUN chmod 755 /usr/local/bin/weave-agent-service
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4320
EXPOSE 4320
ENTRYPOINT ["/usr/local/bin/weave-agent-service"]
