#!/usr/bin/env bash
# Stop only the local stack recorded by scripts/dev-up.sh.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/dev-process-lib.sh
source "$REPO/scripts/dev-process-lib.sh"
CONTAINER="${JINA_DEV_CONTAINER:-jina-dev-postgres}"
STATE_DIR="${JINA_DEV_STATE_DIR:-/tmp/jina-dev}"
ENV_FILE="${JINA_DEV_ENV_FILE:-/tmp/jina-dev.env}"
ARTIFACT_DIR="${JINA_DEV_ARTIFACT_DIRECTORY:-$STATE_DIR/artifacts}"
RESTART_FILE="${JINA_DEV_RESTART_FILE:-$STATE_DIR/restart.env}"

dev_down_main() {
  local processes_only=false
  while (($# > 0)); do
    case "$1" in
      --processes-only)
        processes_only=true
        shift
        ;;
      -h|--help)
        echo "usage: scripts/dev-down.sh [--processes-only]"
        return 0
        ;;
      *)
        echo "unknown option: $1" >&2
        return 2
        ;;
    esac
  done

  jina_validate_safe_directory JINA_DEV_STATE_DIR "$STATE_DIR"
  jina_stop_recorded_processes "$REPO" "$STATE_DIR"

  if [[ "$processes_only" == true ]]; then
    echo "processes stopped. PostgreSQL, Board state, artifacts, tokens, and restart state remain intact."
    return 0
  fi

  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    local owner
    owner="$(
      docker inspect -f '{{ index .Config.Labels "com.jina.local-context.repo" }}' \
        "$CONTAINER" 2>/dev/null || true
    )"
    if [[ "$owner" == "$REPO" ]]; then
      docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "removed $CONTAINER"
    else
      echo "left container $CONTAINER alone (not owned by this checkout)" >&2
    fi
  fi

  rm -f -- "$ENV_FILE" "$RESTART_FILE"
  echo "down. logs remain in $STATE_DIR; local artifacts remain in $ARTIFACT_DIR"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  dev_down_main "$@"
fi
