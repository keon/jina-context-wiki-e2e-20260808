#!/usr/bin/env bash

# Cloud release cleanup primitives. The caller supplies GCP_PROJECT_ID,
# GCP_REGION, release_control_job, and worker_release_secret.

release_cleanup_attempts="${JINA_RELEASE_CLEANUP_ATTEMPTS:-3}"
release_cleanup_retry_seconds="${JINA_RELEASE_CLEANUP_RETRY_SECONDS:-2}"

delete_release_control_job_verified() {
  local attempt
  local observed
  for ((attempt = 1; attempt <= release_cleanup_attempts; attempt += 1)); do
    gcloud run jobs delete "${release_control_job}" \
      --project="${GCP_PROJECT_ID}" \
      --region="${GCP_REGION}" \
      --quiet >/dev/null 2>&1 || true
    if observed="$(
      gcloud run jobs list \
        --project="${GCP_PROJECT_ID}" \
        --region="${GCP_REGION}" \
        --filter="metadata.name=${release_control_job}" \
        --format='value(metadata.name)' 2>/dev/null
    )" && [[ -z "${observed}" ]]; then
      return 0
    fi
    if (( attempt < release_cleanup_attempts )); then
      sleep "${release_cleanup_retry_seconds}"
    fi
  done
  echo "Release-control job ${release_control_job} still exists or could not be verified absent after ${release_cleanup_attempts} attempts" >&2
  return 1
}

destroy_release_secret_version_verified() {
  local version="$1"
  local description="$2"
  local attempt
  local state
  [[ -n "${version}" ]] || return 0

  for ((attempt = 1; attempt <= release_cleanup_attempts; attempt += 1)); do
    gcloud secrets versions destroy "${version}" \
      --secret="${worker_release_secret}" \
      --project="${GCP_PROJECT_ID}" \
      --quiet >/dev/null 2>&1 || true
    if state="$(
      gcloud secrets versions describe "${version}" \
        --secret="${worker_release_secret}" \
        --project="${GCP_PROJECT_ID}" \
        --format='value(state)' 2>/dev/null
    )" && [[ "${state}" == "DESTROYED" ]]; then
      return 0
    fi
    if (( attempt < release_cleanup_attempts )); then
      sleep "${release_cleanup_retry_seconds}"
    fi
  done
  echo "${description} Secret Manager version ${version} was not verified DESTROYED after ${release_cleanup_attempts} attempts" >&2
  return 1
}
