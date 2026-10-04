# RupAI backend image (P0.08). Two targets:
#
#   runtime  the API: compiled JavaScript + production dependencies only, runs as the `node` user
#   tools    the full toolchain (Prisma CLI, tsx): migrations and seeds, run once per deploy
#
#   docker build --target runtime -t rupai-api .
#   docker build --target tools   -t rupai-tools .
#
# Configuration comes from the environment only (src/config/env.ts); no .env file is baked in.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- dependencies + generated Prisma client -------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV PRISMA_HIDE_UPDATE_MESSAGE=1 HUSKY=0
# The Prisma CLI's schema engine (migrations) needs OpenSSL, which the slim image lacks.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
# Only the schema: postinstall runs `prisma generate` from it. Migrations and seeds come later, so
# changing them never invalidates this (slow, network-bound) layer.
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci --no-audit --no-fund

# ---- tools: build, migrate, seed -------------------------------------------------------------------
FROM deps AS tools
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY package.json package-lock.json ./
# --ignore-scripts: postinstall would run the Prisma CLI, which is a dev dependency. Nothing in the
# runtime needs an install script (argon2 is prebuilt, the MariaDB driver is pure JavaScript).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=tools /app/dist ./dist
ARG APP_VERSION=0.0.0-dev
ARG BUILD_COMMIT=unknown
ENV APP_VERSION=${APP_VERSION} BUILD_COMMIT=${BUILD_COMMIT}
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
