FROM mirror.gcr.io/library/node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @jina/worker... build \
  && pnpm --filter @jina/worker deploy --prod --legacy /out

# The runtime needs a git binary for the clone-based ingest transport, which
# distroless cannot provide; slim + git keeps the image close in size.
FROM mirror.gcr.io/library/node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /out ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node

CMD ["node", "dist/server.js"]
