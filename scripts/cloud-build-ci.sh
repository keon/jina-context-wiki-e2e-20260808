#!/usr/bin/env bash
set -euo pipefail

corepack enable
corepack prepare pnpm@11.15.1 --activate

pnpm install --frozen-lockfile --store-dir=/tmp/pnpm-store
pnpm typecheck
pnpm lint
pnpm test
pnpm evaluate:context
pnpm audit --prod --audit-level=high

# Cloud Build deploys these exact-SHA Cloud Run bundles with the backend and
# verifies them independently before it builds the container images.
pnpm --filter @jina/dashboard build
pnpm --filter @jina/admin build
