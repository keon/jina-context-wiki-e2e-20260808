#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_TAG:?IMAGE_TAG is required and must identify the tested staging API image}"
: "${CUTOVER_PHASE:?CUTOVER_PHASE must be prepare, finalize, or verify}"

project="${GCP_PROJECT_ID:-jina-staging-20260802}"
region="${GCP_REGION:-us-east1}"
instance="${CLOUD_SQL_INSTANCE:-jina-staging-20260802:us-east1:jina-db-staging}"
instance_name="${CLOUD_SQL_INSTANCE_NAME:-jina-db-staging}"
database="${JINA_DB_NAME:-jina_staging}"
runtime_user="${JINA_DB_USER:-jina_v2_staging_app}"
legacy_user="${JINA_LEGACY_DB_USER:-jina_v1_staging_app}"
owner_user="${JINA_MIGRATION_DB_USER:-postgres}"
repository="${JINA_ARTIFACT_REGISTRY_REPOSITORY:-jina-staging}"
image="${region}-docker.pkg.dev/${project}/${repository}/api:${IMAGE_TAG}"
job="jina-v2-db-cutover-staging"
service_account="jina-migration-staging@${project}.iam.gserviceaccount.com"
owner_secret="jina-staging-owner-db-password"

if [[ "${project}" == "jina-463721" || "${project}" == "jina-v2" || "${project}" != *staging* ]]; then
  printf 'Refusing database cutover outside the staging project: %s\n' "${project}" >&2
  exit 2
fi
for value in "${instance}" "${instance_name}" "${database}" "${runtime_user}" "${legacy_user}" \
  "${repository}" "${job}" "${service_account}" "${owner_secret}" "${IMAGE_TAG}"; do
  if [[ "${value}" != *staging* ]]; then
    printf 'Refusing non-staging cutover value: %s\n' "${value}" >&2
    exit 2
  fi
done
if [[ "${CUTOVER_PHASE}" != "prepare" && "${CUTOVER_PHASE}" != "finalize" && "${CUTOVER_PHASE}" != "verify" ]]; then
  printf 'CUTOVER_PHASE must be prepare, finalize, or verify\n' >&2
  exit 2
fi

gcloud artifacts docker images describe "${image}" --project="${project}" >/dev/null
gcloud secrets versions describe latest --secret="${owner_secret}" --project="${project}" >/dev/null

if [[ "${CUTOVER_PHASE}" == "prepare" ]]; then
  backup_id="${JINA_CUTOVER_BACKUP_ID:-}"
  if [[ -z "${backup_id}" ]]; then
    backup_description="pre-v2-database-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
    gcloud sql backups create \
      --instance="${instance_name}" \
      --project="${project}" \
      --description="${backup_description}" \
      --quiet
    backup_id="$(gcloud sql backups list --instance="${instance_name}" --project="${project}" \
      --filter="description=${backup_description}" --limit=1 --format='value(id)')"
  fi
  if [[ ! "${backup_id}" =~ ^[0-9]+$ ]]; then
    printf 'A numeric staging backup id is required before prepare\n' >&2
    exit 2
  fi
  backup_status=""
  for _attempt in $(seq 1 180); do
    backup_status="$(gcloud sql backups describe "${backup_id}" --instance="${instance_name}" \
      --project="${project}" --format='value(status)')"
    if [[ "${backup_status}" == "SUCCESSFUL" ]]; then
      break
    fi
    if [[ "${backup_status}" == "FAILED" || "${backup_status}" == "DELETED" ]]; then
      printf 'Staging backup %s failed: %s\n' "${backup_id}" "${backup_status}" >&2
      exit 2
    fi
    sleep 5
  done
  if [[ "${backup_status}" != "SUCCESSFUL" ]]; then
    printf 'Staging backup %s did not become successful: %s\n' "${backup_id}" "${backup_status}" >&2
    exit 2
  fi
fi

deploy_cutover_job() {
  local phase="$1"
  gcloud run jobs deploy "${job}" \
    --project="${project}" \
    --region="${region}" \
    --image="${image}" \
    --service-account="${service_account}" \
    --set-cloudsql-instances="${instance}" \
    --set-env-vars="^~^INSTANCE_UNIX_SOCKET=/cloudsql/${instance}~DB_NAME=${database}~DB_USER=${owner_user}~JINA_PRODUCT_DATABASE_MODE=shared~JINA_DATABASE_CUTOVER_PHASE=${phase}~JINA_PRODUCT_RUNTIME_DB_ROLE=${runtime_user}~JINA_PRODUCT_LEGACY_DB_ROLE=${legacy_user}" \
    --set-secrets="DB_PASS=${owner_secret}:latest" \
    --args=dist/product/database-cutover.js \
    --tasks=1 \
    --max-retries=0 \
    --task-timeout=15m \
    --quiet
  gcloud run jobs execute "${job}" \
    --project="${project}" \
    --region="${region}" \
    --wait
}

deploy_cutover_job "${CUTOVER_PHASE}"

if [[ "${CUTOVER_PHASE}" == "finalize" ]]; then
  gcloud sql users delete "${legacy_user}" \
    --instance="${instance_name}" \
    --project="${project}" \
    --quiet
  deploy_cutover_job verify

  for legacy_job in \
    jina-product-migrate-staging \
    jina-context-migrate-staging \
    jina-context-role-bootstrap-staging; do
    if gcloud run jobs describe "${legacy_job}" --project="${project}" \
        --region="${region}" >/dev/null 2>&1; then
      gcloud run jobs delete "${legacy_job}" --project="${project}" \
        --region="${region}" --quiet
    fi
  done
  for legacy_secret in jina-staging-database-url jina-v1-staging-db-password; do
    if gcloud secrets describe "${legacy_secret}" --project="${project}" >/dev/null 2>&1; then
      gcloud secrets delete "${legacy_secret}" --project="${project}" --quiet
    fi
  done
  gcloud run jobs delete "${job}" --project="${project}" \
    --region="${region}" --quiet
fi
