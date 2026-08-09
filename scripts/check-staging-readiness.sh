#!/usr/bin/env bash
set -uo pipefail

staging_project="${JINA_STAGING_GCP_PROJECT:-jina-staging-20260802}"
region="${JINA_STAGING_REGION:-us-east1}"
cloud_build_region="${JINA_STAGING_CLOUD_BUILD_REGION:-us-central1}"
trigger_name="${JINA_STAGING_CLOUD_BUILD_TRIGGER:-jina-staging-deploy}"
connection_name="${JINA_STAGING_CLOUD_BUILD_CONNECTION:-jina-github}"
repository_name="${JINA_STAGING_CLOUD_BUILD_REPOSITORY:-jina}"
staging_deployer="jina-cloud-build-staging@${staging_project}.iam.gserviceaccount.com"
api_service_account="jina-api-staging@${staging_project}.iam.gserviceaccount.com"
artifact_bucket="${JINA_STAGING_CONTEXT_GCS_BUCKET:-${staging_project}-context-artifacts-us-east1}"
cloud_build_service_agent="service-679811160186@gcp-sa-cloudbuild.iam.gserviceaccount.com"
repository_resource="projects/${staging_project}/locations/${cloud_build_region}/connections/${connection_name}/repositories/${repository_name}"
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

for command_name in gcloud jq; do
  require_command "$command_name"
done

if ((failures > 0)); then
  exit 1
fi

project_policy="$(gcloud projects get-iam-policy "${staging_project}" --format=json 2>/dev/null || true)"
required_deployer_roles=(
  roles/artifactregistry.writer
  roles/cloudbuild.builds.builder
  roles/cloudbuild.builds.viewer
  roles/cloudscheduler.admin
  roles/cloudsql.client
  roles/cloudsql.viewer
  roles/iam.serviceAccountUser
  roles/logging.logWriter
  roles/run.admin
  roles/secretmanager.secretAccessor
  roles/secretmanager.viewer
  roles/serviceusage.serviceUsageConsumer
  roles/storage.objectViewer
)
for role in "${required_deployer_roles[@]}"; do
  if jq -e --arg role "${role}" --arg member "serviceAccount:${staging_deployer}" '
      .bindings[]? | select(.role == $role) | .members[]? | select(. == $member)
    ' <<<"${project_policy}" >/dev/null; then
    pass "Automatic staging deployer has ${role}"
  else
    fail "Automatic staging deployer requires ${role}"
  fi
done
for member in \
  "serviceAccount:${staging_deployer}" \
  "serviceAccount:${api_service_account}"; do
  if jq -e --arg member "${member}" '
      .bindings[]? |
      select(.role == "roles/storage.admin") |
      .members[]? | select(. == $member)
    ' <<<"${project_policy}" >/dev/null; then
    fail "${member} must not have project-level roles/storage.admin"
  else
    pass "${member} has no visible project-level roles/storage.admin grant"
  fi
done

deployer_policy="$(gcloud iam service-accounts get-iam-policy "${staging_deployer}" \
  --project="${staging_project}" --format=json 2>/dev/null || true)"
if jq -e --arg member "serviceAccount:${cloud_build_service_agent}" '
    .bindings[]? |
    select(.role == "roles/iam.serviceAccountTokenCreator") |
    .members[]? | select(. == $member)
  ' <<<"${deployer_policy}" >/dev/null; then
  pass "Cloud Build service agent can mint the dedicated staging build identity"
else
  fail "Cloud Build service agent requires TokenCreator on ${staging_deployer}"
fi

connection_json="$(gcloud builds connections describe "${connection_name}" \
  --project="${staging_project}" --region="${cloud_build_region}" \
  --format=json 2>/dev/null || true)"
if jq -e '.installationState.stage == "COMPLETE" and .githubConfig.appInstallationId != null' \
    <<<"${connection_json}" >/dev/null; then
  pass "Cloud Build GitHub connection ${connection_name} is ready"
else
  fail "Cloud Build GitHub connection ${connection_name} is not ready"
fi

configured_repository="$(gcloud builds repositories describe "${repository_name}" \
  --connection="${connection_name}" --project="${staging_project}" \
  --region="${cloud_build_region}" --format='value(name)' 2>/dev/null || true)"
if [[ "${configured_repository}" == "${repository_resource}" ]]; then
  pass "Cloud Build repository is bound to omxyz/jina"
else
  fail "Cloud Build repository ${repository_resource} is missing"
fi

trigger_json="$(gcloud builds triggers describe "${trigger_name}" \
  --project="${staging_project}" --region="${cloud_build_region}" \
  --format=json 2>/dev/null || true)"
if jq -e \
    --arg repository "${repository_resource}" \
    --arg service_account "projects/${staging_project}/serviceAccounts/${staging_deployer}" '
      .filename == "cloudbuild.staging.yaml" and
      .repositoryEventConfig.repository == $repository and
      .repositoryEventConfig.push.branch == "^staging$" and
      .serviceAccount == $service_account and
      (.approvalConfig.approvalRequired // false) == false and
      (.substitutions | keys) == ["_JINA_CONTEXT_TENANT_ID"]
    ' <<<"${trigger_json}" >/dev/null; then
  pass "${trigger_name} deploys every staging push through cloudbuild.staging.yaml"
else
  fail "${trigger_name} must be an unapproved staging-only cloudbuild.staging.yaml trigger"
fi

context_tenant_id="$(jq -r '.substitutions._JINA_CONTEXT_TENANT_ID // empty' \
  <<<"${trigger_json}")"
if [[ "${context_tenant_id}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  pass "${trigger_name} carries an explicit staging Context tenant UUID"
else
  fail "${trigger_name} requires a UUID-valued _JINA_CONTEXT_TENANT_ID substitution"
fi

artifact_bucket_json="$(gcloud storage buckets describe "gs://${artifact_bucket}" \
  --project="${staging_project}" --format=json 2>/dev/null || true)"
if jq -e --arg bucket "${artifact_bucket}" --arg location "${region^^}" '
    .name == $bucket and
    .location == $location and
    .location_type == "region" and
    .uniform_bucket_level_access == true and
    ((.lifecycle // {} | .rule // []) | length == 0)
  ' <<<"${artifact_bucket_json}" >/dev/null; then
  pass "Staging Context artifact bucket is regional, uniform, and has no lifecycle rules"
else
  fail "Staging Context artifact bucket must be regional, uniform, and have no lifecycle rules"
fi

artifact_bucket_policy="$(gcloud storage buckets get-iam-policy "gs://${artifact_bucket}" \
  --project="${staging_project}" --format=json 2>/dev/null || true)"
if ! jq -e 'type == "object" and (.bindings | type == "array")' \
  <<<"${artifact_bucket_policy}" >/dev/null; then
  fail "Staging Context artifact bucket IAM policy is unreadable"
elif jq -e '
    any(.bindings[]?.members[]?; . == "allUsers" or . == "allAuthenticatedUsers")
  ' <<<"${artifact_bucket_policy}" >/dev/null; then
  fail "Staging Context artifact bucket must not grant public IAM access"
else
  pass "Legacy staging Context artifact bucket has no public IAM principals"
fi

release_secret_policy="$(gcloud secrets get-iam-policy \
  jina-staging-causal-graph-worker-release-credential \
  --project="${staging_project}" --format=json 2>/dev/null || true)"
if jq -e --arg member "serviceAccount:${staging_deployer}" '
    .bindings[]? |
    select(.role == "roles/secretmanager.secretVersionAdder") |
    .members[]? | select(. == $member)
  ' <<<"${release_secret_policy}" >/dev/null; then
  pass "Automatic staging deployer can add causal release credential versions"
else
  fail "Automatic staging deployer requires secretVersionAdder on the causal release credential"
fi

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
  jina-staging-context-trigger-secret-key
  jina-staging-context-trigger-service-token
  jina-staging-context-execution-grant-secret
  jina-staging-context-trigger-dispatch-secret
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
      select(.name == "JINA_WIKI_ARTIFACT_STORE" and .value == "postgres")] | length == 1) and
    ([$service.spec.template.spec.containers[0].env[]? |
      select(.name == "JINA_WIKI_PIPELINE_MODE" and .value == "trigger")] | length == 1) and
    ([$service.spec.template.spec.containers[0].env[]? |
      select(.name == "JINA_WIKI_GENERATOR_POLICY_VERSION" and .value == "wiki-generator-v3")] | length == 1) and
    ([$service.spec.template.spec.containers[0].env[]? |
      select(.name == "JINA_WIKI_MODEL" and .value == "gpt-5.6-terra")] | length == 1) and
    ([$service.spec.template.spec.containers[0].env[]? |
      select(.name == "JINA_WIKI_AUDIT_POLICY_VERSION" and .value == "audit.v2")] | length == 1) and
    ([$service.spec.template.spec.containers[0].env[]? |
      select(.name == "JINA_WIKI_AUDIT_MODEL" and .value == "gpt-5.6-terra")] | length == 1) and
    ([$service.spec.template.spec.containers[0].env[]? |
      select(.name == "JINA_WIKI_AUDITOR_CONFIG_DIGEST" and .value == "ec59b154179e29cec049f93c0d69ff6d3e90a8aecba0b37ab1f24d52ef7bc28b")] | length == 1) and
    ([$service.spec.template.spec.containers[0].env[]? |
      select(.name == "JINA_PRODUCT_DATABASE_URL")] | length == 0)
  ' <<<"${api_service_json}" >/dev/null; then
  pass "Staging product data, wiki artifacts, generator v2, and semantic audit v2 are configured"
else
  fail "Staging must use shared DB/wiki storage plus the exact Trigger generator and semantic-audit v2 contracts"
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
