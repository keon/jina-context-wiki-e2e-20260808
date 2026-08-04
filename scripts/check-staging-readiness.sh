#!/usr/bin/env bash
set -uo pipefail

repository="${JINA_STAGING_REPOSITORY:-omxyz/jina}"
github_environment="${JINA_STAGING_GITHUB_ENVIRONMENT:-Staging}"
staging_project="${JINA_STAGING_GCP_PROJECT:-jina-staging-20260802}"
region="${JINA_STAGING_REGION:-us-east1}"
failures=0

pass() {
  printf 'PASS  %s\n' "$1"
}

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "$1 is installed"
  else
    fail "$1 is required"
  fi
}

for command_name in gh gcloud jq; do
  require_command "$command_name"
done

if ((failures > 0)); then
  exit 1
fi

environment_json="$(gh api "repos/${repository}/environments/${github_environment}" 2>/dev/null || true)"
if [[ -z "${environment_json}" ]]; then
  fail "GitHub environment ${repository}/${github_environment} exists"
else
  pass "GitHub environment ${repository}/${github_environment} exists"
  branch_policy="$(jq -r '
    .deployment_branch_policy.custom_branch_policies == true and
    .deployment_branch_policy.protected_branches == false
  ' <<<"${environment_json}")"
  if [[ "${branch_policy}" == "true" ]]; then
    policies="$(gh api "repos/${repository}/environments/${github_environment}/deployment-branch-policies?per_page=100" 2>/dev/null || true)"
    if jq -e '.branch_policies[]? | select(.name == "staging" and .type == "branch")' \
        <<<"${policies}" >/dev/null; then
      pass "Staging deployments are restricted to the staging branch"
    else
      fail "Staging branch deployment policy is missing"
    fi
  else
    fail "Staging does not use custom branch deployment policies"
  fi
fi

variables_json="$(
  gh api --paginate --slurp \
    "repos/${repository}/environments/${github_environment}/variables?per_page=30" 2>/dev/null |
    jq '{variables: [.[].variables[]]}' || true
)"
secrets_json="$(gh api "repos/${repository}/environments/${github_environment}/secrets?per_page=100" 2>/dev/null || true)"

configured_project="$(jq -r '.variables[]? | select(.name == "GCP_PROJECT_ID") | .value' \
  <<<"${variables_json}")"
if [[ "${configured_project}" == "${staging_project}" ]]; then
  pass "GitHub Staging targets the isolated GCP project ${staging_project}"
else
  fail "GitHub Staging GCP_PROJECT_ID must equal ${staging_project}"
fi

required_variables=(
  GCP_PROJECT_ID
  GCP_REGION
  CLOUD_RUN_SERVICE
  CLOUD_SQL_INSTANCE
  CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT
  ARTIFACT_REGISTRY_REPOSITORY
  JINA_API_BASE_URL
  JINA_DASHBOARD_URL
  JINA_GITHUB_APP_ID
  JINA_GITHUB_APP_SLUG
  JINA_GITHUB_OAUTH_CLIENT_ID
  JINA_DASHBOARD_AUTH_MODE
  JINA_CLERK_PUBLISHABLE_KEY
  JINA_GRAPH_API_URL
  JINA_MCP_URL
  JINA_CONTEXT_TENANT_ID
  JINA_BILLING_ENFORCE
  WEBHOOK_SECRET_NAME
  JINA_GITHUB_APP_PRIVATE_KEY_SECRET_NAME
  INTERNAL_API_TOKEN_SECRET_NAME
  OAUTH_CLIENT_SECRET_NAME
  CLERK_SECRET_KEY_SECRET_NAME
  ENCRYPTION_KEY_SECRET_NAME
  GRAPH_API_TOKEN_SECRET_NAME
  GRAPH_INTERNAL_TOKEN_SECRET_NAME
  AUTUMN_SECRET_KEY_SECRET_NAME
)

for variable_name in "${required_variables[@]}"; do
  variable_value="$(jq -r --arg name "${variable_name}" \
    '.variables[]? | select(.name == $name) | .value' <<<"${variables_json}")"
  if [[ -z "${variable_value}" ]]; then
    fail "GitHub Staging variable ${variable_name} is configured"
  elif [[ "${variable_value}" == *usejina.com* || "${variable_name}" == *_SERVICE ||
          "${variable_name}" == *_INSTANCE || "${variable_name}" == *_SECRET_NAME ||
          "${variable_name}" == JINA_GITHUB_APP_SLUG ||
          "${variable_name}" == CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT ]]; then
    if [[ "${variable_value}" == *staging* ]]; then
      pass "GitHub Staging variable ${variable_name} is staging-scoped"
    else
      fail "GitHub Staging variable ${variable_name} must contain staging"
    fi
  else
    pass "GitHub Staging variable ${variable_name} is configured"
  fi
done

require_exact_staging_variable() {
  local variable_name="$1"
  local expected_value="$2"
  local actual_value
  actual_value="$(jq -r --arg name "${variable_name}" \
    '.variables[]? | select(.name == $name) | .value' <<<"${variables_json}")"
  if [[ "${actual_value}" == "${expected_value}" ]]; then
    pass "GitHub Staging variable ${variable_name} uses ${expected_value}"
  else
    fail "GitHub Staging variable ${variable_name} must equal ${expected_value}"
  fi
}

require_exact_staging_variable JINA_DASHBOARD_URL https://app.staging.usejina.com
require_exact_staging_variable JINA_DASHBOARD_ORIGIN https://app.staging.usejina.com
require_exact_staging_variable JINA_API_BASE_URL https://api.staging.usejina.com
require_exact_staging_variable JINA_GRAPH_API_URL https://api.staging.usejina.com
require_exact_staging_variable JINA_MCP_URL https://mcp.staging.usejina.com/mcp

context_tenant_id="$(jq -r '.variables[]? | select(.name == "JINA_CONTEXT_TENANT_ID") | .value' \
  <<<"${variables_json}")"
if [[ -n "${context_tenant_id}" && ! "${context_tenant_id}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  fail "GitHub Staging variable JINA_CONTEXT_TENANT_ID must be a UUID"
fi

required_environment_secrets=(
  STAGING_JINA_GITHUB_APP_PRIVATE_KEY
  STAGING_JINA_INTERNAL_API_TOKEN
  STAGING_JINA_DAYTONA_API_KEY
  STAGING_JINA_OPENROUTER_API_KEY
  STAGING_JINA_OPENAI_API_KEY
  STAGING_JINA_GITHUB_CLONE_TOKEN
)

for secret_name in "${required_environment_secrets[@]}"; do
  if jq -e --arg name "${secret_name}" '.secrets[]? | select(.name == $name)' \
      <<<"${secrets_json}" >/dev/null; then
    pass "GitHub Staging secret ${secret_name} exists"
  else
    fail "GitHub Staging secret ${secret_name} is missing"
  fi
done

sql_state="$(gcloud sql instances describe jina-db-staging --project="${staging_project}" \
  --format='value(state)' 2>/dev/null || true)"
if [[ "${sql_state}" == "RUNNABLE" ]]; then
  pass "Cloud SQL ${staging_project}/${region}/jina-db-staging is runnable"
else
  fail "Cloud SQL ${staging_project}/${region}/jina-db-staging is not runnable"
fi

if gcloud iam service-accounts describe \
    "jina-migration-staging@${staging_project}.iam.gserviceaccount.com" \
    --project="${staging_project}" >/dev/null 2>&1; then
  pass "Unified v2 migration staging service account exists"
else
  fail "Unified v2 migration staging service account is missing"
fi

product_secrets=(
  jina-staging-github-webhook-secret
  jina-staging-github-app-private-key
  jina-staging-internal-api-token
  jina-staging-github-oauth-client-secret
  jina-staging-clerk-secret-key
  jina-staging-secrets-encryption-key
  jina-staging-graph-api-token
  jina-staging-graph-internal-token
  jina-staging-autumn-secret-key
)
for secret_name in "${product_secrets[@]}"; do
  if gcloud secrets versions describe latest --secret="${secret_name}" \
      --project="${staging_project}" >/dev/null 2>&1; then
    pass "Product Secret Manager secret ${secret_name} has a latest version"
  else
    fail "Product Secret Manager secret ${secret_name} is missing a latest version"
  fi
done

api_service_json="$(gcloud run services describe jina-api-staging \
  --project="${staging_project}" --region="${region}" --format=json 2>/dev/null || true)"
if jq -e '
    . as $service |
    ([$service.spec.template.spec.containers[0].env[]? |
      select(.name == "JINA_PRODUCT_DATABASE_MODE" and .value == "shared")] | length == 1) and
    ([$service.spec.template.spec.containers[0].env[]? |
      select(.name == "JINA_PRODUCT_DATABASE_URL")] | length == 0)
  ' <<<"${api_service_json}" >/dev/null; then
  pass "Staging product data uses the shared v2 database connection"
else
  fail "Staging product data must use shared v2 DB_* credentials without JINA_PRODUCT_DATABASE_URL"
fi

database_users="$(gcloud sql users list --instance=jina-db-staging \
  --project="${staging_project}" --format='value(name)' 2>/dev/null || true)"
if grep -Fxq jina_v2_staging_app <<<"${database_users}" &&
    ! grep -Fxq jina_v1_staging_app <<<"${database_users}"; then
  pass "Cloud SQL has the v2 runtime user and no legacy v1 runtime user"
else
  fail "Cloud SQL runtime users have not completed the v2 cutover"
fi

if gcloud run jobs describe jina-v2-migrate-staging --project="${staging_project}" \
    --region="${region}" >/dev/null 2>&1; then
  pass "Unified v2 staging migration job exists"
else
  fail "Unified v2 staging migration job is missing"
fi

for legacy_job in \
  jina-product-migrate-staging \
  jina-context-migrate-staging \
  jina-context-role-bootstrap-staging; do
  if gcloud run jobs describe "${legacy_job}" --project="${staging_project}" \
      --region="${region}" >/dev/null 2>&1; then
    fail "Legacy staging migration job ${legacy_job} still exists"
  else
    pass "Legacy staging migration job ${legacy_job} is absent"
  fi
done
for legacy_secret in jina-staging-database-url jina-v1-staging-db-password; do
  if gcloud secrets describe "${legacy_secret}" --project="${staging_project}" >/dev/null 2>&1; then
    fail "Legacy staging database secret ${legacy_secret} still exists"
  else
    pass "Legacy staging database secret ${legacy_secret} is absent"
  fi
done
if gcloud run jobs describe jina-v2-db-cutover-staging --project="${staging_project}" \
    --region="${region}" >/dev/null 2>&1; then
  fail "One-time staging database cutover job still exists"
else
  pass "One-time staging database cutover job is absent"
fi

staging_services=(
  jina-api-staging
  jina-context-worker-staging
  jina-task-worker-staging
  jina-causal-graph-worker
)
for service_name in "${staging_services[@]}"; do
  if gcloud run services describe "${service_name}" --project="${staging_project}" \
      --region="${region}" >/dev/null 2>&1; then
    pass "Staging Cloud Run service ${service_name} exists"
  else
    fail "Staging Cloud Run service ${service_name} is missing"
  fi
done

if gcloud iam service-accounts describe \
    "jina-causal-worker-staging@${staging_project}.iam.gserviceaccount.com" \
    --project="${staging_project}" >/dev/null 2>&1; then
  pass "Causal graph staging service account exists"
else
  fail "Causal graph staging service account is missing"
fi

if gcloud secrets versions describe latest \
    --secret=jina-staging-causal-graph-worker-release-credential \
    --project="${staging_project}" >/dev/null 2>&1; then
  pass "Causal graph staging release credential exists"
else
  fail "Causal graph staging release credential is missing"
fi

causal_service_json="$(gcloud run services describe jina-causal-graph-worker \
  --project="${staging_project}" --region="${region}" --format=json 2>/dev/null || true)"
if jq -e '
    [.spec.template.spec.containers[]? | select(.name == "otel-collector")] | length == 1
  ' <<<"${causal_service_json}" >/dev/null &&
  jq -e '
    [.spec.template.spec.containers[]? |
      select(.name != "otel-collector") |
      .env[]? |
      select(.name == "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" and .value == "http://localhost:4318/v1/traces")
    ] | length == 1
  ' <<<"${causal_service_json}" >/dev/null; then
  pass "Causal graph staging worker exports OTel traces through its sidecar"
else
  fail "Causal graph staging worker is missing its OTel sidecar contract"
fi

if command -v vercel >/dev/null 2>&1 && vercel project inspect jina-staging-dashboard \
    --scope omlabs >/dev/null 2>&1; then
  pass "Vercel staging dashboard project exists"
else
  fail "Vercel staging dashboard project is missing"
fi

if command -v vercel >/dev/null 2>&1 && vercel project inspect jina-staging-admin \
    --scope omlabs >/dev/null 2>&1; then
  pass "Vercel staging admin project exists"
else
  fail "Vercel staging admin project is missing"
fi

if command -v vercel >/dev/null 2>&1 && vercel project inspect jina-staging-docs \
    --scope omlabs >/dev/null 2>&1; then
  pass "Vercel staging docs project exists"
else
  fail "Vercel staging docs project is missing"
fi

staging_domain_mappings=(
  "api.staging.usejina.com:jina-api-staging"
  "mcp.staging.usejina.com:jina-api-staging"
)
for mapping in "${staging_domain_mappings[@]}"; do
  domain_name="${mapping%%:*}"
  expected_service="${mapping#*:}"
  mapping_json="$(gcloud beta run domain-mappings describe --domain="${domain_name}" \
    --project="${staging_project}" --region="${region}" --format=json 2>/dev/null || true)"
  mapped_service="$(jq -r '.spec.routeName // empty' <<<"${mapping_json}")"
  certificate_ready="$(jq -r \
    '[.status.conditions[]? | select(.type == "CertificateProvisioned" and .status == "True")] | length > 0' \
    <<<"${mapping_json}")"
  if [[ "${mapped_service}" == "${expected_service}" && "${certificate_ready}" == "true" ]]; then
    pass "Staging domain ${domain_name} routes to ${expected_service} with TLS"
  else
    fail "Staging domain ${domain_name} must route to ${expected_service} with TLS"
  fi
done

if ((failures > 0)); then
  printf '%d staging readiness check(s) failed\n' "${failures}" >&2
  exit 1
fi

printf 'Staging is ready for deployment\n'
