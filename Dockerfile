FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.151.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && mv /usr/local/bin/codex /usr/local/bin/codex-real

WORKDIR /app
COPY server-v3.mjs ./server.mjs
COPY patch-pipeline3.mjs ./patch-pipeline3.mjs
COPY patch-pipeline4.mjs ./patch-pipeline4.mjs
COPY patch-pipeline5.mjs ./patch-pipeline5.mjs
COPY patch-pipeline6.mjs ./patch-pipeline6.mjs
COPY patch-pipeline7.mjs ./patch-pipeline7.mjs
COPY patch-pipeline8.mjs ./patch-pipeline8.mjs
COPY patch-pipeline9.mjs ./patch-pipeline9.mjs
COPY patch-pipeline10.mjs ./patch-pipeline10.mjs
COPY patch-pipeline11.mjs ./patch-pipeline11.mjs
COPY patch-pipeline12.mjs ./patch-pipeline12.mjs
COPY patch-pipeline13.mjs ./patch-pipeline13.mjs
COPY patch-pipeline14.mjs ./patch-pipeline14.mjs
COPY patch-pipeline15.mjs ./patch-pipeline15.mjs
COPY patch-pipeline16.mjs ./patch-pipeline16.mjs
COPY patch-pipeline17.mjs ./patch-pipeline17.mjs
COPY patch-pipeline18.mjs ./patch-pipeline18.mjs
COPY patch-pipeline19.mjs ./patch-pipeline19.mjs
COPY patch-pipeline20.mjs ./patch-pipeline20.mjs
COPY patch-pipeline21.mjs ./patch-pipeline21.mjs
COPY ui-server.mjs ./ui-server.mjs
COPY paperless-codex.user.js ./paperless-codex.user.js
COPY ui-v2.html ./ui.html
COPY codex-wrapper.mjs /usr/local/bin/codex
RUN node ./patch-pipeline3.mjs \
    && node ./patch-pipeline4.mjs \
    && node ./patch-pipeline5.mjs \
    && node ./patch-pipeline6.mjs \
    && node ./patch-pipeline7.mjs \
    && node ./patch-pipeline8.mjs \
    && node ./patch-pipeline9.mjs \
    && node ./patch-pipeline10.mjs \
    && node ./patch-pipeline11.mjs \
    && node ./patch-pipeline12.mjs \
    && node ./patch-pipeline13.mjs \
    && node ./patch-pipeline14.mjs \
    && node ./patch-pipeline15.mjs \
    && node ./patch-pipeline16.mjs \
    && node ./patch-pipeline17.mjs \
    && node ./patch-pipeline18.mjs \
    && node ./patch-pipeline19.mjs \
    && node ./patch-pipeline20.mjs \
    && node ./patch-pipeline21.mjs \
    && node --check ./server.mjs \
    && node --check ./ui-server.mjs \
    && node --check ./paperless-codex.user.js \
    && rm ./patch-pipeline3.mjs ./patch-pipeline4.mjs ./patch-pipeline5.mjs ./patch-pipeline6.mjs ./patch-pipeline7.mjs ./patch-pipeline8.mjs ./patch-pipeline9.mjs ./patch-pipeline10.mjs ./patch-pipeline11.mjs ./patch-pipeline12.mjs ./patch-pipeline13.mjs ./patch-pipeline14.mjs ./patch-pipeline15.mjs ./patch-pipeline16.mjs ./patch-pipeline17.mjs ./patch-pipeline18.mjs ./patch-pipeline19.mjs ./patch-pipeline20.mjs ./patch-pipeline21.mjs ./paperless-codex.user.js \
    && chmod 0755 /usr/local/bin/codex \
    && mkdir -p /data/codex /data/state /tmp/paperless-codex \
    && chown -R node:node /data /tmp/paperless-codex /app

ENV NODE_ENV=production \
    PORT=8080 \
    INNER_PORT=8081 \
    CODEX_HOME=/data/codex \
    CODEX_WORKDIR=/tmp/paperless-codex \
    STATE_DIR=/data/state \
    PAPERLESS_CODEX_VERSION=0.2.8 \
    PAPERLESS_CODEX_PIPELINE_VERSION=21

USER node
EXPOSE 8080
CMD ["node", "ui-server.mjs"]