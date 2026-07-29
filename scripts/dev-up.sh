#!/usr/bin/env bash
# Run the context pipeline on this machine: Postgres, the API, and a worker.
#
# Shaped like production rather than like a test: PostgreSQL 17, the schema and
# capability roles installed by the real migration, and a NOINHERIT runtime login
# the API connects as. Derivation still runs in a real Daytona sandbox against a
# real model, because that is the part worth exercising and it cannot be faked
# usefully.
#
# Usage:
#   scripts/dev-up.sh              # start everything
#   scripts/dev-down.sh            # stop it and remove the container
#
# Then, in another shell:
#   source /tmp/jina-dev.env
#   scripts/context-build.sh omxyz/jina-context-graph-e2e --budget 900
#
# Secrets come from Secret Manager, so `gcloud auth login` must be current. Set
# them in the environment beforehand to skip that:
#   DAYTONA_API_KEY, OPENROUTER_API_KEY, GITHUB_API_TOKEN
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${JINA_DEV_CONTAINER:-jina-dev-postgres}"
PGPORT="${JINA_DEV_PGPORT:-55480}"
API_PORT="${JINA_DEV_API_PORT:-4180}"
DB=jina_dev
MIGRATION_USER=jina_app
MIGRATION_PASS=dev-migration
RUNTIME_USER=jina_runtime
RUNTIME_PASS=dev-runtime
TENANT="${JINA_DEV_TENANT_ID:-11111111-1111-4111-8111-111111111111}"
ENV_FILE=/tmp/jina-dev.env
LOG_DIR=/tmp/jina-dev

secret() {
  local name="$1" var="$2"
  if [[ -n "${!var:-}" ]]; then printf '%s' "${!var}"; return 0; fi
  gcloud secrets versions access latest --secret="$name" 2>/dev/null || true
}

for tool in docker psql node pnpm; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

mkdir -p "$LOG_DIR"
# A restart must not destroy the previous run's evidence: the last stack's logs
# are what explain the failure that prompted the restart.
for name in api worker; do
  [[ -s "$LOG_DIR/$name.log" ]] && mv "$LOG_DIR/$name.log" "$LOG_DIR/$name.$(date +%H%M%S).log"
done

# A previous stack left running would keep the ports and, worse, keep claiming
# work with a token this run is about to replace -- so the new worker dies on a
# taken port while the old one fails every claim with a 401.
"$REPO/scripts/dev-down.sh" >/dev/null 2>&1 || true

echo "==> building"
# Incremental builds survive a branch switch badly: tsc trusts its buildinfo, so
# a schema added on another branch can be missing from dist while the source
# clearly has it, and the stack then runs code the repository does not contain.
# A local stack that lies about which code it is running is worse than a slow one.
find "$REPO/packages" "$REPO/apps" -maxdepth 2 -name "*.tsbuildinfo" -delete 2>/dev/null || true
(cd "$REPO" && pnpm build --force >/dev/null)

echo "==> postgres on :$PGPORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=dev -e POSTGRES_DB="$DB" \
  -p "$PGPORT":5432 postgres:17-alpine >/dev/null
# Wait on the mapped port rather than `docker exec pg_isready`: during initdb the
# image runs a temporary server that answers, then shuts it down, so the naive
# check races and the next statement hits a closing server.
for _ in $(seq 1 90); do
  PGPASSWORD=dev psql -h localhost -p "$PGPORT" -U postgres -d "$DB" -tAc "select 1" >/dev/null 2>&1 && break
  sleep 1
done

echo "==> roles (migration owns the schema; runtime is NOINHERIT, as in production)"
docker exec -i -e PGPASSWORD=dev "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q <<SQL
create role $MIGRATION_USER login password '$MIGRATION_PASS' createrole;
create role $RUNTIME_USER  login password '$RUNTIME_PASS'  noinherit;
grant create,usage on schema public to $MIGRATION_USER;
alter database $DB owner to $MIGRATION_USER;
-- The API keeps a small state table in jina_runtime. It can create that itself,
-- but only with rights the runtime login has no business holding: "create schema
-- if not exists" checks CREATE on the database before it checks existence. So
-- the table is made here, by the login that owns the schema, and the runtime one
-- is left with the data rights it actually needs -- which is how production has
-- it too.
create schema if not exists jina_runtime authorization $MIGRATION_USER;
grant usage on schema jina_runtime to $RUNTIME_USER;
create table if not exists jina_runtime.api_state (
  id smallint primary key check (id = 1),
  snapshot jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
-- Created here by the superuser, so ownership is handed to the migration login:
-- the migration grants on this table and cannot grant on one it does not own.
alter table jina_runtime.api_state owner to $MIGRATION_USER;
grant select,insert,update on jina_runtime.api_state to $RUNTIME_USER;
SQL

MIGRATION_URL="postgres://$MIGRATION_USER:$MIGRATION_PASS@localhost:$PGPORT/$DB"
RUNTIME_URL="postgres://$RUNTIME_USER:$RUNTIME_PASS@localhost:$PGPORT/$DB"

echo "==> migrate --install-roles"
DATABASE_URL="$MIGRATION_URL" CONTEXT_RUNTIME_DB_USER="$RUNTIME_USER" \
  node "$REPO/packages/db/dist/migrate.js" --install-roles >/dev/null

INTERNAL_TOKEN="dev-internal-$RANDOM$RANDOM"
CONTEXT_TOKEN="dev-context-$RANDOM$RANDOM"

echo "==> api on :$API_PORT"
DATABASE_URL="$RUNTIME_URL" \
INTERNAL_API_TOKEN="$INTERNAL_TOKEN" \
CONTEXT_API_TOKEN="$CONTEXT_TOKEN" \
JINA_TENANT_ID="$TENANT" \
JINA_CONTEXT_TENANT_ID="$TENANT" \
JINA_CONTEXT_PRINCIPAL_ID="tenant:$TENANT" \
JINA_TENANT_ADMIN_PRINCIPALS="tenant:$TENANT" \
JINA_DB_MANAGE_SCHEMA=false \
CONTEXT_DERIVE_DOCUMENT_FILES=true \
PORT="$API_PORT" \
  node "$REPO/apps/api/dist/dev-server.js" > "$LOG_DIR/api.log" 2>&1 &
echo $! > "$LOG_DIR/api.pid"

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
  echo "api did not come up; see $LOG_DIR/api.log" >&2
  tail -20 "$LOG_DIR/api.log" >&2 || true
  exit 1
fi

DAYTONA_KEY="$(secret jina-daytona-api-key DAYTONA_API_KEY)"
OPENROUTER_KEY="$(secret jina-openrouter-api-key OPENROUTER_API_KEY)"
GITHUB_TOKEN="$(secret jina-github-api-token GITHUB_API_TOKEN)"

missing=()
# The local executor runs codex on this machine, so Daytona is only required
# when the sandbox is where derivation happens.
if [[ "${JINA_DEV_EXECUTOR:-daytona}" != "local" ]]; then
  [[ -z "$DAYTONA_KEY" ]] && missing+=(DAYTONA_API_KEY)
fi
# The chatgpt provider authenticates with the operator's own Codex session
# (~/.codex/auth.json) instead of a metered key, so the key is only required
# when a key is what will be used.
if [[ "${JINA_DEV_CODEX_PROVIDER:-openrouter}" == "chatgpt" ]]; then
  [[ -f "$HOME/.codex/auth.json" ]] || missing+=("~/.codex/auth.json (run: codex login)")
else
  [[ -z "$OPENROUTER_KEY" ]] && missing+=(OPENROUTER_API_KEY)
fi
if ((${#missing[@]})); then
  echo "==> worker NOT started: missing ${missing[*]}"
  echo "    Derivation runs in a real sandbox against a real model, so it needs these."
  echo "    Run 'gcloud auth login', or export them, then re-run this script."
else
  echo "==> worker"
  JINA_API_URL="http://127.0.0.1:$API_PORT" \
  INTERNAL_API_TOKEN="$INTERNAL_TOKEN" \
  WORKER_TOPICS="run-ingest-evidence|run-derive-knowledge|run-index-context" \
  WORKER_ID="dev-worker" \
  JINA_REQUIRE_GITHUB_INSTALLATION=false \
  DAYTONA_API_KEY="$DAYTONA_KEY" \
  OPENROUTER_API_KEY="$OPENROUTER_KEY" \
  GITHUB_API_TOKEN="$GITHUB_TOKEN" \
  CONTEXT_EXECUTOR="${JINA_DEV_EXECUTOR:-daytona}" \
  CONTEXT_CODEX_PROVIDER="${JINA_DEV_CODEX_PROVIDER:-openrouter}" \
  CONTEXT_CODEX_MODEL="${JINA_DEV_CODEX_MODEL:-openai/gpt-5.4-mini}" \
  CONTEXT_CODEX_CONTEXT_TOKENS=64000 \
  CONTEXT_CODEX_COMPACT_TOKENS=48000 \
  CONTEXT_DERIVE_DOCUMENT_FILES=true \
  CONTEXT_DERIVE_DETAIL=thorough \
  CONTEXT_DERIVE_BUDGET_SECONDS=5400 \
  DAYTONA_RUN_TIMEOUT_SECONDS=5400 \
  CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS=20 \
  PORT=8091 \
    node "$REPO/apps/worker/dist/server.js" > "$LOG_DIR/worker.log" 2>&1 &
  echo $! > "$LOG_DIR/worker.pid"
fi

cat > "$ENV_FILE" <<ENV
# Point scripts/context-build.sh at this stack: source this file first.
export JINA_API_URL=http://127.0.0.1:$API_PORT
export JINA_INTERNAL_TOKEN=$INTERNAL_TOKEN
export JINA_TENANT_ID=$TENANT
ENV

# A repository has to be known to the tenant before a build of it is allowed,
# which in production is the GitHub app's job.
if [[ -n "${JINA_DEV_REPOSITORIES:-}" ]]; then
  IFS=',' read -r -a repositories <<< "$JINA_DEV_REPOSITORIES"
else
  repositories=(omxyz/jina-context-graph-e2e omxyz/jina)
fi
printf -v repository_json '"%s",' "${repositories[@]}"
curl -sS -X POST "http://127.0.0.1:$API_PORT/internal/context/access/sync" \
  -H "authorization: Bearer $INTERNAL_TOKEN" \
  -H "x-jina-tenant-id: $TENANT" \
  -H "x-jina-principal-id: tenant:$TENANT" \
  -H 'content-type: application/json' \
  -d "{\"repositories\":[${repository_json%,}],\"mode\":\"merge\"}" >/dev/null || true

echo
echo "up:  api http://127.0.0.1:$API_PORT   postgres :$PGPORT   logs $LOG_DIR"
echo "     repositories: ${repositories[*]}"
echo
echo "  source $ENV_FILE"
echo "  scripts/context-build.sh omxyz/jina-context-graph-e2e --budget 900"
echo
echo "  scripts/dev-down.sh   to stop"
