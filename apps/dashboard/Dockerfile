FROM mirror.gcr.io/library/node:26-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace

RUN npm install -g pnpm@11.15.1

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @jina/dashboard... build

FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /app
# Next.js standalone output contains the monorepo layout plus a pruned
# node_modules; static assets are copied next to the embedded server.
COPY --from=build --chown=nonroot:nonroot /workspace/apps/dashboard/.next/standalone ./
COPY --from=build --chown=nonroot:nonroot /workspace/apps/dashboard/.next/static ./apps/dashboard/.next/static

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
EXPOSE 8080

CMD ["apps/dashboard/server.js"]
