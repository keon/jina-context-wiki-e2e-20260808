#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${CLOUD_BUILD_ID:?CLOUD_BUILD_ID is required}"

gar="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/jina"
image_tag="${IMAGE_TAG:-${CLOUD_BUILD_ID}}"
api_image="${gar}/api:${image_tag}"
worker_image="${gar}/worker:${image_tag}"
runtime_service_account="jina-runtime@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
cloud_sql_instance="${CLOUD_SQL_INSTANCE:-${GCP_PROJECT_ID}:${GCP_REGION}:jina-postgres}"
graph_cloud_sql_instance="${GRAPH_CLOUD_SQL_INSTANCE:-${GCP_PROJECT_ID}:${GCP_REGION}:jina-postgres}"
tenancy_mode="${JINA_TENANCY_MODE:-fixed}"
db_name="${JINA_DB_NAME:-jina}"
db_user="${JINA_DB_USER:-jina_app}"
db_pass_secret="${JINA_DB_PASS_SECRET:-jina-db-password:latest}"
graph_db_name="${JINA_GRAPH_DB_NAME:-jina}"
graph_db_user="${JINA_GRAPH_DB_USER:-jina_app}"
graph_db_pass_secret="${JINA_GRAPH_DB_PASS_SECRET:-jina-db-password:latest}"
fixed_tenant_id="${JINA_FIXED_TENANT_ID:-omlabs}"
acceptance_github_installation_id="${JINA_ACCEPTANCE_GITHUB_INSTALLATION_ID:-}"
api_min_instances="${JINA_API_MIN_INSTANCES:-1}"
api_max_instances="${JINA_API_MAX_INSTANCES:-3}"
api_concurrency="${JINA_API_CONCURRENCY:-20}"
api_cpu="${JINA_API_CPU:-1}"
api_memory="${JINA_API_MEMORY:-512Mi}"

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
validate_cloud_sql_instance "GRAPH_CLOUD_SQL_INSTANCE" "${graph_cloud_sql_instance}"
validate_nonnegative_integer "JINA_API_MIN_INSTANCES" "${api_min_instances}"
validate_positive_integer "JINA_API_MAX_INSTANCES" "${api_max_instances}"
validate_positive_integer "JINA_API_CONCURRENCY" "${api_concurrency}"
validate_positive_integer "JINA_ACCEPTANCE_GITHUB_INSTALLATION_ID" "${acceptance_github_installation_id}"
if (( api_min_instances > api_max_instances )); then
  echo "JINA_API_MIN_INSTANCES must not exceed JINA_API_MAX_INSTANCES" >&2
  exit 2
fi
if [[ "${db_pass_secret}" == *","* || "${db_pass_secret}" == *"~"* ]]; then
  echo "JINA_DB_PASS_SECRET must be a Cloud Run secret spec without commas or tildes" >&2
  exit 2
fi
if [[ "${graph_db_pass_secret}" == *","* || "${graph_db_pass_secret}" == *"~"* ]]; then
  echo "JINA_GRAPH_DB_PASS_SECRET must be a Cloud Run secret spec without commas or tildes" >&2
  exit 2
fi

cloud_sql_instances="${cloud_sql_instance}"
if [[ "${graph_cloud_sql_instance}" != "${cloud_sql_instance}" ]]; then
  cloud_sql_instances+=",${graph_cloud_sql_instance}"
fi

api_env_vars="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_ENABLE_DEV_ENDPOINTS=false~JINA_SIMULATE_RUNS=false~JINA_SEED_DEMO=false~JINA_GITHUB_WEBHOOK_ENABLED=false~JINA_TENANCY_MODE=${tenancy_mode}~INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${db_user}~GRAPH_INSTANCE_UNIX_SOCKET=/cloudsql/${graph_cloud_sql_instance}~GRAPH_DB_NAME=${graph_db_name}~GRAPH_DB_USER=${graph_db_user}~JINA_DB_MANAGE_SCHEMA=false"
api_secrets="DB_PASS=${db_pass_secret},GRAPH_DB_PASS=${graph_db_pass_secret},INTERNAL_API_TOKEN=jina-internal-api-token:latest,GRAPH_API_TOKEN=jina-graph-api-token:latest,JINA_GLOBAL_ADMIN_TOKEN=jina-global-admin-token:latest,SECRETS_ENCRYPTION_KEY=jina-secrets-encryption-key:latest"

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

verify_worker_health() {
  local url="$1"
  local expected_topics="$2"
  HEALTH_URL="${url}/health" EXPECTED_TOPICS="${expected_topics}" python3 - <<'PY'
import json
import os
import time
import urllib.request

url = os.environ["HEALTH_URL"]
expected = os.environ["EXPECTED_TOPICS"].split("|")
allowed = {
    "active",
    "consecutiveApiFailures",
    "lastApiError",
    "lastApiErrorAt",
    "lastApiSuccessAt",
    "lastWork",
    "metrics",
    "ok",
    "topics",
    "workerId",
}
last_work_allowed = {"failureCategory", "finishedAt", "outcome", "topic"}
for attempt in range(1, 21):
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            health = json.load(response)
        assert health.get("ok") is True
        assert health.get("topics") == expected
        assert set(health) <= allowed
        last_work = health.get("lastWork")
        assert last_work is None or set(last_work) <= last_work_allowed
        print(json.dumps(health, separators=(",", ":")))
        raise SystemExit(0)
    except Exception as error:
        if attempt == 20:
            raise RuntimeError(f"worker health check failed after {attempt} attempts: {url}") from error
        time.sleep(3)
PY
}

require_secret() {
  local secret_spec="$1"
  local secret_name="${secret_spec%%:*}"
  gcloud secrets describe "${secret_name}" --project="${GCP_PROJECT_ID}" >/dev/null
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

for secret_spec in \
  "${db_pass_secret}" \
  "${graph_db_pass_secret}" \
  "jina-internal-api-token:latest" \
  "jina-graph-api-token:latest" \
  "jina-global-admin-token:latest" \
  "jina-secrets-encryption-key:latest" \
  "jina-daytona-api-key:latest" \
  "jina-openrouter-api-key:latest" \
  "jina-github-app-id:latest" \
  "jina-github-app-private-key:latest" \
  "jina-openai-api-key:latest" \
  "jina-github-api-token:latest" \
  "jina-github-clone-token:latest"; do
  require_secret "${secret_spec}"
done

# Apply owner-only DDL before any new runtime revision starts. Runtime services
# intentionally run with JINA_DB_MANAGE_SCHEMA=false and must never discover a
# missing table under live traffic.
gcloud run jobs deploy jina-context-graph-migrate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --service-account="${runtime_service_account}" \
  --set-cloudsql-instances="${graph_cloud_sql_instance}" \
  --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${graph_cloud_sql_instance}~DB_NAME=${graph_db_name}~DB_USER=${graph_db_user}" \
  --set-secrets="DB_PASS=${graph_db_pass_secret}" \
  --args=node_modules/@jina/db/dist/migrate.js \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=15m \
  --quiet

gcloud run jobs execute jina-context-graph-migrate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --wait

gcloud run deploy jina-api \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --allow-unauthenticated \
  --service-account="${runtime_service_account}" \
  --set-cloudsql-instances="${cloud_sql_instances}" \
  --concurrency="${api_concurrency}" \
  --cpu="${api_cpu}" \
  --memory="${api_memory}" \
  --timeout=900 \
  --liveness-probe="initialDelaySeconds=30,timeoutSeconds=10,periodSeconds=30,failureThreshold=3,httpGet.path=/health,httpGet.port=8080" \
  --min-instances="${api_min_instances}" \
  --max-instances="${api_max_instances}" \
  --set-env-vars="${api_env_vars}" \
  --set-secrets="${api_secrets}" \
  --quiet

route_latest_revision "jina-api"
api_url="$(gcloud run services describe jina-api \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --format='value(status.url)')"
retry_health "${api_url}/health"

gcloud run deploy jina-context-graph-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${worker_image}" \
  --allow-unauthenticated \
  --service-account="${runtime_service_account}" \
  --concurrency=1 \
  --timeout=300 \
  --min-instances=3 \
  --max-instances=3 \
  --no-cpu-throttling \
  --set-env-vars="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_API_URL=${api_url}~WORKER_TOPICS=run-context-graph-ingest|run-context-graph-assert|run-context-graph-project~CONTEXT_GRAPH_HISTORY_LIMIT=10000~CONTEXT_GRAPH_INGEST_TRANSPORT=git~CONTEXT_GRAPH_MODEL=openai/gpt-5.6-luna~CONTEXT_GRAPH_MODEL_TIMEOUT_MS=600000~CONTEXT_GRAPH_MODEL_VALIDATION_ATTEMPTS=3~CONTEXT_GRAPH_CODEX_EXECUTION_ATTEMPTS=2~CONTEXT_GRAPH_CODEX_EFFORT=medium~CONTEXT_GRAPH_CODEX_CONTEXT_TOKENS=256000~CONTEXT_GRAPH_CODEX_COMPACT_TOKENS=200000" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,DAYTONA_API_KEY=jina-daytona-api-key:latest,OPENROUTER_API_KEY=jina-openrouter-api-key:latest,GITHUB_APP_ID=jina-github-app-id:latest,GITHUB_APP_PRIVATE_KEY=jina-github-app-private-key:latest" \
  --quiet

route_latest_revision "jina-context-graph-worker"
context_graph_worker_url="$(gcloud run services describe jina-context-graph-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --format='value(status.url)')"
verify_worker_health \
  "${context_graph_worker_url}" \
  "run-context-graph-ingest|run-context-graph-assert|run-context-graph-project"

if gcloud run services describe jina-ontology-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" >/dev/null 2>&1; then
  gcloud run services delete jina-ontology-worker \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --quiet
fi

gcloud run deploy jina-task-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${worker_image}" \
  --allow-unauthenticated \
  --service-account="${runtime_service_account}" \
  --concurrency=1 \
  --timeout=300 \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --set-env-vars="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_API_URL=${api_url}~WORKER_TOPICS=run-review|run-research|run-publish|run-cleanup~REVIEW_MODEL=gpt-5.6-sol" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,OPENAI_API_KEY=jina-openai-api-key:latest,GITHUB_API_TOKEN=jina-github-api-token:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  --quiet

route_latest_revision "jina-task-worker"
task_worker_url="$(gcloud run services describe jina-task-worker \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --format='value(status.url)')"
verify_worker_health \
  "${task_worker_url}" \
  "run-review|run-research|run-publish|run-cleanup"

gcloud run jobs deploy jina-acceptance \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${worker_image}" \
  --service-account="${runtime_service_account}" \
  --set-env-vars="^~^JINA_API_URL=${api_url}~ACCEPTANCE_TENANT_ID=${acceptance_tenant_id}~ACCEPTANCE_PRINCIPAL_ID=${acceptance_principal_id}~ACCEPTANCE_REQUEST_KEY=deploy-${CLOUD_BUILD_ID}~ACCEPTANCE_GITHUB_INSTALLATION_ID=${acceptance_github_installation_id}~ACCEPTANCE_TIMEOUT_MS=3000000~ACCEPTANCE_ISSUE_NUMBER=4~ACCEPTANCE_RESOLUTION_PR_NUMBER=5~ACCEPTANCE_CAUSING_PR_NUMBER=3~ACCEPTANCE_CAUSING_COMMIT_SHA=334234b30d3fe8c85fbf9f4c276d0ce6f26c35e2~ACCEPTANCE_CAUSAL_REASON_INCLUDES=admin~ACCEPTANCE_V51_FIXTURE=true" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest" \
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

cat <<SUMMARY
Cloud Build deployment complete
API: ${api_url}
ContextGraph worker: ${context_graph_worker_url}
Task worker: ${task_worker_url}
Image tag: ${image_tag}
Cloud SQL: ${cloud_sql_instance}
Tenancy mode: ${tenancy_mode}
API instances: ${api_min_instances}-${api_max_instances}
API concurrency: ${api_concurrency}
API size: ${api_cpu} CPU / ${api_memory}
SUMMARY
