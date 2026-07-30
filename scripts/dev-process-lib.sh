#!/usr/bin/env bash
# Process lifecycle primitives shared by the local stack launchers.
#
# This file has no side effects when sourced. Every signal is preceded by an
# exact command-path ownership check, and no helper removes containers, state,
# artifacts, or environment files.

jina_validate_safe_directory() {
  local label="$1" directory="$2"
  if [[ "$directory" != /* || "$directory" == "/" ]]; then
    echo "Refusing unsafe $label: $directory" >&2
    return 2
  fi
}

jina_resolve_local_context_query_principal() {
  local tenant_id="$1" configured="${2:-}" label="${3:-JINA_DEV_CONTEXT_QUERY_PRINCIPAL_ID}"
  local tenant_id_lower principal_lower
  tenant_id_lower="$(printf '%s' "$tenant_id" | tr '[:upper:]' '[:lower:]')"
  local tenant_principal="tenant:$tenant_id_lower" principal="${configured:-tenant:$tenant_id}"
  principal_lower="$(printf '%s' "$principal" | tr '[:upper:]' '[:lower:]')"
  if [[ "$principal_lower" == "$tenant_principal" ]]; then
    printf '%s\n' "$tenant_principal"
    return 0
  fi
  if [[ "$principal" =~ ^user:[^[:space:]@]+@[^[:space:]@]+$ ]]; then
    printf '%s\n' "$principal_lower"
    return 0
  fi
  echo "$label must be the local tenant principal or a non-admin user:<name>@<domain> principal" >&2
  return 2
}

jina_prepare_codex_runtime_home() {
  local session_home="$1" runtime_home="$2"
  jina_validate_safe_directory CODEX_HOME "$session_home"
  jina_validate_safe_directory JINA_DEV_CODEX_RUNTIME_HOME "$runtime_home"
  [[ -f "$session_home/auth.json" ]] || {
    echo "No current Codex session at $session_home/auth.json; run 'codex login'" >&2
    return 1
  }
  if [[ "$session_home" == "$runtime_home" ]]; then
    return 0
  fi

  mkdir -p "$runtime_home"
  chmod 700 "$runtime_home"
  local runtime_auth="$runtime_home/auth.json" expected_auth="$session_home/auth.json"
  if [[ -e "$runtime_auth" || -L "$runtime_auth" ]]; then
    if [[ ! -L "$runtime_auth" || "$(readlink "$runtime_auth")" != "$expected_auth" ]]; then
      echo "Refusing to replace unexpected Codex runtime credential at $runtime_auth" >&2
      return 1
    fi
  else
    ln -s "$expected_auth" "$runtime_auth"
  fi
}

jina_process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

jina_process_alive() {
  kill -0 "$1" 2>/dev/null
}

jina_signal_process() {
  kill "-$1" "$2" 2>/dev/null
}

jina_process_sleep() {
  sleep "$1"
}

jina_expected_process_path() {
  local repository="$1" label="$2"
  case "$label" in
    api) printf '%s\n' "$repository/apps/api/dist/dev-server.js" ;;
    worker-*) printf '%s\n' "$repository/apps/worker/dist/server.js" ;;
    *) return 1 ;;
  esac
}

jina_stop_recorded_process() {
  local repository="$1" pid_file="$2" grace_tenths="${3:-120}"
  local pid="" command expected label
  label="$(basename "$pid_file" .pid)"
  if ! expected="$(jina_expected_process_path "$repository" "$label")"; then
    echo "refusing unrecognized local-stack pid file $pid_file" >&2
    return 2
  fi
  read -r pid <"$pid_file" 2>/dev/null || true
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    rm -f -- "$pid_file"
    return 0
  fi
  command="$(jina_process_command "$pid")"
  if [[ "$command" != *"$expected"* ]]; then
    [[ -n "$command" ]] &&
      echo "left stale $label pid $pid alone (command does not belong to this stack)" >&2
    rm -f -- "$pid_file"
    return 0
  fi
  if ! jina_signal_process TERM "$pid"; then
    rm -f -- "$pid_file"
    return 0
  fi
  local attempt
  for ((attempt = 0; attempt < grace_tenths; attempt += 1)); do
    if ! jina_process_alive "$pid"; then
      rm -f -- "$pid_file"
      echo "stopped $label ($pid)"
      return 0
    fi
    command="$(jina_process_command "$pid")"
    if [[ "$command" != *"$expected"* ]]; then
      rm -f -- "$pid_file"
      echo "left reused $label pid $pid alone (ownership changed after SIGTERM)" >&2
      return 0
    fi
    jina_process_sleep 0.1
  done
  command="$(jina_process_command "$pid")"
  if [[ "$command" != *"$expected"* ]]; then
    rm -f -- "$pid_file"
    echo "left reused $label pid $pid alone (ownership changed before SIGKILL)" >&2
    return 0
  fi
  jina_signal_process KILL "$pid" || true
  rm -f -- "$pid_file"
  echo "stopped $label ($pid) after grace period"
}

jina_stop_recorded_processes() {
  local repository="$1" state_directory="$2" grace_tenths="${3:-120}"
  local pid_file
  [[ -d "$state_directory" ]] || return 0
  # Workers release active Board leases through the still-running API before
  # the API itself receives SIGTERM.
  for pid_file in "$state_directory"/worker-*.pid; do
    [[ -f "$pid_file" ]] || continue
    jina_stop_recorded_process "$repository" "$pid_file" "$grace_tenths"
  done
  if [[ -f "$state_directory/api.pid" ]]; then
    jina_stop_recorded_process "$repository" "$state_directory/api.pid" "$grace_tenths"
  fi
}

jina_rotate_log() {
  local state_directory="$1" retention="$2" name="$3"
  local current="$state_directory/$name.log" timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  [[ -s "$current" ]] && mv "$current" "$state_directory/$name.$timestamp.log"
  local archives=()
  shopt -s nullglob
  archives=("$state_directory/$name".20??????T??????Z.log)
  shopt -u nullglob
  while ((${#archives[@]} > retention)); do
    rm -f -- "${archives[0]}"
    archives=("${archives[@]:1}")
  done
}

jina_spawn_detached() {
  local log_file="$1"
  shift
  python3 - "$log_file" "$@" <<'PY'
import os
import subprocess
import sys

log = open(sys.argv[1], "ab", buffering=0)
process = subprocess.Popen(
    sys.argv[2:],
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=subprocess.STDOUT,
    env=os.environ.copy(),
    start_new_session=True,
    close_fds=True,
)
print(process.pid)
PY
}

jina_wait_for_health() {
  local url="$1" attempts="${2:-60}" delay_seconds="${3:-1}"
  local attempt
  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    jina_process_sleep "$delay_seconds"
  done
  return 1
}
