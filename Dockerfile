# Build stage: compile TypeScript with dev dependencies present.
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/service/package.json apps/service/
RUN npm ci

COPY packages/shared packages/shared
COPY apps/service apps/service
RUN npm run build && npm prune --omit=dev

# Runtime stage: no compiler, no source, no dev dependencies.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data

# better-sqlite3 ships a prebuilt binary; tini gives us correct signal handling
# so a stop actually stops rather than waiting for the 10s kill timeout.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/apps/service/dist ./apps/service/dist
COPY --from=build /app/apps/service/package.json ./apps/service/
COPY --from=build /app/package.json ./

# The data volume holds the database and the master key, so it must be writable
# by the unprivileged user the image runs as.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/service/dist/index.js"]
