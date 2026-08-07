#!/usr/bin/env bash
set -euo pipefail

environment="${1:-}"
case "${environment}" in
  staging)
    project_id="jina-staging-20260802"
    service_account="jina-cloud-build-staging@${project_id}.iam.gserviceaccount.com"
    trigger_access_token_secret="jina-trigger-access-token"
    internal_api_token_secret="jina-staging-internal-api-token"
    daytona_api_key_secret="jina-staging-daytona-api-key"
    github_app_id_secret="jina-staging-github-app-id"
    github_app_private_key_secret="jina-staging-github-app-private-key"
    github_clone_token_secret="jina-staging-github-clone-token"
    openrouter_api_key_secret="jina-staging-openrouter-api-key"
    openai_api_key_secret="jina-staging-openai-api-key"
    substitutions=(
      "_TRIGGER_ENV=staging"
      "_TRIGGER_PROJECT_REF=proj_rqckjugodcaghbpgggbz"
      "_TRIGGER_PROJECT_NAME=jina-staging-isolated"
      "_API_BASE_URL=https://api.staging.usejina.com"
      "_DASHBOARD_URL=https://app.staging.usejina.com"
      "_TRIGGER_ACCESS_TOKEN_SECRET=${trigger_access_token_secret}"
      "_INTERNAL_API_TOKEN_SECRET=${internal_api_token_secret}"
      "_DAYTONA_API_KEY_SECRET=${daytona_api_key_secret}"
      "_GITHUB_APP_ID_SECRET=${github_app_id_secret}"
      "_GITHUB_APP_PRIVATE_KEY_SECRET=${github_app_private_key_secret}"
      "_GITHUB_CLONE_TOKEN_SECRET=${github_clone_token_secret}"
      "_OPENROUTER_API_KEY_SECRET=${openrouter_api_key_secret}"
      "_OPENAI_API_KEY_SECRET=${openai_api_key_secret}"
    )
    ;;
  production)
    project_id="jina-v2"
    service_account="jina-cloud-build-deployer@${project_id}.iam.gserviceaccount.com"
    # Additive project created and inventoried on 2026-08-06. It is review-only
    # and has never owned the legacy billing/backfill/review-scan schedules.
    trigger_project_ref="proj_yrxsqjznkghpwsolfmjp"
    trigger_access_token_secret="jina-trigger-access-token"
    internal_api_token_secret="jina-v1-internal-api-token"
    daytona_api_key_secret="jina-daytona-api-key"
    github_app_id_secret="jina-github-app-id"
    github_app_private_key_secret="jina-github-app-private-key"
    github_clone_token_secret="jina-github-clone-token"
    openrouter_api_key_secret="jina-openrouter-api-key"
    openai_api_key_secret="jina-openai-api-key"
    substitutions=(
      "_TRIGGER_ENV=prod"
      "_TRIGGER_PROJECT_REF=${trigger_project_ref}"
      "_TRIGGER_PROJECT_NAME=jina-review-production"
      "_API_BASE_URL=https://api.usejina.com"
      "_DASHBOARD_URL=https://app.usejina.com"
      "_TRIGGER_ACCESS_TOKEN_SECRET=${trigger_access_token_secret}"
      "_INTERNAL_API_TOKEN_SECRET=${internal_api_token_secret}"
      "_DAYTONA_API_KEY_SECRET=${daytona_api_key_secret}"
      "_GITHUB_APP_ID_SECRET=${github_app_id_secret}"
      "_GITHUB_APP_PRIVATE_KEY_SECRET=${github_app_private_key_secret}"
      "_GITHUB_CLONE_TOKEN_SECRET=${github_clone_token_secret}"
      "_OPENROUTER_API_KEY_SECRET=${openrouter_api_key_secret}"
      "_OPENAI_API_KEY_SECRET=${openai_api_key_secret}"
    )
    ;;
  *)
    echo "usage: scripts/deploy-trigger-gcloud.sh staging|production" >&2
    exit 2
    ;;
esac

secret_versions=(
  "_TRIGGER_ACCESS_TOKEN_VERSION:${trigger_access_token_secret}"
  "_INTERNAL_API_TOKEN_VERSION:${internal_api_token_secret}"
  "_DAYTONA_API_KEY_VERSION:${daytona_api_key_secret}"
  "_GITHUB_APP_ID_VERSION:${github_app_id_secret}"
  "_GITHUB_APP_PRIVATE_KEY_VERSION:${github_app_private_key_secret}"
  "_GITHUB_CLONE_TOKEN_VERSION:${github_clone_token_secret}"
  "_OPENROUTER_API_KEY_VERSION:${openrouter_api_key_secret}"
  "_OPENAI_API_KEY_VERSION:${openai_api_key_secret}"
)
for binding in "${secret_versions[@]}"; do
  substitution_key="${binding%%:*}"
  secret_name="${binding#*:}"
  version_name="$(
    gcloud secrets versions list "${secret_name}" \
      --project="${project_id}" \
      --filter='state=ENABLED' \
      --format='value(name)' | sed 's#^.*/##' | sort -n | tail -n 1
  )"
  # gcloud currently prints the basename for this field, while some surfaces
  # return the fully-qualified resource name. Accept both shapes and submit
  # only the numeric terminal component to Cloud Build.
  numeric_version="${version_name##*/}"
  if [[ ! "${numeric_version}" =~ ^[1-9][0-9]*$ ]]; then
    echo "No enabled numeric version found for ${project_id}/${secret_name}" >&2
    exit 2
  fi
  substitutions+=("${substitution_key}=${numeric_version}")
done

substitution_csv="$(IFS=,; printf '%s' "${substitutions[*]}")"
gcloud builds submit \
  --project="${project_id}" \
  --region=us-central1 \
  --config=cloudbuild.trigger.yaml \
  --service-account="projects/${project_id}/serviceAccounts/${service_account}" \
  --substitutions="${substitution_csv}" \
  .
