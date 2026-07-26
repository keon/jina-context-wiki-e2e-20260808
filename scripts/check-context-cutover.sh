#!/usr/bin/env bash
set -euo pipefail

readonly prohibited='@jina/context-graph|/context-graph|run-context-graph|context_graph_assert|context_graph_project|query_graph|jina_context_graph|CONTEXT_GRAPH_'

set +e
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  legacy_matches="$(
    git grep --line-number --ignore-case --extended-regexp "${prohibited}" -- \
      apps packages scripts \
      ':(exclude,glob)**/*.test.ts' \
      ':(exclude,glob)**/dist/**' \
      ':(exclude,glob)**/README.md' \
      ':(exclude,glob)**/.env.example' \
      ':(exclude)scripts/check-context-cutover.sh' \
      ':(exclude)packages/db/src/legacy-context-cutover.ts'
  )"
  legacy_search_status=$?
else
  legacy_matches="$(
    grep --recursive --line-number --ignore-case --extended-regexp \
      --exclude='*.test.ts' \
      --exclude='*.tsbuildinfo' \
      --exclude='README.md' \
      --exclude='.env.example' \
      --exclude='check-context-cutover.sh' \
      --exclude='legacy-context-cutover.ts' \
      --exclude-dir='dist' \
      --exclude-dir='.next' \
      --exclude-dir='.turbo' \
      --exclude-dir='node_modules' \
      "${prohibited}" apps packages scripts
  )"
  legacy_search_status=$?
fi
set -e
if ((legacy_search_status > 1)); then
  echo "Unable to scan production source for legacy context runtime vocabulary." >&2
  exit 1
fi
if [[ -n "${legacy_matches}" ]]; then
  printf '%s\n' "${legacy_matches}"
  echo "Legacy context runtime vocabulary remains in production source." >&2
  exit 1
fi

normal_retry_output="$(
  GCP_PROJECT_ID=jina-v2 GCP_REGION=us-central1 CLOUD_BUILD_ID=mock-build bash -c '
    gcloud() {
      if [[ "$1 $2 $3" == "run services describe" ]]; then return 1; fi
      return 0
    }
    export -f gcloud
    bash scripts/cloud-build-deploy.sh
  ' 2>&1 || true
)"
if [[ "${normal_retry_output}" != *"interrupted first cutover must resume in destructive mode"* ]]; then
  echo "Normal deployment did not fence an interrupted destructive cutover." >&2
  exit 1
fi

service_discovery_output="$(
  GCP_PROJECT_ID=jina-v2 GCP_REGION=us-central1 CLOUD_BUILD_ID=mock-build bash -c '
    gcloud() {
      if [[ "$1 $2 $3" == "run services list" ]]; then return 1; fi
      return 0
    }
    export -f gcloud
    bash scripts/cloud-build-deploy.sh
  ' 2>&1 || true
)"
if [[ "${service_discovery_output}" != *"Unable to obtain an authoritative Cloud Run service inventory"* ]]; then
  echo "Cloud Run control-plane failure was treated as service absence." >&2
  exit 1
fi

readonly mock_release_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
split_image_output="$(
  GCP_PROJECT_ID=jina-v2 \
    GCP_REGION=us-central1 \
    CLOUD_BUILD_ID=mock-build \
    IMAGE_TAG=latest \
    JINA_CONTEXT_CUTOVER=true \
    JINA_CONTEXT_CUTOVER_BACKUP_ID=1 \
    JINA_CONTEXT_CUTOVER_LEGACY_BACKUP_ID=2 \
    JINA_LEGACY_CUTOVER_TENANT_IDS=eff0efc9-b103-494a-b7a3-1ae7f95c2d26 \
    JINA_RELEASE_SHA="${mock_release_sha}" \
    JINA_BUILD_COMMIT_SHA="${mock_release_sha}" \
    bash -c '
      gcloud() {
        if [[ "$1 $2 $3" == "run services describe" ]]; then return 1; fi
        if [[ "$1 $2" == "builds describe" ]]; then printf "%s\n" "$JINA_RELEASE_SHA"; return 0; fi
        return 0
      }
      export -f gcloud
      bash scripts/cloud-build-deploy.sh
    ' 2>&1 || true
)"
if [[ "${split_image_output}" != *"must deploy images built by one explicit coordinated Cloud Build"* ]]; then
  echo "Destructive cutover accepted an image tag from another build." >&2
  exit 1
fi

run_stale_backup_case() {
  local service_list="$1"
  local marker_override="${2:-}"
  local mock_cutover_marker
  mock_cutover_marker="$(
    python3 -c 'import hashlib; print(hashlib.sha256(("a"*40+"|jina-463721:us-east1:jina-db|1|jina-v2:us-central1:jina-postgres|2").encode()).hexdigest()[:32])'
  )"
  if [[ -n "${marker_override}" ]]; then
    mock_cutover_marker="${marker_override}"
  fi
  MOCK_SERVICE_LIST="${service_list}" \
    MOCK_CUTOVER_MARKER="${mock_cutover_marker}" \
    GCP_PROJECT_ID=jina-v2 \
    GCP_REGION=us-central1 \
    CLOUD_BUILD_ID=mock-build \
    IMAGE_TAG=mock-build \
    CLOUD_SQL_INSTANCE=jina-463721:us-east1:jina-db \
    JINA_CONTEXT_CUTOVER=true \
    JINA_CONTEXT_CUTOVER_BACKUP_ID=1 \
    JINA_CONTEXT_CUTOVER_LEGACY_BACKUP_ID=2 \
    JINA_LEGACY_CUTOVER_TENANT_IDS=eff0efc9-b103-494a-b7a3-1ae7f95c2d26 \
    JINA_RELEASE_SHA="${mock_release_sha}" \
    JINA_BUILD_COMMIT_SHA="${mock_release_sha}" \
    bash -c '
      gcloud() {
        if [[ "$1 $2 $3" == "run services list" ]]; then
          printf "%b" "$MOCK_SERVICE_LIST"
          return 0
        fi
        if [[ "$1 $2 $3" == "run services describe" && "$4" == "jina-api" ]]; then
          printf "%s\n" "{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"env\":[{\"name\":\"GRAPH_API_TOKEN\",\"value\":\"set\"},{\"name\":\"GRAPH_INSTANCE_UNIX_SOCKET\",\"value\":\"/cloudsql/jina-v2:us-central1:jina-postgres\"},{\"name\":\"GRAPH_DB_NAME\",\"value\":\"jina\"},{\"name\":\"GRAPH_DB_USER\",\"value\":\"jina_app\"},{\"name\":\"GRAPH_DB_PASS\",\"valueFrom\":{\"secretKeyRef\":{\"name\":\"jina-db-password\",\"key\":\"latest\"}}}] }]}}}}"
          return 0
        fi
        if [[ "$1 $2" == "builds describe" ]]; then
          printf "%s\n" "$JINA_RELEASE_SHA"
          return 0
        fi
        if [[ "$1 $2 $3" == "sql backups describe" ]]; then
          if [[ "$4" == "1" ]]; then
            printf "%s\n" "{\"status\":\"SUCCESSFUL\",\"description\":\"pre-context-engine-primary-${JINA_RELEASE_SHA}\",\"endTime\":\"2020-01-01T00:00:00Z\"}"
          else
            printf "%s\n" "{\"status\":\"SUCCESSFUL\",\"description\":\"pre-context-engine-legacy-graph-${JINA_RELEASE_SHA}\",\"endTime\":\"2020-01-01T00:00:00Z\"}"
          fi
          return 0
        fi
        if [[ "$1 $2 $3 $4" == "run jobs describe jina-context-cutover-preflight" ]]; then
          printf "%s\n" "{\"metadata\":{\"labels\":{\"jina_cutover_marker\":\"${MOCK_CUTOVER_MARKER}\"}}}"
          return 0
        fi
        if [[ "$1 $2 $3 $4" == "run jobs execute jina-context-cutover-preflight" ]]; then
          return 17
        fi
        return 0
      }
      export -f gcloud
      bash scripts/cloud-build-deploy.sh
    ' 2>&1 || true
}

initial_stale_backup_output="$(
  run_stale_backup_case $'jina-api\njina-context-graph-worker\n'
)"
if [[ "${initial_stale_backup_output}" != *"backup completion must be within the last six hours"* ]]; then
  echo "Initial destructive cutover accepted stale backup evidence." >&2
  exit 1
fi

resumed_stale_backup_output="$(run_stale_backup_case "")"
if [[ "${resumed_stale_backup_output}" != *"Starting destructive context cutover"* ||
      "${resumed_stale_backup_output}" != *"Backup freshness required: false"* ]]; then
  echo "Interrupted destructive cutover could not resume with its original SHA-bound backups." >&2
  exit 1
fi

unmarked_outage_output="$(run_stale_backup_case $'jina-context-graph-worker\n' "wrong-marker")"
if [[ "${unmarked_outage_output}" != *"marker does not match the requested release and backups"* ]]; then
  echo "A service outage without a matching durable marker was treated as a cutover retry." >&2
  exit 1
fi

if ! grep -Fq -- '--labels="jina_cutover_marker=' scripts/cloud-build-deploy.sh ||
  grep -Fq -- '--update-labels="jina_cutover_marker=' scripts/cloud-build-deploy.sh; then
  echo "Cutover marker does not use the Cloud Run jobs deploy label flag." >&2
  exit 1
fi

if grep --quiet --extended-regexp '_JINA_CONTEXT_CUTOVER|_JINA_RELEASE_SHA|_JINA_LEGACY_CUTOVER' cloudbuild.deploy.yaml; then
  echo "Split-image deployment config exposes destructive cutover substitutions." >&2
  exit 1
fi
