# syntax=docker/dockerfile:1.7
#
# Oro backend image — built with the MONOREPO ROOT as build context
# (npm workspaces hoist deps to the root `node_modules`).
#
#   docker build -t harbor.oro.fun/oro/backend:0.1.0 -f backend/Dockerfile .
#                                                                          ↑
#                                       context = oro-client/ (repo root)

FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache tini python3 make g++

# ── deps: install ALL workspaces from root lockfile ─────────────────────────
# We need the backend workspace deps (incl. dev for build & migrations).
# Using `npm ci` at root → npm hoists workspace deps to /app/node_modules.
FROM base AS deps
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --no-audit --no-fund

# ── builder: tsc → backend/dist/ ────────────────────────────────────────────
FROM deps AS builder
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
RUN npm run build -w backend

# ── runtime ────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000

RUN addgroup -S oro && adduser -S oro -G oro -u 1000

# Workspace + manifests
COPY --chown=1000:1000 package.json package-lock.json ./
COPY --chown=1000:1000 backend/package.json backend/tsconfig.json ./backend/
# Hoisted node_modules from deps stage
COPY --chown=1000:1000 --from=deps /app/node_modules ./node_modules
# Compiled backend
COPY --chown=1000:1000 --from=builder /app/backend/dist ./backend/dist
# typeorm CLI needs the source data-source + migrations at runtime
COPY --chown=1000:1000 backend/src/data-source.ts  ./backend/src/data-source.ts
COPY --chown=1000:1000 backend/src/migrations     ./backend/src/migrations

WORKDIR /app/backend
USER 1000
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
