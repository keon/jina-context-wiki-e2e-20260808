#!/usr/bin/env bash
set -euo pipefail

readonly prohibited='@jina/context-graph|/context-graph|run-context-graph|context_graph_assert|context_graph_project|query_graph|jina_context_graph|CONTEXT_GRAPH_'

if rg --line-number --ignore-case \
  --glob '!**/*.test.ts' \
  --glob '!**/dist/**' \
  --glob '!docs/**' \
  --glob '!README.md' \
  --glob '!.env.example' \
  --glob '!scripts/check-context-cutover.sh' \
  --glob '!packages/db/src/legacy-context-cutover.ts' \
  "${prohibited}" apps packages scripts; then
  echo "Legacy context runtime vocabulary remains in production source." >&2
  exit 1
fi
