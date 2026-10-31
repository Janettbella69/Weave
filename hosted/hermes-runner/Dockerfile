FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.15 /uv /uvx /usr/local/bin/
WORKDIR /app
COPY requirements.txt ./
RUN uv venv --python 3.14 .venv && uv pip install --python .venv/bin/python -r requirements.txt
COPY assess.py runner.mjs package.json ./
RUN mkdir /app/.data && chown -R node:node /app
USER node
ENV NODE_ENV=production HERMES_DATA_DIR=/app/.data
CMD ["npm","start"]
