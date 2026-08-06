#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_TAG:?IMAGE_TAG is required and must identify images already pushed by cloudbuild.staging.yaml}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

project="${GCP_PROJECT_ID:-jina-staging-20260802}"
region="${GCP_REGION:-us-east1}"
sql_instance="${CLOUD_SQL_INSTANCE:-jina-staging-20260802:us-east1:jina-db-staging}"
database_name="${JINA_DB_NAME:-jina_staging}"
runtime_user="${JINA_DB_USER:-jina_v2_staging_app}"
owner_user="${JINA_MIGRATION_DB_USER:-postgres}"
context_tenant_id="${JINA_CONTEXT_TENANT_ID:?JINA_CONTEXT_TENANT_ID is required}"
artifact_bucket="${JINA_CONTEXT_GCS_BUCKET:-jina-staging-20260802-context-artifacts-us-east1}"
review_artifact_bucket="${JINA_REVIEW_GCS_BUCKET:-jina-staging-20260802-review-artifacts-us-east1}"
artifact_repository="${JINA_ARTIFACT_REGISTRY_REPOSITORY:-jina-staging}"
gar="${region}-docker.pkg.dev/${project}/${artifact_repository}"
api_image="${gar}/api:${IMAGE_TAG}"
worker_image="${gar}/worker:${IMAGE_TAG}"
otel_collector_image="us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google:0.156.0"
otel_collector_config='{"receivers":{"otlp":{"protocols":{"http":{"endpoint":"0.0.0.0:4318"}}}},"processors":{"memory_limiter":{"check_interval":"1s","limit_mib":128,"spike_limit_mib":32},"batch":{"send_batch_size":256,"timeout":"5s"}},"exporters":{"googlecloud":{}},"extensions":{"health_check":{"endpoint":"0.0.0.0:13133"}},"service":{"extensions":["health_check"],"pipelines":{"traces":{"receivers":["otlp"],"processors":["memory_limiter","batch"],"exporters":["googlecloud"]}}}}'
otel_endpoint="http://localhost:4318/v1/traces"

api_service="jina-api-staging"
context_worker_service="jina-context-worker-staging"
task_worker_service="jina-task-worker-staging"
causal_worker_service="jina-causal-graph-worker"
migration_job="jina-v2-migrate-staging"
billing_retry_scheduler_job="jina-billing-retry-staging"
causal_activation_job="jina-causal-graph-release-activate-staging"
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
product_internal_token_secret="jina-staging-internal-api-token"
product_encryption_secret="jina-staging-secrets-encryption-key"
clerk_secret="jina-staging-clerk-secret-key"
graph_token_secret="jina-staging-graph-api-token"
graph_internal_token_secret="jina-staging-graph-internal-token"
autumn_secret="jina-staging-autumn-secret-key"
daytona_secret="jina-staging-daytona-api-key"
github_app_id_secret="jina-staging-github-app-id"
github_app_private_key_secret="jina-staging-github-app-private-key"
github_clone_token_secret="jina-staging-github-clone-token"
openai_secret="jina-staging-openai-api-key"
causal_release_credential_secret="jina-staging-causal-graph-worker-release-credential"
review_trigger_secret="${JINA_REVIEW_TRIGGER_SECRET:-jina-staging-trigger-secret-key}"
review_board_pipeline_mode="${JINA_REVIEW_BOARD_PIPELINE_MODE:-v1}"
review_board_v2_repositories="${JINA_REVIEW_BOARD_V2_REPOSITORIES:-}"
require_worker_release_gate="${JINA_REQUIRE_WORKER_RELEASE_GATE:-false}"

case "${review_board_pipeline_mode}" in
  paused)
    review_topics="github-installation-backfill|billing-retry"
    review_run_topic_mode="disabled"
    ;;
  v1)
    review_topics="prepare-review|summary-review|runtime-review|finalize-review|publish-review|settle-review|github-installation-backfill|billing-retry"
    review_run_topic_mode="disabled"
    ;;
  v2)
    # Keep the v1 topics during the staging cutover so workflows admitted
    # before the switch can drain while new heads use the Trigger bridge.
    review_topics="prepare-review|summary-review|runtime-review|finalize-review|publish-review|settle-review|run-review|github-installation-backfill|billing-retry"
    review_run_topic_mode="relational"
    ;;
  allowlist)
    printf 'Staging allowlist mode requires separate v1 and v2 task-worker claim lanes; refusing a mixed-topic worker\n' >&2
    exit 2
    ;;
  *)
    printf 'JINA_REVIEW_BOARD_PIPELINE_MODE must be paused, v1, v2, or allowlist\n' >&2
    exit 2
    ;;
esac

required_staging_values=(
  "${project}"
  "${sql_instance}"
  "${database_name}"
  "${runtime_user}"
  "${artifact_bucket}"
  "${review_artifact_bucket}"
  "${artifact_repository}"
  "${api_service}"
  "${context_worker_service}"
  "${task_worker_service}"
  "${migration_job}"
  "${billing_retry_scheduler_job}"
  "${causal_activation_job}"
  "${owner_password_secret}"
  "${runtime_password_secret}"
  "${webhook_secret}"
  "${internal_token_secret}"
  "${context_token_secret}"
  "${checkpoint_secret}"
  "${product_internal_token_secret}"
  "${product_encryption_secret}"
  "${clerk_secret}"
  "${graph_token_secret}"
  "${graph_internal_token_secret}"
  "${autumn_secret}"
  "${daytona_secret}"
  "${github_app_id_secret}"
  "${github_app_private_key_secret}"
  "${github_clone_token_secret}"
  "${openai_secret}"
  "${causal_release_credential_secret}"
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
  "${product_internal_token_secret}" \
  "${product_encryption_secret}" \
  "${clerk_secret}" \
  "${graph_token_secret}" \
  "${graph_internal_token_secret}" \
  "${autumn_secret}" \
  "${daytona_secret}" \
  "${github_app_id_secret}" \
  "${github_app_private_key_secret}" \
  "${github_clone_token_secret}" \
  "${openai_secret}"; do
  gcloud secrets versions describe latest --secret="${secret_name}" --project="${project}" >/dev/null
done
gcloud storage buckets describe "gs://${artifact_bucket}" --project="${project}" >/dev/null
gcloud storage buckets describe "gs://${review_artifact_bucket}" --project="${project}" >/dev/null

serving_revision() {
  local service="$1"
  local description
  description="$(gcloud run services describe "${service}" \
    --project="${project}" --region="${region}" --format=json)"
  SERVICE_DESCRIPTION="${description}" SERVICE_NAME="${service}" python3 -c '
import json
import os

description = json.loads(os.environ["SERVICE_DESCRIPTION"])
service_name = os.environ["SERVICE_NAME"]
serving = {
    target.get("revisionName"): int(target.get("percent", 0))
    for target in description.get("status", {}).get("traffic", [])
    if target.get("revisionName") and int(target.get("percent", 0)) > 0
}
if len(serving) != 1 or next(iter(serving.values())) != 100:
    raise SystemExit(
        f"{service_name} must have one 100% serving revision before deployment; observed {serving}"
    )
print(next(iter(serving)))
'
}

causal_release_state() {
  local revision="$1"
  gcloud run revisions describe "${revision}" \
    --project="${project}" --region="${region}" --format=json |
    python3 -c '
import json
import sys

revision = json.load(sys.stdin)
environment = revision.get("spec", {}).get("containers", [])[0].get("env", [])
release_id = next(
    (item.get("value", "") for item in environment if item.get("name") == "JINA_WORKER_RELEASE_ID"),
    "",
)
credential = next(
    (
        item.get("valueFrom", {}).get("secretKeyRef", {})
        for item in environment
        if item.get("name") == "JINA_WORKER_RELEASE_CREDENTIAL"
    ),
    {},
)
if not release_id or credential.get("name") != "jina-staging-causal-graph-worker-release-credential":
    raise SystemExit("serving causal worker does not expose a restorable release identity")
version = credential.get("key", "")
if not version.isdigit() or int(version) < 1:
    raise SystemExit("serving causal worker does not pin a numbered release credential")
print(release_id, version)
'
}

previous_api_revision="$(serving_revision "${api_service}")"
previous_context_revision="$(serving_revision "${context_worker_service}")"
previous_task_revision="$(serving_revision "${task_worker_service}")"
previous_causal_revision="$(serving_revision "${causal_worker_service}")"
read -r previous_causal_release_id previous_causal_secret_version \
  < <(causal_release_state "${previous_causal_revision}")

traffic_mutation_started="false"
causal_deploy_started="false"

restore_revision() {
  local service="$1"
  local revision="$2"
  gcloud run services update-traffic "${service}" \
    --project="${project}" --region="${region}" \
    --to-revisions="${revision}=100" --clear-tags --quiet
}

restore_causal_release_control() {
  gcloud run jobs deploy "${causal_activation_job}" \
    --project="${project}" \
    --region="${region}" \
    --image="${api_image}" \
    --service-account="${migration_service_account}" \
    --set-cloudsql-instances="${sql_instance}" \
    --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${sql_instance}~DB_NAME=${database_name}~DB_USER=${owner_user}~RUNTIME_DB_USER=${runtime_user}~JINA_CAUSAL_GRAPH_RELEASE_ID=${previous_causal_release_id}~JINA_CAUSAL_GRAPH_WORKER_REVISION=${previous_causal_revision}" \
    --set-secrets="DB_PASS=${owner_password_secret}:latest,JINA_CAUSAL_GRAPH_RELEASE_CREDENTIAL=${causal_release_credential_secret}:${previous_causal_secret_version}" \
    --args=node_modules/@jina/db/dist/activate-causal-graph-release.js \
    --tasks=1 \
    --max-retries=0 \
    --task-timeout=10m \
    --quiet
  gcloud run jobs execute "${causal_activation_job}" \
    --project="${project}" --region="${region}" --wait
}

rollback_failed_staging_release() {
  local status=$?
  local rollback_failed="false"
  trap - EXIT
  if [[ "${status}" -ne 0 && "${traffic_mutation_started}" == "true" ]]; then
    set +e
    printf 'Staging deployment failed; restoring the prior coordinated release\n' >&2
    if [[ "${causal_deploy_started}" == "true" ]]; then
      restore_causal_release_control || rollback_failed="true"
      restore_revision "${causal_worker_service}" "${previous_causal_revision}" || rollback_failed="true"
    fi
    restore_revision "${context_worker_service}" "${previous_context_revision}" || rollback_failed="true"
    restore_revision "${task_worker_service}" "${previous_task_revision}" || rollback_failed="true"
    restore_revision "${api_service}" "${previous_api_revision}" || rollback_failed="true"
    if [[ "${rollback_failed}" == "true" ]]; then
      printf 'Staging compensation was incomplete; inspect all four serving revisions before retrying\n' >&2
    else
      printf 'Prior staging release restored after failed deployment\n' >&2
    fi
  fi
  exit "${status}"
}
trap rollback_failed_staging_release EXIT

if [[ "${JINA_SKIP_STAGING_MIGRATIONS:-false}" == "true" ]]; then
  deployed_migration_image="$(gcloud run jobs describe "${migration_job}" \
    --project="${project}" --region="${region}" \
    --format='value(spec.template.spec.template.spec.containers[0].image)')"
  latest_migration_execution="$(gcloud run jobs executions list --job="${migration_job}" \
    --project="${project}" --region="${region}" --limit=1 --format='value(metadata.name)')"
  latest_migration_status="$(gcloud run jobs executions describe "${latest_migration_execution}" \
    --project="${project}" --region="${region}" --format='value(status.conditions[0].status)')"
  if [[ "${deployed_migration_image}" != "${api_image}" || "${latest_migration_status}" != "True" ]]; then
    printf 'Refusing to skip an unverified staging migration for %s\n' "${api_image}" >&2
    exit 2
  fi
else
  gcloud run jobs deploy "${migration_job}" \
    --project="${project}" \
    --region="${region}" \
    --image="${api_image}" \
    --service-account="${migration_service_account}" \
    --set-cloudsql-instances="${sql_instance}" \
    --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${sql_instance}~DB_NAME=${database_name}~DB_USER=${owner_user}~CONTEXT_RUNTIME_DB_USER=${runtime_user}~JINA_PRODUCT_DATABASE_MODE=shared" \
    --set-secrets="DB_PASS=${owner_password_secret}:latest" \
    --args=dist/product/migrate-all.js,--install-roles \
    --tasks=1 \
    --max-retries=0 \
    --task-timeout=15m \
    --quiet
  gcloud run jobs execute "${migration_job}" \
    --project="${project}" \
    --region="${region}" \
    --wait
fi

api_env="^~^GOOGLE_CLOUD_PROJECT=${project}~JINA_ENVIRONMENT=staging~OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${otel_endpoint}~JINA_ENABLE_DEV_ENDPOINTS=false~JINA_SIMULATE_RUNS=false~JINA_SEED_DEMO=false~JINA_REQUIRE_WORKER_RELEASE_GATE=${require_worker_release_gate}~JINA_REVIEW_BOARD_PIPELINE_MODE=${review_board_pipeline_mode}~JINA_TENANCY_MODE=shared-db~JINA_PRODUCT_API_ENABLED=true~JINA_PRODUCT_DATABASE_MODE=shared~INSTANCE_UNIX_SOCKET=/cloudsql/${sql_instance}~DB_NAME=${database_name}~DB_USER=${runtime_user}~JINA_DB_POOL_MAX=3~JINA_DB_MANAGE_SCHEMA=false~CONTEXT_WORKER_LEASE_MS=9000000~CONTEXT_GCS_BUCKET=${artifact_bucket}~JINA_CONTEXT_TENANT_ID=${context_tenant_id}~JINA_CONTEXT_PRINCIPAL_ID=user:context-query@staging.internal~DASHBOARD_AUTH_MODE=clerk~DASHBOARD_URL=https://app.staging.usejina.com~DASHBOARD_ORIGIN=https://app.staging.usejina.com~API_BASE_URL=https://api.staging.usejina.com~DASHBOARD_COOKIE_SAMESITE=None~DASHBOARD_COOKIE_SECURE=true~CLERK_PUBLISHABLE_KEY=pk_test_cGVhY2VmdWwtcXVhaWwtOTMuY2xlcmsuYWNjb3VudHMuZGV2JA~GITHUB_APP_INSTALL_URL=https://github.com/apps/jina-staging-gcloud-omxyz/installations/new~GITHUB_APP_SLUG=jina-staging-gcloud-omxyz~JINA_BILLING_ENFORCE=off~JINA_GRAPH_API_URL=https://api.staging.usejina.com~JINA_GRAPH_REQUEST_TIMEOUT_MS=20000~JINA_GRAPH_DELEGATED_TOKEN_TTL_MINUTES=15"
if [[ -n "${review_board_v2_repositories}" ]]; then
  api_env+="~JINA_REVIEW_BOARD_V2_REPOSITORIES=${review_board_v2_repositories}"
fi
if [[ "${review_run_topic_mode}" == "relational" ]]; then
  api_env+="~JINA_REVIEW_RUN_TOPIC_MODE=relational"
fi
if [[ -n "${JINA_SCHEDULER_OIDC_SERVICE_ACCOUNT:-}" ]]; then
  api_env+="~JINA_SCHEDULER_OIDC_AUDIENCE=https://api.staging.usejina.com/internal/schedules/billing-retry~JINA_SCHEDULER_OIDC_EMAIL=${JINA_SCHEDULER_OIDC_SERVICE_ACCOUNT}"
fi
api_secrets="DB_PASS=${runtime_password_secret}:latest,GITHUB_WEBHOOK_SECRET=${webhook_secret}:latest,INTERNAL_API_TOKEN=${internal_token_secret}:latest,CONTEXT_API_TOKEN=${context_token_secret}:latest,CONTEXT_PRIVATE_CHECKPOINT_KEY=${checkpoint_secret}:latest,GITHUB_APP_ID=${github_app_id_secret}:latest,GITHUB_APP_PRIVATE_KEY=${github_app_private_key_secret}:latest,JINA_PRODUCT_INTERNAL_API_TOKEN=${product_internal_token_secret}:latest,SECRETS_ENCRYPTION_KEY=${product_encryption_secret}:latest,CLERK_SECRET_KEY=${clerk_secret}:latest,JINA_GRAPH_API_TOKEN=${graph_token_secret}:latest,JINA_GRAPH_INTERNAL_TOKEN=${graph_internal_token_secret}:latest,AUTUMN_SECRET_KEY=${autumn_secret}:latest"
gcloud --quiet run deploy "${api_service}" \
  --project="${project}" \
  --region="${region}" \
  --allow-unauthenticated \
  --service-account="${api_service_account}" \
  --set-cloudsql-instances="${sql_instance}" \
  --concurrency=10 \
  --timeout=3600 \
  --min-instances=0 \
  --max-instances=2 \
  --no-traffic \
  --image="${api_image}" \
  --port=8080 \
  --cpu=1 \
  --memory=1Gi \
  --liveness-probe="initialDelaySeconds=30,timeoutSeconds=10,periodSeconds=30,failureThreshold=3,httpGet.path=/health,httpGet.port=8080" \
  --set-env-vars="${api_env}" \
  --set-secrets="${api_secrets}"
gcloud --quiet run deploy "${api_service}" \
  --project="${project}" \
  --region="${region}" \
  --no-traffic \
  --container=otel-collector \
  --image="${otel_collector_image}" \
  --port=default \
  --cpu=0.5 \
  --memory=256Mi \
  --args=--config=env:OTELCOL_CONFIG \
  --set-env-vars="^~^OTELCOL_CONFIG=${otel_collector_config}" \
  --startup-probe="initialDelaySeconds=0,timeoutSeconds=10,periodSeconds=10,failureThreshold=5,httpGet.path=/,httpGet.port=13133" \
  --liveness-probe="timeoutSeconds=10,periodSeconds=30,failureThreshold=3,httpGet.path=/,httpGet.port=13133"
api_url="$(gcloud run services describe "${api_service}" \
  --project="${project}" \
  --region="${region}" \
  --format='value(status.url)')"
if [[ "${api_url}" != https://*staging* ]]; then
  printf 'Cloud Run returned an unexpected staging API URL: %s\n' "${api_url}" >&2
  exit 2
fi

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

# Health-check the new revision through a tagged URL before it receives any
# traffic. A candidate that never becomes healthy leaves staging serving the
# previous revision instead of an outage. The candidate tag pins the check to
# the revision this deploy created, so an emergency rollback pin cannot be
# mistaken for the candidate.
traffic_mutation_started="true"
gcloud run services update-traffic "${api_service}" \
  --project="${project}" \
  --region="${region}" \
  --set-tags="candidate=LATEST" \
  --quiet
api_candidate_url="${api_url/https:\/\//https://candidate---}"
if ! retry_health "${api_candidate_url}/health"; then
  printf 'Candidate API revision failed its health check; staging traffic was not moved.\n' >&2
  exit 1
fi
# A previous emergency rollback pins traffic to a named revision. Cloud Run
# preserves that pin across later deploys, so restore latest-revision routing
# now that the candidate has proven healthy.
gcloud run services update-traffic "${api_service}" \
  --project="${project}" \
  --region="${region}" \
  --to-latest \
  --quiet

# Cloud Scheduler only admits a durable Board workflow. The task worker owns
# execution, retries, event history, and trace export for every billing drain.
if ! gcloud services list --enabled --project="${project}" \
    --filter='config.name=cloudscheduler.googleapis.com' \
    --format='value(config.name)' | grep -Fxq cloudscheduler.googleapis.com; then
  printf 'Cloud Scheduler API must be enabled as a staging platform prerequisite\n' >&2
  exit 2
fi
scheduler_uri="https://api.staging.usejina.com/internal/schedules/billing-retry"
scheduler_args=(
  --project="${project}"
  --location="${region}"
  --schedule="*/15 * * * *"
  --time-zone="Etc/UTC"
  --uri="${scheduler_uri}"
  --http-method=POST
  --message-body='{}'
  --format=none
  --quiet
)
if [[ -n "${JINA_SCHEDULER_OIDC_SERVICE_ACCOUNT:-}" ]]; then
  # OIDC identity: the API verifies Google's signature, audience, and the
  # service-account email (JINA_SCHEDULER_OIDC_AUDIENCE/EMAIL on the API).
  # No secret is persisted in the Scheduler job resource.
  scheduler_auth_args=(
    --oidc-service-account-email="${JINA_SCHEDULER_OIDC_SERVICE_ACCOUNT}"
    --oidc-token-audience="${scheduler_uri}"
  )
  scheduler_create_headers=(--headers="Content-Type=application/json")
  scheduler_update_headers=(--update-headers="Content-Type=application/json")
else
  # Legacy static bearer: this persists a copy of the internal API token in
  # the Scheduler job where anyone with cloudscheduler.jobs.get can read it,
  # and rotating the secret does not rotate the stored copy. Set
  # JINA_SCHEDULER_OIDC_SERVICE_ACCOUNT to switch to OIDC.
  printf 'WARNING: Cloud Scheduler is using a static bearer token; set JINA_SCHEDULER_OIDC_SERVICE_ACCOUNT to switch to OIDC.\n' >&2
  product_internal_token="$(gcloud secrets versions access latest \
    --secret="${product_internal_token_secret}" --project="${project}")"
  scheduler_auth_args=()
  scheduler_create_headers=(--headers="Authorization=Bearer ${product_internal_token},Content-Type=application/json")
  scheduler_update_headers=(--update-headers="Authorization=Bearer ${product_internal_token},Content-Type=application/json")
fi
if gcloud scheduler jobs describe "${billing_retry_scheduler_job}" \
    --project="${project}" --location="${region}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${billing_retry_scheduler_job}" \
    "${scheduler_args[@]}" \
    ${scheduler_auth_args[@]+"${scheduler_auth_args[@]}"} \
    "${scheduler_update_headers[@]}"
else
  gcloud scheduler jobs create http "${billing_retry_scheduler_job}" \
    "${scheduler_args[@]}" \
    ${scheduler_auth_args[@]+"${scheduler_auth_args[@]}"} \
    "${scheduler_create_headers[@]}"
fi
unset product_internal_token scheduler_uri scheduler_args scheduler_auth_args scheduler_create_headers scheduler_update_headers

context_topics="run-context-input-snapshot|run-context-page-plan|run-context-page-build|run-context-publication"
context_env="^~^GOOGLE_CLOUD_PROJECT=${project}~JINA_ENVIRONMENT=staging~OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${otel_endpoint}~JINA_API_URL=${api_url}~JINA_WORKER_CLAIM_MODE=enabled~WORKER_TOPICS=${context_topics}~JINA_REQUIRE_GITHUB_INSTALLATION=false~CONTEXT_API_TIMEOUT_MS=7800000~CONTEXT_COMPLETION_TIMEOUT_MS=600000~CONTEXT_GITHUB_HISTORY_LIMIT=500~CONTEXT_GIT_HISTORY_LIMIT=5000~CONTEXT_MAX_FILE_BYTES=5242880~CONTEXT_MAX_SNAPSHOT_BYTES=8388608~CONTEXT_BOARD_EXECUTOR=daytona~CONTEXT_DAYTONA_MODEL_SECRET=jina-staging-context-openai~CONTEXT_DAYTONA_MODEL_SECRET_ENV=OPENAI_API_KEY~CONTEXT_DAYTONA_MODEL_DOMAINS=api.openai.com~CONTEXT_CODEX_MODEL=gpt-5.6-terra~CONTEXT_CODEX_EFFORT=low~CONTEXT_CODEX_VERBOSITY=high~CONTEXT_CODEX_CONTEXT_TOKENS=128000~CONTEXT_CODEX_COMPACT_TOKENS=96000~CONTEXT_PAGEINDEX_PYTHON=/opt/pageindex-venv/bin/python~CONTEXT_PAGEINDEX_WORKER=/opt/pageindex-worker/worker.py~PAGEINDEX_SOURCE_ROOT=/opt/PageIndex~CONTEXT_DAYTONA_SNAPSHOT=jina-context-board-codex-0-145-0-bwrap-v2"
context_secrets="INTERNAL_API_TOKEN=${internal_token_secret}:latest,JINA_PRODUCT_INTERNAL_API_TOKEN=${product_internal_token_secret}:latest,DAYTONA_API_KEY=${daytona_secret}:latest,GITHUB_APP_ID=${github_app_id_secret}:latest,GITHUB_APP_PRIVATE_KEY=${github_app_private_key_secret}:latest,GITHUB_CLONE_TOKEN=${github_clone_token_secret}:latest"
gcloud --quiet run deploy "${context_worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --no-allow-unauthenticated \
  --service-account="${context_worker_service_account}" \
  --concurrency=1 \
  --timeout=300 \
  --min-instances=3 \
  --max-instances=10 \
  --no-traffic \
  --image="${worker_image}" \
  --port=8080 \
  --no-cpu-throttling \
  --cpu=1 \
  --memory=1Gi \
  --set-env-vars="${context_env}" \
  --set-secrets="${context_secrets}"
gcloud --quiet run deploy "${context_worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --no-traffic \
  --container=otel-collector \
  --image="${otel_collector_image}" \
  --port=default \
  --cpu=0.5 \
  --memory=256Mi \
  --args=--config=env:OTELCOL_CONFIG \
  --set-env-vars="^~^OTELCOL_CONFIG=${otel_collector_config}" \
  --startup-probe="initialDelaySeconds=0,timeoutSeconds=10,periodSeconds=10,failureThreshold=5,httpGet.path=/,httpGet.port=13133" \
  --liveness-probe="timeoutSeconds=10,periodSeconds=30,failureThreshold=3,httpGet.path=/,httpGet.port=13133"
gcloud run services update-traffic "${context_worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --to-latest \
  --quiet

task_env="^~^GOOGLE_CLOUD_PROJECT=${project}~JINA_ENVIRONMENT=staging~OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${otel_endpoint}~JINA_API_URL=${api_url}~DASHBOARD_URL=https://app.staging.usejina.com~JINA_WORKER_CLAIM_MODE=enabled~WORKER_TOPICS=${review_topics}~JINA_REVIEW_GCS_BUCKET=${review_artifact_bucket}~JINA_GRAPH_MCP_ENABLED=true~DAYTONA_RUN_TIMEOUT_SECONDS=3600~DAYTONA_SETUP_TIMEOUT_SECONDS=300~DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS=120~DAYTONA_SANDBOX_IMAGE=node:22-bookworm~DAYTONA_SANDBOX_CPU=4~DAYTONA_SANDBOX_MEMORY=8~DAYTONA_SANDBOX_DISK=10~REVIEW_CODEX_MODEL=openai/gpt-5.6-luna~REVIEW_CODEX_EFFORT=medium~RUNTIME_PLANNER_MODEL=openai/gpt-5.6-sol~RUNTIME_AGENT_MODEL=openai/gpt-5.6-luna~RUNTIME_MENTAL_TRACE_MODEL=openai/gpt-5.6-luna"
task_secrets="INTERNAL_API_TOKEN=${internal_token_secret}:latest,JINA_PRODUCT_INTERNAL_API_TOKEN=${product_internal_token_secret}:latest,DAYTONA_API_KEY=${daytona_secret}:latest,GITHUB_APP_ID=${github_app_id_secret}:latest,GITHUB_APP_PRIVATE_KEY=${github_app_private_key_secret}:latest,OPENAI_API_KEY=${openai_secret}:latest,GITHUB_CLONE_TOKEN=${github_clone_token_secret}:latest"
if [[ "${review_run_topic_mode}" == "relational" ]]; then
  task_env+="~JINA_REVIEW_RUN_TOPIC_MODE=relational"
  task_secrets+=",TRIGGER_SECRET_KEY=${review_trigger_secret}:latest"
fi
gcloud --quiet run deploy "${task_worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --no-allow-unauthenticated \
  --service-account="${task_worker_service_account}" \
  --concurrency=1 \
  --timeout=3600 \
  --min-instances=1 \
  --max-instances=5 \
  --no-traffic \
  --image="${worker_image}" \
  --port=8080 \
  --no-cpu-throttling \
  --cpu=1 \
  --memory=1Gi \
  --set-env-vars="${task_env}" \
  --set-secrets="${task_secrets}"
gcloud --quiet run deploy "${task_worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --no-traffic \
  --container=otel-collector \
  --image="${otel_collector_image}" \
  --port=default \
  --cpu=0.5 \
  --memory=256Mi \
  --args=--config=env:OTELCOL_CONFIG \
  --set-env-vars="^~^OTELCOL_CONFIG=${otel_collector_config}" \
  --startup-probe="initialDelaySeconds=0,timeoutSeconds=10,periodSeconds=10,failureThreshold=5,httpGet.path=/,httpGet.port=13133" \
  --liveness-probe="timeoutSeconds=10,periodSeconds=30,failureThreshold=3,httpGet.path=/,httpGet.port=13133"
gcloud run services update-traffic "${task_worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --to-latest \
  --quiet

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

# Keep the isolated causal lane on the same source image during every
# coordinated staging deploy. The standalone script remains available for a
# causal-only release, but a normal staging cutover must not leave an older
# artifact protocol behind the unified API.
causal_deploy_started="true"
GCP_PROJECT_ID="${project}" \
GCP_REGION="${region}" \
CLOUD_SQL_INSTANCE="${sql_instance}" \
JINA_DB_NAME="${database_name}" \
JINA_DB_USER="${runtime_user}" \
JINA_MIGRATION_DB_USER="${owner_user}" \
JINA_ARTIFACT_REGISTRY_REPOSITORY="${artifact_repository}" \
IMAGE_TAG="${IMAGE_TAG}" \
bash "${script_dir}/deploy-staging-causal-graph.sh"

traffic_mutation_started="false"
printf 'Jina staging deployed successfully\n'
printf 'API: %s\n' "${api_url}"
