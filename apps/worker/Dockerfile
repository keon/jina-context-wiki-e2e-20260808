FROM mirror.gcr.io/library/node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @jina/worker... build \
  && pnpm --filter @jina/worker deploy --prod --legacy /out

FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["dist/server.js"]
