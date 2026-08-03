#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_TAG:?IMAGE_TAG is required and must identify staging images already pushed by cloudbuild.staging-images.yaml}"

project="${GCP_PROJECT_ID:-jina-staging-20260802}"
region="${GCP_REGION:-us-east1}"
sql_instance="${CLOUD_SQL_INSTANCE:-jina-staging-20260802:us-east1:jina-db-staging}"
database_name="${JINA_DB_NAME:-jina_staging}"
runtime_user="${JINA_DB_USER:-jina_v2_staging_app}"
owner_user="${JINA_MIGRATION_DB_USER:-postgres}"
artifact_repository="${JINA_ARTIFACT_REGISTRY_REPOSITORY:-jina-staging}"
gar="${region}-docker.pkg.dev/${project}/${artifact_repository}"
api_image="${gar}/api:${IMAGE_TAG}"
worker_image="${gar}/worker:${IMAGE_TAG}"

api_service="jina-api-staging"
worker_service="jina-causal-graph-worker"
migration_job="jina-causal-graph-migrate-staging"
activation_job="jina-causal-graph-release-activate-staging"
worker_service_account="jina-causal-worker-staging@${project}.iam.gserviceaccount.com"
migration_service_account="jina-migration-staging@${project}.iam.gserviceaccount.com"

owner_password_secret="jina-staging-owner-db-password"
internal_token_secret="jina-v2-staging-internal-api-token"
release_credential_secret="jina-staging-causal-graph-worker-release-credential"
daytona_secret="jina-staging-daytona-api-key"
openai_secret="jina-staging-openai-api-key"
github_app_id_secret="jina-staging-github-app-id"
github_app_private_key_secret="jina-staging-github-app-private-key"
github_clone_token_secret="jina-staging-github-clone-token"

daytona_snapshot="${JINA_CAUSAL_GRAPH_DAYTONA_SNAPSHOT:-jina-context-board-codex-0-145-0-bwrap-v2}"
daytona_model_secret="${JINA_CAUSAL_GRAPH_DAYTONA_MODEL_SECRET:-jina-staging-context-openai}"
causal_topics="run-causal-graph-history|run-causal-graph-derive|run-causal-graph-publication"

required_staging_values=(
  "${project}"
  "${sql_instance}"
  "${database_name}"
  "${runtime_user}"
  "${artifact_repository}"
  "${api_service}"
  "${migration_job}"
  "${activation_job}"
  "${worker_service_account}"
  "${migration_service_account}"
  "${owner_password_secret}"
  "${internal_token_secret}"
  "${release_credential_secret}"
  "${daytona_secret}"
  "${openai_secret}"
  "${github_app_id_secret}"
  "${github_app_private_key_secret}"
  "${github_clone_token_secret}"
)
if [[ "${project}" == "jina-463721" || "${project}" == "jina-v2" ]]; then
  printf 'Refusing to deploy a staging causal worker into production project: %s\n' "${project}" >&2
  exit 2
fi
for value in "${required_staging_values[@]}"; do
  if [[ "${value}" != *staging* ]]; then
    printf 'Refusing non-staging deployment value: %s\n' "${value}" >&2
    exit 2
  fi
done
if [[ "${worker_service}" != "jina-causal-graph-worker" ]]; then
  printf 'Refusing unexpected causal graph worker identity: %s\n' "${worker_service}" >&2
  exit 2
fi
if [[ ! "${IMAGE_TAG}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ || "${IMAGE_TAG}" != *staging* ]]; then
  printf 'IMAGE_TAG must be a valid immutable staging tag\n' >&2
  exit 2
fi

for image in "${api_image}" "${worker_image}"; do
  gcloud artifacts docker images describe "${image}" --project="${project}" >/dev/null
done
for service_account in "${worker_service_account}" "${migration_service_account}"; do
  gcloud iam service-accounts describe "${service_account}" --project="${project}" >/dev/null
done
for secret_name in \
  "${owner_password_secret}" \
  "${internal_token_secret}" \
  "${daytona_secret}" \
  "${openai_secret}" \
  "${github_app_id_secret}" \
  "${github_app_private_key_secret}" \
  "${github_clone_token_secret}"; do
  gcloud secrets versions describe latest --secret="${secret_name}" --project="${project}" >/dev/null
done
gcloud secrets describe "${release_credential_secret}" --project="${project}" >/dev/null

api_url="$(gcloud run services describe "${api_service}" \
  --project="${project}" \
  --region="${region}" \
  --format='value(status.url)')"
if [[ "${api_url}" != https://*staging* ]]; then
  printf 'Cloud Run returned an unexpected staging API URL: %s\n' "${api_url}" >&2
  exit 2
fi
curl --fail --silent --show-error "${api_url}/health" >/dev/null

# This migration owns only the immutable causal graph release tables and its
# release-control row. It does not pause or mutate the Context worker release.
gcloud run jobs deploy "${migration_job}" \
  --project="${project}" \
  --region="${region}" \
  --image="${api_image}" \
  --service-account="${migration_service_account}" \
  --set-cloudsql-instances="${sql_instance}" \
  --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${sql_instance}~DB_NAME=${database_name}~DB_USER=${owner_user}~RUNTIME_DB_USER=${runtime_user}" \
  --set-secrets="DB_PASS=${owner_password_secret}:latest" \
  --args=node_modules/@jina/db/dist/migrate-causal-graph.js \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=10m \
  --quiet
gcloud run jobs execute "${migration_job}" \
  --project="${project}" \
  --region="${region}" \
  --wait

release_id="${IMAGE_TAG}"
release_suffix="$(python3 -c 'import hashlib, sys; print("cg-" + hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "${release_id}")"
worker_revision="${worker_service}-${release_suffix}"
candidate_tag="c-${release_suffix:3:8}"
release_credential="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
release_secret_version_name="$(
  printf '%s' "${release_credential}" |
    gcloud secrets versions add "${release_credential_secret}" \
      --project="${project}" \
      --data-file=- \
      --format='value(name)'
)"
release_secret_version="${release_secret_version_name##*/}"
if [[ ! "${release_secret_version}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Causal graph worker credential did not produce a Secret Manager version\n' >&2
  exit 2
fi

worker_environment="^~^GOOGLE_CLOUD_PROJECT=${project}~JINA_API_URL=${api_url}~JINA_WORKER_CLAIM_MODE=enabled~WORKER_TOPICS=${causal_topics}~JINA_WORKER_RELEASE_ID=${release_id}~JINA_REQUIRE_GITHUB_INSTALLATION=false~CONTEXT_API_TIMEOUT_MS=7800000~CONTEXT_COMPLETION_TIMEOUT_MS=600000~CONTEXT_GITHUB_HISTORY_LIMIT=500~CONTEXT_GIT_HISTORY_LIMIT=5000~CONTEXT_BOARD_EXECUTOR=daytona~CONTEXT_DAYTONA_MODEL_SECRET=${daytona_model_secret}~CONTEXT_DAYTONA_MODEL_SECRET_ENV=OPENAI_API_KEY~CONTEXT_DAYTONA_MODEL_DOMAINS=api.openai.com~CONTEXT_CODEX_MODEL=gpt-5.6-terra~CONTEXT_CODEX_EFFORT=low~CONTEXT_CODEX_VERBOSITY=high~CONTEXT_CODEX_CONTEXT_TOKENS=128000~CONTEXT_CODEX_COMPACT_TOKENS=96000~CAUSAL_GRAPH_CODEX_MODEL=gpt-5.6-terra~CAUSAL_GRAPH_DERIVE_SECONDS=900~CONTEXT_DAYTONA_SNAPSHOT=${daytona_snapshot}"
worker_secrets="INTERNAL_API_TOKEN=${internal_token_secret}:latest,JINA_WORKER_RELEASE_CREDENTIAL=${release_credential_secret}:${release_secret_version},DAYTONA_API_KEY=${daytona_secret}:latest,CAUSAL_GRAPH_OPENAI_API_KEY=${openai_secret}:latest,GITHUB_APP_ID=${github_app_id_secret}:latest,GITHUB_APP_PRIVATE_KEY=${github_app_private_key_secret}:latest,GITHUB_CLONE_TOKEN=${github_clone_token_secret}:latest"

# A first revision can receive traffic, but the API rejects all of its claims
# until the activation job records this exact release id, credential, and
# Cloud Run revision. Existing services use a zero-traffic candidate.
worker_traffic_args=(--tag="${candidate_tag}")
if gcloud run services describe "${worker_service}" \
  --project="${project}" \
  --region="${region}" >/dev/null 2>&1; then
  worker_traffic_args=(--no-traffic --tag="${candidate_tag}")
fi

gcloud run deploy "${worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --image="${worker_image}" \
  --no-allow-unauthenticated \
  --service-account="${worker_service_account}" \
  --concurrency=1 \
  --memory=1Gi \
  --timeout=300 \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --set-env-vars="${worker_environment}" \
  --set-secrets="${worker_secrets}" \
  "${worker_traffic_args[@]}" \
  --revision-suffix="${release_suffix}" \
  --quiet

gcloud run jobs deploy "${activation_job}" \
  --project="${project}" \
  --region="${region}" \
  --image="${api_image}" \
  --service-account="${migration_service_account}" \
  --set-cloudsql-instances="${sql_instance}" \
  --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${sql_instance}~DB_NAME=${database_name}~DB_USER=${owner_user}~RUNTIME_DB_USER=${runtime_user}~JINA_CAUSAL_GRAPH_RELEASE_ID=${release_id}~JINA_CAUSAL_GRAPH_WORKER_REVISION=${worker_revision}" \
  --set-secrets="DB_PASS=${owner_password_secret}:latest,JINA_CAUSAL_GRAPH_RELEASE_CREDENTIAL=${release_credential_secret}:${release_secret_version}" \
  --args=node_modules/@jina/db/dist/activate-causal-graph-release.js \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=10m \
  --quiet
gcloud run jobs execute "${activation_job}" \
  --project="${project}" \
  --region="${region}" \
  --wait

gcloud run services update-traffic "${worker_service}" \
  --project="${project}" \
  --region="${region}" \
  --to-revisions="${worker_revision}=100" \
  --clear-tags \
  --quiet

observed_topics="$(
  gcloud run revisions describe "${worker_revision}" \
    --project="${project}" \
    --region="${region}" \
    --format=json | python3 -c '
import json, sys
revision = json.load(sys.stdin)
environment = revision["spec"]["containers"][0].get("env", [])
print(next((item.get("value", "") for item in environment if item.get("name") == "WORKER_TOPICS"), ""))
'
)"
if [[ "${observed_topics}" != "${causal_topics}" ]]; then
  printf 'Causal graph worker topic isolation failed: %s\n' "${observed_topics}" >&2
  exit 2
fi

printf 'Causal graph staging release %s deployed in project %s without changing production or the Context worker release\n' "${release_id}" "${project}"
