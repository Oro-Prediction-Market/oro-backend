# syntax=docker/dockerfile:1.7
#
# Oro backend (NestJS) — standalone repo. Bun for install + build, Node for runtime.
#
#   docker build -t harbor.oro.fun/oro/backend:0.1.0 .

# ── deps + build with Bun ───────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Bun reads bun.lock if present, falls back to yarn.lock or package-lock.json.
# We copy whichever the repo has.
COPY package.json ./
COPY bun.lock* yarn.lock* package-lock.json* ./
RUN bun install

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# ── runtime: Node 20 ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

RUN apk add --no-cache tini \
    && addgroup -S oro && adduser -S oro -G oro -u 1000

COPY --chown=1000:1000 package.json tsconfig.json ./
COPY --chown=1000:1000 --from=builder /app/node_modules ./node_modules
COPY --chown=1000:1000 --from=builder /app/dist ./dist
# typeorm CLI needs the source data-source + migrations at runtime
COPY --chown=1000:1000 src/data-source.ts ./src/data-source.ts
COPY --chown=1000:1000 src/migrations    ./src/migrations

USER 1000
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
