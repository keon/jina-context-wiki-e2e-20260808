#!/usr/bin/env bash
# Stop the local stack started by scripts/dev-up.sh.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${JINA_DEV_CONTAINER:-jina-dev-postgres}"
LOG_DIR=/tmp/jina-dev

# Recorded pids first, then anything still running from this checkout. A pid
# file can be stale -- it survives a crash, and a reused pid kills the wrong
# process -- and a worker that outlives its API holds the old token, fails every
# claim with a 401, and keeps the port its replacement needs.
for name in api worker; do
  pid_file="$LOG_DIR/$name.pid"
  [[ -f "$pid_file" ]] || continue
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && echo "stopped $name ($pid)"
  rm -f "$pid_file"
done
for pattern in "$REPO/apps/api/dist/dev-server.js" "$REPO/apps/worker/dist/server.js"; do
  pkill -f "$pattern" 2>/dev/null && echo "stopped stray $(basename "$(dirname "$(dirname "$pattern")")")"
done

docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "removed $CONTAINER"
rm -f /tmp/jina-dev.env
echo "down. logs remain in $LOG_DIR"
