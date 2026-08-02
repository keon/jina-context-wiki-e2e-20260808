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
migration_db_pass_secret="${JINA_MIGRATION_DB_PASS_SECRET:-jina-primary-owner-db-password:latest}"
worker_release_secret="${JINA_CAUSAL_GRAPH_WORKER_RELEASE_SECRET:-jina-causal-graph-worker-release-credential}"
worker_memory="${JINA_CAUSAL_GRAPH_WORKER_MEMORY:-1Gi}"
daytona_snapshot="${JINA_CAUSAL_GRAPH_DAYTONA_SNAPSHOT:-}"
daytona_image="${JINA_CAUSAL_GRAPH_DAYTONA_IMAGE:-}"
daytona_model_secret="${JINA_CAUSAL_GRAPH_DAYTONA_MODEL_SECRET:-}"
release_suffix="$(printf '%s' "${CLOUD_BUILD_ID}" | tr '[:upper:]_' '[:lower:]-')"
short_release_id="$(printf '%s' "${release_suffix}" | tr -d '-' | cut -c1-16)"
candidate_tag="cg-${short_release_id}"
worker_revision="${worker_service}-${release_suffix}"
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

gcloud iam service-accounts describe "${worker_service_account}" --project="${GCP_PROJECT_ID}" >/dev/null
gcloud iam service-accounts describe "${migration_service_account}" --project="${GCP_PROJECT_ID}" >/dev/null
gcloud secrets describe "${worker_release_secret}" --project="${GCP_PROJECT_ID}" >/dev/null

# This migration owns only the two immutable causal graph release tables and
# the causal worker release-control row. It never takes the Context deployment
# lease, pauses Context claims, or mutates the Context release-control row.
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

# The API is the shared Board control plane. This additive revision preserves
# the active Context release identity and never changes either Context worker.
gcloud run deploy "${api_service}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --no-traffic \
  --tag="${candidate_tag}" \
  --revision-suffix="${release_suffix}" \
  --quiet

tagged_service_url() {
  local service="$1"
  local tag="$2"
  gcloud run services describe "${service}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --format=json | TAG="${tag}" python3 -c '
import json, os, sys
traffic=json.load(sys.stdin).get("status",{}).get("traffic",[])
for target in traffic:
    if target.get("tag")==os.environ["TAG"] and target.get("url"):
        print(target["url"])
        break
else:
    raise SystemExit("candidate tag URL is unavailable")
'
}

retry_health() {
  local url="$1"
  for _attempt in $(seq 1 60); do
    if curl --fail --silent --show-error "${url}/health" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "Health check failed for ${url}" >&2
  return 1
}

api_candidate_url="$(tagged_service_url "${api_service}" "${candidate_tag}")"
retry_health "${api_candidate_url}"
# Re-run the idempotent causal migration immediately before shared API traffic
# moves. Its first query fails if a Context deployment acquired its lease while
# this build was producing or checking the candidate revision.
gcloud run jobs execute jina-causal-graph-migrate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --wait
gcloud run services update-traffic "${api_service}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --to-revisions="${api_service}-${release_suffix}=100" \
  --remove-tags="${candidate_tag}" \
  --quiet
api_url="$(gcloud run services describe "${api_service}" --project="${GCP_PROJECT_ID}" --region="${GCP_REGION}" --format='value(status.url)')"

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

worker_environment="^~^GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}~JINA_API_URL=${api_url}~JINA_WORKER_CLAIM_MODE=enabled~WORKER_TOPICS=${causal_topics}~JINA_WORKER_RELEASE_ID=${CLOUD_BUILD_ID}~JINA_REQUIRE_GITHUB_INSTALLATION=false~CONTEXT_API_TIMEOUT_MS=7800000~CONTEXT_COMPLETION_TIMEOUT_MS=600000~CONTEXT_GITHUB_HISTORY_LIMIT=500~CONTEXT_GIT_HISTORY_LIMIT=5000~CONTEXT_BOARD_EXECUTOR=daytona~CONTEXT_DAYTONA_MODEL_SECRET=${daytona_model_secret}~CONTEXT_DAYTONA_MODEL_SECRET_ENV=OPENAI_API_KEY~CONTEXT_DAYTONA_MODEL_DOMAINS=api.openai.com~CONTEXT_CODEX_MODEL=gpt-5.6-terra~CONTEXT_CODEX_EFFORT=low~CONTEXT_CODEX_VERBOSITY=high~CONTEXT_CODEX_CONTEXT_TOKENS=128000~CONTEXT_CODEX_COMPACT_TOKENS=96000~CAUSAL_GRAPH_CODEX_MODEL=gpt-5.6-terra~CAUSAL_GRAPH_DERIVE_SECONDS=300"
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
if gcloud run services describe "${worker_service}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" >/dev/null 2>&1; then
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
  --set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:latest,JINA_WORKER_RELEASE_CREDENTIAL=${worker_release_secret}:${release_secret_version},DAYTONA_API_KEY=jina-daytona-api-key:latest,GITHUB_APP_ID=jina-github-app-id:latest,GITHUB_APP_PRIVATE_KEY=jina-github-app-private-key:latest,GITHUB_CLONE_TOKEN=jina-github-clone-token:latest" \
  "${worker_traffic_args[@]}" \
  --revision-suffix="${release_suffix}" \
  --quiet

# Activate only the causal worker generation. Context workers continue to use
# jina_runtime.release_control and cannot observe this credential rotation.
gcloud run jobs deploy jina-causal-graph-release-activate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${api_image}" \
  --service-account="${migration_service_account}" \
  --set-cloudsql-instances="${cloud_sql_instance}" \
  --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${cloud_sql_instance}~DB_NAME=${db_name}~DB_USER=${migration_db_user}~RUNTIME_DB_USER=${db_user}~JINA_CAUSAL_GRAPH_RELEASE_ID=${CLOUD_BUILD_ID}~JINA_CAUSAL_GRAPH_WORKER_REVISION=${worker_revision}" \
  --set-secrets="DB_PASS=${migration_db_pass_secret},JINA_CAUSAL_GRAPH_RELEASE_CREDENTIAL=${worker_release_secret}:${release_secret_version}" \
  --args=node_modules/@jina/db/dist/activate-causal-graph-release.js \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=10m \
  --quiet
gcloud run jobs execute jina-causal-graph-release-activate \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --wait

gcloud run services update-traffic "${worker_service}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --to-revisions="${worker_revision}=100" \
  --clear-tags \
  --quiet

observed_topics="$(gcloud run revisions describe "${worker_revision}" --project="${GCP_PROJECT_ID}" --region="${GCP_REGION}" --format='value(spec.containers[0].env[?name=WORKER_TOPICS].value)')"
if [[ "${observed_topics}" != "${causal_topics}" ]]; then
  echo "Causal graph worker topic isolation failed: ${observed_topics}" >&2
  exit 2
fi

echo "Causal graph release ${CLOUD_BUILD_ID} deployed without changing Context worker services or release control"
