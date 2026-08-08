# Build on the same Node major the runtime stage uses so compiled output and
# native/optional dependencies are installed under the version that runs them.
FROM mirror.gcr.io/library/node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN npm install -g pnpm@11.15.1

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @jina/api... build \
  && pnpm --filter @jina/api deploy --prod --legacy /out \
  && test -f /out/dist/product/migrate-all.js \
  && test -f /out/product-migrations/0037_collapse_context_schema.sql

FROM mirror.gcr.io/library/node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /out ./
COPY --chown=node:node scripts/context-production-preflight.mjs /opt/jina/context-production-preflight.mjs

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node
ENTRYPOINT ["node"]
CMD ["dist/dev-server.js"]
