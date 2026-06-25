# syntax=docker/dockerfile:1

# Ink — Lorcana deck builder. Tiny Express app: static frontend + a few proxy
# endpoints. No build step, so a single lean stage is plenty.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    # corepack would otherwise prompt before downloading pnpm on first use
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

# pnpm is provided by corepack; the exact version is pinned by package.json's
# "packageManager" field so installs are reproducible.
RUN corepack enable

# Install production deps first so this layer is cached unless the manifest
# or lockfile changes.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Application source (cache/ is intentionally NOT copied — the server fetches
# cards.db / prices.db from dreamborn.ink into it on boot; see .dockerignore).
COPY server.js ./
COPY public ./public

# The runtime cache directory must be writable by the unprivileged "node" user
# (shipped in the official image). Expose it as a volume so the downloaded
# SQLite DBs survive container restarts.
RUN mkdir -p /app/cache && chown -R node:node /app
VOLUME ["/app/cache"]

USER node
EXPOSE 3000

# Liveness probe — /api/ai/config responds without any external network calls.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ai/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
