#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/jina-dev-restart-test.XXXXXX")"
trap 'find "$TEST_TMP" -depth -delete 2>/dev/null || true' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_equal() {
  [[ "$1" == "$2" ]] || fail "expected '$2', got '$1'"
}

test_local_context_query_principal_validation() (
  # shellcheck source=scripts/dev-process-lib.sh
  source "$ROOT/scripts/dev-process-lib.sh"
  tenant=11111111-1111-4111-8111-111111111111
  tenant_principal="tenant:$tenant"
  assert_equal "$(jina_resolve_local_context_query_principal "$tenant" "")" "$tenant_principal"
  assert_equal \
    "$(jina_resolve_local_context_query_principal "$tenant" "$tenant_principal")" \
    "$tenant_principal"
  assert_equal \
    "$(jina_resolve_local_context_query_principal "$tenant" "user:Context-Query@Jina.Internal")" \
    "user:context-query@jina.internal"
  for invalid in \
    "tenant:22222222-2222-4222-8222-222222222222" \
    "svc:context-query" \
    "user:missing-domain" \
    "context-query@jina.internal"; do
    if jina_resolve_local_context_query_principal "$tenant" "$invalid" >/dev/null 2>&1; then
      fail "invalid local Context query principal was accepted: $invalid"
    fi
  done
)

test_pageindex_pin_alignment() (
  pageindex_pin="$(
    sed -n 's/^PAGEINDEX_PIN="\([0-9a-f]\{40\}\)"$/\1/p' "$ROOT/scripts/dev-up.sh"
  )"
  restart_pin_short="$(
    sed -n 's/.*local pageindex_pin_short="\([0-9a-f]\{12\}\)".*/\1/p' "$ROOT/scripts/dev-restart.sh"
  )"
  [[ -n "$pageindex_pin" ]] || fail "dev-up PageIndex pin was not found"
  [[ -n "$restart_pin_short" ]] || fail "dev-restart PageIndex short pin was not found"
  assert_equal "$restart_pin_short" "${pageindex_pin:0:12}"
)

test_pid_ownership() (
  # shellcheck source=scripts/dev-process-lib.sh
  source "$ROOT/scripts/dev-process-lib.sh"
  local_state="$TEST_TMP/ownership"
  mkdir -p "$local_state"
  printf '101\n' >"$local_state/api.pid"
  printf '202\n' >"$local_state/worker-agent-1.pid"
  printf '303\n' >"$local_state/worker-foreign.pid"
  printf 'db-state\n' >"$local_state/container.sentinel"
  printf 'export TOKEN=unchanged\n' >"$local_state/local.env"
  before_container="$(cksum <"$local_state/container.sentinel")"
  before_environment="$(cksum <"$local_state/local.env")"
  signals="$local_state/signals"
  stopped=" "

  jina_process_command() {
    case "$1" in
      101) echo "$ROOT/apps/api/dist/dev-server.js" ;;
      202) echo "node $ROOT/apps/worker/dist/server.js" ;;
      303) echo "/usr/bin/unrelated --important" ;;
    esac
  }
  jina_signal_process() {
    echo "$1 $2" >>"$signals"
    stopped="$stopped$2 "
  }
  jina_process_alive() {
    [[ "$stopped" != *" $1 "* ]]
  }
  jina_process_sleep() {
    :
  }

  jina_stop_recorded_processes "$ROOT" "$local_state" 2
  [[ ! -e "$local_state/api.pid" ]] || fail "owned API pid file survived"
  [[ ! -e "$local_state/worker-agent-1.pid" ]] || fail "owned worker pid file survived"
  [[ ! -e "$local_state/worker-foreign.pid" ]] || fail "stale foreign pid file survived"
  grep -qx 'TERM 101' "$signals" || fail "owned API was not signaled"
  grep -qx 'TERM 202' "$signals" || fail "owned worker was not signaled"
  ! grep -q '303' "$signals" || fail "foreign process was signaled"
  worker_line="$(grep -n 'TERM 202' "$signals" | cut -d: -f1)"
  api_line="$(grep -n 'TERM 101' "$signals" | cut -d: -f1)"
  ((worker_line < api_line)) || fail "API stopped before worker lease release"
  assert_equal "$(cksum <"$local_state/container.sentinel")" "$before_container"
  assert_equal "$(cksum <"$local_state/local.env")" "$before_environment"
)

test_private_state_permissions() (
  # shellcheck source=scripts/dev-restart.sh
  source "$ROOT/scripts/dev-restart.sh"
  private_state="$TEST_TMP/private-state.env"
  printf 'export SAFE=value\n' >"$private_state"
  chmod 644 "$private_state"
  if assert_private_owned_file "$private_state" >/dev/null 2>&1; then
    fail "group/world-readable restart state was accepted"
  fi
  chmod 600 "$private_state"
  assert_private_owned_file "$private_state"
)

test_codex_runtime_home_isolates_mutable_state() (
  # shellcheck source=scripts/dev-process-lib.sh
  source "$ROOT/scripts/dev-process-lib.sh"
  session_home="$TEST_TMP/codex-session"
  runtime_home="$TEST_TMP/codex-runtime"
  mkdir -p "$session_home"
  printf '{"session":"current"}\n' >"$session_home/auth.json"
  printf '{"schema":"desktop-owned"}\n' >"$session_home/models_cache.json"

  jina_prepare_codex_runtime_home "$session_home" "$runtime_home"
  [[ -L "$runtime_home/auth.json" ]] || fail "runtime auth is not a session symlink"
  assert_equal "$(readlink "$runtime_home/auth.json")" "$session_home/auth.json"
  [[ ! -e "$runtime_home/models_cache.json" ]] || fail "desktop model cache leaked into worker runtime home"
  assert_equal "$(stat -f '%Lp' "$runtime_home")" 700

  replacement="$TEST_TMP/replacement-runtime"
  mkdir -p "$replacement"
  printf 'unexpected\n' >"$replacement/auth.json"
  if jina_prepare_codex_runtime_home "$session_home" "$replacement" >/dev/null 2>&1; then
    fail "unexpected runtime credential was overwritten"
  fi
  assert_equal "$(<"$replacement/auth.json")" unexpected
)

test_dev_down_processes_only() (
  local_state="$TEST_TMP/processes-only-down"
  mkdir -p "$local_state/artifacts"
  environment_file="$local_state/local.env"
  restart_file="$local_state/restart.env"
  printf 'environment\n' >"$environment_file"
  printf 'restart\n' >"$restart_file"
  before_environment="$(cksum <"$environment_file")"
  before_restart="$(cksum <"$restart_file")"
  docker_calls="$local_state/docker.calls"
  stop_calls="$local_state/stop.calls"

  export JINA_DEV_STATE_DIR="$local_state"
  export JINA_DEV_ENV_FILE="$environment_file"
  export JINA_DEV_RESTART_FILE="$restart_file"
  export JINA_DEV_ARTIFACT_DIRECTORY="$local_state/artifacts"
  # shellcheck source=scripts/dev-down.sh
  source "$ROOT/scripts/dev-down.sh"
  jina_stop_recorded_processes() {
    echo "$*" >>"$stop_calls"
  }
  docker() {
    echo "$*" >>"$docker_calls"
    return 0
  }

  output="$(dev_down_main --processes-only)"
  [[ "$output" == *"Board state"* ]] || fail "process-only stop did not report state preservation"
  assert_equal "$(cksum <"$environment_file")" "$before_environment"
  assert_equal "$(cksum <"$restart_file")" "$before_restart"
  [[ ! -e "$docker_calls" ]] || fail "process-only stop inspected or removed PostgreSQL"
  [[ -s "$stop_calls" ]] || fail "process-only stop did not stop recorded processes"
)

test_dev_up_keeps_migration_credentials_restart_private() (
  public_environment_block="$(
    awk '
      /Generated by scripts\/dev-up.sh. Source this file/ { capture=1 }
      capture { print }
      /chmod 600 "\$ENV_FILE"/ { exit }
    ' "$ROOT/scripts/dev-up.sh"
  )"
  private_restart_block="$(
    awk '
      /Private, restart-only process configuration/ { capture=1 }
      capture { print }
      /chmod 600 "\$RESTART_FILE"/ { exit }
    ' "$ROOT/scripts/dev-up.sh"
  )"
  [[ "$public_environment_block" != *"JINA_RESTART_MIGRATION_DATABASE_URL"* ]] ||
    fail "migration connection leaked into the sourceable developer environment"
  [[ "$private_restart_block" == *"JINA_RESTART_MIGRATION_DATABASE_URL"* ]] ||
    fail "private restart state does not retain the migration connection"
  [[ "$private_restart_block" == *"JINA_RESTART_RUNTIME_DB_USER"* ]] ||
    fail "private restart state does not retain the runtime database role"
  [[ "$public_environment_block" == *"JINA_CONTEXT_PRINCIPAL_ID"* ]] ||
    fail "sourceable developer environment does not identify the Context query principal"
  [[ "$private_restart_block" == *"JINA_RESTART_CONTEXT_QUERY_PRINCIPAL_ID"* ]] ||
    fail "private restart state does not retain the Context query principal"
  grep -q 'JINA_DEV_CONTEXT_QUERY_PRINCIPAL_ID' "$ROOT/scripts/dev-up.sh" ||
    fail "dev-up has no narrowly scoped local Context query-principal option"
  grep -q 'JINA_TENANT_ADMIN_PRINCIPALS="tenant:$TENANT"' "$ROOT/scripts/dev-up.sh" ||
    fail "dev-up no longer keeps the tenant principal as the local administrator"
  grep -q 'x-jina-principal-id: $CONTEXT_QUERY_PRINCIPAL' "$ROOT/scripts/dev-up.sh" ||
    fail "dev-up does not synchronize repository access for the configured query principal"
)

test_legacy_default_restart_metadata_is_upgradeable() (
  # shellcheck source=scripts/dev-restart.sh
  source "$ROOT/scripts/dev-restart.sh"
  unset JINA_RESTART_MIGRATION_DATABASE_URL JINA_RESTART_RUNTIME_DB_USER
  JINA_RESTART_DATABASE_URL="postgres://jina_runtime:dev-runtime@127.0.0.1:55480/jina_dev"
  resolve_migration_restart_metadata
  assert_equal "$JINA_RESTART_RUNTIME_DB_USER" jina_runtime
  assert_equal \
    "$JINA_RESTART_MIGRATION_DATABASE_URL" \
    "postgres://jina_app:dev-migration@127.0.0.1:55480/jina_dev"

  unset JINA_RESTART_MIGRATION_DATABASE_URL JINA_RESTART_RUNTIME_DB_USER
  JINA_RESTART_DATABASE_URL="postgres://custom-runtime@127.0.0.1/custom"
  if resolve_migration_restart_metadata >/dev/null 2>&1; then
    fail "custom legacy restart state guessed migration credentials"
  fi

  unset JINA_RESTART_CONTEXT_QUERY_PRINCIPAL_ID
  JINA_RESTART_TENANT=11111111-1111-4111-8111-111111111111
  resolve_context_query_principal_restart_metadata
  assert_equal \
    "$JINA_RESTART_CONTEXT_QUERY_PRINCIPAL_ID" \
    "tenant:11111111-1111-4111-8111-111111111111"

  assert_retained_database_targets \
    "postgres://runtime_login:runtime@127.0.0.1:55480/database" \
    "postgres://migration:migration@localhost:55480/database" \
    55480 \
    runtime_login
  if assert_retained_database_targets \
    "postgres://runtime_login:runtime@127.0.0.1:55480/database" \
    "postgres://migration:migration@127.0.0.1:55481/database" \
    55480 \
    runtime_login >/dev/null 2>&1; then
    fail "migration connection outside retained PostgreSQL was accepted"
  fi
)

test_process_only_restart() (
  # shellcheck source=scripts/dev-restart.sh
  source "$ROOT/scripts/dev-restart.sh"
  local_state="$TEST_TMP/restart"
  mkdir -p "$local_state/artifacts" "$local_state/codex" "$local_state/pageindex"
  printf '{}\n' >"$local_state/codex/auth.json"
  printf 'immutable-board-container\n' >"$local_state/container.sentinel"
  printf 'export JINA_INTERNAL_TOKEN=internal-token\nexport JINA_CONTEXT_TOKEN=query-token\n' \
    >"$local_state/local.env"
  chmod 600 "$local_state/local.env"
  cat >"$local_state/codex-bin" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  cat >"$local_state/pageindex-python" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$local_state/codex-bin" "$local_state/pageindex-python"
  : >"$local_state/pageindex/worker.py"
  printf 'old-api\n' >"$local_state/api.log"
  printf 'old-worker\n' >"$local_state/worker-snapshot.log"

  restart_file="$local_state/restart.env"
  {
    printf 'export JINA_RESTART_REPO=%q\n' "$ROOT"
    printf 'export JINA_RESTART_CONTAINER=%q\n' mock-postgres
    printf 'export JINA_RESTART_ENV_FILE=%q\n' "$local_state/local.env"
    printf 'export JINA_RESTART_DATABASE_URL=%q\n' \
      postgres://runtime_login:runtime-private@127.0.0.1:55480/database
    printf 'export JINA_RESTART_MIGRATION_DATABASE_URL=%q\n' \
      postgres://migration:private@127.0.0.1:55480/database
    printf 'export JINA_RESTART_RUNTIME_DB_USER=%q\n' runtime_login
    printf 'export JINA_RESTART_API_PORT=%q\n' 4180
    printf 'export JINA_RESTART_WORKER_PORT_BASE=%q\n' 8091
    printf 'export JINA_RESTART_PGPORT=%q\n' 55480
    printf 'export JINA_RESTART_TENANT=%q\n' 11111111-1111-4111-8111-111111111111
    printf 'export JINA_RESTART_INTERNAL_TOKEN=%q\n' internal-token
    printf 'export JINA_RESTART_CONTEXT_TOKEN=%q\n' query-token
    printf 'export JINA_RESTART_ARTIFACT_DIR=%q\n' "$local_state/artifacts"
    printf 'export JINA_RESTART_PAGEINDEX_SOURCE_ROOT=%q\n' "$local_state/pageindex"
    printf 'export JINA_RESTART_PAGEINDEX_PYTHON=%q\n' "$local_state/pageindex-python"
    printf 'export JINA_RESTART_PAGEINDEX_WORKER=%q\n' "$local_state/pageindex/worker.py"
    printf 'export JINA_RESTART_CODEX_HOME=%q\n' "$local_state/codex"
    printf 'export JINA_RESTART_CODEX_BINARY=%q\n' "$local_state/codex-bin"
    printf 'export JINA_RESTART_MODEL=%q\n' gpt-5.6-terra
    printf 'export JINA_RESTART_EFFORT=%q\n' low
    printf 'export JINA_RESTART_CONTEXT_TOKENS=%q\n' 128000
    printf 'export JINA_RESTART_COMPACT_TOKENS=%q\n' 96000
    printf 'export JINA_RESTART_AGENT_WORKERS=%q\n' 1
    printf 'export JINA_RESTART_AUDIT_WORKERS=%q\n' 1
    printf 'export JINA_RESTART_LOG_RETENTION=%q\n' 3
    printf 'export JINA_RESTART_GITHUB_TOKEN=%q\n' github-token
  } >"$restart_file"
  chmod 600 "$restart_file"

  before_container="$(cksum <"$local_state/container.sentinel")"
  before_environment="$(cksum <"$local_state/local.env")"
  before_restart="$(cksum <"$restart_file")"
  docker_calls="$local_state/docker.calls"
  lifecycle_calls="$local_state/lifecycle.calls"

  docker() {
    echo "$*" >>"$docker_calls"
    case "$*" in
      *com.jina.local-context.repo*) echo "$ROOT" ;;
      *State.Running*) echo true ;;
      *'{{.Id}}'*) echo mock-container-id ;;
      *) return 1 ;;
    esac
  }
  curl() {
    local argument
    for argument in "$@"; do
      if [[ "$argument" == *"/progress" ]]; then
        echo '{"buildId":"cb_retryable","status":"active","stages":[],"pages":[]}'
        return 0
      fi
    done
    echo '{"ok":true}'
  }
  jina_stop_recorded_processes() {
    echo "stop $*" >>"$lifecycle_calls"
  }
  jina_rotate_log() {
    echo "rotate $3" >>"$lifecycle_calls"
  }
  spawn_pid=9000
  jina_spawn_detached() {
    spawn_pid=$((spawn_pid + 1))
    echo "spawn $*" >>"$lifecycle_calls"
    if [[ "$*" == *"/apps/api/dist/dev-server.js"* ]]; then
      echo \
        "api-principals $JINA_CONTEXT_PRINCIPAL_ID $JINA_TENANT_ADMIN_PRINCIPALS" \
        >>"$lifecycle_calls"
    fi
    echo "$spawn_pid"
  }
  jina_wait_for_health() {
    echo "health $1" >>"$lifecycle_calls"
    return 0
  }
  verify_worker_topology() {
    echo "topology $2 $3" >>"$lifecycle_calls"
  }
  context_builds_json() {
    echo '{"builds":[{"id":"cb_retryable","status":"active","repository":"acme/context","ref":"main"}]}'
  }

  output="$(
    JINA_DEV_STATE_DIR="$local_state" \
      JINA_DEV_RESTART_FILE="$restart_file" \
      dev_restart_main
  )"
  assert_equal "$(cksum <"$local_state/container.sentinel")" "$before_container"
  assert_equal "$(cksum <"$local_state/local.env")" "$before_environment"
  assert_equal "$(cksum <"$restart_file")" "$before_restart"
  ! grep -Eq '(^| )(rm|stop|kill)( |$)' "$docker_calls" || fail "restart mutated the container"
  grep -q 'health http://127.0.0.1:4180/health' "$lifecycle_calls" ||
    fail "API health was not verified"
  grep -qx \
    'api-principals tenant:11111111-1111-4111-8111-111111111111 tenant:11111111-1111-4111-8111-111111111111' \
    "$lifecycle_calls" ||
    fail "legacy/default restart no longer uses the tenant principal"
  assert_equal "$(grep -c '^topology ' "$lifecycle_calls")" 6
  [[ "$output" == *"cb_retryable"* ]] || fail "active build was not made observable"
  [[ "$output" == *"PostgreSQL: mock-postgres (mock-container-id), preserved"* ]] ||
    fail "container preservation was not reported"
  [[ -f "$local_state/api.pid" ]] || fail "new API pid was not recorded"
  [[ -f "$local_state/worker-pageindex.pid" ]] || fail "new PageIndex pid was not recorded"

  : >"$docker_calls"
  : >"$lifecycle_calls"
  pnpm() {
    [[ "$*" == "build --force" ]] || fail "unexpected pnpm invocation: $*"
    echo "build" >>"$lifecycle_calls"
  }
  node() {
    if [[ "$1" == "$ROOT/packages/db/dist/migrate.js" ]]; then
      [[ "$2" == "--install-roles" ]] || fail "role installation flag is missing"
      [[ "$DATABASE_URL" == "postgres://migration:private@127.0.0.1:55480/database" ]] ||
        fail "migration did not receive the retained private connection"
      [[ "$CONTEXT_RUNTIME_DB_USER" == runtime_login ]] ||
        fail "migration did not receive the retained runtime role"
      echo "migrate schema-and-roles" >>"$lifecycle_calls"
      return 0
    fi
    command node "$@"
  }

  build_output="$(
    JINA_DEV_STATE_DIR="$local_state" \
      JINA_DEV_RESTART_FILE="$restart_file" \
      JINA_DEV_CONTEXT_QUERY_PRINCIPAL_ID=user:context-query@jina.internal \
      dev_restart_main --build
  )"
  build_line="$(grep -n '^build$' "$lifecycle_calls" | cut -d: -f1)"
  stop_line="$(grep -n '^stop ' "$lifecycle_calls" | head -1 | cut -d: -f1)"
  migrate_line="$(grep -n '^migrate schema-and-roles$' "$lifecycle_calls" | cut -d: -f1)"
  spawn_line="$(grep -n '^spawn ' "$lifecycle_calls" | head -1 | cut -d: -f1)"
  ((build_line < stop_line && stop_line < migrate_line && migrate_line < spawn_line)) ||
    fail "build/migration/process restart ordering is unsafe"
  assert_equal "$(grep -c '^migrate schema-and-roles$' "$lifecycle_calls")" 1
  [[ "$build_output" == *"applying current PostgreSQL schema and runtime grants"* ]] ||
    fail "explicit migration was not reported"
  [[ "$build_output" != *"postgres://migration:private"* ]] ||
    fail "migration credentials leaked to restart output"
  grep -qx 'export JINA_INTERNAL_TOKEN=internal-token' "$local_state/local.env" ||
    fail "query-principal override changed the internal credential"
  grep -qx 'export JINA_CONTEXT_TOKEN=query-token' "$local_state/local.env" ||
    fail "query-principal override changed the static Context credential"
  grep -qx \
    'export JINA_CONTEXT_PRINCIPAL_ID=user:context-query@jina.internal' \
    "$local_state/local.env" ||
    fail "sourceable environment did not retain the overridden Context query principal"
  grep -qx \
    'export JINA_RESTART_CONTEXT_QUERY_PRINCIPAL_ID=user:context-query@jina.internal' \
    "$restart_file" ||
    fail "private restart state did not retain the overridden Context query principal"
  grep -qx \
    'api-principals user:context-query@jina.internal tenant:11111111-1111-4111-8111-111111111111' \
    "$lifecycle_calls" ||
    fail "overridden query principal was not kept separate from the tenant administrator"
  [[ "$(cksum <"$local_state/local.env")" != "$before_environment" ]] ||
    fail "query-principal override was not written to the sourceable environment"
  [[ "$(cksum <"$restart_file")" != "$before_restart" ]] ||
    fail "query-principal override was not written to private restart state"
  assert_equal "$(stat -f '%Lp' "$local_state/local.env")" 600
  assert_equal "$(stat -f '%Lp' "$restart_file")" 600
)

test_local_context_query_principal_validation
test_pageindex_pin_alignment
test_pid_ownership
test_private_state_permissions
test_codex_runtime_home_isolates_mutable_state
test_dev_down_processes_only
test_dev_up_keeps_migration_credentials_restart_private
test_legacy_default_restart_metadata_is_upgradeable
test_process_only_restart
echo "dev restart tests passed"
