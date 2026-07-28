#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${CLOUD_BUILD_ID:?CLOUD_BUILD_ID is required}"

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
migration_service_account="jina-migration@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
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
acceptance_github_installation_id="${JINA_ACCEPTANCE_GITHUB_INSTALLATION_ID:-}"
api_min_instances="${JINA_API_MIN_INSTANCES:-1}"
api_max_instances="${JINA_API_MAX_INSTANCES:-1}"
api_concurrency="${JINA_API_CONCURRENCY:-10}"
api_cpu="${JINA_API_CPU:-1}"
api_memory="${JINA_API_MEMORY:-1Gi}"
api_request_timeout_seconds="${JINA_API_REQUEST_TIMEOUT_SECONDS:-3600}"
context_api_timeout_ms="${JINA_CONTEXT_API_TIMEOUT_MS:-7800000}"
context_completion_timeout_ms="${JINA_CONTEXT_COMPLETION_TIMEOUT_MS:-600000}"
context_worker_lease_ms="${JINA_CONTEXT_WORKER_LEASE_MS:-9000000}"
# Knowledge derivation runs one agent per build inside Daytona, and its context
# window governs how much it can hold while exploring. 16k was chosen because a
# 64k window overran the old fixed 2400s ceiling and failed the release that was
# waiting on it. Both halves of that reason are gone: the gate now spends its own
# small budget rather than the build's, and a run that reaches its budget
# publishes the pages it finished instead of failing. 16k then cost more than it
# saved — a 40-minute run under the file contract published nothing at all, which
# is what a window that compacts faster than the agent can finish a page looks
# like from the outside.
context_codex_context_tokens="${JINA_CONTEXT_CODEX_CONTEXT_TOKENS:-64000}"
context_codex_compact_tokens="${JINA_CONTEXT_CODEX_COMPACT_TOKENS:-48000}"
# Wall clock one derive stage may use, across its repair run. A build may name
# its own; this is the default when it does not. The deploy gate is NOT bound by
# this value: it passes its own small budget below, so a slow repository costs
# the gate coverage rather than holding up the release.
context_derive_budget_seconds="${JINA_CONTEXT_DERIVE_BUDGET_SECONDS:-5400}"
# The gate's own budget, kept well inside the deploy-backend step timeout. A
# derivation that runs out publishes the pages it finished instead of failing,
# so a small budget here is a coverage choice, not a flakiness risk.
acceptance_derivation_budget_seconds="${JINA_ACCEPTANCE_DERIVATION_BUDGET_SECONDS:-900}"
# The agent writes each document as it finishes it, so a finished document is
# durable and the window bounds one document rather than the whole catalog. A run
# that reaches its budget now keeps the pages it already wrote, which is what
# lets an ordinary build be given hours without a slow derivation failing it.
context_derive_document_files="${JINA_CONTEXT_DERIVE_DOCUMENT_FILES:-true}"
# Standard rather than the model's terse setting, which produced one-paragraph
# documents on a task whose output is the document. A build may override it.
context_derive_detail="${JINA_CONTEXT_DERIVE_DETAIL:-standard}"
context_worker_memory="${JINA_CONTEXT_WORKER_MEMORY:-1Gi}"
context_cutover="${JINA_CONTEXT_CUTOVER:-false}"
context_cutover_backup_id="${JINA_CONTEXT_CUTOVER_BACKUP_ID:-}"
context_cutover_legacy_backup_id="${JINA_CONTEXT_CUTOVER_LEGACY_BACKUP_ID:-}"
legacy_cutover_tenant_ids="${JINA_LEGACY_CUTOVER_TENANT_IDS:-}"
release_sha="${JINA_RELEASE_SHA:-}"
build_commit_sha="${JINA_BUILD_COMMIT_SHA:-}"
trusted_primary_cloud_sql_instance="jina-463721:us-east1:jina-db"
trusted_legacy_graph_cloud_sql_instance="jina-v2:us-central1:jina-postgres"
trusted_legacy_graph_db_name="jina"
trusted_legacy_graph_db_user="jina_app"
trusted_legacy_graph_db_pass_secret="jina-db-password:latest"
cutover_primary_db_user="jina_cutover_auditor"
cutover_primary_db_pass_secret="jina-primary-cutover-auditor-db-password:latest"
cutover_legacy_graph_db_user="jina_cutover_auditor"
cutover_legacy_graph_db_pass_secret="jina-legacy-cutover-auditor-db-password:latest"

if [[ "${image_tag}" != "${CLOUD_BUILD_ID}" ]]; then
  echo "Deployment must deploy images built by the current coordinated Cloud Build" >&2
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

validate_cloud_sql_instance "CLOUD_SQL_INSTANCE" "${cloud_sql_instance}"
validate_nonnegative_integer "JINA_API_MIN_INSTANCES" "${api_min_instances}"
validate_positive_integer "JINA_API_MAX_INSTANCES" "${api_max_instances}"
validate_positive_integer "JINA_API_CONCURRENCY" "${api_concurrency}"
validate_positive_integer "JINA_API_REQUEST_TIMEOUT_SECONDS" "${api_request_timeout_seconds}"
validate_positive_integer "JINA_CONTEXT_API_TIMEOUT_MS" "${context_api_timeout_ms}"
validate_positive_integer "JINA_CONTEXT_COMPLETION_TIMEOUT_MS" "${context_completion_timeout_ms}"
validate_positive_integer "JINA_CONTEXT_WORKER_LEASE_MS" "${context_worker_lease_ms}"
validate_positive_integer "JINA_CONTEXT_CODEX_CONTEXT_TOKENS" "${context_codex_context_tokens}"
validate_positive_integer "JINA_CONTEXT_CODEX_COMPACT_TOKENS" "${context_codex_compact_tokens}"
if (( context_codex_compact_tokens >= context_codex_context_tokens )); then
  echo "JINA_CONTEXT_CODEX_COMPACT_TOKENS must stay below the context window it compacts" >&2
  exit 2
fi
if [[ -n "${acceptance_github_installation_id}" ]]; then
  validate_positive_integer "JINA_ACCEPTANCE_GITHUB_INSTALLATION_ID" "${acceptance_github_installation_id}"
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
validate_positive_integer "JINA_CONTEXT_DERIVE_BUDGET_SECONDS" "${context_derive_budget_seconds}"
validate_positive_integer "JINA_ACCEPTANCE_DERIVATION_BUDGET_SECONDS" "${acceptance_derivation_budget_seconds}"
# The derive budget is spent inside one context operation, so the operation
# timeout has to outlast it or the stage is cut short by the wrong limit.
if (( context_derive_budget_seconds * 1000 >= context_api_timeout_ms )); then
  echo "JINA_CONTEXT_DERIVE_BUDGET_SECONDS must be below JINA_CONTEXT_API_TIMEOUT_MS" >&2
  exit 2
fi
# 7200s is the ceiling the sandbox enforces; a larger value would be silently
# clamped rather than honoured.
if (( context_derive_budget_seconds > 7200 )); then
  echo "JINA_CONTEXT_DERIVE_BUDGET_SECONDS must not exceed the 7200-second sandbox ceiling" >&2
  exit 2
fi
# A release waits on the gate's derivation, so its budget must stay inside the
# deploy-backend step timeout in cloudbuild.yaml.
if (( acceptance_derivation_budget_seconds > 3000 )); then
  echo "JINA_ACCEPTANCE_DERIVATION_BUDGET_SECONDS must stay well inside the 4200s deploy-backend step" >&2
  exit 2
fi
if [[ "${db_pass_secret}" == *","* || "${db_pass_secret}" == *"~"* ||
      "${migration_db_pass_secret}" == *","* || "${migration_db_pass_secret}" == *"~"* ]]; then
  echo "Database password secrets must be Cloud Run secret specs without commas or tildes" >&2
  exit 2
fi
if [[ "${context_cutover}" != "true" && "${context_cutover}" != "false" ]]; then
  echo "JINA_CONTEXT_CUTOVER must be true or false" >&2
  exit 2
fi
deploy_traffic_args=()
if [[ "${context_cutover}" == "false" ]]; then
  deploy_traffic_args=(--no-traffic)
fi

legacy_api_env_value() {
  local environment_name="$1"
  LEGACY_API_DESCRIPTION="${legacy_api_description}" LEGACY_API_ENV_NAME="${environment_name}" python3 -c '
import json
import os

description = json.loads(os.environ["LEGACY_API_DESCRIPTION"])
name = os.environ["LEGACY_API_ENV_NAME"]
for container in description.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []):
    for entry in container.get("env", []):
        if entry.get("name") == name:
            print(entry.get("value", ""))
            raise SystemExit(0)
raise SystemExit(1)
'
}

legacy_api_env_secret_spec() {
  local environment_name="$1"
  LEGACY_API_DESCRIPTION="${legacy_api_description}" LEGACY_API_ENV_NAME="${environment_name}" python3 -c '
import json
import os

description = json.loads(os.environ["LEGACY_API_DESCRIPTION"])
name = os.environ["LEGACY_API_ENV_NAME"]
for container in description.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []):
    for entry in container.get("env", []):
        if entry.get("name") != name:
            continue
        reference = entry.get("valueFrom", {}).get("secretKeyRef", {})
        secret_name = reference.get("name")
        version = reference.get("key")
        if not secret_name or not version:
            raise SystemExit(1)
        print(f"{secret_name}:{version}")
        raise SystemExit(0)
raise SystemExit(1)
'
}

api_env_vars="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_ENABLE_DEV_ENDPOINTS=false~JINA_SIMULATE_RUNS=false~JINA_SEED_DEMO=false~JINA_TENANCY_MODE=${tenancy_mode}~INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${db_user}~JINA_DB_MANAGE_SCHEMA=false~CONTEXT_WORKER_LEASE_MS=${context_worker_lease_ms}~CONTEXT_DERIVE_DOCUMENT_FILES=${context_derive_document_files}"
api_secrets="DB_PASS=${db_pass_secret},GITHUB_WEBHOOK_SECRET=jina-github-webhook-secret:latest,INTERNAL_API_TOKEN=jina-internal-api-token:latest,CONTEXT_API_TOKEN=jina-context-api-token:latest"

case "${tenancy_mode}" in
  fixed)
    : "${fixed_tenant_id:?JINA_FIXED_TENANT_ID is required in fixed mode}"
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

verify_cutover_backup() {
  local metadata="$1"
  local expected_description="$2"
  local require_freshness="$3"
  BACKUP_METADATA="${metadata}" \
    EXPECTED_DESCRIPTION="${expected_description}" \
    REQUIRE_FRESHNESS="${require_freshness}" \
    python3 -c '
import datetime
import json
import os

metadata = json.loads(os.environ["BACKUP_METADATA"])
if metadata.get("status") != "SUCCESSFUL":
    raise SystemExit("backup status is not SUCCESSFUL")
if metadata.get("description") != os.environ["EXPECTED_DESCRIPTION"]:
    raise SystemExit("backup description is not bound to the exact release SHA")
end_time = metadata.get("endTime")
if not end_time:
    raise SystemExit("backup has no completion time")
completed = datetime.datetime.fromisoformat(end_time.replace("Z", "+00:00"))
age = (datetime.datetime.now(datetime.timezone.utc) - completed).total_seconds()
if age < -300:
    raise SystemExit("backup completion time is in the future")
if os.environ["REQUIRE_FRESHNESS"] == "true" and age > 21600:
    raise SystemExit("backup completion must be within the last six hours")
print(end_time)
'
}

cutover_marker_fingerprint() {
  CUTOVER_MARKER_INPUT="$1" python3 -c '
import hashlib
import os

print(hashlib.sha256(os.environ["CUTOVER_MARKER_INPUT"].encode()).hexdigest()[:32])
'
}

verify_cutover_marker() {
  CUTOVER_MARKER_METADATA="$1" EXPECTED_CUTOVER_MARKER="$2" python3 -c '
import json
import os

metadata = json.loads(os.environ["CUTOVER_MARKER_METADATA"])
actual = metadata.get("metadata", {}).get("labels", {}).get("jina_cutover_marker")
if actual != os.environ["EXPECTED_CUTOVER_MARKER"]:
    raise SystemExit("cutover marker is absent or belongs to different release evidence")
'
}

route_latest_revision() {
  local service="$1"
  local revision
  local ready
  revision="$(gcloud run services describe "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format='value(status.latestCreatedRevisionName)')"
  if [[ -z "${revision}" ]]; then
    echo "${service} did not report a latest created revision" >&2
    exit 2
  fi
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
  gcloud run services update-traffic "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --to-revisions="${revision}=100" \
    --quiet >/dev/null
  echo "Routed ${service} 100% to ${revision}"
}

snapshot_service_traffic() {
  local service="$1"
  local description
  if ! description="$(gcloud run services describe "${service}" \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --format=json 2>/dev/null)"; then
    return 0
  fi
  SERVICE_DESCRIPTION="${description}" python3 -c '
import json
import os

description = json.loads(os.environ["SERVICE_DESCRIPTION"])
assignments = []
for target in description.get("status", {}).get("traffic", []):
    revision = target.get("revisionName")
    percent = target.get("percent")
    if revision and isinstance(percent, int) and percent > 0:
        assignments.append(f"{revision}={percent}")
if assignments and sum(int(item.rsplit("=", 1)[1]) for item in assignments) != 100:
    raise SystemExit("serving traffic does not total 100 percent")
print(",".join(assignments))
'
}

restore_service_traffic() {
  local service="$1"
  local assignments="$2"
  if [[ -z "${assignments}" ]]; then
    echo "No prior traffic assignment recorded for ${service}; leaving it unchanged" >&2
    return 0
  fi
  gcloud run services update-traffic "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --to-revisions="${assignments}" \
    --quiet >/dev/null
  echo "Restored ${service} traffic to ${assignments}" >&2
}

release_cutover_started="false"
prior_api_traffic=""
prior_context_worker_traffic=""
prior_task_worker_traffic=""
prior_dashboard_traffic=""
prior_admin_traffic=""
# Set once the migration has advanced the schema, after which restoring the
# previous traffic assignments would take the API down rather than recover it.
schema_migration_applied="false"

rollback_failed_release() {
  local status=$?
  trap - EXIT
  # Restoring traffic assumes the previous revision can still serve the database.
  # Once the migration has advanced the schema that is no longer true: the
  # previous revision predates the context engine, so restoring it takes the API
  # down instead of recovering it, and a traffic switch cannot undo a migration.
  # Leave the assignments alone and say what recovery actually requires.
  if [[ "${status}" -ne 0 && "${schema_migration_applied}" == "true" ]]; then
    cat >&2 <<'ROLLFORWARD'
Release failed after the migration advanced the database schema.
Cloud Run traffic has deliberately NOT been restored: the previous revision
predates this schema and returns ok=false, so restoring it causes an outage
rather than recovering from one.
Recover by rolling forward to the newest ready revision, for example:
  gcloud run services update-traffic jina-api --region=<region> --project=<project> \
    --to-revisions=<newest-ready-revision>=100
Then resolve the failure above and re-run the release.
ROLLFORWARD
    exit "${status}"
  fi
  if [[ "${status}" -ne 0 && "${release_cutover_started}" == "true" &&
        "${context_cutover}" == "false" ]]; then
    echo "Release failed; restoring the previous Cloud Run traffic assignments" >&2
    local rollback_status=0
    restore_service_traffic "jina-context-worker" "${prior_context_worker_traffic}" || rollback_status=$?
    restore_service_traffic "jina-task-worker" "${prior_task_worker_traffic}" || rollback_status=$?
    restore_service_traffic "jina-api" "${prior_api_traffic}" || rollback_status=$?
    restore_service_traffic "jina-dashboard" "${prior_dashboard_traffic}" || rollback_status=$?
    restore_service_traffic "jina-admin" "${prior_admin_traffic}" || rollback_status=$?
    if [[ "${rollback_status}" -ne 0 ]]; then
      echo "One or more Cloud Run services could not be rolled back automatically" >&2
    fi
  fi
  exit "${status}"
}

trap rollback_failed_release EXIT

for secret_spec in \
  "${db_pass_secret}" \
  "${migration_db_pass_secret}" \
  "jina-github-webhook-secret:latest" \
  "jina-internal-api-token:latest" \
  "jina-context-api-token:latest" \
  "jina-daytona-api-key:latest" \
  "jina-openrouter-api-key:latest" \
  "jina-github-app-id:latest" \
  "jina-github-app-private-key:latest" \
  "jina-openai-api-key:latest" \
  "jina-github-clone-token:latest"; do
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
  "${acceptance_service_account}"; do
  gcloud iam service-accounts describe "${service_account}" --project="${GCP_PROJECT_ID}" >/dev/null
done
gcloud iam service-accounts describe "${migration_service_account}" --project="${GCP_PROJECT_ID}" >/dev/null

api_image="$(resolve_release_image "${api_image}")"
worker_image="$(resolve_release_image "${worker_image}")"
dashboard_image="$(resolve_release_image "${dashboard_image}")"
admin_image="$(resolve_release_image "${admin_image}")"

service_snapshot_contains() {
  local snapshot="$1"
  local expected_name="$2"
  local service_name
  while IFS= read -r service_name; do
    if [[ "${service_name}" == "${expected_name}" ]]; then
      return 0
    fi
  done <<<"${snapshot}"
  return 1
}

if ! service_list_snapshot="$(gcloud run services list \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --format='value(metadata.name)')"; then
  echo "Unable to obtain an authoritative Cloud Run service inventory" >&2
  exit 2
fi

legacy_worker="jina-context-graph-worker"
legacy_worker_present="false"
if service_snapshot_contains "${service_list_snapshot}" "${legacy_worker}"; then
  legacy_worker_present="true"
  if ! gcloud run services describe "${legacy_worker}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" >/dev/null; then
    echo "Unable to verify the listed legacy context worker" >&2
    exit 2
  fi
fi
api_present="false"
legacy_api_present="false"
legacy_api_description=""
if service_snapshot_contains "${service_list_snapshot}" "jina-api"; then
  api_present="true"
  if ! legacy_api_description="$(gcloud run services describe jina-api \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format=json)"; then
    echo "Unable to verify the listed API service" >&2
    exit 2
  fi
  api_environment_names="$(LEGACY_API_DESCRIPTION="${legacy_api_description}" python3 -c '
import json
import os

description = json.loads(os.environ["LEGACY_API_DESCRIPTION"])
names = []
for container in description.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []):
    for entry in container.get("env", []):
        name = entry.get("name")
        if name:
            names.append(name)
print(";".join(names))
')"
  if [[ ";${api_environment_names};" == *";GRAPH_API_TOKEN;"* ||
        ";${api_environment_names};" == *";GRAPH_DB_NAME;"* ]]; then
    legacy_api_present="true"
  fi
fi
if [[ "${context_cutover}" == "false" ]]; then
  if [[ "${legacy_worker_present}" == "true" || "${legacy_api_present}" == "true" ]]; then
    echo "Legacy context runtime is present; destructive cutover evidence is required before migration" >&2
    exit 2
  fi
  if [[ "${api_present}" != "true" ]]; then
    echo "No context-engine API exists; an interrupted first cutover must resume in destructive mode" >&2
    exit 2
  fi
fi
if [[ "${context_cutover}" == "true" ]]; then
  if [[ "${api_present}" == "true" && "${legacy_api_present}" != "true" ]]; then
    echo "A context-engine API already exists; rerun as a normal release with JINA_CONTEXT_CUTOVER=false" >&2
    exit 2
  fi
  if [[ ! "${context_cutover_backup_id}" =~ ^[1-9][0-9]*$ ]]; then
    echo "JINA_CONTEXT_CUTOVER_BACKUP_ID must identify the verified pre-cutover backup" >&2
    exit 2
  fi
  if [[ ! "${context_cutover_legacy_backup_id}" =~ ^[1-9][0-9]*$ ]]; then
    echo "JINA_CONTEXT_CUTOVER_LEGACY_BACKUP_ID must identify the verified legacy graph backup" >&2
    exit 2
  fi
  if [[ ! "${release_sha}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "JINA_RELEASE_SHA must be the exact 40-character source SHA for a destructive cutover" >&2
    exit 2
  fi
  if [[ "${build_commit_sha}" != "${release_sha}" ]]; then
    echo "JINA_RELEASE_SHA must equal the connected-repository Cloud Build COMMIT_SHA" >&2
    exit 2
  fi
  resolved_source_sha="$(gcloud builds describe "${CLOUD_BUILD_ID}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format='value(sourceProvenance.resolvedGitSource.revision)')"
  if [[ "${resolved_source_sha}" != "${release_sha}" ]]; then
    echo "JINA_RELEASE_SHA must equal Cloud Build's resolved repository source revision" >&2
    exit 2
  fi
  if [[ "${image_tag}" != "${CLOUD_BUILD_ID}" ]]; then
    echo "Destructive context cutover must deploy images built by the current coordinated Cloud Build" >&2
    exit 2
  fi
  if [[ "${cloud_sql_instance}" != "${trusted_primary_cloud_sql_instance}" ||
        "${db_name}" != "jina" ||
        "${migration_db_user}" != "jina_app" ||
        "${migration_db_pass_secret}" != "jina-primary-owner-db-password:latest" ]]; then
    echo "Destructive cutover must use the trusted production primary database identity" >&2
    exit 2
  fi
  require_secret "${trusted_legacy_graph_db_pass_secret}"
  require_secret "${cutover_primary_db_pass_secret}"
  require_secret "${cutover_legacy_graph_db_pass_secret}"
  IFS='|' read -r -a cutover_tenants <<<"${legacy_cutover_tenant_ids}"
  if (( ${#cutover_tenants[@]} == 0 )); then
    echo "JINA_LEGACY_CUTOVER_TENANT_IDS must contain the complete active-tenant inventory" >&2
    exit 2
  fi
  for tenant_id in "${cutover_tenants[@]}"; do
    if [[ ! "${tenant_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
      echo "JINA_LEGACY_CUTOVER_TENANT_IDS must be a pipe-delimited list of canonical UUIDs" >&2
      exit 2
    fi
  done
  if [[ "${legacy_api_present}" == "true" ]]; then
    deployed_legacy_graph_socket="$(legacy_api_env_value GRAPH_INSTANCE_UNIX_SOCKET)"
    deployed_legacy_graph_db_name="$(legacy_api_env_value GRAPH_DB_NAME)"
    deployed_legacy_graph_db_user="$(legacy_api_env_value GRAPH_DB_USER)"
    deployed_legacy_graph_db_pass_secret="$(legacy_api_env_secret_spec GRAPH_DB_PASS)"
    if [[ "${deployed_legacy_graph_socket}" != "/cloudsql/${trusted_legacy_graph_cloud_sql_instance}" ||
          "${deployed_legacy_graph_db_name}" != "${trusted_legacy_graph_db_name}" ||
          "${deployed_legacy_graph_db_user}" != "${trusted_legacy_graph_db_user}" ||
          "${deployed_legacy_graph_db_pass_secret}" != "${trusted_legacy_graph_db_pass_secret}" ]]; then
      echo "Declared legacy graph database does not match the deployed legacy API" >&2
      exit 2
    fi
  fi
  database_project="${cloud_sql_instance%%:*}"
  database_instance="${cloud_sql_instance##*:}"
  legacy_database_project="${trusted_legacy_graph_cloud_sql_instance%%:*}"
  legacy_database_instance="${trusted_legacy_graph_cloud_sql_instance##*:}"
  cutover_marker="$(cutover_marker_fingerprint \
    "${release_sha}|${cloud_sql_instance}|${context_cutover_backup_id}|${trusted_legacy_graph_cloud_sql_instance}|${context_cutover_legacy_backup_id}")"
  backup_freshness_required="true"
  if [[ "${legacy_api_present}" != "true" || "${legacy_worker_present}" != "true" ]]; then
    backup_freshness_required="false"
    if ! cutover_marker_metadata="$(gcloud run jobs describe jina-context-cutover-preflight \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --format=json)"; then
      echo "Interrupted cutover has no authoritative durable resume marker" >&2
      exit 2
    fi
    if ! verify_cutover_marker "${cutover_marker_metadata}" "${cutover_marker}"; then
      echo "Interrupted cutover marker does not match the requested release and backups" >&2
      exit 2
    fi
  fi
  primary_backup_metadata="$(gcloud sql backups describe "${context_cutover_backup_id}" \
    --project="${database_project}" \
    --instance="${database_instance}" \
    --format=json)"
  if ! primary_backup_completed_at="$(verify_cutover_backup \
    "${primary_backup_metadata}" \
    "pre-context-engine-primary-${release_sha}" \
    "${backup_freshness_required}")"; then
    echo "Primary backup ${context_cutover_backup_id} is not valid evidence for release ${release_sha}" >&2
    exit 2
  fi
  legacy_backup_metadata="$(gcloud sql backups describe "${context_cutover_legacy_backup_id}" \
    --project="${legacy_database_project}" \
    --instance="${legacy_database_instance}" \
    --format=json)"
  if ! legacy_backup_completed_at="$(verify_cutover_backup \
    "${legacy_backup_metadata}" \
    "pre-context-engine-legacy-graph-${release_sha}" \
    "${backup_freshness_required}")"; then
    echo "Legacy graph backup ${context_cutover_legacy_backup_id} is not valid evidence for release ${release_sha}" >&2
    exit 2
  fi

  # This non-serving job is also the durable resume marker. It is created
  # before either legacy service is removed and is bound to the exact release,
  # instances, and backup IDs through the verified label fingerprint.
  gcloud run jobs deploy jina-context-cutover-preflight \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --image="${api_image}" \
    --service-account="${migration_service_account}" \
    --set-cloudsql-instances="${cloud_sql_instance},${trusted_legacy_graph_cloud_sql_instance}" \
    --labels="jina_cutover_marker=${cutover_marker}" \
    --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${cutover_primary_db_user}~LEGACY_GRAPH_INSTANCE_UNIX_SOCKET=/cloudsql/${trusted_legacy_graph_cloud_sql_instance}~LEGACY_GRAPH_DB_NAME=${trusted_legacy_graph_db_name}~LEGACY_GRAPH_DB_USER=${cutover_legacy_graph_db_user}~JINA_LEGACY_CUTOVER_TENANT_IDS=${legacy_cutover_tenant_ids}" \
    --set-secrets="DB_PASS=${cutover_primary_db_pass_secret},LEGACY_GRAPH_DB_PASS=${cutover_legacy_graph_db_pass_secret}" \
    --args=dist/cutover-preflight.js \
    --tasks=1 \
    --max-retries=0 \
    --task-timeout=5m \
    --quiet

  cat <<CUTOVER
Starting destructive context cutover
Release SHA: ${release_sha}
Verified primary backup: ${database_project}/${database_instance}/${context_cutover_backup_id}
Verified legacy graph backup: ${legacy_database_project}/${legacy_database_instance}/${context_cutover_legacy_backup_id}
Primary backup completed: ${primary_backup_completed_at}
Legacy graph backup completed: ${legacy_backup_completed_at}
Backup freshness required: ${backup_freshness_required}
CUTOVER

  # Stop every intake surface and then claims before auditing the durable queue. The
  # database audit runs only after the old write path is absent, so no task can
  # cross a preflight-to-shutdown race.
  if [[ "${legacy_api_present}" == "true" ]]; then
    gcloud run services delete jina-api \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --quiet
  fi
  if [[ "${legacy_worker_present}" == "true" ]]; then
    gcloud run services delete "${legacy_worker}" \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --quiet
  fi
  if ! post_quiesce_service_snapshot="$(gcloud run services list \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format='value(metadata.name)')"; then
    echo "Unable to verify Cloud Run service absence after quiesce" >&2
    exit 2
  fi
  if service_snapshot_contains "${post_quiesce_service_snapshot}" "${legacy_worker}"; then
    echo "Legacy context worker still exists after quiesce" >&2
    exit 2
  fi
  if service_snapshot_contains "${post_quiesce_service_snapshot}" "jina-api"; then
    echo "API still exists after destructive quiesce" >&2
    exit 2
  fi
  echo "Legacy context worker and API are absent; auditing the fenced durable queue"

  gcloud run jobs execute jina-context-cutover-preflight \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --wait
  echo "Fenced legacy queue has no active graph work; migration may start"
fi

# Apply owner-only DDL before any new runtime revision starts. Runtime services
# intentionally run with JINA_DB_MANAGE_SCHEMA=false and use a different Google
# identity that has no access to the migration-owner database secret.
gcloud run jobs deploy jina-context-migrate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --service-account="${migration_service_account}" \
  --set-cloudsql-instances="${cloud_sql_instance}" \
  --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${migration_db_user}~CONTEXT_RUNTIME_DB_USER=${db_user}" \
  --set-secrets="DB_PASS=${migration_db_pass_secret}" \
  --args=node_modules/@jina/db/dist/migrate.js,--install-roles \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=15m \
  --quiet

gcloud run jobs execute jina-context-migrate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --wait
# The schema is now ahead of whatever the previous revision expects, so a later
# failure must not restore the previous traffic assignments.
schema_migration_applied="true"

if [[ "${context_cutover}" == "false" ]]; then
  prior_api_traffic="$(snapshot_service_traffic "jina-api")"
  prior_context_worker_traffic="$(snapshot_service_traffic "jina-context-worker")"
  prior_task_worker_traffic="$(snapshot_service_traffic "jina-task-worker")"
  prior_dashboard_traffic="$(snapshot_service_traffic "jina-dashboard")"
  prior_admin_traffic="$(snapshot_service_traffic "jina-admin")"
fi
release_cutover_started="true"

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
  "${deploy_traffic_args[@]}" \
  --quiet

route_latest_revision "jina-api"
api_url="$(gcloud run services describe jina-api \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --format='value(status.url)')"
retry_health "${api_url}/health"

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
  --set-env-vars="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_API_URL=${api_url}~WORKER_TOPICS=run-ingest-evidence|run-derive-knowledge|run-index-context~JINA_REQUIRE_GITHUB_INSTALLATION=false~CONTEXT_API_TIMEOUT_MS=${context_api_timeout_ms}~CONTEXT_COMPLETION_TIMEOUT_MS=${context_completion_timeout_ms}~CONTEXT_GITHUB_HISTORY_LIMIT=500~CONTEXT_GIT_HISTORY_LIMIT=5000~CONTEXT_MAX_FILE_BYTES=5242880~CONTEXT_MAX_SNAPSHOT_BYTES=8388608~DAYTONA_RUN_TIMEOUT_SECONDS=${context_derive_budget_seconds}~CONTEXT_DERIVE_BUDGET_SECONDS=${context_derive_budget_seconds}~CONTEXT_CODEX_PROVIDER=openrouter~CONTEXT_CODEX_MODEL=openai/gpt-5.4-mini~CONTEXT_CODEX_EFFORT=medium~CONTEXT_CODEX_CONTEXT_TOKENS=${context_codex_context_tokens}~CONTEXT_CODEX_COMPACT_TOKENS=${context_codex_compact_tokens}~CONTEXT_DERIVE_DOCUMENT_FILES=${context_derive_document_files}~CONTEXT_DERIVE_DETAIL=${context_derive_detail}~CONTEXT_AGENT_ARCHIVE_MAX_BYTES=134217728" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,DAYTONA_API_KEY=jina-daytona-api-key:latest,OPENROUTER_API_KEY=jina-openrouter-api-key:latest,GITHUB_APP_ID=jina-github-app-id:latest,GITHUB_APP_PRIVATE_KEY=jina-github-app-private-key:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  "${deploy_traffic_args[@]}" \
  --quiet

route_latest_revision "jina-context-worker"
context_worker_url="$(gcloud run services describe jina-context-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --format='value(status.url)')"

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
  --set-env-vars="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_API_URL=${api_url}~WORKER_TOPICS=run-review|run-research|run-publish|run-cleanup~REVIEW_MODEL=gpt-5.6-sol" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,OPENAI_API_KEY=jina-openai-api-key:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  "${deploy_traffic_args[@]}" \
  --quiet

route_latest_revision "jina-task-worker"
task_worker_url="$(gcloud run services describe jina-task-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --format='value(status.url)')"

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
  "${deploy_traffic_args[@]}" \
  --quiet
route_latest_revision "jina-dashboard"
dashboard_url="$(gcloud run services describe jina-dashboard \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --format='value(status.url)')"

gcloud run deploy jina-admin \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${admin_image}" \
  --allow-unauthenticated \
  --service-account="${admin_service_account}" \
  --set-env-vars="${web_env_vars}" \
  --set-secrets="${web_secrets}" \
  "${deploy_traffic_args[@]}" \
  --quiet
route_latest_revision "jina-admin"
admin_url="$(gcloud run services describe jina-admin \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --format='value(status.url)')"

gcloud run jobs deploy jina-acceptance \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${worker_image}" \
  --service-account="${acceptance_service_account}" \
  --set-env-vars="^~^JINA_API_URL=${api_url}~ACCEPTANCE_CONTEXT_WORKER_URL=${context_worker_url}~ACCEPTANCE_TASK_WORKER_URL=${task_worker_url}~ACCEPTANCE_TENANT_ID=${acceptance_tenant_id}~ACCEPTANCE_PRINCIPAL_ID=${context_query_principal_id}~ACCEPTANCE_ADMIN_PRINCIPAL_ID=${acceptance_principal_id}~ACCEPTANCE_REQUEST_KEY=deploy-${CLOUD_BUILD_ID}~ACCEPTANCE_GITHUB_INSTALLATION_ID=${acceptance_github_installation_id}~ACCEPTANCE_DERIVATION_BUDGET_SECONDS=${acceptance_derivation_budget_seconds}~ACCEPTANCE_TIMEOUT_MS=3000000" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,CONTEXT_API_TOKEN=jina-context-api-token:latest" \
  --args=dist/acceptance.js \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=55m \
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

release_cutover_started="false"

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
API size: ${api_cpu} CPU / ${api_memory}
Context worker memory: ${context_worker_memory}
SUMMARY
