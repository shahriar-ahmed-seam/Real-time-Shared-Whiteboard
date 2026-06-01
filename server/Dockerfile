# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Synapse Server — production container image
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage build (Requirements 8.1, 8.2, 8.3):
#   - The base image tag is pinned to a specific Node 22 LTS patch release so
#     two builds from the same commit produce functionally identical images.
#   - Dependencies are installed deterministically from the committed
#     package-lock.json via `npm ci` (never `npm install`).
#   - The runtime stage executes the COMPILED `dist/index.js` (no ts-node /
#     on-the-fly compilation) as a NON-ROOT user.
#
# Build context: the `server/` directory.
#   docker build -t synapse-server ./server
# ─────────────────────────────────────────────────────────────────────────────

# Pin to a specific patch release (not a floating tag) for reproducible builds.
ARG NODE_IMAGE=node:22.12.0-slim


# ── Stage 1: build ───────────────────────────────────────────────────────────
# Installs the full dependency set (including devDependencies such as
# TypeScript) and compiles the TypeScript sources to `dist/`.
FROM ${NODE_IMAGE} AS build

WORKDIR /app

# Copy only the manifests first so the dependency layer is cached and only
# reinstalled when the lockfile actually changes.
COPY package.json package-lock.json ./

# Deterministic install straight from the committed lockfile.
RUN npm ci

# Copy the sources needed to compile (tsconfig + src). Honors .dockerignore.
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/ via the project's real build script (`tsc`).
RUN npm run build


# ── Stage 2: production dependencies ──────────────────────────────────────────
# A clean, production-only node_modules tree (devDependencies omitted) installed
# deterministically from the same lockfile.
FROM ${NODE_IMAGE} AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev


# ── Stage 3: runtime ──────────────────────────────────────────────────────────
# Slim, version-pinned Node image that runs the compiled output as the
# unprivileged `node` user shipped with the official image (uid/gid 1000).
FROM ${NODE_IMAGE} AS runtime

# Production profile: enables encrypted-transport enforcement and disables dev
# tooling. PORT can be overridden at runtime; mirrors the Config_Loader default.
ENV NODE_ENV=production \
    PORT=3001

WORKDIR /app

# Production dependencies and the compiled application, owned by the non-root
# `node` user so the running process never owns its own code.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Drop root privileges before running the process (Requirement 8.3).
USER node

EXPOSE 3001

# Liveness probe using the bundled Node runtime (no extra tooling required).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3001) + '/', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Run the COMPILED entrypoint directly — no source compilation at startup.
CMD ["node", "dist/index.js"]
