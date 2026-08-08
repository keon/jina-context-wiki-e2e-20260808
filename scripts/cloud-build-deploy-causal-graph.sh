#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${CLOUD_BUILD_ID:?CLOUD_BUILD_ID is required}"

gar="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/jina"
api_image="${gar}/api:${CLOUD_BUILD_ID}"
worker_image="${gar}/worker:${CLOUD_BUILD_ID}"
api_service="jina-api"
worker_service="jina-causal-graph-worker"
worker_service_account="jina-causal-graph-worker@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
migration_service_account="jina-migration@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
cloud_sql_instance="${CLOUD_SQL_INSTANCE:-${GCP_PROJECT_ID}:${GCP_REGION}:jina-postgres}"
db_name="${JINA_DB_NAME:-jina}"
db_user="${JINA_DB_USER:-jina_app}"
migration_db_user="${JINA_MIGRATION_DB_USER:-jina_app}"
migration_db_pass_secret="${JINA_MIGRATION_DB_PASS_SECRET:-jina-primary-owner-db-password:3}"
worker_release_secret="${JINA_CAUSAL_GRAPH_WORKER_RELEASE_SECRET:-jina-causal-graph-worker-release-credential}"
product_api_url="${JINA_PRODUCT_API_URL:-https://api.usejina.com}"
product_internal_token_secret="${JINA_PRODUCT_INTERNAL_API_TOKEN_SECRET:-jina-product-internal-api-token}"
internal_api_token_secret_version="${JINA_INTERNAL_API_TOKEN_SECRET_VERSION:-1}"
product_internal_token_secret_version="${JINA_PRODUCT_INTERNAL_API_TOKEN_SECRET_VERSION:-1}"
daytona_api_key_secret_version="${JINA_DAYTONA_API_KEY_SECRET_VERSION:-1}"
openai_api_key_secret_version="${JINA_OPENAI_API_KEY_SECRET_VERSION:-1}"
github_app_id_secret_version="${JINA_GITHUB_APP_ID_SECRET_VERSION:-1}"
github_app_private_key_secret_version="${JINA_GITHUB_APP_PRIVATE_KEY_SECRET_VERSION:-1}"
github_clone_token_secret_version="${JINA_GITHUB_CLONE_TOKEN_SECRET_VERSION:-1}"
worker_memory="${JINA_CAUSAL_GRAPH_WORKER_MEMORY:-1Gi}"
worker_drain_timeout_seconds="${JINA_WORKER_DRAIN_TIMEOUT_SECONDS:-1800}"
daytona_snapshot="${JINA_CAUSAL_GRAPH_DAYTONA_SNAPSHOT:-}"
daytona_image="${JINA_CAUSAL_GRAPH_DAYTONA_IMAGE:-}"
daytona_model_secret="${JINA_CAUSAL_GRAPH_DAYTONA_MODEL_SECRET:-}"
release_suffix="$(printf '%s' "${CLOUD_BUILD_ID}" | tr '[:upper:]_' '[:lower:]-')"
short_release_id="$(printf '%s' "${release_suffix}" | tr -d '-' | cut -c1-16)"
candidate_tag="cg-${short_release_id}"
worker_revision="${worker_service}-${release_suffix}"
release_control_job="jina-causal-release-${short_release_id}"
production_preflight_path="/opt/jina/context-production-preflight.mjs"
causal_topics="run-causal-graph-history|run-causal-graph-derive|run-causal-graph-publication"
release_credential="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"

if [[ -n "${daytona_snapshot}" && -n "${daytona_image}" ]] || [[ -z "${daytona_snapshot}" && -z "${daytona_image}" ]]; then
  echo "Exactly one JINA_CAUSAL_GRAPH_DAYTONA_SNAPSHOT or JINA_CAUSAL_GRAPH_DAYTONA_IMAGE is required" >&2
  exit 2
fi
if [[ -z "${daytona_model_secret}" ]]; then
  echo "JINA_CAUSAL_GRAPH_DAYTONA_MODEL_SECRET is required" >&2
  exit 2
fi
if [[ -n "${daytona_image}" && ! "${daytona_image}" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "JINA_CAUSAL_GRAPH_DAYTONA_IMAGE must be pinned by sha256 digest" >&2
  exit 2
fi
if [[ ! "${release_suffix}" =~ ^[a-z0-9][a-z0-9.-]{0,62}$ ]]; then
  echo "CLOUD_BUILD_ID cannot form a valid Cloud Run revision suffix" >&2
  exit 2
fi
if [[ ! "${worker_drain_timeout_seconds}" =~ ^[0-9]+$ ]] ||
  (( worker_drain_timeout_seconds < 60 || worker_drain_timeout_seconds > 14400 )); then
  echo "JINA_WORKER_DRAIN_TIMEOUT_SECONDS must be an integer between 60 and 14400" >&2
  exit 2
fi
release_control_task_timeout_seconds=$((worker_drain_timeout_seconds + 600))
if [[ ! "${migration_db_pass_secret}" =~ ^[A-Za-z][A-Za-z0-9_-]{0,254}:[1-9][0-9]*$ ]]; then
  echo "JINA_MIGRATION_DB_PASS_SECRET must use an explicit numeric version" >&2
  exit 2
fi
for secret_version_name in \
  internal_api_token_secret_version \
  product_internal_token_secret_version \
  daytona_api_key_secret_version \
  openai_api_key_secret_version \
  github_app_id_secret_version \
  github_app_private_key_secret_version \
  github_clone_token_secret_version; do
  if [[ ! "${!secret_version_name}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${secret_version_name} must be a positive numeric Secret Manager version" >&2
    exit 2
  fi
done
if [[ ! "${product_api_url}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^[:space:]]*)?$ ]]; then
  echo "JINA_PRODUCT_API_URL must be an HTTPS URL" >&2
  exit 2
fi
if [[ ! "${product_internal_token_secret}" =~ ^[A-Za-z][A-Za-z0-9_-]{0,254}$ ]]; then
  echo "JINA_PRODUCT_INTERNAL_API_TOKEN_SECRET must be a Secret Manager secret name" >&2
  exit 2
fi

require_enabled_secret_version() {
  local secret_spec="$1"
  local secret_name="${secret_spec%%:*}"
  local secret_version="${secret_spec#*:}"
  local secret_state
  if ! secret_state="$(gcloud secrets versions describe "${secret_version}" \
    --secret="${secret_name}" \
    --project="${GCP_PROJECT_ID}" \
    --format='value(state)')"; then
    echo "Secret ${secret_name} version ${secret_version} is missing or unreadable" >&2
    exit 2
  fi
  if [[ "${secret_state}" != "ENABLED" ]]; then
    echo "Secret ${secret_name} version ${secret_version} is not ENABLED (state=${secret_state:-unknown})" >&2
    exit 2
  fi
}

gcloud iam service-accounts describe "${worker_service_account}" --project="${GCP_PROJECT_ID}" >/dev/null
gcloud iam service-accounts describe "${migration_service_account}" --project="${GCP_PROJECT_ID}" >/dev/null
gcloud secrets describe "${worker_release_secret}" --project="${GCP_PROJECT_ID}" >/dev/null
for secret_spec in \
  "${migration_db_pass_secret}" \
  "jina-internal-api-token:${internal_api_token_secret_version}" \
  "${product_internal_token_secret}:${product_internal_token_secret_version}" \
  "jina-daytona-api-key:${daytona_api_key_secret_version}" \
  "jina-openai-api-key:${openai_api_key_secret_version}" \
  "jina-github-app-id:${github_app_id_secret_version}" \
  "jina-github-app-private-key:${github_app_private_key_secret_version}" \
  "jina-github-clone-token:${github_clone_token_secret_version}"; do
  require_enabled_secret_version "${secret_spec}"
done

# This migration owns only the two immutable causal graph release tables and
# the causal worker release-control row. The later identity cutover takes the
# shared deployment lease and briefly closes Board admission, but never changes
# the accepted Context/task generation tuple.
gcloud run jobs deploy jina-causal-graph-migrate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --service-account="${migration_service_account}" \
  --set-cloudsql-instances="${cloud_sql_instance}" \
  --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${migration_db_user}~RUNTIME_DB_USER=${db_user}" \
  --set-secrets="DB_PASS=${migration_db_pass_secret}" \
  --args=node_modules/@jina/db/dist/migrate-causal-graph.js \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=10m \
  --quiet
gcloud run jobs execute jina-causal-graph-migrate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --wait

# The API is a shared control plane owned exclusively by the coordinated main
# release. Causal releases consume its stable identity but cannot deploy a
# revision, create a tag, or change traffic. Any new causal API contract must
# therefore reach production through cloudbuild.yaml before this lane runs.
api_url="$(gcloud run services describe "${api_service}" --project="${GCP_PROJECT_ID}" --region="${GCP_REGION}" --format='value(status.url)')"
if [[ -z "${api_url}" ]]; then
  echo "Stable shared API URL is unavailable; deploy the coordinated main release first" >&2
  exit 2
fi
curl --fail --silent --show-error "${api_url}/health" >/dev/null

service_exists="false"
previous_revision=""
previous_release_id=""
previous_release_secret_version=""
if gcloud run services describe "${worker_service}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" >/dev/null 2>&1; then
  service_exists="true"
fi

capture_previous_causal_release() {
  # The rollback target is mutable deployment state. Read it only while this
  # release owns the shared lease; a causal release may legitimately finish
  # while this build prepares its zero-traffic candidate.
  if [[ "${service_exists}" != "true" ]]; then return 0; fi
  previous_revision="$(
    gcloud run services describe "${worker_service}" \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --format=json | python3 -c '
import json, sys
service = json.load(sys.stdin)
serving = [
    item.get("revisionName", "")
    for item in service.get("status", {}).get("traffic", [])
    if int(item.get("percent", 0)) == 100 and item.get("revisionName")
]
if len(set(serving)) != 1:
    raise SystemExit("causal worker must have exactly one 100% serving revision before release")
print(serving[0])
'
  )"
  previous_identity="$(
    gcloud run revisions describe "${previous_revision}" \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --format=json | python3 -c '
import json, sys
revision = json.load(sys.stdin)
environment = {
    item.get("name"): item
    for item in revision.get("spec", {}).get("containers", [{}])[0].get("env", [])
}
release_id = environment.get("JINA_WORKER_RELEASE_ID", {}).get("value", "")
secret_ref = environment.get("JINA_WORKER_RELEASE_CREDENTIAL", {}).get("valueFrom", {}).get("secretKeyRef", {})
secret_name = secret_ref.get("name", "")
secret_version = secret_ref.get("key", "")
if not release_id or not secret_name or not secret_version:
    raise SystemExit("serving causal worker is missing its release identity or credential binding")
print("\t".join((release_id, secret_name, secret_version)))
'
  )"
  IFS=$'\t' read -r previous_release_id previous_release_secret previous_release_secret_version <<<"${previous_identity}"
  if [[ "${previous_release_secret}" != "${worker_release_secret}" ]]; then
    echo "Serving causal credential uses unexpected Secret ${previous_release_secret}" >&2
    exit 2
  fi
  require_enabled_secret_version "${previous_release_secret}:${previous_release_secret_version}"
}

release_secret_version_name="$(
  printf '%s' "${release_credential}" |
    gcloud secrets versions add "${worker_release_secret}" \
      --project="${GCP_PROJECT_ID}" \
      --data-file=- \
      --format='value(name)'
)"
release_secret_version="${release_secret_version_name##*/}"
if [[ ! "${release_secret_version}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Causal graph worker credential did not produce a Secret Manager version" >&2
  exit 2
fi

worker_environment="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_API_URL=${api_url}~JINA_PRODUCT_API_URL=${product_api_url}~JINA_WORKER_CLAIM_MODE=enabled~WORKER_TOPICS=${causal_topics}~JINA_WORKER_RELEASE_ID=${CLOUD_BUILD_ID}~JINA_REQUIRE_GITHUB_INSTALLATION=false~CONTEXT_API_TIMEOUT_MS=7800000~CONTEXT_COMPLETION_TIMEOUT_MS=600000~CONTEXT_GITHUB_HISTORY_LIMIT=500~CONTEXT_GIT_HISTORY_LIMIT=5000~CONTEXT_BOARD_EXECUTOR=daytona~CONTEXT_DAYTONA_MODEL_SECRET=${daytona_model_secret}~CONTEXT_DAYTONA_MODEL_SECRET_ENV=OPENAI_API_KEY~CONTEXT_DAYTONA_MODEL_DOMAINS=api.openai.com~CONTEXT_CODEX_MODEL=gpt-5.6-terra~CONTEXT_CODEX_EFFORT=medium~CONTEXT_CODEX_VERBOSITY=high~CONTEXT_CODEX_CONTEXT_TOKENS=128000~CONTEXT_CODEX_COMPACT_TOKENS=96000~CAUSAL_GRAPH_CODEX_MODEL=gpt-5.6-terra~CAUSAL_GRAPH_DERIVE_SECONDS=900"
if [[ -n "${daytona_snapshot}" ]]; then
  worker_environment+="~CONTEXT_DAYTONA_SNAPSHOT=${daytona_snapshot}"
else
  worker_environment+="~CONTEXT_DAYTONA_IMAGE=${daytona_image}"
fi

# Cloud Run does not accept --no-traffic while creating a service. A first
# causal worker revision may receive traffic, but it still cannot claim work:
# its release id and credential are not activated until the job below commits
# them to the causal-only release-control table. Existing services keep the
# normal zero-traffic candidate path.
worker_traffic_args=(--tag="${candidate_tag}")
if [[ "${service_exists}" == "true" ]]; then
  worker_traffic_args=(--no-traffic --tag="${candidate_tag}")
fi

gcloud run deploy "${worker_service}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${worker_image}" \
  --no-allow-unauthenticated \
  --service-account="${worker_service_account}" \
  --concurrency=1 \
  --memory="${worker_memory}" \
  --timeout=300 \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --set-env-vars="${worker_environment}" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:${internal_api_token_secret_version},JINA_PRODUCT_INTERNAL_API_TOKEN=${product_internal_token_secret}:${product_internal_token_secret_version},JINA_WORKER_RELEASE_CREDENTIAL=${worker_release_secret}:${release_secret_version},DAYTONA_API_KEY=jina-daytona-api-key:${daytona_api_key_secret_version},JINA_MANAGED_MODEL_API_KEY=jina-openai-api-key:${openai_api_key_secret_version},CAUSAL_GRAPH_OPENAI_API_KEY=jina-openai-api-key:${openai_api_key_secret_version},GITHUB_APP_ID=jina-github-app-id:${github_app_id_secret_version},GITHUB_APP_PRIVATE_KEY=jina-github-app-private-key:${github_app_private_key_secret_version},GITHUB_CLONE_TOKEN=jina-github-clone-token:${github_clone_token_secret_version}" \
  "${worker_traffic_args[@]}" \
  --revision-suffix="${release_suffix}" \
  --quiet

observed_topics="$(
  gcloud run revisions describe "${worker_revision}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format=json | python3 -c '
import json, sys
revision = json.load(sys.stdin)
environment = revision["spec"]["containers"][0].get("env", [])
print(next((item.get("value", "") for item in environment if item.get("name") == "WORKER_TOPICS"), ""))
'
)"
if [[ "${observed_topics}" != "${causal_topics}" ]]; then
  echo "Causal graph worker topic isolation failed: ${observed_topics}" >&2
  exit 2
fi

activate_causal_release() {
  local target_release_id="$1"
  local target_revision="$2"
  local target_secret_version="$3"
  gcloud run jobs deploy jina-causal-graph-release-activate \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --image="${api_image}" \
    --service-account="${migration_service_account}" \
    --set-cloudsql-instances="${cloud_sql_instance}" \
    --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${migration_db_user}~RUNTIME_DB_USER=${db_user}~JINA_CAUSAL_GRAPH_RELEASE_ID=${target_release_id}~JINA_CAUSAL_GRAPH_WORKER_REVISION=${target_revision}" \
    --set-secrets="DB_PASS=${migration_db_pass_secret},JINA_CAUSAL_GRAPH_RELEASE_CREDENTIAL=${worker_release_secret}:${target_secret_version}" \
    --args=node_modules/@jina/db/dist/activate-causal-graph-release.js \
    --tasks=1 \
    --max-retries=0 \
    --task-timeout=10m \
    --quiet
  gcloud run jobs execute jina-causal-graph-release-activate \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --wait
}

route_causal_revision() {
  local target_revision="$1"
  gcloud run services update-traffic "${worker_service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --to-revisions="${target_revision}=100" \
    --clear-tags \
    --quiet
}

run_release_control() {
  local action="$1"
  gcloud run jobs execute "${release_control_job}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --args="${production_preflight_path},${action}" \
    --wait
}

retry_operation() {
  local description="$1"
  shift
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then return 0; fi
    echo "${description} failed (attempt ${attempt}/3)" >&2
    if (( attempt < 3 )); then sleep 5; fi
  done
  return 1
}

release_lease_acquired="false"
claim_admission_closed="false"
causal_release_activated="false"
causal_activation_uncertain="false"
new_traffic_routed="false"
release_renewal_pid=""

start_release_renewal() {
  local deployment_pid="$$"
  (
    while sleep 300; do
      if ! run_release_control "release-renew"; then
        echo "Causal deployment lease renewal failed" >&2
        kill -TERM "${deployment_pid}"
        exit 1
      fi
    done
  ) &
  release_renewal_pid="$!"
}

stop_release_renewal() {
  if [[ -n "${release_renewal_pid}" ]]; then
    kill "${release_renewal_pid}" 2>/dev/null || true
    wait "${release_renewal_pid}" 2>/dev/null || true
    release_renewal_pid=""
  fi
}

cleanup_failed_causal_release() {
  local status="$?"
  trap - EXIT
  stop_release_renewal
  if [[ "${status}" -ne 0 ]]; then
    local recovery_ok="true"
    if [[ ("${causal_release_activated}" == "true" || "${causal_activation_uncertain}" == "true") &&
      "${new_traffic_routed}" != "true" ]]; then
      if [[ -n "${previous_revision}" ]] &&
        retry_operation \
          "restore prior causal release identity" \
          activate_causal_release \
          "${previous_release_id}" \
          "${previous_revision}" \
          "${previous_release_secret_version}" &&
        retry_operation "restore prior causal traffic" route_causal_revision "${previous_revision}"; then
        causal_release_activated="false"
        causal_activation_uncertain="false"
      else
        recovery_ok="false"
        echo "Causal identity changed but prior identity/traffic could not be restored; shared claim admission remains closed" >&2
      fi
    fi
    if [[ "${claim_admission_closed}" == "true" && "${recovery_ok}" == "true" ]]; then
      if retry_operation "reopen shared worker admission" run_release_control "worker-resume"; then
        claim_admission_closed="false"
      else
        recovery_ok="false"
      fi
    fi
    if [[ "${release_lease_acquired}" == "true" && "${recovery_ok}" == "true" ]]; then
      if retry_operation "release causal deployment lease" run_release_control "release-release"; then
        release_lease_acquired="false"
      fi
    fi
  fi
  exit "${status}"
}
trap cleanup_failed_causal_release EXIT

# Use the causal generation credential as this release's shared deployment
# credential as well. It must remain enabled for the serving causal worker, so
# rollback evidence does not depend on a disposable lease-only Secret version.
release_control_env="^~^CLOUD_BUILD_ID=${CLOUD_BUILD_ID}~JINA_WORKER_RELEASE_ID=${CLOUD_BUILD_ID}~JINA_DEPLOYMENT_LEASE_SECONDS=1800~JINA_WORKER_DRAIN_TIMEOUT_SECONDS=${worker_drain_timeout_seconds}~CONTEXT_RUNTIME_DB_USER=${db_user}~INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${migration_db_user}"
gcloud run jobs deploy "${release_control_job}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --service-account="${migration_service_account}" \
  --set-cloudsql-instances="${cloud_sql_instance}" \
  --set-env-vars="${release_control_env}" \
  --set-secrets="DB_PASS=${migration_db_pass_secret},JINA_WORKER_RELEASE_CREDENTIAL=${worker_release_secret}:${release_secret_version}" \
  --command=node \
  --args="${production_preflight_path},release-acquire" \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout="${release_control_task_timeout_seconds}s" \
  --quiet

run_release_control "release-acquire"
release_lease_acquired="true"
start_release_renewal
capture_previous_causal_release
run_release_control "worker-drain"
claim_admission_closed="true"
# Unlike the coordinated schema release, causal-only cutover preserves the
# current Context/task generation tuple. It waits for zero Board attempts while
# worker_accepts_claims=false, then switches only the causal identity.
run_release_control "board-await-quiescence"
run_release_control "board-verify"

# Set uncertainty before the remote execution: the activation transaction can
# commit even when Cloud Run loses its completion acknowledgement. Cleanup must
# restore the prior identity before it may reopen shared admission in that case.
causal_activation_uncertain="true"
activate_causal_release "${CLOUD_BUILD_ID}" "${worker_revision}" "${release_secret_version}"
causal_release_activated="true"
causal_activation_uncertain="false"
retry_operation "route causal candidate" route_causal_revision "${worker_revision}"
new_traffic_routed="true"
retry_operation "reopen shared worker admission" run_release_control "worker-resume"
claim_admission_closed="false"
retry_operation "release causal deployment lease" run_release_control "release-release"
release_lease_acquired="false"
stop_release_renewal
trap - EXIT

echo "Causal graph release ${CLOUD_BUILD_ID} deployed under the shared admission lease without changing the shared API or Context/task release identity"
