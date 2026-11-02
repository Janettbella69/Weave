# Image for the legacy /query path (removed in step 2). /wake with AGENT_ISOLATION=docker starts
# a container per wake, so run that service on the host instead (see README.md).
FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
COPY mcp ./mcp
COPY plugin ./plugin
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4320
USER node
EXPOSE 4320
CMD ["npm","start"]
