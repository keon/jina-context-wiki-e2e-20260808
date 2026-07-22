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
tenancy_mode="${JINA_TENANCY_MODE:-fixed}"
db_name="${JINA_DB_NAME:-jina}"
db_user="${JINA_DB_USER:-jina_app}"
db_pass_secret="${JINA_DB_PASS_SECRET:-jina-db-password:latest}"
fixed_tenant_id="${JINA_FIXED_TENANT_ID:-omlabs}"

validate_cloud_sql_instance() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[a-z][a-z0-9.-]*:[a-z0-9-]+:[a-zA-Z0-9_-]+$ ]]; then
    echo "${name} must be a Cloud SQL connection name in project:region:instance form" >&2
    exit 2
  fi
}

validate_cloud_sql_instance "CLOUD_SQL_INSTANCE" "${cloud_sql_instance}"
if [[ "${db_pass_secret}" == *","* || "${db_pass_secret}" == *"~"* ]]; then
  echo "JINA_DB_PASS_SECRET must be a Cloud Run secret spec without commas or tildes" >&2
  exit 2
fi

api_env_vars="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_ENABLE_DEV_ENDPOINTS=false~JINA_SIMULATE_RUNS=false~JINA_SEED_DEMO=false~JINA_TENANCY_MODE=${tenancy_mode}~INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${db_user}~JINA_DB_MANAGE_SCHEMA=false"
api_secrets="DB_PASS=${db_pass_secret},GITHUB_WEBHOOK_SECRET=jina-github-webhook-secret:latest,INTERNAL_API_TOKEN=jina-internal-api-token:latest,GRAPH_API_TOKEN=jina-graph-api-token:latest"

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

gcloud run deploy jina-api \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --allow-unauthenticated \
  --service-account="${runtime_service_account}" \
  --set-cloudsql-instances="${cloud_sql_instance}" \
  --concurrency=20 \
  --timeout=900 \
  --min-instances=0 \
  --max-instances=1 \
  --set-env-vars="${api_env_vars}" \
  --set-secrets="${api_secrets}" \
  --quiet

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
  --set-env-vars="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_API_URL=${api_url}~WORKER_TOPICS=run-context-graph-ingest|run-context-graph-assert|run-context-graph-project~CONTEXT_GRAPH_HISTORY_LIMIT=10000~CONTEXT_GRAPH_INGEST_TRANSPORT=git~DAYTONA_RUN_TIMEOUT_SECONDS=2400~CONTEXT_GRAPH_CODEX_PROVIDER=openrouter~CONTEXT_GRAPH_CODEX_MODEL=deepseek/deepseek-v4-flash~CONTEXT_GRAPH_CODEX_CONTEXT_TOKENS=16000~CONTEXT_GRAPH_CODEX_COMPACT_TOKENS=12000" \
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,DAYTONA_API_KEY=jina-daytona-api-key:latest,OPENROUTER_API_KEY=jina-openrouter-api-key:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  --quiet

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
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,OPENAI_API_KEY=jina-openai-api-key:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  --quiet

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
  --set-env-vars="^~^JINA_API_URL=${api_url}~ACCEPTANCE_TENANT_ID=${acceptance_tenant_id}~ACCEPTANCE_PRINCIPAL_ID=${acceptance_principal_id}~ACCEPTANCE_REQUEST_KEY=deploy-${CLOUD_BUILD_ID}~ACCEPTANCE_TIMEOUT_MS=3000000~ACCEPTANCE_ISSUE_NUMBER=4~ACCEPTANCE_RESOLUTION_PR_NUMBER=5~ACCEPTANCE_CAUSING_PR_NUMBER=3~ACCEPTANCE_CAUSING_COMMIT_SHA=334234b30d3fe8c85fbf9f4c276d0ce6f26c35e2~ACCEPTANCE_CAUSAL_REASON_INCLUDES=admin~ACCEPTANCE_V51_FIXTURE=true" \
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
SUMMARY
