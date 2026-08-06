#!/usr/bin/env bash
set -euo pipefail

corepack enable
corepack prepare pnpm@11.15.1 --activate

pnpm install --frozen-lockfile --store-dir=/tmp/pnpm-store
pnpm typecheck
pnpm lint
if [[ -n "${DATABASE_URL:-}" ]]; then
  pnpm --filter @jina/api build
  # Runtime migrations must run before product ones (0030 depends on them).
  pnpm --filter @jina/api exec node dist/product/migrate-all.js
  unset DATABASE_URL
fi
pnpm test
pnpm audit --prod --audit-level=high

# Cloud Build deploys these exact-SHA Cloud Run bundles with the backend and
# verifies them independently before it builds the container images.
pnpm --filter @jina/dashboard build
pnpm --filter @jina/admin build
