#!/usr/bin/env bash
set -euo pipefail

readonly prohibited='@jina/context-graph|/context-graph|run-context-graph|context_graph_assert|context_graph_project|query_graph|jina_context_graph|CONTEXT_GRAPH_'

if rg --line-number --ignore-case \
  --glob '!**/*.test.ts' \
  --glob '!**/dist/**' \
  --glob '!docs/**' \
  --glob '!README.md' \
  --glob '!.env.example' \
  --glob '!scripts/check-context-cutover.sh' \
  --glob '!packages/db/src/legacy-context-cutover.ts' \
  "${prohibited}" apps packages scripts; then
  echo "Legacy context runtime vocabulary remains in production source." >&2
  exit 1
fi

normal_retry_output="$(
  GCP_PROJECT_ID=jina-v2 GCP_REGION=us-central1 CLOUD_BUILD_ID=mock-build bash -c '
    gcloud() {
      if [[ "$1 $2 $3" == "run services describe" ]]; then return 1; fi
      return 0
    }
    export -f gcloud
    bash scripts/cloud-build-deploy.sh
  ' 2>&1 || true
)"
if [[ "${normal_retry_output}" != *"interrupted first cutover must resume in destructive mode"* ]]; then
  echo "Normal deployment did not fence an interrupted destructive cutover." >&2
  exit 1
fi

service_discovery_output="$(
  GCP_PROJECT_ID=jina-v2 GCP_REGION=us-central1 CLOUD_BUILD_ID=mock-build bash -c '
    gcloud() {
      if [[ "$1 $2 $3" == "run services list" ]]; then return 1; fi
      return 0
    }
    export -f gcloud
    bash scripts/cloud-build-deploy.sh
  ' 2>&1 || true
)"
if [[ "${service_discovery_output}" != *"Unable to obtain an authoritative Cloud Run service inventory"* ]]; then
  echo "Cloud Run control-plane failure was treated as service absence." >&2
  exit 1
fi

readonly mock_release_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
split_image_output="$(
  GCP_PROJECT_ID=jina-v2 \
    GCP_REGION=us-central1 \
    CLOUD_BUILD_ID=mock-build \
    IMAGE_TAG=latest \
    JINA_CONTEXT_CUTOVER=true \
    JINA_CONTEXT_CUTOVER_BACKUP_ID=1 \
    JINA_CONTEXT_CUTOVER_LEGACY_BACKUP_ID=2 \
    JINA_LEGACY_CUTOVER_TENANT_IDS=eff0efc9-b103-494a-b7a3-1ae7f95c2d26 \
    JINA_RELEASE_SHA="${mock_release_sha}" \
    JINA_BUILD_COMMIT_SHA="${mock_release_sha}" \
    bash -c '
      gcloud() {
        if [[ "$1 $2 $3" == "run services describe" ]]; then return 1; fi
        if [[ "$1 $2" == "builds describe" ]]; then printf "%s\n" "$JINA_RELEASE_SHA"; return 0; fi
        return 0
      }
      export -f gcloud
      bash scripts/cloud-build-deploy.sh
    ' 2>&1 || true
)"
if [[ "${split_image_output}" != *"must deploy images built by the current coordinated Cloud Build"* ]]; then
  echo "Destructive cutover accepted an image tag from another build." >&2
  exit 1
fi

if rg --quiet '_JINA_CONTEXT_CUTOVER|_JINA_RELEASE_SHA|_JINA_LEGACY_CUTOVER' cloudbuild.deploy.yaml; then
  echo "Split-image deployment config exposes destructive cutover substitutions." >&2
  exit 1
fi
