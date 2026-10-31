FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY runtime.mjs server.mjs ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4320
USER node
EXPOSE 4320
CMD ["npm","start"]
