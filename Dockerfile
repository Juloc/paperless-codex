FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.151.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && mv /usr/local/bin/codex /usr/local/bin/codex-real

WORKDIR /app
COPY server.mjs ./server.mjs
COPY codex-wrapper.mjs /usr/local/bin/codex
RUN chmod 0755 /usr/local/bin/codex \
    && mkdir -p /data/codex /data/state /tmp/paperless-codex \
    && chown -R node:node /data /tmp/paperless-codex /app

ENV NODE_ENV=production \
    PORT=8080 \
    CODEX_HOME=/data/codex \
    CODEX_WORKDIR=/tmp/paperless-codex \
    STATE_DIR=/data/state

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
