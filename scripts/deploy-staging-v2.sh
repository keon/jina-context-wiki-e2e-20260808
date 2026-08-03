#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_TAG:?IMAGE_TAG is required and must identify images already pushed by cloudbuild.images.yaml}"

project="${GCP_PROJECT_ID:-jina-staging-20260802}"
region="${GCP_REGION:-us-east1}"
sql_instance="${CLOUD_SQL_INSTANCE:-jina-staging-20260802:us-east1:jina-db-staging}"
database_name="${JINA_DB_NAME:-jina_staging}"
runtime_user="${JINA_DB_USER:-jina_v2_staging_app}"
owner_user="${JINA_MIGRATION_DB_USER:-postgres}"
context_tenant_id="${JINA_CONTEXT_TENANT_ID:?JINA_CONTEXT_TENANT_ID is required}"
artifact_bucket="${JINA_CONTEXT_GCS_BUCKET:-jina-staging-20260802-context-artifacts-us-east1}"
v1_api_url="${JINA_V1_API_URL:-https://legacy-api.staging.usejina.com}"
artifact_repository="${JINA_ARTIFACT_REGISTRY_REPOSITORY:-jina-staging}"
gar="${region}-docker.pkg.dev/${project}/${artifact_repository}"
api_image="${gar}/api:${IMAGE_TAG}"
worker_image="${gar}/worker:${IMAGE_TAG}"

api_service="jina-api-staging"
context_worker_service="jina-context-worker-staging"
task_worker_service="jina-task-worker-staging"
migration_job="jina-context-migrate-staging"
api_service_account="jina-api-staging@${project}.iam.gserviceaccount.com"
context_worker_service_account="jina-context-worker-staging@${project}.iam.gserviceaccount.com"
task_worker_service_account="jina-task-worker-staging@${project}.iam.gserviceaccount.com"
migration_service_account="jina-migration-staging@${project}.iam.gserviceaccount.com"

owner_password_secret="jina-staging-owner-db-password"
runtime_password_secret="jina-staging-db-password"
webhook_secret="jina-staging-github-webhook-secret"
internal_token_secret="${JINA_V2_INTERNAL_TOKEN_SECRET:-jina-v2-staging-internal-api-token}"
context_token_secret="jina-staging-context-api-token"
checkpoint_secret="jina-staging-context-private-checkpoint-key"
v1_internal_token_secret="jina-staging-v1-internal-api-token"
daytona_secret="jina-staging-daytona-api-key"
github_app_id_secret="jina-staging-github-app-id"
github_app_private_key_secret="jina-staging-github-app-private-key"
github_clone_token_secret="jina-staging-github-clone-token"
openai_secret="jina-staging-openai-api-key"

required_staging_values=(
  "${project}"
  "${sql_instance}"
  "${database_name}"
  "${runtime_user}"
  "${artifact_bucket}"
  "${artifact_repository}"
  "${v1_api_url}"
  "${api_service}"
  "${context_worker_service}"
  "${task_worker_service}"
  "${migration_job}"
  "${owner_password_secret}"
  "${runtime_password_secret}"
  "${webhook_secret}"
  "${internal_token_secret}"
  "${context_token_secret}"
  "${checkpoint_secret}"
  "${v1_internal_token_secret}"
  "${daytona_secret}"
  "${github_app_id_secret}"
  "${github_app_private_key_secret}"
  "${github_clone_token_secret}"
  "${openai_secret}"
)
if [[ "${project}" == "jina-463721" || "${project}" == "jina-v2" ]]; then
  printf 'Refusing to deploy staging services into production project: %s\n' "${project}" >&2
  exit 2
fi
for value in "${required_staging_values[@]}"; do
  if [[ "${value}" != *staging* ]]; then
    printf 'Refusing non-staging deployment value: %s\n' "${value}" >&2
    exit 2
  fi
done

if [[ ! "${IMAGE_TAG}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  printf 'IMAGE_TAG is not a valid immutable Artifact Registry tag\n' >&2
  exit 2
fi
if [[ "${IMAGE_TAG}" != *staging* ]]; then
  printf 'IMAGE_TAG must contain staging\n' >&2
  exit 2
fi
if [[ ! "${context_tenant_id}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  printf 'JINA_CONTEXT_TENANT_ID must be an explicit staging tenant UUID\n' >&2
  exit 2
fi

for image in "${api_image}" "${worker_image}"; do
  gcloud artifacts docker images describe "${image}" --project="${project}" >/dev/null
done
for service_account in \
  "${api_service_account}" \
  "${context_worker_service_account}" \
  "${task_worker_service_account}" \
  "${migration_service_account}"; do
  gcloud iam service-accounts describe "${service_account}" --project="${project}" >/dev/null
done
for secret_name in \
  "${owner_password_secret}" \
  "${runtime_password_secret}" \
  "${webhook_secret}" \
  "${internal_token_secret}" \
  "${context_token_secret}" \
  "${checkpoint_secret}" \
  "${v1_internal_token_secret}" \
  "${daytona_secret}" \
  "${github_app_id_secret}" \
  "${github_app_private_key_secret}" \
  "${github_clone_token_secret}" \
  "${openai_secret}"; do
  gcloud secrets versions describe latest --secret="${secret_name}" --project="${project}" >/dev/null
done
gcloud storage buckets describe "gs://${artifact_bucket}" --project="${project}" >/dev/null

gcloud run jobs deploy "${migration_job}" \
  --project="${project}" \
  --region="${region}" \
  --image="${api_image}" \
  --service-account="${migration_service_account}" \
  --set-cloudsql-instances="${sql_instance}" \
  --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${sql_instance}~DB_NAME=${database_name}~DB_USER=${owner_user}~CONTEXT_RUNTIME_DB_USER=${runtime_user}" \
  --set-secrets="DB_PASS=${owner_password_secret}:latest" \
  --args=node_modules/@jina/db/dist/migrate.js,--install-roles \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=15m \
  --quiet
gcloud run jobs execute "${migration_job}" \
  --project="${project}" \
  --region="${region}" \
  --wait

api_env="^~^GOOGLE_CLOUD_PROJECT=${project}~JINA_ENABLE_DEV_ENDPOINTS=false~JINA_SIMULATE_RUNS=false~JINA_SEED_DEMO=false~JINA_REQUIRE_WORKER_RELEASE_GATE=false~JINA_TENANCY_MODE=shared-db~INSTANCE_UNIX_SOCKET=/cloudsql/${sql_instance}~DB_NAME=${database_name}~DB_USER=${runtime_user}~JINA_DB_POOL_MAX=3~JINA_DB_MANAGE_SCHEMA=false~CONTEXT_WORKER_LEASE_MS=9000000~CONTEXT_GCS_BUCKET=${artifact_bucket}~JINA_CONTEXT_TENANT_ID=${context_tenant_id}~JINA_CONTEXT_PRINCIPAL_ID=user:context-query@staging.internal"
api_secrets="DB_PASS=${runtime_password_secret}:latest,GITHUB_WEBHOOK_SECRET=${webhook_secret}:latest,INTERNAL_API_TOKEN=${internal_token_secret}:latest,CONTEXT_API_TOKEN=${context_token_secret}:latest,CONTEXT_PRIVATE_CHECKPOINT_KEY=${checkpoint_secret}:latest"
gcloud run deploy "${api_service}" \
  --project="${project}" \
  --region="${region}" \
  --image="${api_image}" \
  --allow-unauthenticated \
  --service-account="${api_service_account}" \
  --set-cloudsql-instances="${sql_instance}" \
  --concurrency=10 \
  --cpu=1 \
  --memory=1Gi \
  --timeout=3600 \
  --liveness-probe="initialDelaySeconds=30,timeoutSeconds=10,periodSeconds=30,failureThreshold=3,httpGet.path=/health,httpGet.port=8080" \
  --min-instances=0 \
  --max-instances=2 \
  --set-env-vars="${api_env}" \
  --set-secrets="${api_secrets}" \
  --quiet

api_url="$(gcloud run services describe "${api_service}" \
  --project="${project}" \
  --region="${region}" \
  --format='value(status.url)')"
if [[ "${api_url}" != https://*staging* ]]; then
  printf 'Cloud Run returned an unexpected staging API URL: %s\n' "${api_url}" >&2
  exit 2
fi

context_topics="run-context-input-snapshot|run-context-research-plan|run-context-research|run-context-publication-plan|run-context-page-write|run-context-page-audit|run-context-page-repair|run-context-source-challenge|run-context-task-evaluation|run-context-gap-repair|run-context-certification|run-context-publication|run-context-pageindex"
context_env="^~^GOOGLE_CLOUD_PROJECT=${project}~JINA_API_URL=${api_url}~JINA_V1_API_URL=${v1_api_url}~JINA_WORKER_CLAIM_MODE=enabled~WORKER_TOPICS=${context_topics}~JINA_REQUIRE_GITHUB_INSTALLATION=false~CONTEXT_API_TIMEOUT_MS=7800000~CONTEXT_COMPLETION_TIMEOUT_MS=600000~CONTEXT_GITHUB_HISTORY_LIMIT=500~CONTEXT_GIT_HISTORY_LIMIT=5000~CONTEXT_MAX_FILE_BYTES=5242880~CONTEXT_MAX_SNAPSHOT_BYTES=8388608~CONTEXT_BOARD_EXECUTOR=daytona~CONTEXT_DAYTONA_MODEL_SECRET=jina-staging-context-openai~CONTEXT_DAYTONA_MODEL_SECRET_ENV=OPENAI_API_KEY~CONTEXT_DAYTONA_MODEL_DOMAINS=api.openai.com~CONTEXT_CODEX_MODEL=gpt-5.6-terra~CONTEXT_CODEX_EFFORT=low~CONTEXT_CODEX_VERBOSITY=high~CONTEXT_CODEX_CONTEXT_TOKENS=128000~CONTEXT_CODEX_COMPACT_TOKENS=96000~CONTEXT_PAGEINDEX_PYTHON=/opt/pageindex-venv/bin/python~CONTEXT_PAGEINDEX_WORKER=/opt/pageindex-worker/worker.py~PAGEINDEX_SOURCE_ROOT=/opt/PageIndex~CONTEXT_DAYTONA_SNAPSHOT=jina-context-board-codex-0-145-0-bwrap-v2"
context_secrets="INTERNAL_API_TOKEN=${internal_token_secret}:latest,JINA_V1_INTERNAL_API_TOKEN=${v1_internal_token_secret}:latest,DAYTONA_API_KEY=${daytona_secret}:latest,GITHUB_APP_ID=${github_app_id_secret}:latest,GITHUB_APP_PRIVATE_KEY=${github_app_private_key_secret}:latest,GITHUB_CLONE_TOKEN=${github_clone_token_secret}:latest"
gcloud run deploy "${context_worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --image="${worker_image}" \
  --no-allow-unauthenticated \
  --service-account="${context_worker_service_account}" \
  --concurrency=1 \
  --memory=1Gi \
  --timeout=300 \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --set-env-vars="${context_env}" \
  --set-secrets="${context_secrets}" \
  --quiet

task_env="^~^GOOGLE_CLOUD_PROJECT=${project}~JINA_API_URL=${api_url}~JINA_WORKER_CLAIM_MODE=enabled~WORKER_TOPICS=run-review~REVIEW_MODEL=gpt-5.6-sol"
task_secrets="INTERNAL_API_TOKEN=${internal_token_secret}:latest,OPENAI_API_KEY=${openai_secret}:latest,GITHUB_CLONE_TOKEN=${github_clone_token_secret}:latest"
gcloud run deploy "${task_worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --image="${worker_image}" \
  --no-allow-unauthenticated \
  --service-account="${task_worker_service_account}" \
  --concurrency=1 \
  --timeout=300 \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --set-env-vars="${task_env}" \
  --set-secrets="${task_secrets}" \
  --quiet

retry_health() {
  local url="$1"
  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --max-time 10 "${url}" >/dev/null; then
      return 0
    fi
    if [[ "${attempt}" == "20" ]]; then
      return 1
    fi
    sleep 3
  done
}
retry_health "${api_url}/health"

internal_token="$(gcloud secrets versions access latest \
  --secret="${internal_token_secret}" --project="${project}")"
for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error --max-time 20 \
      --header "authorization: Bearer ${internal_token}" \
      --header "x-jina-tenant-id: ${context_tenant_id}" \
      --header "x-jina-principal-id: user:staging-operator@jina.internal" \
      "${api_url}/overview" >/dev/null; then
    break
  fi
  if [[ "${attempt}" == "20" ]]; then
    printf 'Staging API overview did not become ready\n' >&2
    exit 1
  fi
  sleep 3
done

printf 'V2 staging deployed successfully\n'
printf 'API: %s\n' "${api_url}"
