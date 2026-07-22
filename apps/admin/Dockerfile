FROM mirror.gcr.io/library/node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @jina/admin build

FROM mirror.gcr.io/library/node:22-bookworm-slim

WORKDIR /app
COPY --from=build /workspace/apps/admin/.next/standalone ./
COPY --from=build /workspace/apps/admin/.next/static ./apps/admin/.next/static

ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
EXPOSE 8080

USER node
CMD ["node", "apps/admin/server.js"]
