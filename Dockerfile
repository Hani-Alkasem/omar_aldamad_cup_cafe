# syntax=docker/dockerfile:1.7
#
# One multi-target build for the monorepo:
#   docker build --target api        -t itam/api .         API (NestJS)          :4000
#   docker build --target dispatcher -t itam/dispatcher .  webhook dispatcher    (no port)
#   docker build --target web        -t itam/web .         Next.js               :3000
#   docker build --target worker     -t itam/worker .      discovery worker      (no port)
#   docker build --target lab        -t itam/lab .         lab simulator (demo only)
#
# Behind a TLS-intercepting proxy, pass its CA so npm and pnpm can fetch (proxy URLs go in HTTPS_PROXY build args):
#   docker build --secret id=ca,src=/path/to/ca.pem ...

ARG NODE_IMAGE=node:22.11.0-bookworm-slim
ARG NODE_FULL_IMAGE=node:22.11.0-bookworm

# OpenSSL 3 for Prisma's query engine, taken from the full image of the same Debian release.
# (Copying two libraries avoids apt in the runtime image: no package mirror needed at build time.)
FROM ${NODE_FULL_IMAGE} AS openssl
RUN mkdir /ssl && cp /usr/lib/*-linux-gnu/libssl.so.3 /usr/lib/*-linux-gnu/libcrypto.so.3 /ssl/

# ─── toolchain ──────────────────────────────────────────────────────────────
# Build stages use the full image: it has OpenSSL 3, so Prisma resolves the same engines the runtime loads.
FROM ${NODE_FULL_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
# An optional proxy CA: used if mounted, ignored otherwise.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm install -g --no-fund --no-audit pnpm@10.11.0
WORKDIR /repo

# ─── dependencies (cached until a manifest or the lockfile changes) ─────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/discovery-worker/package.json apps/discovery-worker/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile

# ─── build everything once ─────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @itam/shared build \
 && pnpm --filter @itam/api build \
 && pnpm --filter @itam/discovery-worker build \
 && pnpm --filter @itam/web build

# Production-only trees per app (workspace deps copied in, dev deps dropped).
FROM build AS deploy
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm --filter @itam/api deploy --prod --legacy /out/api \
 && pnpm --filter @itam/discovery-worker deploy --prod --legacy /out/worker \
 && cd /out/api && node_modules/.bin/prisma generate \
    # Fetch every engine now (query + schema): migrations must not download anything at runtime.
 && node_modules/.bin/prisma version

# ─── runtime base: no compilers, no package manager, non-root ──────────────
FROM ${NODE_IMAGE} AS runtime
# Prisma's query engine links against OpenSSL 3, which the slim image does not ship.
COPY --from=openssl /ssl/ /usr/local/lib/
RUN ldconfig
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=deploy --chown=node:node /out/api ./
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime AS dispatcher
COPY --from=deploy --chown=node:node /out/api ./
ENV DISPATCHER_HEARTBEAT_FILE=/tmp/dispatcher.alive
# Healthy while the delivery loop has turned within the last 30 s.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "const s=require('fs').statSync(process.env.DISPATCHER_HEARTBEAT_FILE);process.exit(Date.now()-s.mtimeMs<30000?0:1)"
CMD ["node", "--enable-source-maps", "dist/dispatcher.js"]

FROM runtime AS worker
COPY --from=deploy --chown=node:node /out/worker ./
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime AS web
# Next's standalone output keeps the monorepo layout: server.js lives under apps/web.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/racks/demo').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# Demo only: the simulator runs from source with the full dev toolchain.
FROM build AS lab
USER node
WORKDIR /repo/apps/discovery-worker
CMD ["node_modules/.bin/tsx", "scripts/lab.ts"]
