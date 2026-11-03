FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts/clean.mjs ./scripts/clean.mjs
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/data/agent-crew.sqlite
ENV LOCK_PATH=/data/controller.lock
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/start.mjs ./scripts/start.mjs
RUN mkdir /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "scripts/start.mjs"]
