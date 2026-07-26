#!/usr/bin/env bash
set -euo pipefail

corepack enable
corepack prepare pnpm@11.15.1 --activate

pnpm install --frozen-lockfile --store-dir=/tmp/pnpm-store
bash scripts/check-context-cutover.sh
pnpm typecheck
pnpm lint
pnpm test
pnpm evaluate:context
pnpm audit --prod --audit-level=high

# Vercel owns these deployments, but Cloud Build still verifies that both
# production Next.js bundles compile before a change can reach main.
pnpm --filter @jina/dashboard build
pnpm --filter @jina/admin build
