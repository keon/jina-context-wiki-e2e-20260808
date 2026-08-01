#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${CLOUD_BUILD_ID:?CLOUD_BUILD_ID is required}"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud-release-cleanup-lib.sh"

gar="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/jina"
image_tag="${IMAGE_TAG:-${CLOUD_BUILD_ID}}"
api_image="${gar}/api:${image_tag}"
worker_image="${gar}/worker:${image_tag}"
dashboard_image="${gar}/dashboard:${image_tag}"
admin_image="${gar}/admin:${image_tag}"
api_service_account="jina-api-runtime@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
context_worker_service_account="jina-context-worker@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
task_worker_service_account="jina-task-worker@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
dashboard_service_account="jina-dashboard@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
admin_service_account="jina-admin@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
acceptance_service_account="jina-acceptance@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
trigger_acceptance_service_account="jina-trigger-acceptance@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
migration_service_account="jina-migration@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
build_service_account="jina-cloud-build-deployer@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
cloud_sql_instance="${CLOUD_SQL_INSTANCE:-${GCP_PROJECT_ID}:${GCP_REGION}:jina-postgres}"
tenancy_mode="${JINA_TENANCY_MODE:-fixed}"
db_name="${JINA_DB_NAME:-jina}"
db_user="${JINA_DB_USER:-jina_app}"
db_pass_secret="${JINA_DB_PASS_SECRET:-jina-db-password:latest}"
migration_db_user="${JINA_MIGRATION_DB_USER:-jina_app}"
migration_db_pass_secret="${JINA_MIGRATION_DB_PASS_SECRET:-jina-primary-owner-db-password:latest}"
# Jina v1 owns the migration login's password; this is where it keeps it.
shared_owner_secret_project="${JINA_SHARED_OWNER_SECRET_PROJECT:-jina-463721}"
shared_owner_secret="${JINA_SHARED_OWNER_SECRET:-jina-database-url}"
fixed_tenant_id="${JINA_FIXED_TENANT_ID:-omlabs}"
acceptance_repository="${JINA_ACCEPTANCE_REPOSITORY:-omxyz/jina-context-graph-e2e}"
acceptance_github_installation_id="${JINA_ACCEPTANCE_GITHUB_INSTALLATION_ID:-140435029}"
trigger_acceptance_github_app_id_secret="${JINA_TRIGGER_ACCEPTANCE_GITHUB_APP_ID_SECRET:-jina-trigger-acceptance-github-app-id}"
trigger_acceptance_github_app_private_key_secret="${JINA_TRIGGER_ACCEPTANCE_GITHUB_APP_PRIVATE_KEY_SECRET:-jina-trigger-acceptance-github-app-private-key}"
trigger_acceptance_github_installation_id="${JINA_TRIGGER_ACCEPTANCE_GITHUB_INSTALLATION_ID:-150069172}"
api_min_instances="${JINA_API_MIN_INSTANCES:-1}"
api_max_instances="${JINA_API_MAX_INSTANCES:-1}"
api_concurrency="${JINA_API_CONCURRENCY:-10}"
api_db_pool_max="${JINA_API_DB_POOL_MAX:-3}"
api_cpu="${JINA_API_CPU:-1}"
api_memory="${JINA_API_MEMORY:-1Gi}"
api_request_timeout_seconds="${JINA_API_REQUEST_TIMEOUT_SECONDS:-3600}"
context_api_timeout_ms="${JINA_CONTEXT_API_TIMEOUT_MS:-7800000}"
context_completion_timeout_ms="${JINA_CONTEXT_COMPLETION_TIMEOUT_MS:-600000}"
context_worker_lease_ms="${JINA_CONTEXT_WORKER_LEASE_MS:-9000000}"
context_codex_context_tokens="${JINA_CONTEXT_CODEX_CONTEXT_TOKENS:-128000}"
context_codex_compact_tokens="${JINA_CONTEXT_CODEX_COMPACT_TOKENS:-96000}"
acceptance_derivation_budget_seconds="${JINA_ACCEPTANCE_DERIVATION_BUDGET_SECONDS:-10800}"
acceptance_derivation_token_budget="${JINA_ACCEPTANCE_DERIVATION_TOKEN_BUDGET:-24000000}"
acceptance_timeout_ms="${JINA_ACCEPTANCE_TIMEOUT_MS:-10800000}"
acceptance_job_timeout_seconds="${JINA_ACCEPTANCE_JOB_TIMEOUT_SECONDS:-11700}"
deployment_acceptance_mode="${JINA_DEPLOYMENT_ACCEPTANCE_MODE:-full}"
context_worker_memory="${JINA_CONTEXT_WORKER_MEMORY:-1Gi}"
context_artifact_bucket="${JINA_CONTEXT_GCS_BUCKET:-${GCP_PROJECT_ID}-jina-context-artifacts}"
worker_release_secret="${JINA_WORKER_RELEASE_SECRET:-jina-worker-release-credential}"
context_daytona_snapshot="${JINA_CONTEXT_DAYTONA_SNAPSHOT:-}"
context_daytona_image="${JINA_CONTEXT_DAYTONA_IMAGE:-}"
context_daytona_model_secret="${JINA_CONTEXT_DAYTONA_MODEL_SECRET:-}"
context_daytona_model_secret_env="${JINA_CONTEXT_DAYTONA_MODEL_SECRET_ENV:-OPENAI_API_KEY}"
context_daytona_model_domains="${JINA_CONTEXT_DAYTONA_MODEL_DOMAINS:-api.openai.com}"
v1_api_url="${JINA_V1_API_URL:-https://api.usejina.com}"
v1_internal_token_secret="${JINA_V1_INTERNAL_API_TOKEN_SECRET:-jina-v1-internal-api-token}"
context_reset_mode="${JINA_CONTEXT_RESET_MODE:-disabled}"
context_reset_confirmation="${JINA_CONFIRM_CONTEXT_RESET:-}"
context_board_topics="run-context-input-snapshot|run-context-research-plan|run-context-research|run-context-publication-plan|run-context-page-write|run-context-page-audit|run-context-page-repair|run-context-source-challenge|run-context-task-evaluation|run-context-gap-repair|run-context-certification|run-context-publication|run-context-pageindex"
release_suffix="$(printf '%s' "${CLOUD_BUILD_ID}" | tr '[:upper:]_' '[:lower:]-')"
short_release_id="$(printf '%s' "${release_suffix}" | tr -d '-' | cut -c1-16)"
release_tag="c-${short_release_id}"
drain_suffix="drain-${release_suffix}"
context_drain_revision="jina-context-worker-${drain_suffix}"
task_drain_revision="jina-task-worker-${drain_suffix}"
context_candidate_revision="jina-context-worker-${release_suffix}"
task_candidate_revision="jina-task-worker-${release_suffix}"
release_control_job="jina-context-release-${short_release_id}"
trigger_acceptance_job="jina-context-production-trigger-acceptance"
deployment_release_credential="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
deployment_release_secret_version=""
worker_release_credential="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
worker_release_secret_version=""
worker_release_credential_sha256="$(
  printf '%s' "${worker_release_credential}" |
    python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
)"
production_preflight_path="/opt/jina/context-production-preflight.mjs"
production_trigger_acceptance_path="/opt/jina/context-production-trigger-e2e.mjs"

if [[ "${image_tag}" != "${CLOUD_BUILD_ID}" ]]; then
  echo "Deployment must deploy images built by the current coordinated Cloud Build" >&2
  exit 2
fi
if [[ "${deployment_acceptance_mode}" != "full" && "${deployment_acceptance_mode}" != "mechanical" ]]; then
  echo "JINA_DEPLOYMENT_ACCEPTANCE_MODE must be full or mechanical" >&2
  exit 2
fi
if [[ ! "${image_tag}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]]; then
  echo "IMAGE_TAG is not a valid immutable Artifact Registry tag" >&2
  exit 2
fi

validate_positive_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${name} must be a positive integer" >&2
    exit 2
  fi
}

validate_nonnegative_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "${name} must be a non-negative integer" >&2
    exit 2
  fi
}

validate_cloud_sql_instance() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[a-z][a-z0-9.-]*:[a-z0-9-]+:[a-zA-Z0-9_-]+$ ]]; then
    echo "${name} must be a Cloud SQL connection name in project:region:instance form" >&2
    exit 2
  fi
}

validate_secret_name() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[A-Za-z][A-Za-z0-9_-]{0,254}$ ]]; then
    echo "${name} is not a valid Secret Manager secret name" >&2
    exit 2
  fi
}

validate_tenant_id() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then
    echo "${name} must contain only letters, numbers, dot, underscore, colon, or hyphen" >&2
    exit 2
  fi
}

validate_cloud_sql_instance "CLOUD_SQL_INSTANCE" "${cloud_sql_instance}"
validate_nonnegative_integer "JINA_API_MIN_INSTANCES" "${api_min_instances}"
validate_positive_integer "JINA_API_MAX_INSTANCES" "${api_max_instances}"
validate_positive_integer "JINA_API_CONCURRENCY" "${api_concurrency}"
validate_positive_integer "JINA_API_DB_POOL_MAX" "${api_db_pool_max}"
validate_positive_integer "JINA_API_REQUEST_TIMEOUT_SECONDS" "${api_request_timeout_seconds}"
validate_positive_integer "JINA_CONTEXT_API_TIMEOUT_MS" "${context_api_timeout_ms}"
validate_positive_integer "JINA_CONTEXT_COMPLETION_TIMEOUT_MS" "${context_completion_timeout_ms}"
validate_positive_integer "JINA_CONTEXT_WORKER_LEASE_MS" "${context_worker_lease_ms}"
validate_positive_integer "JINA_CONTEXT_CODEX_CONTEXT_TOKENS" "${context_codex_context_tokens}"
validate_positive_integer "JINA_CONTEXT_CODEX_COMPACT_TOKENS" "${context_codex_compact_tokens}"
validate_positive_integer "JINA_ACCEPTANCE_TIMEOUT_MS" "${acceptance_timeout_ms}"
validate_positive_integer "JINA_ACCEPTANCE_JOB_TIMEOUT_SECONDS" "${acceptance_job_timeout_seconds}"
if (( context_codex_compact_tokens >= context_codex_context_tokens )); then
  echo "JINA_CONTEXT_CODEX_COMPACT_TOKENS must stay below the context window it compacts" >&2
  exit 2
fi
validate_positive_integer "JINA_ACCEPTANCE_GITHUB_INSTALLATION_ID" "${acceptance_github_installation_id}"
validate_positive_integer \
  "JINA_TRIGGER_ACCEPTANCE_GITHUB_INSTALLATION_ID" \
  "${trigger_acceptance_github_installation_id}"
if [[ "${acceptance_github_installation_id}" == "${trigger_acceptance_github_installation_id}" ]]; then
  echo "Trigger-acceptance and operational GitHub installation IDs must differ" >&2
  exit 2
fi
validate_secret_name \
  "JINA_TRIGGER_ACCEPTANCE_GITHUB_APP_ID_SECRET" \
  "${trigger_acceptance_github_app_id_secret}"
validate_secret_name \
  "JINA_TRIGGER_ACCEPTANCE_GITHUB_APP_PRIVATE_KEY_SECRET" \
  "${trigger_acceptance_github_app_private_key_secret}"
validate_secret_name \
  "JINA_V1_INTERNAL_API_TOKEN_SECRET" \
  "${v1_internal_token_secret}"
if [[ "${trigger_acceptance_github_app_id_secret}" == "jina-github-app-id" ||
      "${trigger_acceptance_github_app_private_key_secret}" == "jina-github-app-private-key" ||
      "${trigger_acceptance_github_app_id_secret}" == "${trigger_acceptance_github_app_private_key_secret}" ]]; then
  echo "Trigger-acceptance GitHub App secrets must be distinct from each other and the operational App secrets" >&2
  exit 2
fi
if [[ ! "${acceptance_repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "JINA_ACCEPTANCE_REPOSITORY must be an owner/repository name" >&2
  exit 2
fi
if (( api_min_instances > api_max_instances )); then
  echo "JINA_API_MIN_INSTANCES must not exceed JINA_API_MAX_INSTANCES" >&2
  exit 2
fi
if (( api_request_timeout_seconds > 3600 )); then
  echo "JINA_API_REQUEST_TIMEOUT_SECONDS must not exceed Cloud Run's 3600-second limit" >&2
  exit 2
fi
if (( context_api_timeout_ms <= api_request_timeout_seconds * 1000 )); then
  echo "JINA_CONTEXT_API_TIMEOUT_MS must exceed the API request timeout" >&2
  exit 2
fi
if (( context_worker_lease_ms <= context_api_timeout_ms + context_completion_timeout_ms )); then
  echo "JINA_CONTEXT_WORKER_LEASE_MS must exceed the combined context operation and completion timeouts" >&2
  exit 2
fi
validate_positive_integer "JINA_ACCEPTANCE_DERIVATION_BUDGET_SECONDS" "${acceptance_derivation_budget_seconds}"
validate_positive_integer "JINA_ACCEPTANCE_DERIVATION_TOKEN_BUDGET" "${acceptance_derivation_token_budget}"
if (( acceptance_timeout_ms < acceptance_derivation_budget_seconds * 1000 )); then
  echo "JINA_ACCEPTANCE_TIMEOUT_MS must cover JINA_ACCEPTANCE_DERIVATION_BUDGET_SECONDS" >&2
  exit 2
fi
if (( acceptance_job_timeout_seconds * 1000 <= acceptance_timeout_ms + 300000 )); then
  echo "JINA_ACCEPTANCE_JOB_TIMEOUT_SECONDS must leave at least five minutes around the polling timeout" >&2
  exit 2
fi
if [[ -n "${context_daytona_snapshot}" && -n "${context_daytona_image}" ]] ||
   [[ -z "${context_daytona_snapshot}" && -z "${context_daytona_image}" ]]; then
  echo "Exactly one JINA_CONTEXT_DAYTONA_SNAPSHOT or JINA_CONTEXT_DAYTONA_IMAGE is required" >&2
  exit 2
fi
if [[ -n "${context_daytona_snapshot}" &&
      ! "${context_daytona_snapshot}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "JINA_CONTEXT_DAYTONA_SNAPSHOT must name one immutable Daytona snapshot" >&2
  exit 2
fi
if [[ -n "${context_daytona_image}" &&
      ! "${context_daytona_image}" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "JINA_CONTEXT_DAYTONA_IMAGE must be pinned by sha256 digest" >&2
  exit 2
fi
if [[ ! "${context_daytona_model_secret}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ||
      "${context_daytona_model_secret}" =~ ^[sS][kK][-_] ]]; then
  echo "JINA_CONTEXT_DAYTONA_MODEL_SECRET must name a Daytona organization Secret" >&2
  exit 2
fi
if [[ "${context_daytona_model_secret_env}" != "OPENAI_API_KEY" &&
      "${context_daytona_model_secret_env}" != "OPENROUTER_API_KEY" ]]; then
  echo "JINA_CONTEXT_DAYTONA_MODEL_SECRET_ENV must be OPENAI_API_KEY or OPENROUTER_API_KEY" >&2
  exit 2
fi
if [[ "${context_daytona_snapshot}${context_daytona_image}${context_daytona_model_domains}" == *"~"* ]]; then
  echo "Daytona configuration must not contain the Cloud Run environment delimiter" >&2
  exit 2
fi
CONTEXT_DAYTONA_MODEL_DOMAINS="${context_daytona_model_domains}" python3 - <<'PY'
import os
import re

domains = [item.strip().lower() for item in os.environ["CONTEXT_DAYTONA_MODEL_DOMAINS"].split(",")]
pattern = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$")
if not domains or len(domains) > 8 or any(not pattern.fullmatch(item) for item in domains):
    raise SystemExit("JINA_CONTEXT_DAYTONA_MODEL_DOMAINS must contain 1..8 valid comma-separated domains")
PY
if [[ "${db_pass_secret}" == *","* || "${db_pass_secret}" == *"~"* ||
      "${migration_db_pass_secret}" == *","* || "${migration_db_pass_secret}" == *"~"* ]]; then
  echo "Database password secrets must be Cloud Run secret specs without commas or tildes" >&2
  exit 2
fi
if [[ ! "${release_suffix}" =~ ^[a-z0-9][a-z0-9-]{0,35}$ ]]; then
  echo "CLOUD_BUILD_ID must produce a valid coordinated Cloud Run revision suffix" >&2
  exit 2
fi
if [[ ! "${drain_suffix}" =~ ^[a-z0-9][a-z0-9-]{0,41}$ ]]; then
  echo "CLOUD_BUILD_ID must produce a valid paused worker drain revision suffix" >&2
  exit 2
fi
if [[ ! "${release_tag}" =~ ^[a-z][a-z0-9-]{0,24}$ ]]; then
  echo "CLOUD_BUILD_ID must produce a short valid Cloud Run traffic tag" >&2
  exit 2
fi
if [[ ! "${worker_release_secret}" =~ ^[A-Za-z][A-Za-z0-9_-]{0,254}$ ]]; then
  echo "JINA_WORKER_RELEASE_SECRET is not a valid Secret Manager secret name" >&2
  exit 2
fi
if (( ${#deployment_release_credential} < 32 || ${#worker_release_credential} < 32 )) ||
   [[ ! "${worker_release_credential_sha256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Unable to generate independent release-control and worker-generation credentials" >&2
  exit 2
fi
case "${context_reset_mode}" in
  disabled)
    if [[ -n "${context_reset_confirmation}" ]]; then
      echo "JINA_CONFIRM_CONTEXT_RESET must be empty when reset mode is disabled" >&2
      exit 2
    fi
    ;;
  legacy-once)
    if [[ "${context_reset_confirmation}" != "delete-rebuildable-context" ]]; then
      echo "JINA_CONFIRM_CONTEXT_RESET=delete-rebuildable-context is required for legacy-once" >&2
      exit 2
    fi
    ;;
  *)
    echo "JINA_CONTEXT_RESET_MODE must be disabled or legacy-once" >&2
    exit 2
    ;;
esac
deploy_candidate_args=(
  --no-traffic
  --tag="${release_tag}"
  --revision-suffix="${release_suffix}"
)

api_env_vars="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_ENABLE_DEV_ENDPOINTS=false~JINA_SIMULATE_RUNS=false~JINA_SEED_DEMO=false~JINA_REQUIRE_WORKER_RELEASE_GATE=true~JINA_TENANCY_MODE=${tenancy_mode}~INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${db_user}~JINA_DB_POOL_MAX=${api_db_pool_max}~JINA_DB_MANAGE_SCHEMA=false~CONTEXT_WORKER_LEASE_MS=${context_worker_lease_ms}~CONTEXT_GCS_BUCKET=${context_artifact_bucket}"
api_secrets="DB_PASS=${db_pass_secret},GITHUB_WEBHOOK_SECRET=jina-github-webhook-secret:latest,INTERNAL_API_TOKEN=jina-internal-api-token:latest,CONTEXT_API_TOKEN=jina-context-api-token:latest,CONTEXT_PRIVATE_CHECKPOINT_KEY=jina-context-private-checkpoint-key:latest"

case "${tenancy_mode}" in
  fixed)
    : "${fixed_tenant_id:?JINA_FIXED_TENANT_ID is required in fixed mode}"
    validate_tenant_id "JINA_FIXED_TENANT_ID" "${fixed_tenant_id}"
    api_env_vars+="~JINA_TENANT_ID=${fixed_tenant_id}~JINA_TENANT_ADMIN_PRINCIPALS=user:keon@omlabs.xyz~JINA_TENANT_ALIASES=github:unscoped,e2e-production,e2e"
    acceptance_tenant_id="${fixed_tenant_id}"
    acceptance_principal_id="user:keon@omlabs.xyz"
    ;;
  shared-db)
    acceptance_tenant_id="eff0efc9-b103-494a-b7a3-1ae7f95c2d26"
    acceptance_principal_id="tenant:${acceptance_tenant_id}"
    ;;
  *)
    echo "JINA_TENANCY_MODE must be fixed or shared-db" >&2
    exit 2
    ;;
esac
context_query_principal_id="user:context-query@jina.internal"
api_env_vars+="~JINA_CONTEXT_TENANT_ID=${acceptance_tenant_id}~JINA_CONTEXT_PRINCIPAL_ID=${context_query_principal_id}"

retry_health() {
  local url="$1"
  HEALTH_URL="${url}" python3 - <<'PY'
import os
import time
import urllib.request

url = os.environ["HEALTH_URL"]
for attempt in range(1, 21):
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            if 200 <= response.status < 300:
                print(response.read().decode())
                raise SystemExit(0)
    except Exception as error:
        if attempt == 20:
            raise RuntimeError(f"health check failed after {attempt} attempts: {url}") from error
        time.sleep(3)
PY
}

require_secret() {
  local secret_spec="$1"
  local secret_name="${secret_spec%%:*}"
  gcloud secrets describe "${secret_name}" --project="${GCP_PROJECT_ID}" >/dev/null
}

artifact_bucket_bootstrap_hint() {
  cat >&2 <<EOF
A platform operator must precreate gs://${context_artifact_bucket} in ${GCP_REGION}
with uniform bucket-level access and no lifecycle rules, then grant
roles/storage.admin to ${build_service_account} on that bucket only.
See "Platform bootstrap prerequisites" in docs/DEPLOYMENT.md.
EOF
}

require_artifact_bucket_prerequisites() {
  local bucket_description bucket_policy
  if ! bucket_description="$(gcloud storage buckets describe "gs://${context_artifact_bucket}" \
    --project="${GCP_PROJECT_ID}" \
    --format=json 2>/dev/null)"; then
    echo "Artifact bucket gs://${context_artifact_bucket} is missing or unreadable." >&2
    echo "It is a platform prerequisite; the deployment will not create it." >&2
    artifact_bucket_bootstrap_hint
    exit 2
  fi

  if ! BUCKET_DESCRIPTION="${bucket_description}" \
    EXPECTED_BUCKET="${context_artifact_bucket}" \
    EXPECTED_LOCATION="${GCP_REGION}" \
    python3 -c '
import json
import os
import sys

bucket = json.loads(os.environ["BUCKET_DESCRIPTION"])
expected_bucket = os.environ["EXPECTED_BUCKET"]
expected_location = os.environ["EXPECTED_LOCATION"].upper()
errors = []
if bucket.get("name") != expected_bucket:
    errors.append(f"name must be {expected_bucket}")
if bucket.get("location") != expected_location or bucket.get("location_type") != "region":
    errors.append(f"location must be the region {expected_location}")
if bucket.get("uniform_bucket_level_access") is not True:
    errors.append("uniform bucket-level access must be enabled")
lifecycle = bucket.get("lifecycle")
if lifecycle and (not isinstance(lifecycle, dict) or lifecycle.get("rule")):
    errors.append("lifecycle rules must be absent; Context retention is reference-aware")
if errors:
    sys.stderr.write("Artifact bucket prerequisite failed: " + "; ".join(errors) + "\n")
    raise SystemExit(2)
'; then
    artifact_bucket_bootstrap_hint
    exit 2
  fi

  if ! bucket_policy="$(gcloud storage buckets get-iam-policy "gs://${context_artifact_bucket}" \
    --project="${GCP_PROJECT_ID}" \
    --format=json 2>/dev/null)"; then
    echo "Cannot read IAM for artifact bucket gs://${context_artifact_bucket}." >&2
    echo "The build service account requires bucket-scoped roles/storage.admin." >&2
    artifact_bucket_bootstrap_hint
    exit 2
  fi

  if ! BUCKET_POLICY="${bucket_policy}" \
    BUILD_MEMBER="serviceAccount:${build_service_account}" \
    python3 -c '
import json
import os
import sys

policy = json.loads(os.environ["BUCKET_POLICY"])
build_member = os.environ["BUILD_MEMBER"]
bindings = policy.get("bindings", [])
has_admin = any(
    binding.get("role") == "roles/storage.admin"
    and build_member in binding.get("members", [])
    and not binding.get("condition")
    for binding in bindings
)
public_members = {"allUsers", "allAuthenticatedUsers"}
is_public = any(
    public_members.intersection(binding.get("members", []))
    for binding in bindings
)
if not has_admin:
    sys.stderr.write(
        "Artifact bucket prerequisite failed: "
        f"{build_member} needs an unconditional bucket-scoped roles/storage.admin binding\n"
    )
    raise SystemExit(2)
if is_public:
    sys.stderr.write("Artifact bucket prerequisite failed: public IAM principals are forbidden\n")
    raise SystemExit(2)
'; then
    artifact_bucket_bootstrap_hint
    exit 2
  fi
}

# The migration login is shared with Jina v1 (omxyz/jina-simulation), which holds
# the same password in its own secret in another project. Nothing keeps the two
# copies in step, and existence checks cannot see the difference, so a v1
# rotation leaves this release authenticating with a stale password and failing
# at the schema step after every image has already been built and pushed.
# Compare fingerprints up front and fail before that expensive work. Only
# fingerprints are ever printed. A release is not blocked when the upstream
# secret is unreadable, because cross-project access is not required to deploy.
require_migration_credential_matches_shared_owner() {
  local upstream migration_secret migration_version
  if ! upstream="$(gcloud secrets versions access latest \
    --secret="${shared_owner_secret}" \
    --project="${shared_owner_secret_project}" 2>/dev/null)" || [[ -z "${upstream}" ]]; then
    echo "Skipping shared migration-credential check: cannot read ${shared_owner_secret} in ${shared_owner_secret_project}" >&2
    return 0
  fi
  migration_secret="${migration_db_pass_secret%%:*}"
  migration_version="${migration_db_pass_secret#*:}"
  local migration
  migration="$(gcloud secrets versions access "${migration_version}" \
    --secret="${migration_secret}" \
    --project="${GCP_PROJECT_ID}")"
  UPSTREAM_URL="${upstream}" MIGRATION_PASSWORD="${migration}" \
    UPSTREAM_PROJECT="${shared_owner_secret_project}" \
    UPSTREAM_SECRET="${shared_owner_secret}" \
    MIGRATION_PROJECT="${GCP_PROJECT_ID}" \
    MIGRATION_SECRET="${migration_secret}" \
    MIGRATION_VERSION="${migration_version}" \
    python3 -c '
import hashlib
import os
import sys
import urllib.parse


def fingerprint(value):
    return hashlib.sha256(value.encode()).hexdigest()[:12]


upstream_project = os.environ["UPSTREAM_PROJECT"]
upstream_secret = os.environ["UPSTREAM_SECRET"]
migration_project = os.environ["MIGRATION_PROJECT"]
migration_secret = os.environ["MIGRATION_SECRET"]
migration_version = os.environ["MIGRATION_VERSION"]
upstream_label = f"{upstream_project}/{upstream_secret}"
migration_label = f"{migration_project}/{migration_secret}:{migration_version}"

expected = urllib.parse.unquote(
    urllib.parse.urlparse(os.environ["UPSTREAM_URL"].strip()).password or ""
)
actual = os.environ["MIGRATION_PASSWORD"].rstrip("\n")
if not expected or not actual:
    # Nothing to compare against, so report it and leave the release alone. The
    # migration still fails loudly if the password it holds is wrong.
    print(f"Skipping shared migration-credential check: {upstream_label} carries no password to compare")
    raise SystemExit(0)
if expected == actual:
    print(f"Migration credential matches {upstream_label} ({fingerprint(actual)})")
    raise SystemExit(0)

sys.exit(
    "\n".join(
        [
            "Migration credential is stale.",
            f"  {upstream_label} has {fingerprint(expected)}",
            f"  {migration_label} has {fingerprint(actual)}",
            "Jina v1 owns this password. Copy it across rather than resetting the",
            "role, which would break v1:",
            f"  gcloud secrets versions access latest --secret={upstream_secret} \\",
            f"    --project={upstream_project} \\",
            "    | python3 -c \"import sys,urllib.parse as p; sys.stdout.write("
            "p.unquote(p.urlparse(sys.stdin.read().strip()).password or str()))\" \\",
            f"    | gcloud secrets versions add {migration_secret} \\",
            f"      --project={migration_project} --data-file=-",
        ]
    )
)
'
}

resolve_release_image() {
  local tagged_image="$1"
  local digest_image
  digest_image="$(gcloud artifacts docker images describe "${tagged_image}" \
    --project="${GCP_PROJECT_ID}" \
    --format='value(image_summary.fully_qualified_digest)')"
  if [[ "${digest_image%%@*}" != "${tagged_image%:*}" ||
        ! "${digest_image#*@}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Unable to pin coordinated release image digest: ${tagged_image}" >&2
    exit 2
  fi
  printf '%s\n' "${digest_image}"
}

wait_for_candidate_revision() {
  local service="$1"
  local suffix="${2:-${release_suffix}}"
  local revision="${service}-${suffix}"
  local ready=""
  for _attempt in $(seq 1 60); do
    ready="$(gcloud run revisions describe "${revision}" \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --format='value(status.conditions[0].status)' 2>/dev/null || true)"
    if [[ "${ready}" == "True" ]]; then
      break
    fi
    sleep 2
  done
  if [[ "${ready}" != "True" ]]; then
    echo "${service} revision ${revision} did not become ready" >&2
    exit 2
  fi
}

candidate_service_url() {
  local service="$1"
  local description
  description="$(gcloud run services describe "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format=json)"
  SERVICE_DESCRIPTION="${description}" RELEASE_TAG="${release_tag}" python3 -c '
import json
import os

description = json.loads(os.environ["SERVICE_DESCRIPTION"])
tag = os.environ["RELEASE_TAG"]
for target in description.get("status", {}).get("traffic", []):
    if target.get("tag") == tag and target.get("url"):
        print(target["url"])
        raise SystemExit(0)
raise SystemExit(f"candidate tag {tag} has no URL")
'
}

stable_service_url() {
  local service="$1"
  local url
  url="$(gcloud run services describe "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format='value(status.url)')"
  if [[ ! "${url}" =~ ^https://[^/]+$ ]]; then
    echo "${service} has no stable Cloud Run service URL" >&2
    exit 2
  fi
  printf '%s\n' "${url}"
}

validate_candidate_tag_url() {
  local service="$1"
  local stable_url hostname first_label tagged_label
  stable_url="$(stable_service_url "${service}")"
  hostname="${stable_url#https://}"
  first_label="${hostname%%.*}"
  tagged_label="${release_tag}---${first_label}"
  if (( ${#tagged_label} > 63 )); then
    echo "Candidate tag ${release_tag} cannot address ${service}: Cloud Run DNS label would be ${#tagged_label} characters" >&2
    exit 2
  fi
}

context_worker_environment() {
  local target_api_url="$1"
  local claim_mode="$2"
  local target_revision="${3:-}"
  local environment
  environment="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_API_URL=${target_api_url}~JINA_V1_API_URL=${v1_api_url}~JINA_WORKER_CLAIM_MODE=${claim_mode}~WORKER_TOPICS=${context_board_topics}~JINA_REQUIRE_GITHUB_INSTALLATION=false~CONTEXT_API_TIMEOUT_MS=${context_api_timeout_ms}~CONTEXT_COMPLETION_TIMEOUT_MS=${context_completion_timeout_ms}~CONTEXT_GITHUB_HISTORY_LIMIT=500~CONTEXT_GIT_HISTORY_LIMIT=5000~CONTEXT_MAX_FILE_BYTES=5242880~CONTEXT_MAX_SNAPSHOT_BYTES=8388608~CONTEXT_BOARD_EXECUTOR=daytona~CONTEXT_DAYTONA_MODEL_SECRET=${context_daytona_model_secret}~CONTEXT_DAYTONA_MODEL_SECRET_ENV=${context_daytona_model_secret_env}~CONTEXT_DAYTONA_MODEL_DOMAINS=${context_daytona_model_domains}~CONTEXT_CODEX_MODEL=gpt-5.6-terra~CONTEXT_CODEX_EFFORT=low~CONTEXT_CODEX_VERBOSITY=high~CONTEXT_CODEX_CONTEXT_TOKENS=${context_codex_context_tokens}~CONTEXT_CODEX_COMPACT_TOKENS=${context_codex_compact_tokens}~CONTEXT_PAGEINDEX_PYTHON=/opt/pageindex-venv/bin/python~CONTEXT_PAGEINDEX_WORKER=/opt/pageindex-worker/worker.py~PAGEINDEX_SOURCE_ROOT=/opt/PageIndex"
  if [[ "${claim_mode}" == "enabled" ]]; then
    [[ "${target_revision}" == "${context_candidate_revision}" ]] || {
      echo "Enabled Context worker requires its exact candidate revision" >&2
      exit 2
    }
    environment+="~JINA_WORKER_RELEASE_ID=${CLOUD_BUILD_ID}"
  fi
  if [[ -n "${context_daytona_snapshot}" ]]; then
    environment+="~CONTEXT_DAYTONA_SNAPSHOT=${context_daytona_snapshot}"
  else
    environment+="~CONTEXT_DAYTONA_IMAGE=${context_daytona_image}"
  fi
  printf '%s\n' "${environment}"
}

task_worker_environment() {
  local target_api_url="$1"
  local claim_mode="$2"
  local target_revision="${3:-}"
  local environment
  if [[ "${claim_mode}" == "enabled" && "${target_revision}" != "${task_candidate_revision}" ]]; then
    echo "Enabled task worker requires its exact candidate revision" >&2
    exit 2
  fi
  environment="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_API_URL=${target_api_url}~JINA_WORKER_CLAIM_MODE=${claim_mode}~WORKER_TOPICS=run-review~REVIEW_MODEL=gpt-5.6-sol"
  if [[ "${claim_mode}" == "enabled" ]]; then
    environment+="~JINA_WORKER_RELEASE_ID=${CLOUD_BUILD_ID}"
  fi
  printf '%s\n' "${environment}"
}

worker_revisions() {
  local service="$1"
  gcloud run revisions list \
    --service="${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format='value(metadata.name)'
}

wait_for_exact_worker_revisions() {
  local service="$1"
  shift
  local expected actual
  expected="$(printf '%s\n' "$@" | LC_ALL=C sort)"
  for _attempt in $(seq 1 60); do
    actual="$(worker_revisions "${service}" | sed '/^$/d' | LC_ALL=C sort)"
    if [[ "${actual}" == "${expected}" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "${service} revision isolation failed." >&2
  echo "Expected revisions:" >&2
  printf '%s\n' "${expected}" >&2
  echo "Observed revisions:" >&2
  printf '%s\n' "${actual}" >&2
  return 2
}

route_paused_worker() {
  local service="$1"
  local drain_revision="$2"
  if ! gcloud run services update-traffic "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --clear-tags \
    --to-revisions="${drain_revision}=100" \
    --quiet >/dev/null; then
    echo "Unable to route ${service} to paused drain ${drain_revision}" >&2
    return 1
  fi
  gcloud run services describe "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format=json |
    DRAIN_REVISION="${drain_revision}" python3 -c '
import json
import os
import sys

traffic = json.load(sys.stdin).get("status", {}).get("traffic", [])
serving = {
    target.get("revisionName"): int(target.get("percent", 0))
    for target in traffic
    if target.get("revisionName") and int(target.get("percent", 0)) > 0
}
expected = {os.environ["DRAIN_REVISION"]: 100}
if serving != expected:
    raise SystemExit(f"paused worker traffic mismatch: expected {expected}, observed {serving}")
'
}

route_paused_worker_and_delete_prior_revisions() {
  local service="$1"
  local drain_revision="$2"
  local revision cleanup_failed="false"
  route_paused_worker "${service}" "${drain_revision}" || return 1
  while IFS= read -r revision; do
    [[ -z "${revision}" || "${revision}" == "${drain_revision}" ]] && continue
    if [[ "${revision}" != "${service}-"* ]]; then
      echo "Refusing to delete unexpected revision ${revision} while draining ${service}" >&2
      cleanup_failed="true"
      continue
    fi
    if ! gcloud run revisions delete "${revision}" \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --no-async \
      --quiet; then
      cleanup_failed="true"
    fi
  done < <(worker_revisions "${service}")
  if [[ "${cleanup_failed}" == "true" ]]; then
    return 1
  fi
  wait_for_exact_worker_revisions "${service}" "${drain_revision}"
}

verify_candidate_worker_isolation() {
  local service="$1"
  local drain_revision="$2"
  local candidate_revision="${service}-${release_suffix}"
  local service_description drain_description candidate_description
  wait_for_exact_worker_revisions "${service}" "${drain_revision}" "${candidate_revision}"
  service_description="$(gcloud run services describe "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format=json)"
  drain_description="$(gcloud run revisions describe "${drain_revision}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format=json)"
  candidate_description="$(gcloud run revisions describe "${candidate_revision}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format=json)"
  SERVICE_DESCRIPTION="${service_description}" \
    DRAIN_DESCRIPTION="${drain_description}" \
    CANDIDATE_DESCRIPTION="${candidate_description}" \
    DRAIN_REVISION="${drain_revision}" \
    CANDIDATE_REVISION="${candidate_revision}" \
    CANDIDATE_TAG="${release_tag}" \
    EXPECTED_IMAGE="${worker_image}" \
    EXPECTED_API_URL="$3" \
    EXPECTED_RELEASE_ID="${CLOUD_BUILD_ID}" \
    python3 -c '
import json
import os

service = json.loads(os.environ["SERVICE_DESCRIPTION"])
drain = json.loads(os.environ["DRAIN_DESCRIPTION"])
candidate = json.loads(os.environ["CANDIDATE_DESCRIPTION"])
drain_revision = os.environ["DRAIN_REVISION"]
candidate_revision = os.environ["CANDIDATE_REVISION"]
candidate_tag = os.environ["CANDIDATE_TAG"]
expected_image = os.environ["EXPECTED_IMAGE"]
expected_api_url = os.environ["EXPECTED_API_URL"]
expected_release_id = os.environ["EXPECTED_RELEASE_ID"]

traffic = service.get("status", {}).get("traffic", [])
percent_by_revision = {
    target.get("revisionName"): int(target.get("percent", 0))
    for target in traffic
    if target.get("revisionName")
}
if percent_by_revision.get(drain_revision) != 100:
    raise SystemExit(f"{drain_revision} is not the sole serving drain revision")
tag_target = next((target for target in traffic if target.get("tag") == candidate_tag), None)
if not tag_target or tag_target.get("revisionName") != candidate_revision:
    raise SystemExit(f"candidate tag {candidate_tag} does not name {candidate_revision}")

def container(description):
    containers = description.get("spec", {}).get("containers", [])
    if len(containers) != 1:
        raise SystemExit("worker revision must contain exactly one container")
    return containers[0]

def environment(description):
    return {
        item.get("name"): item.get("value")
        for item in container(description).get("env", [])
        if "value" in item
    }

if container(drain).get("image") != expected_image:
    raise SystemExit("paused drain revision does not use the coordinated worker image digest")
if container(candidate).get("image") != expected_image:
    raise SystemExit("candidate worker revision does not use the coordinated worker image digest")
drain_env = environment(drain)
candidate_env = environment(candidate)
if drain_env.get("JINA_WORKER_CLAIM_MODE") != "paused":
    raise SystemExit("drain revision is not explicitly paused")
if candidate_env.get("JINA_WORKER_CLAIM_MODE") != "enabled":
    raise SystemExit("candidate revision is not explicitly claim-enabled")
if candidate_env.get("JINA_WORKER_RELEASE_ID") != expected_release_id:
    raise SystemExit("candidate revision does not carry the coordinated worker release ID")
if candidate_env.get("JINA_API_URL") != expected_api_url:
    raise SystemExit("candidate worker does not target the exact candidate API URL")
'
}

route_candidate_revision() {
  local service="$1"
  local revision="${service}-${release_suffix}"
  gcloud run services update-traffic "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --set-tags="${release_tag}=${revision}" \
    --to-revisions="${revision}=100" \
    --quiet >/dev/null
  echo "Routed ${service} 100% to ${revision}"
}

cutover_started="false"
accepted_cutover_complete="false"
accepted_release_control_credential_destroyed="false"
accepted_release_control_job_deleted="false"
post_cutover_cleanup_complete="false"
post_cutover_phase="candidate"
trigger_acceptance_job_status="not-attempted"
worker_quiescence_started="false"
board_leases_verified="false"
release_lease_acquired="false"
release_renewal_pid=""

run_release_control() {
  local action="$1"
  gcloud run jobs execute "${release_control_job}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --args="${production_preflight_path},${action}" \
    --wait
}

start_release_renewal() {
  local deployment_pid="$$"
  (
    while sleep 300; do
      if ! run_release_control "release-renew"; then
        echo "Deployment lease renewal failed; terminating coordinated release" >&2
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

extend_release_lease_for_repair() {
  gcloud run jobs execute "${release_control_job}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --update-env-vars="JINA_DEPLOYMENT_LEASE_SECONDS=43200" \
    --args="${production_preflight_path},release-renew" \
    --wait >/dev/null 2>&1
}

destroy_worker_release_credential_verified() {
  if destroy_release_secret_version_verified \
    "${worker_release_secret_version}" \
    "Unaccepted worker-generation credential"; then
    worker_release_secret_version=""
    return 0
  fi
  return 1
}

destroy_deployment_release_credential_verified() {
  if destroy_release_secret_version_verified \
    "${deployment_release_secret_version}" \
    "Release-control credential"; then
    return 0
  fi
  return 1
}

report_accepted_release_failure() {
  if [[ "${post_cutover_cleanup_complete}" == "true" ]]; then
    cat >&2 <<POSTCUTOVER
The accepted coordinated release is serving and its database deployment lease
was released. Its short-lived release-control credential and job were both
verified absent. A later post-cutover step failed during ${post_cutover_phase};
no release-control cleanup or traffic rollback is required. Production traffic
and the accepted worker generation were deliberately left unchanged.
POSTCUTOVER
    return
  fi

  cat >&2 <<ROLLFORWARD
The accepted coordinated release is serving and its database deployment lease
was released, but verified cleanup of its short-lived release-control artifacts
did not complete. Production traffic and the accepted worker generation were
deliberately left unchanged. Complete only the outstanding cleanup below; do
not roll back to mixed revisions.
ROLLFORWARD
  if [[ "${accepted_release_control_credential_destroyed}" != "true" ]]; then
    echo "  Destroy release-control credential version ${deployment_release_secret_version}." >&2
  fi
  if [[ "${accepted_release_control_job_deleted}" != "true" ]]; then
    echo "  Remove release-control job ${release_control_job}." >&2
  fi
}

reconcile_trigger_acceptance_job() {
  local stable_api_url
  local trigger_acceptance_command

  if ! stable_api_url="$(stable_service_url "jina-api")"; then
    return 1
  fi
  if ! printf -v trigger_acceptance_command \
    'exec node %q --api-url %q --tenant %q --principal %q --repository %q --installation-id %q --fixture-installation-id %q --confirm-repository %q --report %q' \
    "${production_trigger_acceptance_path}" \
    "${stable_api_url}" \
    "${acceptance_tenant_id}" \
    "${context_query_principal_id}" \
    "${acceptance_repository}" \
    "${acceptance_github_installation_id}" \
    "${trigger_acceptance_github_installation_id}" \
    "${acceptance_repository}" \
    "/tmp/context-production-trigger-acceptance.json"; then
    return 1
  fi

  # Use an alternate gcloud list delimiter. The command values are validated
  # not to contain "~", so the shell command remains one container argument
  # even when the same repository is intentionally present twice.
  gcloud run jobs deploy "${trigger_acceptance_job}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --image="${worker_image}" \
    --service-account="${trigger_acceptance_service_account}" \
    --set-env-vars="JINA_TRIGGER_ACCEPTANCE_ALLOWED_REPOSITORY=${acceptance_repository}" \
    --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,GITHUB_APP_ID=jina-github-app-id:latest,GITHUB_APP_PRIVATE_KEY=jina-github-app-private-key:latest,GITHUB_FIXTURE_APP_ID=${trigger_acceptance_github_app_id_secret}:latest,GITHUB_FIXTURE_APP_PRIVATE_KEY=${trigger_acceptance_github_app_private_key_secret}:latest" \
    --command=/bin/sh \
    --args="^~^-c~${trigger_acceptance_command}" \
    --tasks=1 \
    --max-retries=0 \
    --task-timeout=86400s \
    --quiet
}

reconcile_trigger_acceptance_job_nonfatal() {
  trigger_acceptance_job_status="reconciling"
  if reconcile_trigger_acceptance_job; then
    trigger_acceptance_job_status="ready"
    return 0
  fi

  trigger_acceptance_job_status="failed-nonfatal"
  cat >&2 <<'AUXILIARY'
The accepted release is serving and release-control cleanup is verified, but
the operator-run production trigger-acceptance job could not be reconciled.
This auxiliary job is not part of release acceptance, so the release remains
successful. Inspect or redeploy the job separately; do not roll back traffic or
repeat database migration.
AUXILIARY
  return 0
}

rollback_failed_release() {
  local status=$?
  trap - EXIT
  if [[ "${status}" -ne 0 && "${accepted_cutover_complete}" == "true" ]]; then
    stop_release_renewal
    report_accepted_release_failure
    exit "${status}"
  fi
  if [[ "${status}" -ne 0 && "${cutover_started}" == "true" ]]; then
    if [[ "${release_lease_acquired}" == "true" ]]; then
      extend_release_lease_for_repair || true
    fi
    stop_release_renewal
    cat >&2 <<'ROLLFORWARD'
Release failed while routing an already accepted coordinated candidate.
Cloud Run traffic has deliberately NOT been restored: there is no supported
mixed-version rollback after the Context schema transition. Finish routing the
exact accepted revisions, for example:
  gcloud run services update-traffic jina-api --region=<region> --project=<project> \
    --to-revisions=jina-api-<cloud-build-id>=100
Then re-run production acceptance against the serving release.
The durable deployment lease was extended for twelve hours to block a second
release while this accepted cutover is repaired.
ROLLFORWARD
    exit "${status}"
  fi
  if [[ "${status}" -ne 0 && "${worker_quiescence_started}" == "true" ]]; then
    local cleanup_ok="true"
    run_release_control "worker-pause" >/dev/null 2>&1 || cleanup_ok="false"
    # A failed candidate is the latest-created Cloud Run revision and cannot be
    # deleted directly. Route only to the paused drain here; the generation
    # credential is destroyed below, and the next drain revision makes the
    # retained 0%-traffic candidate eligible for normal revision cleanup.
    route_paused_worker \
      "jina-context-worker" "${context_drain_revision}" >/dev/null 2>&1 || cleanup_ok="false"
    route_paused_worker \
      "jina-task-worker" "${task_drain_revision}" >/dev/null 2>&1 || cleanup_ok="false"
    run_release_control "board-drain" >/dev/null 2>&1 || cleanup_ok="false"
    run_release_control "board-verify" >/dev/null 2>&1 || cleanup_ok="false"
    if [[ "${cleanup_ok}" == "true" ]]; then
      board_leases_verified="true"
      # Invalidate the unaccepted generation before relinquishing the database
      # lease. A failed destroy therefore cannot leave usable worker
      # credentials after another deployment starts.
      destroy_worker_release_credential_verified || cleanup_ok="false"
    fi
    if [[ "${cleanup_ok}" == "true" ]]; then
      # Worker claims remain disabled after a rejected candidate, but the
      # serving API must still accept/cancel work and webhooks. Restore only
      # its Board DML grant; do not reactivate an unaccepted worker generation.
      run_release_control "runtime-write-enable" >/dev/null 2>&1 || cleanup_ok="false"
    fi
    if [[ "${cleanup_ok}" == "true" ]]; then
      # Keep renewing throughout all fail-closed work. Stop only after the
      # generation is destroyed and zero leases have been independently
      # verified, so release-release cannot race a background renewal.
      stop_release_renewal
      run_release_control "release-release" >/dev/null 2>&1 || cleanup_ok="false"
    fi
    if [[ "${cleanup_ok}" == "true" ]]; then
      release_lease_acquired="false"
      delete_release_control_job_verified || cleanup_ok="false"
      destroy_deployment_release_credential_verified || cleanup_ok="false"
    fi
    if [[ "${cleanup_ok}" != "true" && "${release_lease_acquired}" == "true" ]]; then
      # Failure to destroy the generation credential is fail-closed: retain
      # the database lease and extend it before stopping the renewer.
      extend_release_lease_for_repair || true
      stop_release_renewal
    fi
    cat >&2 <<ROLLFORWARD
Candidate release failed after background-worker quiescence began.
Fail-closed cleanup completed: ${cleanup_ok}
Worker claims are disabled, the unaccepted generation was invalidated, and the
worker services were returned to the exact paused drain revisions:
  ${context_drain_revision}
  ${task_drain_revision}
Board zero-lease verification completed:
  ${board_leases_verified}
Deployment lease remains held:
  ${release_lease_acquired}
If the lease remains held, do not start another release. Inspect the release-
control row, exact worker revision inventories, Board leases, control job, and
credential versions, then finish the same cleanup. If it was released, only
verified removal of the short-lived control artifacts remains.
ROLLFORWARD
    exit "${status}"
  fi
  if [[ "${status}" -ne 0 ]]; then
    echo "Candidate release failed before cutover; production traffic was not changed" >&2
    if [[ "${release_lease_acquired}" == "true" ]]; then
      if destroy_worker_release_credential_verified; then
        stop_release_renewal
        if run_release_control "release-release" >/dev/null 2>&1; then
          release_lease_acquired="false"
        else
          extend_release_lease_for_repair || true
        fi
      else
        extend_release_lease_for_repair || true
        stop_release_renewal
        echo "The deployment lease remains held because the unaccepted worker-generation credential was not destroyed" >&2
        exit "${status}"
      fi
    else
      destroy_worker_release_credential_verified || true
    fi
    if [[ "${release_lease_acquired}" == "false" ]]; then
      delete_release_control_job_verified || true
      destroy_deployment_release_credential_verified || true
    fi
  fi
  exit "${status}"
}

trap rollback_failed_release EXIT

# Platform operators create and secure this bucket once. Requiring it before
# secret checks, image resolution, Daytona execution, or Cloud SQL mutation
# makes an incomplete bootstrap fail cheaply and clearly. The build identity
# receives storage administration on this bucket only, never on the project.
require_artifact_bucket_prerequisites

for secret_spec in \
  "${db_pass_secret}" \
  "${migration_db_pass_secret}" \
  "jina-github-webhook-secret:latest" \
  "jina-context-private-checkpoint-key:latest" \
  "jina-internal-api-token:latest" \
  "${v1_internal_token_secret}:latest" \
  "jina-context-api-token:latest" \
  "jina-daytona-api-key:latest" \
  "jina-github-app-id:latest" \
  "jina-github-app-private-key:latest" \
  "${trigger_acceptance_github_app_id_secret}:latest" \
  "${trigger_acceptance_github_app_private_key_secret}:latest" \
  "jina-openai-api-key:latest" \
  "jina-github-clone-token:latest" \
  "${worker_release_secret}"; do
  require_secret "${secret_spec}"
done
require_secret "jina-web-auth-password:latest"
require_migration_credential_matches_shared_owner
for service_account in \
  "${api_service_account}" \
  "${context_worker_service_account}" \
  "${task_worker_service_account}" \
  "${dashboard_service_account}" \
  "${admin_service_account}" \
  "${acceptance_service_account}" \
  "${trigger_acceptance_service_account}"; do
  gcloud iam service-accounts describe "${service_account}" --project="${GCP_PROJECT_ID}" >/dev/null
done
gcloud iam service-accounts describe "${migration_service_account}" --project="${GCP_PROJECT_ID}" >/dev/null

api_image="$(resolve_release_image "${api_image}")"
worker_image="$(resolve_release_image "${worker_image}")"
dashboard_image="$(resolve_release_image "${dashboard_image}")"
admin_image="$(resolve_release_image "${admin_image}")"

# Full releases validate the remote sandbox, organization Secret reference,
# model access, and Codex toolchain before touching production. An explicitly
# mechanical release validates infrastructure only: provider credit or model
# availability must not block an API/runtime repair that does not claim
# end-to-end Context quality.
if [[ "${deployment_acceptance_mode}" == "full" ]]; then
  daytona_preflight_env="^~^CONTEXT_DAYTONA_MODULE_PATH=/app/node_modules/@jina/daytona/dist/index.js~CONTEXT_DAYTONA_MODEL_SECRET=${context_daytona_model_secret}~CONTEXT_DAYTONA_MODEL_SECRET_ENV=${context_daytona_model_secret_env}~CONTEXT_DAYTONA_MODEL_DOMAINS=${context_daytona_model_domains}~CONTEXT_CODEX_MODEL=gpt-5.6-terra~CONTEXT_CODEX_EFFORT=low~CONTEXT_CODEX_VERBOSITY=high~CONTEXT_CODEX_CONTEXT_TOKENS=${context_codex_context_tokens}~CONTEXT_CODEX_COMPACT_TOKENS=${context_codex_compact_tokens}"
  if [[ -n "${context_daytona_snapshot}" ]]; then
    daytona_preflight_env+="~CONTEXT_DAYTONA_SNAPSHOT=${context_daytona_snapshot}"
  else
    daytona_preflight_env+="~CONTEXT_DAYTONA_IMAGE=${context_daytona_image}"
  fi
  gcloud run jobs deploy jina-context-daytona-preflight \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --image="${worker_image}" \
    --service-account="${context_worker_service_account}" \
    --set-env-vars="${daytona_preflight_env}" \
    --set-secrets="DAYTONA_API_KEY=jina-daytona-api-key:latest" \
    --command=node \
    --args="${production_preflight_path},daytona" \
    --tasks=1 \
    --max-retries=0 \
    --task-timeout=10m \
    --quiet
  gcloud run jobs execute jina-context-daytona-preflight \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --wait
else
  echo "Mechanical deployment: skipping model-executing Daytona preflight"
fi

# A traffic tag becomes the left-most DNS label prefix. Validate it against the
# live Cloud Run service identifiers before creating any candidate revision.
for service in jina-api jina-context-worker jina-task-worker jina-dashboard jina-admin; do
  validate_candidate_tag_url "${service}"
done

# Create independent version-scoped credentials. The release-control,
# migration, and reset jobs mount only the deployment credential. Candidate
# workers mount only the generation credential, while the release-control job
# receives its non-secret SHA-256 digest for the durable worker gate.
deployment_release_secret_version_name="$(
  printf '%s' "${deployment_release_credential}" |
    gcloud secrets versions add "${worker_release_secret}" \
      --project="${GCP_PROJECT_ID}" \
      --data-file=- \
      --format='value(name)'
)"
deployment_release_secret_version="${deployment_release_secret_version_name##*/}"
if [[ ! "${deployment_release_secret_version}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Release-control credential did not produce a Secret Manager version" >&2
  exit 2
fi

worker_release_secret_version_name="$(
  printf '%s' "${worker_release_credential}" |
    gcloud secrets versions add "${worker_release_secret}" \
      --project="${GCP_PROJECT_ID}" \
      --data-file=- \
      --format='value(name)'
)"
worker_release_secret_version="${worker_release_secret_version_name##*/}"
if [[ ! "${worker_release_secret_version}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Release-scoped worker credential did not produce a Secret Manager version" >&2
  exit 2
fi

# The unique control job owns the durable renewable lease, generation gate,
# schema checks, and Board fencing for this build. A second build can create its
# own job, but release-acquire fails before that build can touch worker services.
release_control_env="^~^CONTEXT_RESET_MODULE_PATH=/app/node_modules/@jina/db/dist/reset-context-data.js~CONTEXT_BOARD_MODULE_PATH=/app/node_modules/@jina/board/dist/index.js~CLOUD_BUILD_ID=${CLOUD_BUILD_ID}~JINA_WORKER_RELEASE_ID=${CLOUD_BUILD_ID}~JINA_WORKER_GENERATION_CREDENTIAL_SHA256=${worker_release_credential_sha256}~JINA_DEPLOYMENT_LEASE_SECONDS=1800~JINA_CONTEXT_WORKER_REVISION=${context_candidate_revision}~JINA_TASK_WORKER_REVISION=${task_candidate_revision}~JINA_CONTEXT_RESET_MODE=${context_reset_mode}~CONTEXT_RUNTIME_DB_USER=${db_user}~INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${migration_db_user}"
gcloud run jobs deploy "${release_control_job}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --service-account="${migration_service_account}" \
  --set-cloudsql-instances="${cloud_sql_instance}" \
  --set-env-vars="${release_control_env}" \
  --set-secrets="DB_PASS=${migration_db_pass_secret},JINA_WORKER_RELEASE_CREDENTIAL=${worker_release_secret}:${deployment_release_secret_version}" \
  --command=node \
  --args="${production_preflight_path},release-acquire" \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=15m \
  --quiet
run_release_control "release-acquire"
release_lease_acquired="true"
start_release_renewal

# Fail every predictable schema/privilege problem and verify a restorable
# backup while the serving worker generation is still untouched.
run_release_control "schema-inspect"
cloud_sql_project="${cloud_sql_instance%%:*}"
cloud_sql_instance_id="${cloud_sql_instance##*:}"
backup_description="pre-context-${CLOUD_BUILD_ID}"
context_backup_id="$(gcloud sql backups list \
  --project="${cloud_sql_project}" \
  --instance="${cloud_sql_instance_id}" \
  --filter="description=${backup_description}" \
  --format='value(id)')"
if [[ -z "${context_backup_id}" ]]; then
  if ! gcloud sql backups create \
      --project="${cloud_sql_project}" \
      --instance="${cloud_sql_instance_id}" \
      --description="${backup_description}" \
      --quiet; then
    echo "Unable to create the coordinated Cloud SQL backup for ${cloud_sql_instance}." >&2
    echo "${build_service_account} requires the least-privilege" >&2
    echo "projects/${cloud_sql_project}/roles/jinaContextBackupOperator binding." >&2
    echo "See \"Platform bootstrap prerequisites\" in docs/DEPLOYMENT.md." >&2
    exit 2
  fi
  context_backup_id="$(gcloud sql backups list \
    --project="${cloud_sql_project}" \
    --instance="${cloud_sql_instance_id}" \
    --filter="description=${backup_description}" \
    --format='value(id)')"
fi
if [[ ! "${context_backup_id}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Cloud SQL backup lookup did not return exactly one valid backup ID" >&2
  exit 2
fi
context_backup_status="$(gcloud sql backups describe "${context_backup_id}" \
  --project="${cloud_sql_project}" \
  --instance="${cloud_sql_instance_id}" \
  --format='value(status)')"
if [[ "${context_backup_status}" != "SUCCESSFUL" ]]; then
  echo "Cloud SQL backup ${context_backup_id} is not successful" >&2
  exit 2
fi
echo "Verified Cloud SQL backup ${context_backup_id} for ${cloud_sql_instance}"

# Create both paused drains before closing the database generation gate. Once
# both revisions are ready, worker-pause serializes behind any in-flight Board
# mutation, so no claim/renew/complete can commit after it returns.
serving_api_url="$(stable_service_url "jina-api")"
gcloud run deploy jina-context-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${worker_image}" \
  --no-allow-unauthenticated \
  --service-account="${context_worker_service_account}" \
  --concurrency=1 \
  --memory="${context_worker_memory}" \
  --timeout=300 \
  --min-instances=3 \
  --max-instances=3 \
  --no-cpu-throttling \
  --set-env-vars="$(context_worker_environment "${serving_api_url}" "paused")" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,JINA_V1_INTERNAL_API_TOKEN=${v1_internal_token_secret}:latest,DAYTONA_API_KEY=jina-daytona-api-key:latest,GITHUB_APP_ID=jina-github-app-id:latest,GITHUB_APP_PRIVATE_KEY=jina-github-app-private-key:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  --no-traffic \
  --revision-suffix="${drain_suffix}" \
  --quiet
wait_for_candidate_revision "jina-context-worker" "${drain_suffix}"

gcloud run deploy jina-task-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${worker_image}" \
  --no-allow-unauthenticated \
  --service-account="${task_worker_service_account}" \
  --concurrency=1 \
  --timeout=300 \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --set-env-vars="$(task_worker_environment "${serving_api_url}" "paused")" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,OPENAI_API_KEY=jina-openai-api-key:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  --no-traffic \
  --revision-suffix="${drain_suffix}" \
  --quiet
wait_for_candidate_revision "jina-task-worker" "${drain_suffix}"

worker_quiescence_started="true"
run_release_control "worker-pause"
route_paused_worker_and_delete_prior_revisions "jina-context-worker" "${context_drain_revision}"
route_paused_worker_and_delete_prior_revisions "jina-task-worker" "${task_drain_revision}"
run_release_control "board-drain"
run_release_control "board-verify"
board_leases_verified="true"

# Recheck the exact schema under the still-live deployment lease after worker
# quiescence and immediately before owner DDL.
run_release_control "schema-inspect"

# Context artifacts are immutable and tenant scoped. The platform prerequisite
# check already proved that the precreated bucket has no blanket lifecycle
# rules; retention must remain reference-aware.
gcloud storage buckets add-iam-policy-binding "gs://${context_artifact_bucket}" \
  --member="serviceAccount:${api_service_account}" \
  --role="roles/storage.objectUser" \
  --quiet >/dev/null

# Apply owner-only DDL before any new runtime revision starts. Runtime services
# intentionally run with JINA_DB_MANAGE_SCHEMA=false and use a different Google
# identity that has no access to the migration-owner database secret.
gcloud run jobs deploy jina-context-migrate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --service-account="${migration_service_account}" \
  --set-cloudsql-instances="${cloud_sql_instance}" \
  --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${migration_db_user}~CONTEXT_RUNTIME_DB_USER=${db_user}~JINA_WORKER_RELEASE_ID=${CLOUD_BUILD_ID}" \
  --set-secrets="DB_PASS=${migration_db_pass_secret},JINA_WORKER_RELEASE_CREDENTIAL=${worker_release_secret}:${deployment_release_secret_version}" \
  --args=node_modules/@jina/db/dist/migrate.js,--install-roles \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=15m \
  --quiet

gcloud run jobs execute jina-context-migrate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --wait

if [[ "${context_reset_mode}" == "legacy-once" ]]; then
  gcloud run jobs deploy jina-context-legacy-reset \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --image="${api_image}" \
    --service-account="${migration_service_account}" \
    --set-cloudsql-instances="${cloud_sql_instance}" \
    --set-env-vars="^~^CONTEXT_RESET_MODULE_PATH=/app/node_modules/@jina/db/dist/reset-context-data.js~INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${migration_db_user}~JINA_WORKER_RELEASE_ID=${CLOUD_BUILD_ID}~JINA_CONTEXT_RESET_MODE=legacy-once~JINA_CONFIRM_CONTEXT_RESET=${context_reset_confirmation}~JINA_CONTEXT_RESET_BACKUP_ID=${context_backup_id}" \
    --set-secrets="DB_PASS=${migration_db_pass_secret},JINA_WORKER_RELEASE_CREDENTIAL=${worker_release_secret}:${deployment_release_secret_version}" \
    --command=node \
    --args="${production_preflight_path},schema-reset" \
    --tasks=1 \
    --max-retries=0 \
    --task-timeout=20m \
    --quiet
  gcloud run jobs execute jina-context-legacy-reset \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --wait
fi

gcloud run deploy jina-api \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --allow-unauthenticated \
  --service-account="${api_service_account}" \
  --set-cloudsql-instances="${cloud_sql_instance}" \
  --concurrency="${api_concurrency}" \
  --cpu="${api_cpu}" \
  --memory="${api_memory}" \
  --timeout="${api_request_timeout_seconds}" \
  --liveness-probe="initialDelaySeconds=30,timeoutSeconds=10,periodSeconds=30,failureThreshold=3,httpGet.path=/health,httpGet.port=8080" \
  --min-instances="${api_min_instances}" \
  --max-instances="${api_max_instances}" \
  --set-env-vars="${api_env_vars}" \
  --set-secrets="${api_secrets}" \
  "${deploy_candidate_args[@]}" \
  --quiet

wait_for_candidate_revision "jina-api"
api_url="$(candidate_service_url "jina-api")"
retry_health "${api_url}/health"

run_release_control "worker-enable"
context_worker_env_vars="$(context_worker_environment "${api_url}" "enabled" "${context_candidate_revision}")"

gcloud run deploy jina-context-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${worker_image}" \
  --no-allow-unauthenticated \
  --service-account="${context_worker_service_account}" \
  --concurrency=1 \
  --memory="${context_worker_memory}" \
  --timeout=300 \
  --min-instances=3 \
  --max-instances=3 \
  --no-cpu-throttling \
  --set-env-vars="${context_worker_env_vars}" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,JINA_V1_INTERNAL_API_TOKEN=${v1_internal_token_secret}:latest,JINA_WORKER_RELEASE_CREDENTIAL=${worker_release_secret}:${worker_release_secret_version},DAYTONA_API_KEY=jina-daytona-api-key:latest,GITHUB_APP_ID=jina-github-app-id:latest,GITHUB_APP_PRIVATE_KEY=jina-github-app-private-key:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  "${deploy_candidate_args[@]}" \
  --quiet

wait_for_candidate_revision "jina-context-worker"
context_worker_url="$(candidate_service_url "jina-context-worker")"
context_worker_audience="$(stable_service_url "jina-context-worker")"

gcloud run deploy jina-task-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${worker_image}" \
  --no-allow-unauthenticated \
  --service-account="${task_worker_service_account}" \
  --concurrency=1 \
  --timeout=300 \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --set-env-vars="$(task_worker_environment "${api_url}" "enabled" "${task_candidate_revision}")" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,JINA_WORKER_RELEASE_CREDENTIAL=${worker_release_secret}:${worker_release_secret_version},OPENAI_API_KEY=jina-openai-api-key:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  "${deploy_candidate_args[@]}" \
  --quiet

wait_for_candidate_revision "jina-task-worker"
task_worker_url="$(candidate_service_url "jina-task-worker")"
task_worker_audience="$(stable_service_url "jina-task-worker")"

verify_candidate_worker_isolation \
  "jina-context-worker" \
  "${context_drain_revision}" \
  "${api_url}"
verify_candidate_worker_isolation \
  "jina-task-worker" \
  "${task_drain_revision}" \
  "${api_url}"

for worker_service in "jina-context-worker" "jina-task-worker"; do
  gcloud run services add-iam-policy-binding "${worker_service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --member="serviceAccount:${acceptance_service_account}" \
    --role="roles/run.invoker" \
    --quiet >/dev/null
done

web_env_vars="^~^JINA_API_URL=${api_url}~JINA_TENANT_ID=${acceptance_tenant_id}~JINA_WEB_PRINCIPAL_ID=${acceptance_principal_id}~JINA_WEB_AUTH_USERNAME=omlabs"
web_secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,JINA_WEB_AUTH_PASSWORD=jina-web-auth-password:latest"

gcloud run deploy jina-dashboard \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${dashboard_image}" \
  --service-account="${dashboard_service_account}" \
  --set-env-vars="${web_env_vars}" \
  --set-secrets="${web_secrets}" \
  "${deploy_candidate_args[@]}" \
  --quiet
wait_for_candidate_revision "jina-dashboard"
dashboard_url="$(candidate_service_url "jina-dashboard")"
dashboard_audience="$(stable_service_url "jina-dashboard")"
gcloud run services add-iam-policy-binding jina-dashboard \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --member="serviceAccount:${acceptance_service_account}" \
  --role="roles/run.invoker" \
  --quiet >/dev/null
gcloud iam service-accounts add-iam-policy-binding "${acceptance_service_account}" \
  --project="${GCP_PROJECT_ID}" \
  --member="serviceAccount:${acceptance_service_account}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --quiet >/dev/null
gcloud iap web add-iam-policy-binding \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --resource-type=cloud-run \
  --service=jina-dashboard \
  --member="serviceAccount:${acceptance_service_account}" \
  --role="roles/iap.httpsResourceAccessor" \
  --quiet >/dev/null

gcloud run deploy jina-admin \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${admin_image}" \
  --allow-unauthenticated \
  --service-account="${admin_service_account}" \
  --set-env-vars="${web_env_vars}" \
  --set-secrets="${web_secrets}" \
  "${deploy_candidate_args[@]}" \
  --quiet
wait_for_candidate_revision "jina-admin"
admin_url="$(candidate_service_url "jina-admin")"

if [[ "${deployment_acceptance_mode}" == "full" ]]; then
  # Something outside this repository periodically rewrites the IAM policy on
  # these secrets to a fixed member list, and the acceptance job's accessor
  # grant was twice removed between a manual re-grant and the deploy that
  # needed it. Restore the grants immediately before full acceptance.
  for acceptance_secret in jina-internal-api-token jina-context-api-token; do
    gcloud secrets add-iam-policy-binding "${acceptance_secret}" \
      --project="${GCP_PROJECT_ID}" \
      --member="serviceAccount:${acceptance_service_account}" \
      --role="roles/secretmanager.secretAccessor" \
      --quiet >/dev/null 2>&1 \
      || echo "WARNING: could not restore ${acceptance_secret} access for ${acceptance_service_account}; continuing"
  done

  gcloud run jobs deploy jina-acceptance \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --image="${worker_image}" \
    --service-account="${acceptance_service_account}" \
    --set-env-vars="^~^JINA_API_URL=${api_url}~ACCEPTANCE_WORKER_RELEASE_ID=${CLOUD_BUILD_ID}~ACCEPTANCE_CONTEXT_WORKER_REVISION=${context_candidate_revision}~ACCEPTANCE_TASK_WORKER_REVISION=${task_candidate_revision}~ACCEPTANCE_CONTEXT_WORKER_URL=${context_worker_url}~ACCEPTANCE_CONTEXT_WORKER_AUDIENCE=${context_worker_audience}~ACCEPTANCE_TASK_WORKER_URL=${task_worker_url}~ACCEPTANCE_TASK_WORKER_AUDIENCE=${task_worker_audience}~ACCEPTANCE_DASHBOARD_URL=${dashboard_url}~ACCEPTANCE_DASHBOARD_AUDIENCE=${dashboard_audience}~ACCEPTANCE_ADMIN_URL=${admin_url}~ACCEPTANCE_WEB_AUTH_USERNAME=omlabs~ACCEPTANCE_TENANT_ID=${acceptance_tenant_id}~ACCEPTANCE_PRINCIPAL_ID=${context_query_principal_id}~ACCEPTANCE_ADMIN_PRINCIPAL_ID=${acceptance_principal_id}~ACCEPTANCE_REPOSITORY=${acceptance_repository}~ACCEPTANCE_REQUEST_KEY=deploy-${CLOUD_BUILD_ID}~ACCEPTANCE_GITHUB_INSTALLATION_ID=${acceptance_github_installation_id}~ACCEPTANCE_DERIVATION_BUDGET_SECONDS=${acceptance_derivation_budget_seconds}~ACCEPTANCE_DERIVATION_TOKEN_BUDGET=${acceptance_derivation_token_budget}~ACCEPTANCE_TIMEOUT_MS=${acceptance_timeout_ms}" \
    --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,ACCEPTANCE_WEB_AUTH_PASSWORD=jina-web-auth-password:latest" \
    --args=dist/acceptance.js \
    --tasks=1 \
    --max-retries=0 \
    --task-timeout="${acceptance_job_timeout_seconds}s" \
    --quiet

  acceptance_status=0
  gcloud run jobs execute jina-acceptance \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --wait || acceptance_status=$?

  execution_name="$(gcloud run jobs executions list \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --job=jina-acceptance \
    --sort-by='~metadata.creationTimestamp' \
    --limit=1 \
    --format='value(metadata.name)')"

  if [[ -n "${execution_name}" ]]; then
    gcloud run jobs executions describe "${execution_name}" \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --format='yaml(metadata.name,status.startTime,status.completionTime,status.conditions,status.failedCount,status.succeededCount)' || true
  fi

  if [[ "${acceptance_status}" -ne 0 ]]; then
    echo "Acceptance execution failed; Cloud Run job logs follow." >&2
    gcloud logging read \
      "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"jina-acceptance\" AND labels.\"run.googleapis.com/execution_name\"=\"${execution_name}\"" \
      --project="${GCP_PROJECT_ID}" \
      --order=asc \
      --format='value(timestamp,severity,textPayload,jsonPayload.message)' \
      --limit=500 || true
    exit "${acceptance_status}"
  fi
else
  echo "Mechanical deployment mode: candidate readiness passed; full Context acceptance deferred"
fi

# Full acceptance, when selected, used only tagged candidate URLs. Mechanical
# mode reached this point only after candidate readiness and worker-isolation
# checks. Production traffic changes only to this Cloud Build's exact revisions.
cutover_started="true"
post_cutover_phase="cutover"
for service in \
  "jina-api" \
  "jina-context-worker" \
  "jina-task-worker" \
  "jina-dashboard" \
  "jina-admin"; do
  route_candidate_revision "${service}"
done

gcloud run revisions delete "${context_drain_revision}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --no-async \
  --quiet
gcloud run revisions delete "${task_drain_revision}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --no-async \
  --quiet
wait_for_exact_worker_revisions "jina-context-worker" "jina-context-worker-${release_suffix}"
wait_for_exact_worker_revisions "jina-task-worker" "jina-task-worker-${release_suffix}"
stop_release_renewal
run_release_control "release-release"
release_lease_acquired="false"
cutover_started="false"
worker_quiescence_started="false"
board_leases_verified="false"
accepted_cutover_complete="true"
post_cutover_phase="release-control-cleanup"

# The serving worker generation keeps its own numbered credential version.
# The independent control credential and job must now both be verified gone.
# A cleanup failure fails the build but never rolls an accepted
# cutover back to a mixed set of revisions.
post_cutover_cleanup_ok="true"
if destroy_deployment_release_credential_verified; then
  accepted_release_control_credential_destroyed="true"
else
  post_cutover_cleanup_ok="false"
fi
if delete_release_control_job_verified; then
  accepted_release_control_job_deleted="true"
else
  post_cutover_cleanup_ok="false"
fi
if [[ "${post_cutover_cleanup_ok}" != "true" ]]; then
  exit 2
fi
post_cutover_cleanup_complete="true"

# Install the destructive trigger acceptance as an explicit operator-run job
# only after the coordinated candidate is accepted, serving, and its temporary
# release-control artifacts are verified gone. Deployment never executes it,
# and reconciliation failure cannot invalidate the already accepted release.
post_cutover_phase="auxiliary-trigger-acceptance"
reconcile_trigger_acceptance_job_nonfatal
post_cutover_phase="summary"

cat <<SUMMARY
Cloud Build deployment complete
API: ${api_url}
Context worker: ${context_worker_url}
Task worker: ${task_worker_url}
Dashboard: ${dashboard_url}
Admin: ${admin_url}
Image tag: ${image_tag}
Cloud SQL: ${cloud_sql_instance}
Tenancy mode: ${tenancy_mode}
API instances: ${api_min_instances}-${api_max_instances}
API concurrency: ${api_concurrency}
API PostgreSQL pool maximum (per pool): ${api_db_pool_max}
API size: ${api_cpu} CPU / ${api_memory}
Context worker memory: ${context_worker_memory}
Candidate tag: ${release_tag}
Pre-deployment backup: ${context_backup_id}
Context reset mode: ${context_reset_mode}
Deployment acceptance mode: ${deployment_acceptance_mode}
Production trigger acceptance job: ${trigger_acceptance_job} (${trigger_acceptance_job_status}, not executed)
SUMMARY
post_cutover_phase="complete"
