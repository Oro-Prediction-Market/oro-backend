# syntax=docker/dockerfile:1.7
#
# Oro backend (NestJS) — standalone repo. Bun for install + build, Node for runtime.
#
#   docker build -t harbor.oro.fun/oro/backend:0.1.0 .

# ── deps + build with Bun ───────────────────────────────────────────────────
# Pinned, not floating.
#
# `oven/bun:1.3-alpine` moved to bun 1.3.14, which fails to extract typeorm's
# tarball — "error: Fail extracting tarball for typeorm" — killing both local
# and CI builds with no change on our side. Reproduced in a clean container on
# 1.3.14 and confirmed working on 1.2.
#
# Before bumping this, run: bun install against this package.json in a clean
# container and check typeorm actually lands in node_modules.
FROM oven/bun:1.2-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Bun reads bun.lock if present, falls back to yarn.lock or package-lock.json.
# We copy whichever the repo has.
COPY package.json ./
COPY bun.lock* yarn.lock* package-lock.json* ./
RUN bun install

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# tsconfig.build.json, not tsconfig.json: the base config includes the test
# suite, so one stale spec file failed `tsc` and took the image build with it.
RUN bun run build

# ── runtime: Node 20 ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

RUN apk add --no-cache tini
# Reuse the `node` user that the base image already ships (UID 1000).

COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
# Compiled migrations live in dist/migrations/. They are NOT run at startup —
# `migrationsRun` is false, because several replicas booting together would
# race each other. The deploy workflow runs them once as a Job on this image:
#   node node_modules/typeorm/cli.js migration:run -d dist/data-source.js
# which is why node_modules is kept whole rather than pruned to production.

USER node
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
