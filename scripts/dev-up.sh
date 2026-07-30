#!/usr/bin/env bash
# Start the Board-native Context stack on this machine.
#
# The stack uses the production PostgreSQL migration and atomic publication
# transaction, local immutable artifacts, the current Codex login, and the
# pinned self-hosted PageIndex implementation. Worker roles are separate so
# repository research, page writing, and audits can run concurrently.
#
# Usage:
#   scripts/dev-up.sh
#   source /tmp/jina-dev.env
#   scripts/context-build.sh omxyz/jina --budget 5400 --detail thorough
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/dev-process-lib.sh
source "$REPO/scripts/dev-process-lib.sh"
CONTAINER="${JINA_DEV_CONTAINER:-jina-dev-postgres}"
PGPORT="${JINA_DEV_PGPORT:-55480}"
API_PORT="${JINA_DEV_API_PORT:-4180}"
WORKER_PORT_BASE="${JINA_DEV_WORKER_PORT_BASE:-8091}"
DB="${JINA_DEV_DATABASE:-jina_dev}"
MIGRATION_USER="${JINA_DEV_MIGRATION_USER:-jina_app}"
MIGRATION_PASS="${JINA_DEV_MIGRATION_PASSWORD:-dev-migration}"
RUNTIME_USER="${JINA_DEV_RUNTIME_USER:-jina_runtime}"
RUNTIME_PASS="${JINA_DEV_RUNTIME_PASSWORD:-dev-runtime}"
TENANT="${JINA_DEV_TENANT_ID:-11111111-1111-4111-8111-111111111111}"
CONTEXT_QUERY_PRINCIPAL="$(
  jina_resolve_local_context_query_principal \
    "$TENANT" "${JINA_DEV_CONTEXT_QUERY_PRINCIPAL_ID:-}" JINA_DEV_CONTEXT_QUERY_PRINCIPAL_ID
)"
STATE_DIR="${JINA_DEV_STATE_DIR:-/tmp/jina-dev}"
ENV_FILE="${JINA_DEV_ENV_FILE:-/tmp/jina-dev.env}"
ARTIFACT_DIR="${JINA_DEV_ARTIFACT_DIRECTORY:-$STATE_DIR/artifacts}"
PAGEINDEX_HOME="${JINA_DEV_PAGEINDEX_HOME:-$STATE_DIR/pageindex}"
PAGEINDEX_PIN="982514ab40fe42a169ea087c13819cf87c87724f"
PAGEINDEX_PIN_SHORT="${PAGEINDEX_PIN:0:12}"
PAGEINDEX_SOURCE_ROOT="${PAGEINDEX_SOURCE_ROOT:-$PAGEINDEX_HOME/PageIndex-$PAGEINDEX_PIN_SHORT}"
CUSTOM_PAGEINDEX_PYTHON="${CONTEXT_PAGEINDEX_PYTHON:-}"
CONTEXT_PAGEINDEX_PYTHON="${CUSTOM_PAGEINDEX_PYTHON:-$PAGEINDEX_HOME/venv/bin/python}"
CONTEXT_PAGEINDEX_WORKER="${CONTEXT_PAGEINDEX_WORKER:-$REPO/services/pageindex-worker/worker.py}"
CODEX_SESSION_HOME_PATH="${CODEX_HOME:-$HOME/.codex}"
CODEX_HOME_PATH="${JINA_DEV_CODEX_RUNTIME_HOME:-$STATE_DIR/codex-home}"
CODEX_BINARY_PATH="${CODEX_BINARY:-$(command -v codex 2>/dev/null || true)}"
MODEL="${JINA_DEV_CODEX_MODEL:-gpt-5.6-terra}"
EFFORT="${JINA_DEV_CODEX_EFFORT:-low}"
CONTEXT_TOKENS="${JINA_DEV_CODEX_CONTEXT_TOKENS:-128000}"
COMPACT_TOKENS="${JINA_DEV_CODEX_COMPACT_TOKENS:-96000}"
AGENT_WORKERS="${JINA_DEV_AGENT_WORKERS:-3}"
AUDIT_WORKERS="${JINA_DEV_AUDIT_WORKERS:-2}"
LOG_RETENTION="${JINA_DEV_LOG_RETENTION:-5}"
RESTART_FILE="${JINA_DEV_RESTART_FILE:-$STATE_DIR/restart.env}"

require_positive_integer() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer" >&2
    exit 2
  fi
}

for pair in \
  "JINA_DEV_PGPORT:$PGPORT" \
  "JINA_DEV_API_PORT:$API_PORT" \
  "JINA_DEV_WORKER_PORT_BASE:$WORKER_PORT_BASE" \
  "JINA_DEV_CODEX_CONTEXT_TOKENS:$CONTEXT_TOKENS" \
  "JINA_DEV_CODEX_COMPACT_TOKENS:$COMPACT_TOKENS" \
  "JINA_DEV_AGENT_WORKERS:$AGENT_WORKERS" \
  "JINA_DEV_AUDIT_WORKERS:$AUDIT_WORKERS" \
  "JINA_DEV_LOG_RETENTION:$LOG_RETENTION"; do
  require_positive_integer "${pair%%:*}" "${pair#*:}"
done
for identifier in "$DB" "$MIGRATION_USER" "$RUNTIME_USER"; do
  if [[ ! "$identifier" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Database and role names must be PostgreSQL identifiers" >&2
    exit 2
  fi
done
for password in "$MIGRATION_PASS" "$RUNTIME_PASS"; do
  if [[ ! "$password" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Local database passwords may contain only letters, digits, dot, underscore, and hyphen" >&2
    exit 2
  fi
done

jina_validate_safe_directory JINA_DEV_STATE_DIR "$STATE_DIR"
jina_validate_safe_directory JINA_DEV_ARTIFACT_DIRECTORY "$ARTIFACT_DIR"

for tool in curl docker git node openssl pnpm psql python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done
if [[ -z "$CODEX_BINARY_PATH" || ! -x "$CODEX_BINARY_PATH" ]]; then
  echo "Codex CLI is required (set CODEX_BINARY if it is not on PATH)" >&2
  exit 2
fi
if [[ ! -f "$CODEX_SESSION_HOME_PATH/auth.json" ]]; then
  echo "No current Codex session at $CODEX_SESSION_HOME_PATH/auth.json; run 'codex login'" >&2
  exit 2
fi

mkdir -p "$STATE_DIR" "$ARTIFACT_DIR" "$PAGEINDEX_HOME"
jina_prepare_codex_runtime_home "$CODEX_SESSION_HOME_PATH" "$CODEX_HOME_PATH"

# Stop only processes recorded by this stack before rotating their logs. This
# avoids broad pkill patterns and leaves prior diagnostics available.
"$REPO/scripts/dev-down.sh" >/dev/null 2>&1 || true
cleanup_failed_start() {
  local status="$1"
  echo "Local stack startup failed; stopping processes started by this attempt." >&2
  JINA_DEV_CONTAINER="$CONTAINER" \
    JINA_DEV_STATE_DIR="$STATE_DIR" \
    JINA_DEV_ENV_FILE="$ENV_FILE" \
    "$REPO/scripts/dev-down.sh" >/dev/null 2>&1 || true
  exit "$status"
}
trap 'cleanup_failed_start "$?"' ERR

for existing in "$STATE_DIR"/*.log; do
  [[ -e "$existing" ]] || break
  base="$(basename "$existing" .log)"
  [[ "$base" == *".20"* ]] || jina_rotate_log "$STATE_DIR" "$LOG_RETENTION" "$base"
done

select_pageindex_python() {
  local candidate
  if [[ -n "${JINA_DEV_PAGEINDEX_BOOTSTRAP_PYTHON:-}" ]]; then
    candidate="$JINA_DEV_PAGEINDEX_BOOTSTRAP_PYTHON"
    command -v "$candidate" >/dev/null || {
      echo "$candidate is not available" >&2
      return 1
    }
    command -v "$candidate"
    return
  fi
  for candidate in python3.11 python3.12 python3.13 python3.10 python3; do
    if command -v "$candidate" >/dev/null &&
      "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
      command -v "$candidate"
      return
    fi
  done
  echo "PageIndex requires Python 3.10 or newer" >&2
  return 1
}

echo "==> self-hosted PageIndex ($PAGEINDEX_PIN_SHORT)"
if [[ ! -d "$PAGEINDEX_SOURCE_ROOT/.git" ]]; then
  if [[ -e "$PAGEINDEX_SOURCE_ROOT" ]]; then
    echo "$PAGEINDEX_SOURCE_ROOT exists but is not a Git checkout" >&2
    exit 1
  fi
  git clone --filter=blob:none --no-checkout \
    https://github.com/VectifyAI/PageIndex.git "$PAGEINDEX_SOURCE_ROOT" >/dev/null
  git -C "$PAGEINDEX_SOURCE_ROOT" fetch --depth 1 origin "$PAGEINDEX_PIN" >/dev/null
  git -C "$PAGEINDEX_SOURCE_ROOT" checkout --detach "$PAGEINDEX_PIN" >/dev/null
fi
actual_pageindex_pin="$(git -C "$PAGEINDEX_SOURCE_ROOT" rev-parse HEAD)"
if [[ "$actual_pageindex_pin" != "$PAGEINDEX_PIN" ]]; then
  echo "PageIndex checkout is $actual_pageindex_pin, expected $PAGEINDEX_PIN" >&2
  echo "Use a different JINA_DEV_PAGEINDEX_HOME or restore the pinned checkout." >&2
  exit 1
fi

if [[ -n "$CUSTOM_PAGEINDEX_PYTHON" && ! -x "$CONTEXT_PAGEINDEX_PYTHON" ]]; then
  echo "Configured CONTEXT_PAGEINDEX_PYTHON is not executable: $CONTEXT_PAGEINDEX_PYTHON" >&2
  exit 1
fi
if [[ ! -x "$CONTEXT_PAGEINDEX_PYTHON" ]]; then
  bootstrap_python="$(select_pageindex_python)"
  "$bootstrap_python" -m venv "$(dirname "$(dirname "$CONTEXT_PAGEINDEX_PYTHON")")"
fi
"$CONTEXT_PAGEINDEX_PYTHON" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' || {
  echo "CONTEXT_PAGEINDEX_PYTHON must be Python 3.10 or newer" >&2
  exit 1
}
requirements_digest="$(
  node -e 'const f=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' \
    "$REPO/services/pageindex-worker/requirements.txt"
)"
requirements_stamp="$PAGEINDEX_HOME/requirements.$requirements_digest"
install_pageindex_requirements() {
  "$CONTEXT_PAGEINDEX_PYTHON" -m pip install --disable-pip-version-check \
    -r "$REPO/services/pageindex-worker/requirements.txt" >/dev/null
  : > "$requirements_stamp"
}
if [[ ! -f "$requirements_stamp" ]]; then
  install_pageindex_requirements
fi
if ! PAGEINDEX_SOURCE_ROOT="$PAGEINDEX_SOURCE_ROOT" \
  "$CONTEXT_PAGEINDEX_PYTHON" "$CONTEXT_PAGEINDEX_WORKER" --probe >/dev/null 2>&1; then
  # The digest stamp can outlive a recreated or externally modified virtual
  # environment. Repair the actual interpreter once, then require the
  # authoritative worker probe to pass.
  install_pageindex_requirements
fi
PAGEINDEX_SOURCE_ROOT="$PAGEINDEX_SOURCE_ROOT" \
  "$CONTEXT_PAGEINDEX_PYTHON" "$CONTEXT_PAGEINDEX_WORKER" --probe >/dev/null

echo "==> building workspace"
# Force a clean TypeScript graph: stale buildinfo can otherwise run code from a
# previous branch even though the source tree has changed.
find "$REPO/packages" "$REPO/apps" -maxdepth 2 -name "*.tsbuildinfo" -delete 2>/dev/null || true
(cd "$REPO" && pnpm build --force >/dev/null)

echo "==> PostgreSQL 17 on :$PGPORT"
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container $CONTAINER already exists and was not removed by dev-down.sh" >&2
  exit 1
fi
docker run -d --name "$CONTAINER" \
  --label "com.jina.local-context.repo=$REPO" \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB="$DB" \
  -p "$PGPORT":5432 postgres:17-alpine >/dev/null
for _ in $(seq 1 90); do
  if PGPASSWORD=dev psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" \
    -tAc "select 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! PGPASSWORD=dev psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" \
  -tAc "select 1" >/dev/null 2>&1; then
  echo "PostgreSQL did not become ready" >&2
  exit 1
fi

echo "==> roles and runtime state"
docker exec -i -e PGPASSWORD=dev "$CONTAINER" psql -U postgres -d "$DB" \
  -v ON_ERROR_STOP=1 -q \
  -v migration_user="$MIGRATION_USER" \
  -v migration_pass="$MIGRATION_PASS" \
  -v runtime_user="$RUNTIME_USER" \
  -v runtime_pass="$RUNTIME_PASS" \
  -v database_name="$DB" <<'SQL'
create role :"migration_user" login password :'migration_pass' createrole;
create role :"runtime_user" login password :'runtime_pass' noinherit;
grant :"runtime_user" to :"migration_user" with admin option;
grant create,usage on schema public to :"migration_user";
alter database :"database_name" owner to :"migration_user";
create schema if not exists jina_runtime authorization :"migration_user";
grant usage on schema jina_runtime to :"runtime_user";
create table if not exists jina_runtime.api_state (
  id smallint primary key check (id = 1),
  snapshot jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table jina_runtime.api_state owner to :"migration_user";
grant select,insert,update on jina_runtime.api_state to :"runtime_user";
SQL

MIGRATION_URL="postgres://$MIGRATION_USER:$MIGRATION_PASS@127.0.0.1:$PGPORT/$DB"
RUNTIME_URL="postgres://$RUNTIME_USER:$RUNTIME_PASS@127.0.0.1:$PGPORT/$DB"
DATABASE_URL="$MIGRATION_URL" CONTEXT_RUNTIME_DB_USER="$RUNTIME_USER" \
  node "$REPO/packages/db/dist/migrate.js" --install-roles >/dev/null

INTERNAL_TOKEN="$(openssl rand -hex 32)"
CONTEXT_TOKEN="$(openssl rand -hex 32)"
GITHUB_TOKEN="${GITHUB_API_TOKEN:-${GITHUB_CLONE_TOKEN:-}}"
if [[ -z "$GITHUB_TOKEN" ]] && command -v gh >/dev/null; then
  GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [[ -z "$GITHUB_TOKEN" ]]; then
  echo "warning: no GitHub token; provider history may be partial or rate-limited" >&2
  echo "         export GITHUB_API_TOKEN or authenticate the gh CLI for complete evidence" >&2
fi

echo "==> API on :$API_PORT"
(
  export DATABASE_URL="$RUNTIME_URL"
  export INTERNAL_API_TOKEN="$INTERNAL_TOKEN"
  export CONTEXT_API_TOKEN="$CONTEXT_TOKEN"
  export JINA_TENANT_ID="$TENANT"
  export JINA_CONTEXT_TENANT_ID="$TENANT"
  export JINA_CONTEXT_PRINCIPAL_ID="$CONTEXT_QUERY_PRINCIPAL"
  export JINA_TENANT_ADMIN_PRINCIPALS="tenant:$TENANT"
  export JINA_DB_MANAGE_SCHEMA=false
  export JINA_ENABLE_DEV_ENDPOINTS=true
  export JINA_TRUST_DEV_IDENTITY_HEADERS=false
  export CONTEXT_ARTIFACT_DIRECTORY="$ARTIFACT_DIR"
  # shellcheck disable=SC2030 # This process receives its own listener port.
  export PORT="$API_PORT"
  jina_spawn_detached "$STATE_DIR/api.log" node "$REPO/apps/api/dist/dev-server.js"
) >"$STATE_DIR/api.pid"

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
  echo "API did not start; see $STATE_DIR/api.log" >&2
  tail -30 "$STATE_DIR/api.log" >&2 || true
  exit 1
fi

worker_common=(
  "JINA_API_URL=http://127.0.0.1:$API_PORT"
  "INTERNAL_API_TOKEN=$INTERNAL_TOKEN"
  "JINA_REQUIRE_GITHUB_INSTALLATION=false"
  "GIT_TERMINAL_PROMPT=0"
  "GITHUB_API_TOKEN=$GITHUB_TOKEN"
  "GITHUB_CLONE_TOKEN=$GITHUB_TOKEN"
  "CONTEXT_BOARD_EXECUTOR=local"
  "CONTEXT_CODEX_AUTH=session"
  "CONTEXT_CODEX_MODEL=$MODEL"
  "CONTEXT_CODEX_EFFORT=$EFFORT"
  "CONTEXT_CODEX_VERBOSITY=high"
  "CONTEXT_CODEX_CONTEXT_TOKENS=$CONTEXT_TOKENS"
  "CONTEXT_CODEX_COMPACT_TOKENS=$COMPACT_TOKENS"
  "CONTEXT_AGENT_ARCHIVE_MAX_BYTES=134217728"
  "CONTEXT_API_TIMEOUT_MS=7200000"
  "CONTEXT_DERIVE_BUDGET_SECONDS=5400"
  "CONTEXT_PAGEINDEX_PROCESS_TIMEOUT_MS=300000"
  "CONTEXT_PAGEINDEX_BUILD_TIMEOUT_MS=300000"
  "CONTEXT_PAGEINDEX_PYTHON=$CONTEXT_PAGEINDEX_PYTHON"
  "CONTEXT_PAGEINDEX_WORKER=$CONTEXT_PAGEINDEX_WORKER"
  "PAGEINDEX_SOURCE_ROOT=$PAGEINDEX_SOURCE_ROOT"
  "CODEX_BINARY=$CODEX_BINARY_PATH"
  "CODEX_HOME=$CODEX_HOME_PATH"
  "NODE_ENV=development"
)
worker_index=0
worker_roles=()

start_worker() {
  local role="$1" topics="$2" port
  port=$((WORKER_PORT_BASE + worker_index))
  worker_index=$((worker_index + 1))
  worker_roles+=("$role")
  jina_rotate_log "$STATE_DIR" "$LOG_RETENTION" "worker-$role"
  (
    export "${worker_common[@]}"
    export WORKER_ID="dev-$role"
    export WORKER_TOPICS="$topics"
    # shellcheck disable=SC2031 # Each worker subshell receives a distinct port.
    export PORT="$port"
    jina_spawn_detached "$STATE_DIR/worker-$role.log" node "$REPO/apps/worker/dist/server.js"
  ) >"$STATE_DIR/worker-$role.pid"
}

echo "==> Board workers"
start_worker snapshot "run-context-input-snapshot"
for index in $(seq 1 "$AGENT_WORKERS"); do
  start_worker "agent-$index" \
    "run-context-research-plan|run-context-research|run-context-publication-plan|run-context-page-write|run-context-page-repair|run-context-gap-repair"
done
for index in $(seq 1 "$AUDIT_WORKERS"); do
  start_worker "auditor-$index" \
    "run-context-page-audit|run-context-source-challenge|run-context-task-evaluation"
done
start_worker certification "run-context-certification"
start_worker publication "run-context-publication"
start_worker pageindex "run-context-pageindex"

# Let every process finish configuration before calling the stack healthy.
sleep 2
for role in "${worker_roles[@]}"; do
  pid="$(<"$STATE_DIR/worker-$role.pid")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Worker $role exited during startup; see $STATE_DIR/worker-$role.log" >&2
    tail -30 "$STATE_DIR/worker-$role.log" >&2 || true
    exit 1
  fi
done

{
  echo "# Generated by scripts/dev-up.sh. Source this file before context-build.sh."
  printf 'export JINA_API_URL=%q\n' "http://127.0.0.1:$API_PORT"
  printf 'export JINA_INTERNAL_TOKEN=%q\n' "$INTERNAL_TOKEN"
  printf 'export JINA_CONTEXT_TOKEN=%q\n' "$CONTEXT_TOKEN"
  printf 'export JINA_TENANT_ID=%q\n' "$TENANT"
  printf 'export JINA_CONTEXT_PRINCIPAL_ID=%q\n' "$CONTEXT_QUERY_PRINCIPAL"
  printf 'export JINA_DEV_STATE_DIR=%q\n' "$STATE_DIR"
  printf 'export CONTEXT_ARTIFACT_DIRECTORY=%q\n' "$ARTIFACT_DIR"
  printf 'export PAGEINDEX_SOURCE_ROOT=%q\n' "$PAGEINDEX_SOURCE_ROOT"
  printf 'export CONTEXT_PAGEINDEX_PYTHON=%q\n' "$CONTEXT_PAGEINDEX_PYTHON"
  printf 'export CONTEXT_PAGEINDEX_WORKER=%q\n' "$CONTEXT_PAGEINDEX_WORKER"
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"

# Private, restart-only process configuration. Unlike dev-up, dev-restart never
# rotates these credentials or recreates PostgreSQL, so an interrupted Board
# lease can be released/reclaimed against the exact persisted api_state graph.
# The migration connection remains only in this mode-0600 file: explicit
# `dev-restart.sh --build` needs it to apply the current schema and capability
# grants before the retained runtime login starts new processes.
{
  printf 'export JINA_RESTART_REPO=%q\n' "$REPO"
  printf 'export JINA_RESTART_CONTAINER=%q\n' "$CONTAINER"
  printf 'export JINA_RESTART_ENV_FILE=%q\n' "$ENV_FILE"
  printf 'export JINA_RESTART_DATABASE_URL=%q\n' "$RUNTIME_URL"
  printf 'export JINA_RESTART_MIGRATION_DATABASE_URL=%q\n' "$MIGRATION_URL"
  printf 'export JINA_RESTART_RUNTIME_DB_USER=%q\n' "$RUNTIME_USER"
  printf 'export JINA_RESTART_API_PORT=%q\n' "$API_PORT"
  printf 'export JINA_RESTART_WORKER_PORT_BASE=%q\n' "$WORKER_PORT_BASE"
  printf 'export JINA_RESTART_PGPORT=%q\n' "$PGPORT"
  printf 'export JINA_RESTART_TENANT=%q\n' "$TENANT"
  printf 'export JINA_RESTART_CONTEXT_QUERY_PRINCIPAL_ID=%q\n' "$CONTEXT_QUERY_PRINCIPAL"
  printf 'export JINA_RESTART_INTERNAL_TOKEN=%q\n' "$INTERNAL_TOKEN"
  printf 'export JINA_RESTART_CONTEXT_TOKEN=%q\n' "$CONTEXT_TOKEN"
  printf 'export JINA_RESTART_ARTIFACT_DIR=%q\n' "$ARTIFACT_DIR"
  printf 'export JINA_RESTART_PAGEINDEX_SOURCE_ROOT=%q\n' "$PAGEINDEX_SOURCE_ROOT"
  printf 'export JINA_RESTART_PAGEINDEX_PYTHON=%q\n' "$CONTEXT_PAGEINDEX_PYTHON"
  printf 'export JINA_RESTART_PAGEINDEX_WORKER=%q\n' "$CONTEXT_PAGEINDEX_WORKER"
  printf 'export JINA_RESTART_CODEX_HOME=%q\n' "$CODEX_HOME_PATH"
  printf 'export JINA_RESTART_CODEX_BINARY=%q\n' "$CODEX_BINARY_PATH"
  printf 'export JINA_RESTART_MODEL=%q\n' "$MODEL"
  printf 'export JINA_RESTART_EFFORT=%q\n' "$EFFORT"
  printf 'export JINA_RESTART_CONTEXT_TOKENS=%q\n' "$CONTEXT_TOKENS"
  printf 'export JINA_RESTART_COMPACT_TOKENS=%q\n' "$COMPACT_TOKENS"
  printf 'export JINA_RESTART_AGENT_WORKERS=%q\n' "$AGENT_WORKERS"
  printf 'export JINA_RESTART_AUDIT_WORKERS=%q\n' "$AUDIT_WORKERS"
  printf 'export JINA_RESTART_LOG_RETENTION=%q\n' "$LOG_RETENTION"
  printf 'export JINA_RESTART_GITHUB_TOKEN=%q\n' "$GITHUB_TOKEN"
} >"$RESTART_FILE"
chmod 600 "$RESTART_FILE"

# The GitHub App normally owns this repository ACL synchronization.
if [[ -n "${JINA_DEV_REPOSITORIES:-}" ]]; then
  IFS=',' read -r -a repositories <<<"$JINA_DEV_REPOSITORIES"
else
  repositories=(omxyz/jina-context-graph-e2e omxyz/jina)
fi
repository_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "${repositories[@]}")"
curl -fsS -X POST "http://127.0.0.1:$API_PORT/internal/context/access/sync" \
  -H "authorization: Bearer $INTERNAL_TOKEN" \
  -H "x-jina-tenant-id: $TENANT" \
  -H "x-jina-principal-id: $CONTEXT_QUERY_PRINCIPAL" \
  -H 'content-type: application/json' \
  -d "{\"repositories\":$repository_json,\"mode\":\"merge\"}" >/dev/null

echo
echo "Board-native Context is up:"
echo "  API:       http://127.0.0.1:$API_PORT"
echo "  PostgreSQL localhost:$PGPORT"
echo "  Workers:   ${worker_roles[*]}"
echo "  Artifacts: $ARTIFACT_DIR"
echo "  PageIndex: $PAGEINDEX_SOURCE_ROOT @ $PAGEINDEX_PIN_SHORT"
echo "  Logs:      $STATE_DIR"
echo
echo "Run:"
echo "  source $ENV_FILE"
echo "  scripts/context-build.sh omxyz/jina --budget 5400 --detail thorough"
echo
echo "Restart processes without losing checkpoints: scripts/dev-restart.sh"
echo "Stop with scripts/dev-down.sh"
trap - ERR
