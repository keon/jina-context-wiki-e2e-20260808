import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const BOARD_TOPICS = [
  "run-context-input-snapshot",
  "run-context-page-plan",
  "run-context-page-build",
  "run-context-publication"
];
const LEGACY_TOPICS = [
  "run-context-research-plan",
  "run-context-research",
  "run-context-publication-plan",
  "run-context-page-write",
  "run-context-page-audit",
  "run-context-page-repair",
  "run-context-source-challenge",
  "run-context-task-evaluation",
  "run-context-gap-repair",
  "run-context-certification",
  "run-context-pageindex",
  "run-ingest-evidence",
  "run-derive-knowledge",
  "run-index-context"
];

const deployment = await readFile("scripts/cloud-build-deploy.sh", "utf8");
const causalDeployment = await readFile("scripts/cloud-build-deploy-causal-graph.sh", "utf8");
const causalCloudBuild = await readFile("cloudbuild.causal-graph.yaml", "utf8");
const releaseCleanupLibrary = await readFile("scripts/cloud-release-cleanup-lib.sh", "utf8");
const apiDockerfile = await readFile("apps/api/Dockerfile", "utf8");
const workerDockerfile = await readFile("apps/worker/Dockerfile", "utf8");
const pageIndexDockerfile = await readFile("services/pageindex-worker/Dockerfile", "utf8");
const pageIndexWorker = await readFile("services/pageindex-worker/worker.py", "utf8");
const cloudBuild = await readFile("cloudbuild.yaml", "utf8");
const productionPreflight = await readFile("scripts/context-production-preflight.mjs", "utf8");
const productionTriggerAcceptance = await readFile("scripts/context-production-trigger-e2e.mjs", "utf8");
const apiServer = await readFile("apps/api/src/server.ts", "utf8");
const workerServer = await readFile("apps/worker/src/server.ts", "utf8");
const postgresStateStore = await readFile("packages/db/src/postgres-json-state-store.ts", "utf8");
const databaseMigration = await readFile("packages/db/src/migrate.ts", "utf8");
const deploymentDocs = await readFile("docs/DEPLOYMENT.md", "utf8");
const publicApiCandidateDeployment = await readFile("scripts/deploy-public-api-candidate.mjs", "utf8");
const stagingDeployment = await readFile("scripts/deploy-staging.sh", "utf8");
const stagingSerialization = await readFile("scripts/serialize-cloud-build-deploy.sh", "utf8");
const stagingCloudBuild = await readFile("cloudbuild.staging.yaml", "utf8");

async function withFakeGcloud(source, callback) {
  const directory = await mkdtemp(join(tmpdir(), "jina-deploy-gcloud-"));
  const executable = join(directory, "gcloud");
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  try {
    return await callback({
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GCP_PROJECT_ID: "quality-project",
      GCP_REGION: "us-east1",
      CLOUD_BUILD_ID: "quality-build",
      JINA_CONTEXT_DAYTONA_SNAPSHOT: "snapshot-v1",
      JINA_CONTEXT_DAYTONA_MODEL_SECRET: "openai-model-secret"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function numericSecretPreflightGcloud(versionResult) {
  return `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "storage buckets describe" ]]; then
  printf '%s\\n' '{"name":"quality-project-jina-context-artifacts","location":"US-EAST1","location_type":"region","uniform_bucket_level_access":true}'
  exit 0
fi
if [[ "$1 $2 $3" == "storage buckets get-iam-policy" ]]; then
  printf '%s\\n' '{"bindings":[{"role":"roles/storage.admin","members":["serviceAccount:jina-cloud-build-deployer@quality-project.iam.gserviceaccount.com"]}]}'
  exit 0
fi
if [[ "$1 $2 $3" == "secrets versions describe" ]]; then
  ${versionResult}
fi
exit 97
`;
}

test("production deployment shell is syntactically valid", async () => {
  await execFileAsync("bash", ["-n", "scripts/cloud-build-deploy.sh"]);
  await execFileAsync("bash", ["-n", "scripts/cloud-build-deploy-causal-graph.sh"]);
  await execFileAsync("bash", ["-n", "scripts/cloud-release-cleanup-lib.sh"]);
  await execFileAsync(process.execPath, ["--check", "scripts/context-production-preflight.mjs"]);
  await execFileAsync(process.execPath, ["--check", "scripts/context-production-trigger-e2e.mjs"]);
});

test("production Cloud Build declares image validation before every dependent build step", () => {
  const validationStep = cloudBuild.indexOf("  - id: validate-image-selection");
  const firstDependent = cloudBuild.indexOf("    waitFor: [validate-image-selection]");
  assert.ok(validationStep >= 0, "image selection validation step must exist");
  assert.ok(firstDependent >= 0, "image build steps must wait for image selection validation");
  assert.ok(
    validationStep < firstDependent,
    "Cloud Build requires every waitFor dependency to be declared before the dependent step"
  );
});

test("staging uses one v2 database connection and one migration job", async () => {
  await execFileAsync("bash", ["-n", "scripts/deploy-staging.sh"]);
  await execFileAsync("bash", ["-n", "scripts/serialize-cloud-build-deploy.sh"]);
  assert.match(stagingDeployment, /JINA_PRODUCT_DATABASE_MODE=shared/);
  assert.match(stagingDeployment, /migration_job="jina-v2-migrate-staging"/);
  assert.match(stagingDeployment, /--args=dist\/product\/migrate-all\.js,--install-roles/);
  assert.doesNotMatch(stagingDeployment, /JINA_PRODUCT_DATABASE_URL|jina-staging-database-url/);
  assert.doesNotMatch(stagingDeployment, /jina-product-migrate-staging|jina-context-migrate-staging/);
  assert.match(
    stagingDeployment,
    /services update-traffic "\$\{api_service\}"[\s\S]+?--to-revisions="\$\{api_release_revision\}=100"/
  );
  assert.match(
    stagingDeployment,
    /context_topics="run-context-input-snapshot\|run-context-page-plan\|run-context-page-build\|run-context-publication"/
  );
  assert.match(stagingDeployment, /--min-instances=3/);
  assert.match(stagingDeployment, /--max-instances=10/);
  assert.match(stagingDeployment, /--max-instances=5/);
  assert.match(stagingDeployment, /JINA_REVIEW_BOARD_PIPELINE_MODE=\$\{review_board_pipeline_mode\}/);
  assert.match(stagingDeployment, /DASHBOARD_AUTH_MODE=\$\{dashboard_auth_mode\}/);
  assert.match(stagingDeployment, /JINA_GITHUB_OAUTH_CLIENT_ID is required/);
  assert.match(stagingDeployment, /GITHUB_OAUTH_CLIENT_SECRET=\$\{github_oauth_client_secret\}:latest/);
  assert.match(stagingDeployment, /JINA_GRAPH_REQUEST_TIMEOUT_MS=30000/);
  assert.match(stagingCloudBuild, /JINA_REQUIRE_WORKER_RELEASE_GATE=true/);
  assert.match(stagingDeployment, /jina-staging-worker-release-credential/);
  assert.match(stagingDeployment, /activate-worker-release\.js/);
  assert.match(stagingDeployment, /JINA_WORKER_ACCEPTS_CLAIMS=\$\{accepts_claims\}/);
  assert.match(stagingDeployment, /JINA_WORKER_RELEASE_ID=\$\{release_id\}/);
  assert.match(
    stagingDeployment,
    /JINA_WORKER_RELEASE_CREDENTIAL=\$\{worker_release_credential_secret\}:\$\{release_secret_version\}/
  );
  assert.match(stagingDeployment, /--to-revisions="\$\{context_release_revision\}=100"/);
  assert.match(stagingDeployment, /--to-revisions="\$\{task_release_revision\}=100"/);
  assert.ok(
    stagingDeployment.indexOf('--to-revisions="${task_release_revision}=100"') <
      stagingDeployment.indexOf('--to-revisions="${api_release_revision}=100"'),
    "the gated API must move only after the credentialed workers"
  );
  const releaseSwitch = stagingDeployment.indexOf('main_release_mutation_started="true"');
  const closeClaims = stagingDeployment.indexOf("\n  false\n", releaseSwitch);
  const moveApi = stagingDeployment.indexOf('--to-revisions="${api_release_revision}=100"');
  const reopenClaims = stagingDeployment.indexOf("\n  true\n", moveApi);
  assert.ok(closeClaims >= 0 && closeClaims < moveApi, "claim admission must close before traffic moves");
  assert.ok(moveApi < reopenClaims, "claim admission must reopen only after API traffic moves");
  assert.match(stagingDeployment, /restore_main_release_control/);
  assert.match(stagingDeployment, /JINA_REVIEW_RUN_TOPIC_MODE=relational/);
  assert.match(stagingDeployment, /TRIGGER_SECRET_KEY=\$\{review_trigger_secret\}:latest/);
  assert.match(
    stagingDeployment,
    /GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY=\$\{github_webhook_inbox_encryption_secret\}:\$\{github_webhook_inbox_encryption_key_version\}/
  );
  assert.match(
    stagingDeployment,
    /JINA_PRODUCT_INTERNAL_API_TOKEN=\$\{product_internal_token_secret\}:\$\{product_internal_token_version\}/
  );
  assert.match(
    stagingDeployment,
    /gcloud secrets versions describe "\$\{product_internal_token_version\}"[\s\S]+?--secret="\$\{product_internal_token_secret\}"/
  );
  assert.doesNotMatch(stagingDeployment, /JINA_PRODUCT_INTERNAL_API_TOKEN=\$\{product_internal_token_secret\}:latest/);
  assert.match(stagingDeployment, /github_webhook_inbox_scheduler_job="jina-github-webhook-inbox-staging"/);
  assert.match(stagingDeployment, /--schedule="\* \* \* \* \*"/);
  assert.match(
    stagingDeployment,
    /inbox_scheduler_uri="https:\/\/api\.staging\.usejina\.com\/internal\/github-webhook-inbox\/process"/
  );
  assert.match(stagingDeployment, /--oidc-token-audience="\$\{scheduler_audience\}"/);
  assert.match(
    stagingDeployment,
    /scheduler_oidc_service_account="\$\{JINA_SCHEDULER_OIDC_SERVICE_ACCOUNT:-\$\{api_service_account\}\}"/
  );
  assert.match(stagingDeployment, /--remove-headers=Authorization/);
  assert.doesNotMatch(stagingDeployment, /Authorization=Bearer|product_internal_token=.*secrets versions access/);
  assert.doesNotMatch(stagingDeployment, /Relational run-review (?:is|remains) blocked/);
  assert.match(
    stagingDeployment,
    /review_topics="prepare-review\|summary-review\|runtime-review\|finalize-review\|publish-review\|settle-review\|run-review\|github-installation-backfill\|billing-retry"/
  );
  assert.match(
    stagingDeployment,
    /review_topics="prepare-review\|summary-review\|runtime-review\|finalize-review\|publish-review\|settle-review\|github-installation-backfill\|billing-retry"/
  );
  assert.doesNotMatch(stagingDeployment, /JINA_LEGACY_REVIEW_PIPELINE_ENABLED/);
  assert.doesNotMatch(deployment, /JINA_LEGACY_REVIEW_PIPELINE_ENABLED/);
  assert.match(deployment, /JINA_REVIEW_RUN_TOPIC_MODE=relational/);
  assert.doesNotMatch(deployment, /JINA_REVIEW_RUN_TOPIC_MODE=legacy/);
  assert.match(deployment, /JINA_PRODUCT_API_URL=\$\{product_api_url\}/);
  assert.match(deployment, /TRIGGER_API_URL=\$\{trigger_api_url\}/);
  assert.match(stagingDeployment, /deploy-staging-causal-graph\.sh/);
  assert.doesNotMatch(stagingDeployment, /gcloud services enable/);
  assert.match(stagingDeployment, /Cloud Scheduler API must be enabled as a staging platform prerequisite/);
  assert.match(stagingDeployment, /trap rollback_failed_staging_release EXIT/);
  assert.match(stagingDeployment, /restore_causal_release_control/);
  assert.match(stagingDeployment, /restore_revision "\$\{api_service\}" "\$\{previous_api_revision\}"/);
  assert.match(stagingDeployment, /restore_revision "\$\{context_worker_service\}" "\$\{previous_context_revision\}"/);
  assert.match(stagingDeployment, /restore_revision "\$\{task_worker_service\}" "\$\{previous_task_revision\}"/);
  assert.match(stagingDeployment, /restore_revision "\$\{causal_worker_service\}" "\$\{previous_causal_revision\}"/);
  for (const topic of LEGACY_TOPICS) assert.doesNotMatch(stagingDeployment, new RegExp(topic));
});

test("staging branch pushes deploy one immutable coordinated release", () => {
  assert.match(stagingCloudBuild, /id: serialize-deployment[\s\S]+?scripts\/serialize-cloud-build-deploy\.sh/);
  assert.match(stagingCloudBuild, /id: deploy-staging[\s\S]+?scripts\/deploy-staging\.sh/);
  assert.match(stagingCloudBuild, /IMAGE_TAG=staging-\$COMMIT_SHA/);
  assert.match(stagingCloudBuild, /JINA_CONTEXT_TENANT_ID=\$\{_JINA_CONTEXT_TENANT_ID\}/);
  assert.match(stagingCloudBuild, /JINA_REVIEW_BOARD_PIPELINE_MODE=v2/);
  assert.match(stagingCloudBuild, /JINA_DASHBOARD_AUTH_MODE=\$\{_JINA_DASHBOARD_AUTH_MODE\}/);
  assert.match(stagingCloudBuild, /JINA_GITHUB_OAUTH_CLIENT_ID=\$\{_JINA_GITHUB_OAUTH_CLIENT_ID\}/);
  assert.match(stagingCloudBuild, /JINA_GITHUB_WEBHOOK_INBOX_ENABLED=true/);
  assert.match(
    stagingCloudBuild,
    /GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION=\$\{_GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION\}/
  );
  assert.match(stagingCloudBuild, /JINA_PRODUCT_INTERNAL_TOKEN_VERSION=\$\{_JINA_PRODUCT_INTERNAL_TOKEN_VERSION\}/);
  assert.match(stagingCloudBuild, /_GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION: "1"/);
  assert.match(stagingCloudBuild, /_JINA_PRODUCT_INTERNAL_TOKEN_VERSION: "4"/);
  assert.match(stagingCloudBuild, /org\.opencontainers\.image\.revision=\$COMMIT_SHA/);
  assert.doesNotMatch(stagingCloudBuild, /_IMAGE_TAG|_SOURCE_SHA|dynamicSubstitutions/);
  assert.match(
    stagingCloudBuild,
    /serviceAccount: projects\/jina-staging-20260802\/serviceAccounts\/jina-cloud-build-staging@jina-staging-20260802\.iam\.gserviceaccount\.com/
  );
  assert.match(stagingSerialization, /build\.get\("buildTriggerId"\) == os\.environ\["TRIGGER_ID"\]/);
  assert.match(stagingSerialization, /build\.get\("createTime", ""\) < os\.environ\["CURRENT_CREATE_TIME"\]/);
  assert.match(stagingSerialization, /active = \{"QUEUED", "PENDING", "WORKING"\}/);
  assert.match(stagingSerialization, /json\.load\(sys\.stdin\)/);
  assert.doesNotMatch(stagingSerialization, /BUILDS_JSON=/);
  assert.match(deploymentDocs, /`jina-staging-deploy`/);
  assert.doesNotMatch(deploymentDocs, /\.github\/workflows\/deploy-staging\.yml/);
});

test("staging deployment serialization accepts build listings larger than the environment limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jina-staging-serialization-"));
  const executable = join(directory, "gcloud");
  await writeFile(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "builds describe" ]]; then
  printf 'trigger-staging 2026-08-06T19:00:00Z\\n'
  exit 0
fi
if [[ "$1 $2" == "builds list" ]]; then
  python3 -c 'import json; print(json.dumps([{"id":"quality-build","buildTriggerId":"trigger-staging","createTime":"2026-08-06T19:00:00Z","status":"WORKING","padding":"x" * 3000000}]))'
  exit 0
fi
exit 2
`
  );
  await chmod(executable, 0o755);
  try {
    const { stdout } = await execFileAsync("bash", ["scripts/serialize-cloud-build-deploy.sh"], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GCP_PROJECT_ID: "quality-project",
        GCP_CLOUD_BUILD_REGION: "us-east1",
        CLOUD_BUILD_ID: "quality-build"
      },
      maxBuffer: 10 * 1024 * 1024
    });
    assert.match(stdout, /owns the staging deployment lane/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production compute, images, artifacts, and shared database are co-located in us-east1", () => {
  assert.match(cloudBuild, /GCP_REGION=us-east1/);
  assert.match(cloudBuild, /us-east1-docker\.pkg\.dev\/\$PROJECT_ID\/jina\/api:\$BUILD_ID/);
  assert.match(cloudBuild, /_CLOUD_SQL_INSTANCE: jina-463721:us-east1:jina-db/);
  assert.match(
    cloudBuild,
    /JINA_CONTEXT_GCS_BUCKET=\$\{_JINA_CONTEXT_GCS_BUCKET\}[\s\S]+?_JINA_CONTEXT_GCS_BUCKET: jina-v2-jina-context-artifacts-us-east1/
  );
  assert.doesNotMatch(cloudBuild, /us-central1|US-CENTRAL1/);
});

test("production jobs execute the image-baked preflight without an oversized environment variable", () => {
  for (const dockerfile of [apiDockerfile, workerDockerfile]) {
    assert.match(
      dockerfile,
      /COPY --chown=node:node scripts\/context-production-preflight\.mjs \/opt\/jina\/context-production-preflight\.mjs/
    );
  }
  assert.match(
    workerDockerfile,
    /COPY --chown=node:node scripts\/context-production-trigger-e2e\.mjs \/opt\/jina\/context-production-trigger-e2e\.mjs/
  );
  assert.match(deployment, /production_preflight_path="\/opt\/jina\/context-production-preflight\.mjs"/);
  assert.doesNotMatch(deployment, /JINA_PREFLIGHT_SOURCE_B64|preflight_program_b64|Buffer\.from\(.*base64/);
  for (const action of ["daytona", "release-acquire", "schema-reset"]) {
    assert.ok(deployment.includes(`--args="\${production_preflight_path},${action}"`), action);
  }
});

test("candidate revisions pass full acceptance before production traffic changes", () => {
  const acceptance = deployment.indexOf("gcloud run jobs execute jina-acceptance");
  const cutover = deployment.indexOf('cutover_started="true"');
  assert.ok(acceptance > 0);
  assert.ok(cutover > acceptance);
  assert.match(deployment, /--no-traffic/);
  assert.match(deployment, /--tag="\$\{release_tag\}"/);
  assert.match(deployment, /--revision-suffix="\$\{release_suffix\}"/);
  assert.match(deployment, /candidate_service_url "jina-api"/);
  assert.match(deployment, /route_candidate_revision "\$\{service\}"/);
  assert.match(
    deployment,
    /route_candidate_revision\(\)[\s\S]+?--set-tags="\$\{release_tag\}=\$\{revision\}"[\s\S]+?--to-revisions="\$\{revision\}=100"/
  );
  assert.doesNotMatch(deployment, /route_latest_revision/);
});

test("deferred deployment is the non-routing default and explicit acceptance modes remain available", () => {
  assert.match(cloudBuild, /JINA_DEPLOYMENT_ACCEPTANCE_MODE=\$\{_JINA_DEPLOYMENT_ACCEPTANCE_MODE\}/);
  assert.match(cloudBuild, /_JINA_DEPLOYMENT_ACCEPTANCE_MODE: deferred/);
  assert.match(deployment, /deployment_acceptance_mode="\$\{JINA_DEPLOYMENT_ACCEPTANCE_MODE:-deferred\}"/);
  assert.match(deployment, /JINA_DEPLOYMENT_ACCEPTANCE_MODE must be full, mechanical, or deferred/);
  assert.match(
    deployment,
    /if \[\[ "\$\{deployment_acceptance_mode\}" == "full" \]\]; then[\s\S]+?gcloud run jobs execute jina-acceptance[\s\S]+?else[\s\S]+?deployment mode: candidate readiness passed/
  );
  assert.equal(deployment.match(/gcloud run jobs execute jina-context-daytona-preflight/g)?.length, 1);
  assert.ok(
    deployment.indexOf("gcloud run jobs execute jina-context-daytona-preflight") <
      deployment.indexOf('if [[ "${deployment_acceptance_mode}" == "full" ]]')
  );
  const deferredGate = deployment.indexOf('if [[ "${deployment_acceptance_mode}" == "deferred" ]]');
  const rollbackTrap = deployment.indexOf("trap rollback_failed_release EXIT");
  const firstCloudMutation = deployment.indexOf("gcloud run jobs deploy jina-context-daytona-preflight", deferredGate);
  assert.ok(deferredGate > 0);
  assert.ok(rollbackTrap > deferredGate, "mutation-capable cleanup must not be armed during deferred preflight");
  assert.ok(firstCloudMutation > deferredGate);
  assert.ok(firstCloudMutation > rollbackTrap);
  assert.match(
    deployment.slice(deferredGate, firstCloudMutation),
    /Deferred deployment complete: immutable images verified; production state and traffic unchanged[\s\S]+?exit 0/
  );
});

test("explicit production acceptance reuses the deferred build's source-bound images", () => {
  assert.match(cloudBuild, /id: validate-image-selection[\s\S]+?org\.opencontainers\.image\.revision/);
  assert.match(cloudBuild, /test "\$\$\{revision\}" = "\$COMMIT_SHA"/);
  assert.match(cloudBuild, /test "\$\$\{source\}" = "https:\/\/github\.com\/omxyz\/jina"/);
  assert.match(cloudBuild, /IMAGE_TAG=\$\{_JINA_EXISTING_IMAGE_TAG\}/);
  assert.match(cloudBuild, /JINA_REUSE_EXISTING_IMAGE_TAG=\$\{_JINA_REUSE_EXISTING_IMAGE_TAG\}/);
  assert.match(cloudBuild, /_JINA_EXISTING_IMAGE_TAG: ""/);
  assert.match(cloudBuild, /_JINA_REUSE_EXISTING_IMAGE_TAG: "false"/);
  assert.match(deployment, /A non-current IMAGE_TAG requires JINA_REUSE_EXISTING_IMAGE_TAG=true/);
  assert.match(deployment, /JINA_REUSE_EXISTING_IMAGE_TAG=true requires a prior IMAGE_TAG/);
});

test("the private coordinated API cannot be mistaken for the public GitHub-auth API", () => {
  assert.match(deployment, /api_env_vars="[^\n]+DASHBOARD_AUTH_MODE=disabled/);
  const privateApiSecrets = deployment.match(/api_secrets="([^"]+)"/)?.[1] ?? "";
  assert.doesNotMatch(privateApiSecrets, /GITHUB_OAUTH_CLIENT_SECRET|GITHUB_APP_PRIVATE_KEY|SECRETS_ENCRYPTION_KEY/);
  assert.match(cloudBuild, /_JINA_PUBLIC_API_BASE_URL: https:\/\/api\.usejina\.com/);
  assert.match(cloudBuild, /_JINA_DASHBOARD_AUTH_MODE: github/);
  assert.match(publicApiCandidateDeployment, /service: "jina-code-review-api"/);
  assert.match(publicApiCandidateDeployment, /project: "jina-463721"/);
  for (const contract of [
    /API_BASE_URL: "https:\/\/api\.usejina\.com"/,
    /SUPPORTED_DASHBOARD_AUTH_MODES[^\n]+"github"[^\n]+"clerk"/,
    /DASHBOARD_URL: "https:\/\/app\.usejina\.com"/,
    /DASHBOARD_COOKIE_SAMESITE: "None"/,
    /DASHBOARD_COOKIE_SECURE: "true"/,
    /"GITHUB_OAUTH_CLIENT_SECRET"/
  ]) {
    assert.match(publicApiCandidateDeployment, contract);
  }
});

test("the polling Context pool keeps one executor warm unless a release opts into more", () => {
  assert.match(cloudBuild, /_JINA_CONTEXT_WORKER_MIN_INSTANCES: "1"/);
  assert.match(cloudBuild, /_JINA_CONTEXT_WORKER_MAX_INSTANCES: "100"/);
  assert.match(deployment, /context_worker_min_instances="\$\{JINA_CONTEXT_WORKER_MIN_INSTANCES:-1\}"/);
  assert.match(deployment, /--min-instances="\$\{context_worker_min_instances\}"/);
  assert.match(deployment, /CONTEXT_GIT_COMMAND_TIMEOUT_MS=300000/);
});

test("production long-lived services use only numeric Secret Manager versions", () => {
  assert.doesNotMatch(deployment, /:latest/);
  assert.doesNotMatch(cloudBuild, /:latest/);
  assert.doesNotMatch(causalDeployment, /:latest/);
  assert.doesNotMatch(causalCloudBuild, /:latest/);
  assert.match(deployment, /validate_numeric_secret_ref "JINA_DB_PASS_SECRET" "\$\{db_pass_secret\}"/);
  assert.match(
    deployment,
    /validate_numeric_secret_ref "JINA_MIGRATION_DB_PASS_SECRET" "\$\{migration_db_pass_secret\}"/
  );
  for (const substitution of [
    "_JINA_GITHUB_WEBHOOK_SECRET_VERSION",
    "_JINA_INTERNAL_API_TOKEN_SECRET_VERSION",
    "_JINA_PRODUCT_INTERNAL_API_TOKEN_SECRET_VERSION",
    "_JINA_CONTEXT_API_TOKEN_SECRET_VERSION",
    "_JINA_CONTEXT_PRIVATE_CHECKPOINT_KEY_SECRET_VERSION",
    "_JINA_REVIEW_TRIGGER_SECRET_VERSION",
    "_JINA_DAYTONA_API_KEY_SECRET_VERSION",
    "_JINA_GITHUB_APP_ID_SECRET_VERSION",
    "_JINA_GITHUB_APP_PRIVATE_KEY_SECRET_VERSION",
    "_JINA_OPENAI_API_KEY_SECRET_VERSION",
    "_JINA_GITHUB_CLONE_TOKEN_SECRET_VERSION",
    "_JINA_WEB_AUTH_PASSWORD_SECRET_VERSION"
  ]) {
    assert.match(cloudBuild, new RegExp(`${substitution}: "[1-9][0-9]*"`));
  }
  assert.match(causalDeployment, /JINA_MIGRATION_DB_PASS_SECRET must use an explicit numeric version/);
  assert.match(
    causalDeployment,
    /gcloud secrets versions describe "\$\{secret_version\}"[\s\S]+?state=\$\{secret_state:-unknown\}/
  );
  assert.match(causalCloudBuild, /_CLOUD_SQL_INSTANCE: jina-463721:us-east1:jina-db/);
  assert.match(causalCloudBuild, /_JINA_DB_USER: jina_v2_app/);
  for (const substitution of [
    "_JINA_INTERNAL_API_TOKEN_SECRET_VERSION",
    "_JINA_PRODUCT_INTERNAL_API_TOKEN_SECRET_VERSION",
    "_JINA_DAYTONA_API_KEY_SECRET_VERSION",
    "_JINA_OPENAI_API_KEY_SECRET_VERSION",
    "_JINA_GITHUB_APP_ID_SECRET_VERSION",
    "_JINA_GITHUB_APP_PRIVATE_KEY_SECRET_VERSION",
    "_JINA_GITHUB_CLONE_TOKEN_SECRET_VERSION"
  ]) {
    assert.match(causalCloudBuild, new RegExp(`${substitution}: "[1-9][0-9]*"`));
  }
  assert.match(deployment, /gcloud secrets versions access \{upstream_version\} --secret=\{upstream_secret\}/);
});

test("production run-review workers retain relational Trigger dispatch and exact credentials", () => {
  const taskDeployments = [
    ...deployment.matchAll(/gcloud run deploy jina-task-worker[\s\S]+?wait_for_candidate_revision "jina-task-worker"/g)
  ].map((match) => match[0]);

  assert.equal(taskDeployments.length, 2);
  for (const taskDeployment of taskDeployments) {
    assert.match(taskDeployment, /--set-env-vars="\$\(task_worker_environment /);
    assert.match(
      taskDeployment,
      /JINA_PRODUCT_INTERNAL_API_TOKEN=\$\{product_internal_token_secret\}:\$\{product_internal_token_secret_version\}/
    );
    assert.match(taskDeployment, /TRIGGER_SECRET_KEY=\$\{review_trigger_secret\}:\$\{review_trigger_secret_version\}/);
  }
  assert.match(cloudBuild, /_JINA_PRODUCT_API_URL: https:\/\/api\.usejina\.com/);
  assert.match(
    deployment,
    /"\$\{review_trigger_secret\}:\$\{review_trigger_secret_version\}"[\s\S]+?require_secret "\$\{secret_spec\}"/
  );
});

test("Context lease expiry stays bounded relative to the worker heartbeat", () => {
  const leaseMinutes = Number(/DEFAULT_CONTEXT_WORKER_LEASE_MS = (\d+) \* 60 \* 1000/.exec(apiServer)?.[1]);
  const heartbeatMs = Number(
    /heartbeatIntervalMs = positiveInt\(process\.env\.WORKER_HEARTBEAT_INTERVAL_MS, ([\d_]+)\)/
      .exec(workerServer)?.[1]
      ?.replaceAll("_", "")
  );
  assert.equal(leaseMinutes, 5);
  assert.equal(heartbeatMs, 60_000);
  assert.ok(leaseMinutes * 60_000 >= heartbeatMs * 3, "the lease must tolerate multiple missed renewals");
  assert.ok(leaseMinutes * 60_000 <= heartbeatMs * 5, "hard-failure recovery must remain within five heartbeats");
});

test("background workers are quiesced and Board leases are proven empty before schema mutation", () => {
  const daytona = deployment.indexOf("gcloud run jobs execute jina-context-daytona-preflight");
  const drainAdmission = deployment.indexOf('run_release_control "worker-drain"', daytona);
  const awaitDrain = deployment.indexOf('run_release_control "board-await-drain"', drainAdmission);
  const quiescence = deployment.indexOf('worker_quiescence_started="true"', awaitDrain);
  const preFenceVerify = deployment.indexOf('run_release_control "board-verify"', quiescence);
  const contextDrain = deployment.indexOf(
    'route_paused_worker_and_delete_prior_revisions "jina-context-worker"',
    quiescence
  );
  const taskDrain = deployment.indexOf(
    'route_paused_worker_and_delete_prior_revisions "jina-task-worker"',
    contextDrain
  );
  const boardVerify = deployment.indexOf('run_release_control "board-verify"', taskDrain);
  const migration = deployment.indexOf("gcloud run jobs execute jina-context-migrate", boardVerify);

  assert.ok(daytona > 0);
  assert.ok(drainAdmission > daytona);
  assert.ok(awaitDrain > drainAdmission);
  assert.ok(quiescence > awaitDrain);
  assert.ok(preFenceVerify > quiescence);
  assert.ok(contextDrain > quiescence);
  assert.ok(taskDrain > contextDrain);
  assert.ok(boardVerify > taskDrain);
  assert.ok(migration > boardVerify);
  assert.match(deployment, /JINA_WORKER_CLAIM_MODE=\$\{claim_mode\}/);
  assert.equal(deployment.match(/--scaling=auto/g)?.length, 4);
  assert.match(deployment, /--clear-tags[\s\S]+?--to-revisions="\$\{drain_revision\}=100"/);
  assert.match(deployment, /gcloud run revisions delete "\$\{revision\}"[\s\S]+?--no-async/);
  assert.match(deployment, /wait_for_exact_worker_revisions "\$\{service\}" "\$\{drain_revision\}"/);
});

test("a failed graceful drain reopens claim admission without replacing the serving workers", () => {
  const trap = deployment.indexOf("rollback_failed_release()");
  const drainFailure = deployment.indexOf('worker_drain_started}" == "true"', trap);
  const resume = deployment.indexOf('run_release_control "worker-resume"', drainFailure);
  const forcedDrain = deployment.indexOf('route_paused_worker \\\n      "jina-context-worker"', resume);
  assert.ok(drainFailure > trap);
  assert.ok(resume > drainFailure);
  assert.ok(forcedDrain > resume);
  assert.match(productionPreflight, /action === "worker-drain"/);
  assert.match(productionPreflight, /action === "worker-resume"/);
  assert.doesNotMatch(productionPreflight, /cannot (?:drain|resume) an inactive worker generation/);
  assert.match(
    productionPreflight,
    /action === "worker-resume"[\s\S]+?if \(row\?\.worker_claims_enabled\)[\s\S]+?worker_accepts_claims=true/
  );
  assert.match(productionPreflight, /command === "board-await-drain"/);
  assert.match(productionPreflight, /release_control\.board_drain_wait/);
  assert.match(productionPreflight, /release_control\.board_drained_and_worker_paused/);
  assert.match(productionPreflight, /cannot pause worker generation with \$\{leases\.length\} active Board leases/);
  assert.match(deployment, /JINA_WORKER_DRAIN_TIMEOUT_SECONDS:-1800/);
  assert.match(deployment, /release_control_task_timeout_seconds=\$\(\(worker_drain_timeout_seconds \+ 600\)\)/);
  assert.match(deployment, /--task-timeout="\$\{release_control_task_timeout_seconds\}s"/);
});

test("candidate traffic tags are short and validated against each live Cloud Run service identifier", () => {
  assert.match(deployment, /short_release_id=.*cut -c1-16/);
  assert.match(deployment, /release_tag="c-\$\{short_release_id\}"/);
  assert.match(deployment, /tagged_label="\$\{release_tag\}---\$\{first_label\}"/);
  assert.match(deployment, /if \(\( \$\{#tagged_label\} > 63 \)\)/);
  const validation = deployment.indexOf(
    "for service in jina-api jina-context-worker jina-task-worker jina-dashboard jina-admin"
  );
  const credentialVersion = deployment.indexOf("gcloud secrets versions add", validation);
  assert.ok(validation > 0);
  assert.ok(credentialVersion > validation);
});

test("coordinated releases hold one renewable durable lease and reject overlap before worker mutation", () => {
  const acquire = deployment.indexOf('run_release_control "release-acquire"');
  const renewal = deployment.indexOf("start_release_renewal", acquire);
  const backup = deployment.indexOf("gcloud sql backups create", acquire);
  const quiescence = deployment.indexOf('worker_quiescence_started="true"', acquire);
  const release = deployment.indexOf('run_release_control "release-release"', quiescence);
  assert.ok(acquire > 0);
  assert.ok(renewal > acquire);
  assert.ok(backup > renewal);
  assert.ok(quiescence > backup);
  assert.ok(release > quiescence);
  assert.doesNotMatch(deployment, /BASHPID/);
  assert.match(
    productionPreflight,
    /coordinated release \$\{row\.lease_release_id\} already holds the deployment lease/
  );
  assert.match(productionPreflight, /lease_expires_at=clock_timestamp\(\)\+\(\$1::text \|\| ' seconds'\)::interval/);
  assert.match(productionPreflight, /pg_advisory_xact_lock\(hashtext\('jina_runtime\.release_control'\)\)/);
  assert.match(productionPreflight, /event: "release_control\.lock_retry"/);
  assert.match(productionPreflight, /error\?\.code !== "55P03"/);
  assert.match(productionPreflight, /action === "release-renew" \? 3 : 12/);
  assert.match(productionPreflight, /revoke insert,update on jina_runtime\.api_state/);
  assert.match(productionPreflight, /grant select,insert,update on jina_runtime\.api_state/);
  assert.match(apiServer, /DEFAULT_CONTEXT_WORKER_LEASE_MS = 5 \* 60 \* 1000/);
  assert.match(deployment, /JINA_CONTEXT_WORKER_LEASE_MS:-300000/);
  assert.match(deployment, /JINA_CONTEXT_WORKER_MAX_INSTANCES:-100/);
  assert.equal(deployment.match(/--max="\$\{context_worker_max_instances\}"/g)?.length, 2);
  assert.equal(deployment.match(/--min="\$\{context_worker_min_instances\}"/g)?.length, 2);
  assert.equal(deployment.match(/--max-instances="\$\{context_worker_max_instances\}"/g)?.length, 2);
  assert.match(deployment, /JINA_TASK_WORKER_MAX_INSTANCES:-5/);
  assert.equal(deployment.match(/--max="\$\{task_worker_max_instances\}"/g)?.length, 2);
  assert.equal(deployment.match(/--min=1/g)?.length, 2);
  assert.equal(deployment.match(/--max-instances="\$\{task_worker_max_instances\}"/g)?.length, 2);
  assert.match(deployment, /WORKER_HEARTBEAT_INTERVAL_MS=\$\{context_worker_heartbeat_interval_ms\}/);
  assert.match(deployment, /must cover at least three worker heartbeat intervals/);
});

test("schema preflight and exact post-migration checks run under the release lease", () => {
  const acquire = deployment.indexOf('run_release_control "release-acquire"');
  const firstSchema = deployment.indexOf('run_release_control "schema-preflight"', acquire);
  const backup = deployment.indexOf("gcloud sql backups create", firstSchema);
  const quiescence = deployment.indexOf('worker_quiescence_started="true"', backup);
  const secondSchema = deployment.indexOf('run_release_control "schema-preflight"', quiescence);
  const migration = deployment.indexOf("gcloud run jobs deploy jina-context-migrate", secondSchema);
  const exactSchema = deployment.indexOf('run_release_control "schema-inspect"', migration);
  const api = deployment.indexOf("gcloud run deploy jina-api", exactSchema);
  assert.ok(firstSchema > acquire);
  assert.ok(backup > firstSchema);
  assert.ok(quiescence > backup);
  assert.ok(secondSchema > quiescence);
  assert.ok(migration > secondSchema);
  assert.ok(exactSchema > migration);
  assert.ok(api > exactSchema);
  assert.match(productionPreflight, /await assertDeploymentLease\(client\);[\s\S]+?await inspectSchemaDatabase/);
});

test("production uses the exact API image to apply runtime and product migrations together", () => {
  const migrationDeployment = deployment.match(
    /gcloud run jobs deploy jina-context-migrate[\s\S]+?gcloud run jobs execute jina-context-migrate/
  )?.[0];
  assert.ok(migrationDeployment);
  assert.match(migrationDeployment, /--image="\$\{api_image\}"/);
  assert.match(migrationDeployment, /--args=dist\/product\/migrate-all\.js,--install-roles/);
  assert.doesNotMatch(migrationDeployment, /node_modules\/@jina\/db\/dist\/migrate\.js/);
  assert.match(apiDockerfile, /test -f \/out\/dist\/product\/migrate-all\.js/);
  assert.match(apiDockerfile, /test -f \/out\/product-migrations\/0031_github_webhook_inbox\.sql/);
});

test("owner migration and destructive reset are bound to the live coordinated deployment lease", () => {
  const migrationDeployment = deployment.match(
    /gcloud run jobs deploy jina-context-migrate[\s\S]+?gcloud run jobs execute jina-context-migrate/
  )?.[0];
  const resetDeployment = deployment.match(
    /gcloud run jobs deploy jina-context-legacy-reset[\s\S]+?gcloud run jobs execute jina-context-legacy-reset/
  )?.[0];
  assert.ok(migrationDeployment);
  assert.ok(resetDeployment);
  for (const job of [migrationDeployment, resetDeployment]) {
    assert.match(job, /JINA_WORKER_RELEASE_ID=\$\{CLOUD_BUILD_ID\}/);
    assert.match(
      job,
      /JINA_WORKER_RELEASE_CREDENTIAL=\$\{worker_release_secret\}:\$\{deployment_release_secret_version\}/
    );
  }
  assert.match(databaseMigration, /applySchema\(pool, "jina_runtime\.schema", JINA_RUNTIME_SCHEMA_SQL\)/);
  assert.match(databaseMigration, /pg_advisory_lock\(hashtext\('jina_runtime\.api_state'\)\)/);
  assert.match(databaseMigration, /lease_credential_sha256=\$2/);
  assert.match(databaseMigration, /lease_expires_at > clock_timestamp\(\)/);
  assert.match(productionPreflight, /assertDeploymentLease\(client, true\)/);
  assert.match(productionPreflight, /if \(action !== "release-renew"\)/);
});

test("failed unaccepted candidates are paused, fenced, and independently verified before lease release", () => {
  const trap = deployment.indexOf("rollback_failed_release()");
  const stopClaims = deployment.indexOf('run_release_control "worker-drain"', trap);
  const awaitDrain = deployment.indexOf('run_release_control "board-await-drain"', stopClaims);
  const verify = deployment.indexOf('run_release_control "board-verify"', awaitDrain);
  const contextDrain = deployment.indexOf('route_paused_worker \\\n      "jina-context-worker"', verify);
  const taskDrain = deployment.indexOf('route_paused_worker \\\n      "jina-task-worker"', contextDrain);
  const destroyGeneration = deployment.indexOf("destroy_worker_release_credential_verified", verify);
  const restoreApiWrites = deployment.indexOf('run_release_control "runtime-write-enable"', destroyGeneration);
  const stopRenewal = deployment.indexOf("stop_release_renewal", restoreApiWrites);
  const release = deployment.indexOf('run_release_control "release-release"', stopRenewal);
  assert.ok(stopClaims > trap);
  assert.ok(awaitDrain > stopClaims);
  assert.ok(verify > awaitDrain);
  assert.ok(contextDrain > verify);
  assert.ok(taskDrain > contextDrain);
  assert.ok(destroyGeneration > taskDrain);
  assert.ok(restoreApiWrites > destroyGeneration);
  assert.ok(stopRenewal > restoreApiWrites);
  assert.ok(release > stopRenewal);
  assert.match(productionPreflight, /action === "runtime-write-enable"/);
  assert.match(
    deployment,
    /"destroy unaccepted worker credential" destroy_worker_release_credential_verified[\s\S]+?extend_release_lease_for_repair \|\| true[\s\S]+?stop_release_renewal/
  );
  assert.match(deployment, /Failed-release cleanup \$\{description\}: attempt \$\{attempt\}/);
  assert.match(deployment, /worker_generation_invalidated="true"/);
  assert.match(
    deployment,
    /A failed candidate is the latest-created Cloud Run revision and cannot be[\s\S]+?generation[\s\S]+?credential is destroyed/
  );
  assert.match(deployment, /paused worker traffic mismatch/);
});

test("release and worker credentials are independent and only the worker digest enters the generation gate", () => {
  assert.match(deployment, /deployment_release_credential=.*secrets\.token_urlsafe/);
  assert.match(deployment, /worker_release_credential=.*secrets\.token_urlsafe/);
  assert.match(deployment, /JINA_WORKER_GENERATION_CREDENTIAL_SHA256=\$\{worker_release_credential_sha256\}/);
  assert.match(productionPreflight, /const workerCredentialSha256 = requiredWorkerGenerationCredentialSha256\(\)/);
  assert.match(productionPreflight, /\[release\.releaseId, workerCredentialSha256, contextRevision, taskRevision\]/);
  assert.match(
    deployment,
    /JINA_WORKER_RELEASE_CREDENTIAL=\$\{worker_release_secret\}:\$\{worker_release_secret_version\}/
  );
});

test("accepted cutover cleanup is verified and cannot invoke candidate rollback", () => {
  const release = deployment.lastIndexOf('run_release_control "release-release"');
  const accepted = deployment.indexOf('accepted_cutover_complete="true"', release);
  const destroyControl = deployment.indexOf("destroy_deployment_release_credential_verified", accepted);
  const deleteJob = deployment.indexOf("delete_release_control_job_verified", destroyControl);
  assert.ok(release > 0);
  assert.ok(accepted > release);
  assert.ok(destroyControl > accepted);
  assert.ok(deleteJob > destroyControl);
  assert.match(
    deployment,
    /if \[\[ "\$\{status\}" -ne 0 && "\$\{accepted_cutover_complete\}" == "true" \]\]; then[\s\S]+?report_accepted_release_failure/
  );
  assert.match(
    deployment,
    /if \[\[ "\$\{post_cutover_cleanup_complete\}" == "true" \]\]; then[\s\S]+?no release-control cleanup or traffic rollback is required/
  );
  assert.match(
    deployment,
    /accepted_release_control_credential_destroyed[\s\S]+?Destroy release-control credential version/
  );
  assert.match(deployment, /accepted_release_control_job_deleted[\s\S]+?Remove release-control job/);
  assert.match(releaseCleanupLibrary, /for \(\(attempt = 1; attempt <= release_cleanup_attempts; attempt \+= 1\)\)/);
  assert.match(releaseCleanupLibrary, /gcloud run jobs list[\s\S]+?metadata\.name=\$\{release_control_job\}/);
  assert.match(releaseCleanupLibrary, /\[\[ "\$\{state\}" == "DESTROYED" \]\]/);
});

test("cleanup helpers retry transient fake-gcloud failures and verify final absence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jina-release-cleanup-"));
  const executable = join(directory, "gcloud");
  const stateDirectory = join(directory, "state");
  await writeFile(
    executable,
    `#!/usr/bin/env bash
set -eu
command="$1 $2 $3"
if [[ "\${command}" == "run jobs delete" ]]; then
  count_file="\${FAKE_STATE}/job-delete-count"
  count=0
  [[ ! -f "\${count_file}" ]] || count="$(cat "\${count_file}")"
  count=$((count + 1))
  printf '%s' "\${count}" >"\${count_file}"
  if (( count == 1 )); then exit 1; fi
  rm -f "\${FAKE_STATE}/job"
  exit 0
fi
if [[ "\${command}" == "run jobs list" ]]; then
  [[ ! -f "\${FAKE_STATE}/job" ]] || printf '%s\\n' "jina-context-release-test"
  exit 0
fi
if [[ "\${command}" == "secrets versions destroy" ]]; then
  count_file="\${FAKE_STATE}/secret-destroy-count"
  count=0
  [[ ! -f "\${count_file}" ]] || count="$(cat "\${count_file}")"
  count=$((count + 1))
  printf '%s' "\${count}" >"\${count_file}"
  if (( count == 1 )); then exit 1; fi
  printf '%s' "DESTROYED" >"\${FAKE_STATE}/secret-state"
  exit 0
fi
if [[ "\${command}" == "secrets versions describe" ]]; then
  cat "\${FAKE_STATE}/secret-state"
  exit 0
fi
exit 97
`
  );
  await chmod(executable, 0o755);
  await execFileAsync("mkdir", ["-p", stateDirectory]);
  await writeFile(join(stateDirectory, "job"), "present");
  await writeFile(join(stateDirectory, "secret-state"), "ENABLED");
  try {
    await execFileAsync(
      "bash",
      [
        "-c",
        'source scripts/cloud-release-cleanup-lib.sh; delete_release_control_job_verified; destroy_release_secret_version_verified 7 "test credential"'
      ],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          FAKE_STATE: stateDirectory,
          GCP_PROJECT_ID: "quality-project",
          GCP_REGION: "us-east1",
          release_control_job: "jina-context-release-test",
          worker_release_secret: "jina-worker-release-credential",
          JINA_RELEASE_CLEANUP_RETRY_SECONDS: "0"
        }
      }
    );
    assert.equal(await readFile(join(stateDirectory, "job-delete-count"), "utf8"), "2");
    assert.equal(await readFile(join(stateDirectory, "secret-destroy-count"), "utf8"), "2");
    assert.equal(await readFile(join(stateDirectory, "secret-state"), "utf8"), "DESTROYED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("secret cleanup fails closed when fake gcloud never verifies destruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jina-release-cleanup-fail-"));
  const executable = join(directory, "gcloud");
  await writeFile(
    executable,
    `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "secrets versions describe" ]]; then printf '%s\\n' ENABLED; exit 0; fi
exit 1
`
  );
  await chmod(executable, 0o755);
  try {
    await assert.rejects(
      execFileAsync(
        "bash",
        [
          "-c",
          'source scripts/cloud-release-cleanup-lib.sh; destroy_release_secret_version_verified 9 "test credential"'
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GCP_PROJECT_ID: "quality-project",
            GCP_REGION: "us-east1",
            worker_release_secret: "jina-worker-release-credential",
            JINA_RELEASE_CLEANUP_ATTEMPTS: "2",
            JINA_RELEASE_CLEANUP_RETRY_SECONDS: "0"
          }
        }
      ),
      /was not verified DESTROYED after 2 attempts/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production preflight fences the exact durable Board leases and independently verifies zero", () => {
  assert.match(productionPreflight, /command === "board-drain"/);
  assert.match(productionPreflight, /command === "board-verify"/);
  assert.match(productionPreflight, /select pg_advisory_xact_lock\(hashtext\('jina_runtime\.api_state'\)\)/);
  assert.match(productionPreflight, /select snapshot from jina_runtime\.api_state where id=1 for update/);
  assert.match(productionPreflight, /fenceBoardSnapshot\(snapshot, board\.fenceOutboxLeases/);
  assert.match(productionPreflight, /set snapshot=\$1::jsonb,version=version\+1,updated_at=clock_timestamp\(\)/);
  assert.match(productionPreflight, /Board drain did not fence exactly the active lease inventory/);
  assert.match(productionPreflight, /Board has \$\{leases\.length\} active leases after worker drain/);
  assert.match(productionPreflight, /assertPageOrientedContextCutover\(snapshot\)/);
  assert.match(productionPreflight, /contextWorkflowContract !== "page-oriented"/);
  assert.match(productionPreflight, /LEGACY_CONTEXT_OUTBOX_TOPICS\.has\(message\.topic\)/);
});

test("acceptance can be claimed only by the exact coordinated candidate worker revisions", () => {
  const isolation = deployment.indexOf("verify_candidate_worker_isolation \\");
  const acceptance = deployment.indexOf("gcloud run jobs execute jina-acceptance");
  const cutover = deployment.indexOf('cutover_started="true"');
  const drainCleanup = deployment.indexOf('gcloud run revisions delete "${context_drain_revision}"', cutover);

  assert.ok(isolation > 0);
  assert.ok(acceptance > isolation);
  assert.ok(cutover > acceptance);
  assert.ok(drainCleanup > cutover);
  assert.match(deployment, /EXPECTED_IMAGE="\$\{worker_image\}"/);
  assert.match(deployment, /candidate_env\.get\("JINA_WORKER_CLAIM_MODE"\) != "enabled"/);
  assert.match(deployment, /drain_env\.get\("JINA_WORKER_CLAIM_MODE"\) != "paused"/);
  assert.match(deployment, /candidate_env\.get\("JINA_API_URL"\) != expected_api_url/);
  assert.match(deployment, /candidate_env\.get\("JINA_WORKER_RELEASE_ID"\) != expected_release_id/);
  assert.match(apiServer, /requireWorkerReleaseGate/);
  assert.match(apiServer, /workerReleaseCredential/);
  assert.match(workerServer, /workerReleaseRequestBody/);
  assert.match(postgresStateStore, /from jina_runtime\.release_control/);
  assert.match(postgresStateStore, /worker_claims_enabled/);
  assert.match(
    deployment,
    /wait_for_exact_worker_revisions "jina-context-worker" "jina-context-worker-\$\{release_suffix\}"/
  );
  assert.match(deploymentDocs, /Prior\s+worker revisions are not rollback candidates/);
});

test("deployment verifies a primary backup before migration and one-time reset", () => {
  const lookup = deployment.indexOf("gcloud sql backups list");
  const backup = deployment.indexOf("gcloud sql backups create", lookup);
  const status = deployment.indexOf('context_backup_status="$(gcloud sql backups describe');
  const migration = deployment.indexOf("gcloud run jobs deploy jina-context-migrate");
  const reset = deployment.indexOf("gcloud run jobs deploy jina-context-legacy-reset");
  assert.ok(lookup > 0);
  assert.ok(backup > lookup);
  assert.ok(status > backup);
  assert.ok(migration > status);
  assert.ok(reset > migration);
  assert.match(deployment, /if \[\[ -z "\$\{context_backup_id\}" \]\]; then/);
  assert.match(deployment, /--filter="description=\$\{backup_description\}"/);
  assert.match(deployment, /JINA_CONTEXT_RESET_BACKUP_ID=\$\{context_backup_id\}/);
  assert.match(deployment, /context_backup_status.*SUCCESSFUL/s);
  assert.match(deployment, /roles\/jinaContextBackupOperator binding/);
});

test("one-time production reset is schema-exact and preserves the generic task board", () => {
  assert.match(productionPreflight, /assertExactSet\(tables, legacy, "one-time legacy Context schema"\)/);
  assert.match(productionPreflight, /assertPreservedShapes/);
  assert.match(productionPreflight, /preservedDigests/);
  assert.match(productionPreflight, /drop table \$\{LEGACY_CONTEXT_TABLES/);
  assert.doesNotMatch(productionPreflight, /drop table[^;]*cascade/i);
  assert.doesNotMatch(productionPreflight, /truncate[^;]*jina_runtime\.api_state/i);
  assert.doesNotMatch(productionPreflight, /delete[^;]*jina_runtime\.api_state/i);
  assert.match(cloudBuild, /_JINA_CONTEXT_RESET_MODE: disabled[\s\S]+?_JINA_CONFIRM_CONTEXT_RESET: ""/);
});

test("artifact bucket is a precreated least-privilege platform prerequisite", () => {
  const prerequisite = deployment.indexOf("require_artifact_bucket_prerequisites");
  const backup = deployment.indexOf("gcloud sql backups create");
  assert.ok(prerequisite > 0);
  assert.ok(backup > prerequisite);
  assert.match(deployment, /the deployment will not create it/);
  assert.match(deployment, /unconditional bucket-scoped roles\/storage\.admin binding/);
  assert.match(deployment, /public IAM principals are forbidden/);
  assert.doesNotMatch(deployment, /gcloud storage buckets create/);
  assert.doesNotMatch(deployment, /gcloud storage buckets update/);
  assert.doesNotMatch(deployment, /--lifecycle-file/);
  assert.doesNotMatch(deployment, /JINA_CONTEXT_ARTIFACT_RETENTION_DAYS/);
  assert.match(deploymentDocs, /roles\/jinaContextBackupOperator/);
  assert.match(deploymentDocs, /--uniform-bucket-level-access/);
  assert.match(deploymentDocs, /--public-access-prevention/);
  assert.match(deploymentDocs, /Never grant `roles\/storage\.admin`[\s\S]+at project scope/);
});

test("deployment fails clearly and before mutation when the artifact bucket is absent", async () => {
  await withFakeGcloud("#!/usr/bin/env bash\nexit 1\n", async (env) => {
    await assert.rejects(execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], { env }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Artifact bucket gs:\/\/quality-project-jina-context-artifacts is missing/);
      assert.match(error.stderr, /platform prerequisite; the deployment will not create it/);
      assert.match(error.stderr, /roles\/storage\.admin[\s\S]+on that bucket only/);
      assert.doesNotMatch(error.stderr, /Cloud SQL backup/);
      return true;
    });
  });
});

test("deployment fails clearly without bucket-scoped build storage administration", async () => {
  const fakeGcloud = `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "storage buckets describe" ]]; then
  printf '%s\\n' '{"name":"quality-project-jina-context-artifacts","location":"US-EAST1","location_type":"region","uniform_bucket_level_access":true}'
  exit 0
fi
if [[ "$1 $2 $3" == "storage buckets get-iam-policy" ]]; then
  printf '%s\\n' '{"bindings":[]}'
  exit 0
fi
exit 97
`;
  await withFakeGcloud(fakeGcloud, async (env) => {
    await assert.rejects(execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], { env }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /needs an unconditional bucket-scoped roles\/storage\.admin binding/);
      assert.doesNotMatch(error.stderr, /Cloud SQL backup/);
      return true;
    });
  });
});

test("deployment rejects a missing numeric Secret version before cloud mutation", async () => {
  await withFakeGcloud(numericSecretPreflightGcloud("exit 1"), async (env) => {
    await assert.rejects(execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], { env }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Secret jina-db-password version 2 is missing or unreadable/);
      assert.doesNotMatch(error.stderr, /Cloud SQL backup/);
      return true;
    });
  });
});

test("deployment rejects a disabled numeric Secret version before cloud mutation", async () => {
  await withFakeGcloud(numericSecretPreflightGcloud("printf '%s\\n' DISABLED; exit 0"), async (env) => {
    await assert.rejects(execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], { env }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Secret jina-db-password version 2 is not ENABLED \(state=DISABLED\)/);
      assert.doesNotMatch(error.stderr, /Cloud SQL backup/);
      return true;
    });
  });
});

test("deployment rejects blanket lifecycle rules on retained Context artifacts", async () => {
  const fakeGcloud = `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "storage buckets describe" ]]; then
  printf '%s\\n' '{"name":"quality-project-jina-context-artifacts","location":"US-EAST1","location_type":"region","uniform_bucket_level_access":true,"lifecycle":{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}}'
  exit 0
fi
exit 97
`;
  await withFakeGcloud(fakeGcloud, async (env) => {
    await assert.rejects(execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], { env }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /lifecycle rules must be absent; Context retention is reference-aware/);
      assert.doesNotMatch(error.stderr, /Cloud SQL backup/);
      return true;
    });
  });
});

test("deployment rejects public artifact-bucket principals", async () => {
  const fakeGcloud = `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "storage buckets describe" ]]; then
  printf '%s\\n' '{"name":"quality-project-jina-context-artifacts","location":"US-EAST1","location_type":"region","uniform_bucket_level_access":true}'
  exit 0
fi
if [[ "$1 $2 $3" == "storage buckets get-iam-policy" ]]; then
  printf '%s\\n' '{"bindings":[{"role":"roles/storage.admin","members":["serviceAccount:jina-cloud-build-deployer@quality-project.iam.gserviceaccount.com"]},{"role":"roles/storage.objectViewer","members":["allUsers"]}]}'
  exit 0
fi
exit 97
`;
  await withFakeGcloud(fakeGcloud, async (env) => {
    await assert.rejects(execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], { env }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /public IAM principals are forbidden/);
      assert.doesNotMatch(error.stderr, /Cloud SQL backup/);
      return true;
    });
  });
});

test("production acceptance uses a registered fixture with a Cloud Build override", () => {
  assert.match(cloudBuild, /_JINA_ACCEPTANCE_REPOSITORY: omxyz\/jina-context-graph-e2e/);
  assert.match(cloudBuild, /JINA_ACCEPTANCE_REPOSITORY=\$\{_JINA_ACCEPTANCE_REPOSITORY\}/);
  assert.match(deployment, /acceptance_repository="\$\{JINA_ACCEPTANCE_REPOSITORY:-omxyz\/jina-context-graph-e2e\}"/);
  assert.match(deployment, /ACCEPTANCE_REPOSITORY=\$\{acceptance_repository\}/);
});

test("post-cutover trigger acceptance is deployed with a distinct least-scope fixture identity and never auto-runs", () => {
  for (const [name, value] of [
    ["JINA_TRIGGER_ACCEPTANCE_GITHUB_APP_ID_SECRET", "jina-trigger-acceptance-github-app-id"],
    ["JINA_TRIGGER_ACCEPTANCE_GITHUB_APP_PRIVATE_KEY_SECRET", "jina-trigger-acceptance-github-app-private-key"],
    ["JINA_TRIGGER_ACCEPTANCE_GITHUB_INSTALLATION_ID", "150069172"]
  ]) {
    assert.match(cloudBuild, new RegExp(`${name}=\\$\\{_${name}\\}`));
    assert.match(cloudBuild, new RegExp(`_${name}: "?${value}"?`));
  }

  const cleanup = deployment.indexOf(
    'post_cutover_cleanup_complete="true"',
    deployment.indexOf('accepted_cutover_complete="true"')
  );
  const jobReconciliation = deployment.indexOf("reconcile_trigger_acceptance_job_nonfatal", cleanup);
  const jobDeployment = deployment.indexOf('gcloud run jobs deploy "${trigger_acceptance_job}"');
  assert.ok(cleanup > 0);
  assert.ok(jobReconciliation > cleanup);
  assert.ok(jobDeployment > 0);
  assert.doesNotMatch(deployment, /gcloud run jobs execute "\$\{trigger_acceptance_job\}"/);
  assert.doesNotMatch(deployment, /gcloud run jobs execute jina-context-production-trigger-acceptance/);

  const jobBlock =
    deployment.match(/gcloud run jobs deploy "\$\{trigger_acceptance_job\}"[\s\S]+?--quiet\n/)?.[0] ?? "";
  assert.ok(jobBlock);
  assert.match(jobBlock, /--service-account="\$\{trigger_acceptance_service_account\}"/);
  assert.match(jobBlock, /GITHUB_APP_ID=jina-github-app-id:\$\{github_app_id_secret_version\}/);
  assert.match(
    jobBlock,
    /GITHUB_APP_PRIVATE_KEY=jina-github-app-private-key:\$\{github_app_private_key_secret_version\}/
  );
  assert.match(
    jobBlock,
    /GITHUB_FIXTURE_APP_ID=\$\{trigger_acceptance_github_app_id_secret\}:\$\{trigger_acceptance_github_app_id_secret_version\}/
  );
  assert.match(
    jobBlock,
    /GITHUB_FIXTURE_APP_PRIVATE_KEY=\$\{trigger_acceptance_github_app_private_key_secret\}:\$\{trigger_acceptance_github_app_private_key_secret_version\}/
  );
  assert.match(deployment, /--installation-id %q --fixture-installation-id %q --confirm-repository %q/);
  assert.match(deployment, /"\$\{acceptance_github_installation_id\}"/);
  assert.match(deployment, /"\$\{trigger_acceptance_github_installation_id\}"/);
  assert.equal(
    [...deployment.matchAll(/^[ \t]*"\$\{acceptance_repository\}"[ \t]*\\$/gm)].length,
    2,
    "the operator command retains both repository and confirmation arguments"
  );
  assert.match(jobBlock, /--command=\/bin\/sh/);
  assert.match(jobBlock, /--args="\^~\^-c~\$\{trigger_acceptance_command\}"/);
  assert.match(jobBlock, /--task-timeout=86400s/);
  assert.match(deployment, /stable_api_url="\$\(stable_service_url "jina-api"\)"/);
  assert.match(
    deployment,
    /if reconcile_trigger_acceptance_job; then[\s\S]+?trigger_acceptance_job_status="ready"[\s\S]+?trigger_acceptance_job_status="failed-nonfatal"[\s\S]+?return 0/
  );
  assert.match(
    deployment,
    /trigger_acceptance_service_account="jina-trigger-acceptance@\$\{GCP_PROJECT_ID\}\.iam\.gserviceaccount\.com"/
  );
  assert.match(productionTriggerAcceptance, /fixtureGithubAppId must differ from the operational githubAppId/);
  assert.match(productionTriggerAcceptance, /fixtureInstallationId must differ from the operational installationId/);

  const contextWorkerDeployments = [
    ...deployment.matchAll(
      /gcloud run deploy jina-context-worker[\s\S]+?wait_for_candidate_revision "jina-context-worker"[^\n]*\n/g
    )
  ].map((match) => match[0]);
  assert.ok(contextWorkerDeployments.length >= 2);
  for (const block of contextWorkerDeployments) {
    assert.doesNotMatch(block, /GITHUB_FIXTURE_APP/);
  }
  const candidateAcceptance =
    deployment.match(/gcloud run jobs deploy jina-acceptance[\s\S]+?acceptance_status=0/)?.[0] ?? "";
  assert.doesNotMatch(candidateAcceptance, /GITHUB_FIXTURE_APP/);
});

test("deployment rejects shared trigger and operational fixture credentials before cloud mutation", async () => {
  await withFakeGcloud("#!/usr/bin/env bash\nexit 97\n", async (env) => {
    await assert.rejects(
      execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
        env: {
          ...env,
          JINA_ACCEPTANCE_GITHUB_INSTALLATION_ID: "140435029",
          JINA_TRIGGER_ACCEPTANCE_GITHUB_INSTALLATION_ID: "140435029"
        }
      }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /installation IDs must differ/);
        return true;
      }
    );
    await assert.rejects(
      execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
        env: {
          ...env,
          JINA_TRIGGER_ACCEPTANCE_GITHUB_APP_ID_SECRET: "jina-github-app-id"
        }
      }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /secrets must be distinct/);
        return true;
      }
    );
  });
});

test("deployment rejects an invalid acceptance repository before cloud mutation", async () => {
  await withFakeGcloud("#!/usr/bin/env bash\nexit 97\n", async (env) => {
    await assert.rejects(
      execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
        env: { ...env, JINA_ACCEPTANCE_REPOSITORY: "omxyz/repository/extra" }
      }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /JINA_ACCEPTANCE_REPOSITORY must be an owner\/repository name/);
        return true;
      }
    );
  });
});

test("production gate has a measured three-hour acceptance window", () => {
  assert.match(cloudBuild, /_JINA_ACCEPTANCE_DERIVATION_BUDGET_SECONDS: "10800"/);
  assert.match(cloudBuild, /_JINA_ACCEPTANCE_TIMEOUT_MS: "10800000"/);
  assert.match(cloudBuild, /_JINA_ACCEPTANCE_JOB_TIMEOUT_SECONDS: "11700"/);
  assert.match(cloudBuild, /timeout: 21600s/);
  assert.match(deployment, /ACCEPTANCE_TIMEOUT_MS=\$\{acceptance_timeout_ms\}/);
  assert.match(deployment, /--task-timeout="\$\{acceptance_job_timeout_seconds\}s"/);
});

test("all releases probe the Daytona sandbox before Cloud SQL mutation", () => {
  const preflight = deployment.indexOf("gcloud run jobs execute jina-context-daytona-preflight");
  const backup = deployment.indexOf("gcloud sql backups create");
  const migration = deployment.indexOf("gcloud run jobs deploy jina-context-migrate");
  assert.ok(preflight > 0);
  assert.ok(backup > preflight);
  assert.ok(migration > backup);
  assert.match(productionPreflight, /daytona\.snapshot\.get/);
  assert.match(productionPreflight, /sandbox = await daytona\.create/);
  assert.match(productionPreflight, /networkBlockAll: true/);
  assert.match(productionPreflight, /ephemeral: true/);
  assert.match(productionPreflight, /ttlMinutes: 5/);
  assert.match(productionPreflight, /sandbox\.process\.executeCommand/);
  assert.match(productionPreflight, /AUTH_OK/);
  assert.match(productionPreflight, /sandbox\.delete\(60, true\)/);
  assert.doesNotMatch(productionPreflight, /DaytonaBoardAgentStageRunner|modelSecret|codex exec/);
  assert.match(
    deployment,
    /daytona_preflight_env="\^~\^CONTEXT_DAYTONA_MODULE_PATH=\/app\/node_modules\/@jina\/daytona\/dist\/index\.js"/
  );
  assert.doesNotMatch(deployment.match(/daytona_preflight_env=.*$/m)?.[0] ?? "", /MODEL_SECRET|CONTEXT_CODEX/);
});

test("production context worker claims exactly the Board topics", () => {
  const configured = /^context_board_topics="([^"]+)"$/m.exec(deployment)?.[1]?.split("|") ?? [];

  assert.deepEqual(configured, BOARD_TOPICS);
  for (const topic of LEGACY_TOPICS) assert.doesNotMatch(deployment, new RegExp(topic));
  assert.match(deployment, /WORKER_TOPICS=\$\{context_board_topics\}/);
  assert.match(deployment, /JINA_PRODUCT_API_URL=\$\{product_api_url\}/);
  assert.match(deployment, /WORKER_PREFERRED_REPOSITORY=\$\{acceptance_repository\}/);
});

test("production Board agents are Daytona-only and mount the managed fallback under its narrow name", () => {
  assert.match(deployment, /CONTEXT_BOARD_EXECUTOR=daytona/);
  assert.match(deployment, /CONTEXT_DAYTONA_MODEL_SECRET=/);
  assert.match(deployment, /CONTEXT_DAYTONA_MODEL_SECRET_ENV=/);
  assert.match(deployment, /CONTEXT_DAYTONA_MODEL_DOMAINS=/);
  assert.match(deployment, /CONTEXT_DAYTONA_(?:SNAPSHOT|IMAGE)=/);
  assert.match(
    deployment,
    /--set-secrets="INTERNAL_API_TOKEN=jina-internal-api-token:\$\{internal_api_token_secret_version\},JINA_PRODUCT_INTERNAL_API_TOKEN=\$\{product_internal_token_secret\}:\$\{product_internal_token_secret_version\},JINA_MANAGED_MODEL_API_KEY=jina-openai-api-key:\$\{openai_api_key_secret_version\},DAYTONA_API_KEY=jina-daytona-api-key:\$\{daytona_api_key_secret_version\},GITHUB_APP_ID=/
  );

  const workerDeployment =
    deployment.match(
      /gcloud run deploy jina-context-worker[\s\S]+?wait_for_candidate_revision "jina-context-worker"/
    )?.[0] ?? "";
  assert.ok(workerDeployment);
  assert.match(workerDeployment, /JINA_MANAGED_MODEL_API_KEY=jina-openai-api-key:\$\{openai_api_key_secret_version\}/);
  assert.doesNotMatch(workerDeployment, /OPENAI_API_KEY=jina-openai-api-key/);
});

test("production storage, quota database, and PageIndex dependencies are explicit", () => {
  assert.match(deployment, /CONTEXT_GCS_BUCKET=\$\{context_artifact_bucket\}/);
  assert.match(deployment, /--set-cloudsql-instances="\$\{cloud_sql_instance\}"/);
  assert.match(deployment, /product\/migrate-all\.js,--install-roles/);
  assert.match(deployment, /CONTEXT_PAGEINDEX_PYTHON=\/opt\/pageindex-venv\/bin\/python/);
  assert.match(deployment, /CONTEXT_PAGEINDEX_WORKER=\/opt\/pageindex-worker\/worker\.py/);
  assert.match(deployment, /PAGEINDEX_SOURCE_ROOT=\/opt\/PageIndex/);

  for (const dockerfile of [workerDockerfile, pageIndexDockerfile]) {
    assert.match(dockerfile, /982514ab40fe42a169ea087c13819cf87c87724f/);
    assert.match(dockerfile, /worker\.py --probe/);
  }
  assert.match(workerDockerfile, /COPY --from=pageindex --chown=node:node \/opt\/PageIndex \/opt\/PageIndex/);
  assert.match(workerDockerfile, /COPY --from=pageindex --chown=node:node \/opt\/pageindex-venv \/opt\/pageindex-venv/);
  assert.match(pageIndexWorker, /ADAPTER_VERSION = "982514ab40fe42a169ea087c13819cf87c87724f"/);
  assert.match(pageIndexWorker, /SOURCE_PIN = ADAPTER_VERSION/);
  assert.match(pageIndexWorker, /SOURCE_DIGEST = "[0-9a-f]{64}"/);
  assert.match(pageIndexWorker, /"sourceDigest": verified_source_digest\(\)/);
  assert.match(pageIndexWorker, /import_module\("page_index_md"\)/);
  assert.doesNotMatch(pageIndexWorker, /import_module\("pageindex\.page_index_md"\)/);
  assert.match(workerDockerfile, /apt-get install[^]*\btar\b/);
  assert.doesNotMatch(apiDockerfile, /CODEX_BINARY|@openai\/codex/);
  assert.doesNotMatch(deployment.match(/^api_env_vars=.*$/m)?.[0] ?? "", /CONTEXT_(?:TREE_SELECTOR|CODEX_)/);
  assert.doesNotMatch(deployment.match(/^api_secrets=.*$/m)?.[0] ?? "", /OPENAI_API_KEY/);
  assert.doesNotMatch(apiDockerfile, /PageIndex|pageindex-worker/);
});

test("API burst capacity preserves the aggregate PostgreSQL connection budget", () => {
  assert.match(cloudBuild, /_JINA_API_MAX_INSTANCES: "4"/);
  assert.match(cloudBuild, /_JINA_CONTEXT_WORKER_MAX_INSTANCES: "100"/);
  assert.match(cloudBuild, /_JINA_TASK_WORKER_MAX_INSTANCES: "5"/);
  assert.match(cloudBuild, /_JINA_API_DB_POOL_MAX: "3"/);
  assert.match(cloudBuild, /JINA_API_DB_POOL_MAX=\$\{_JINA_API_DB_POOL_MAX\}/);
  assert.match(deployment.match(/^api_env_vars=.*$/m)?.[0] ?? "", /JINA_DB_POOL_MAX=\$\{api_db_pool_max\}/);
});

test("production acceptance receives both web surfaces and only its bounded credentials", () => {
  const acceptanceDeployment = deployment.match(
    /gcloud run jobs deploy jina-acceptance[\s\S]+?acceptance_status=0/
  )?.[0];
  assert.ok(acceptanceDeployment);

  assert.match(deployment, /ACCEPTANCE_DASHBOARD_URL=\$\{dashboard_url\}/);
  assert.match(deployment, /ACCEPTANCE_DASHBOARD_AUDIENCE=\$\{dashboard_audience\}/);
  assert.match(deployment, /ACCEPTANCE_ADMIN_URL=\$\{admin_url\}/);
  assert.match(deployment, /ACCEPTANCE_CONTEXT_WORKER_AUDIENCE=\$\{context_worker_audience\}/);
  assert.match(deployment, /ACCEPTANCE_TASK_WORKER_AUDIENCE=\$\{task_worker_audience\}/);
  assert.match(deployment, /context_worker_url="\$\(candidate_service_url "jina-context-worker"\)"/);
  assert.match(deployment, /task_worker_url="\$\(candidate_service_url "jina-task-worker"\)"/);
  assert.match(deployment, /dashboard_url="\$\(candidate_service_url "jina-dashboard"\)"/);
  assert.match(deployment, /dashboard_audience="\$\(stable_service_url "jina-dashboard"\)"/);
  assert.match(deployment, /context_worker_audience="\$\(stable_service_url "jina-context-worker"\)"/);
  assert.match(deployment, /task_worker_audience="\$\(stable_service_url "jina-task-worker"\)"/);
  assert.match(
    deployment,
    /stable_service_url\(\)[\s\S]+?--format='value\(status\.url\)'[\s\S]+?printf '%s\\n' "\$\{url\}"/
  );
  assert.match(deployment, /ACCEPTANCE_WEB_AUTH_USERNAME=omlabs/);
  assert.match(
    acceptanceDeployment,
    /INTERNAL_API_TOKEN=jina-internal-api-token:\$\{internal_api_token_secret_version\},ACCEPTANCE_WEB_AUTH_PASSWORD=jina-web-auth-password:\$\{web_auth_password_secret_version\}/
  );
  assert.doesNotMatch(acceptanceDeployment, /CONTEXT_API_TOKEN/);
  assert.match(
    deployment,
    /^api_secrets=.*CONTEXT_API_TOKEN=jina-context-api-token:\$\{context_api_token_secret_version\}/m
  );
  assert.match(
    deployment,
    /gcloud run services add-iam-policy-binding jina-dashboard[\s\S]+?serviceAccount:\$\{acceptance_service_account\}[\s\S]+?roles\/run\.invoker/
  );
  assert.match(
    deployment,
    /gcloud iam service-accounts add-iam-policy-binding "\$\{acceptance_service_account\}"[\s\S]+?roles\/iam\.serviceAccountTokenCreator/
  );
  assert.match(
    deployment,
    /gcloud iap web add-iam-policy-binding[\s\S]+?--service=jina-dashboard[\s\S]+?serviceAccount:\$\{acceptance_service_account\}[\s\S]+?roles\/iap\.httpsResourceAccessor/
  );
});

test("coordinated Cloud Build requires Daytona sandbox and model Secret substitutions", () => {
  for (const name of [
    "JINA_CONTEXT_DAYTONA_SNAPSHOT",
    "JINA_CONTEXT_DAYTONA_IMAGE",
    "JINA_CONTEXT_DAYTONA_MODEL_SECRET",
    "JINA_CONTEXT_DAYTONA_MODEL_SECRET_ENV",
    "JINA_CONTEXT_DAYTONA_MODEL_DOMAINS"
  ]) {
    assert.match(cloudBuild, new RegExp(`${name}=\\$\\{_${name}\\}`));
  }
});

test("deployment fails before cloud mutation without an explicit Daytona sandbox", async () => {
  await assert.rejects(
    execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
      env: {
        ...process.env,
        GCP_PROJECT_ID: "quality-project",
        GCP_REGION: "us-east1",
        CLOUD_BUILD_ID: "quality-build",
        JINA_CONTEXT_DAYTONA_MODEL_SECRET: "openai-model-secret"
      }
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Exactly one JINA_CONTEXT_DAYTONA_SNAPSHOT or JINA_CONTEXT_DAYTONA_IMAGE is required/);
      assert.doesNotMatch(error.stderr, /gcloud/);
      return true;
    }
  );
});

test("deployment fails before cloud mutation when both Daytona sandbox selectors are set", async () => {
  await assert.rejects(
    execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
      env: {
        ...process.env,
        GCP_PROJECT_ID: "quality-project",
        GCP_REGION: "us-east1",
        CLOUD_BUILD_ID: "quality-build",
        JINA_CONTEXT_DAYTONA_SNAPSHOT: "snapshot-v1",
        JINA_CONTEXT_DAYTONA_IMAGE: "registry.example/agent@sha256:abc",
        JINA_CONTEXT_DAYTONA_MODEL_SECRET: "openai-model-secret"
      }
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Exactly one JINA_CONTEXT_DAYTONA_SNAPSHOT or JINA_CONTEXT_DAYTONA_IMAGE is required/);
      return true;
    }
  );
});

test("deployment fails before cloud mutation without a Daytona model Secret name", async () => {
  await assert.rejects(
    execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
      env: {
        ...process.env,
        GCP_PROJECT_ID: "quality-project",
        GCP_REGION: "us-east1",
        CLOUD_BUILD_ID: "quality-build",
        JINA_CONTEXT_DAYTONA_SNAPSHOT: "snapshot-v1",
        JINA_CONTEXT_DAYTONA_MODEL_SECRET: ""
      }
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /JINA_CONTEXT_DAYTONA_MODEL_SECRET must name a Daytona organization Secret/);
      assert.doesNotMatch(error.stderr, /gcloud/);
      return true;
    }
  );
});

test("deployment rejects a mutable Daytona image before cloud mutation", async () => {
  await assert.rejects(
    execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
      env: {
        ...process.env,
        GCP_PROJECT_ID: "quality-project",
        GCP_REGION: "us-east1",
        CLOUD_BUILD_ID: "quality-build",
        JINA_CONTEXT_DAYTONA_IMAGE: "registry.example/agent:latest",
        JINA_CONTEXT_DAYTONA_MODEL_SECRET: "openai-model-secret"
      }
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /JINA_CONTEXT_DAYTONA_IMAGE must be pinned by sha256 digest/);
      assert.doesNotMatch(error.stderr, /gcloud/);
      return true;
    }
  );
});

test("deployment rejects a model credential in place of a Daytona Secret name", async () => {
  const credentialValue = "sk-proj-private-model-credential";
  await assert.rejects(
    execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
      env: {
        ...process.env,
        GCP_PROJECT_ID: "quality-project",
        GCP_REGION: "us-east1",
        CLOUD_BUILD_ID: "quality-build",
        JINA_CONTEXT_DAYTONA_SNAPSHOT: "snapshot-v1",
        JINA_CONTEXT_DAYTONA_MODEL_SECRET: credentialValue
      }
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /must name a Daytona organization Secret/);
      assert.doesNotMatch(error.stderr, new RegExp(credentialValue));
      assert.doesNotMatch(error.stderr, /gcloud/);
      return true;
    }
  );
});

test("deployment validates and preflights the product internal token Secret", async () => {
  assert.match(
    deployment,
    /validate_secret_name \\\n  "JINA_PRODUCT_INTERNAL_API_TOKEN_SECRET" \\\n  "\$\{product_internal_token_secret\}"/
  );
  assert.match(
    deployment,
    /for secret_spec in[\s\S]+?"\$\{product_internal_token_secret\}:\$\{product_internal_token_secret_version\}"[\s\S]+?require_secret "\$\{secret_spec\}"/
  );

  await assert.rejects(
    execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
      env: {
        ...process.env,
        GCP_PROJECT_ID: "quality-project",
        GCP_REGION: "us-east1",
        CLOUD_BUILD_ID: "quality-build",
        JINA_CONTEXT_DAYTONA_SNAPSHOT: "snapshot-v1",
        JINA_CONTEXT_DAYTONA_MODEL_SECRET: "openai-model-secret",
        JINA_PRODUCT_INTERNAL_API_TOKEN_SECRET: "not/a/secret"
      }
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /JINA_PRODUCT_INTERNAL_API_TOKEN_SECRET is not a valid Secret Manager secret name/);
      assert.doesNotMatch(error.stderr, /gcloud/);
      return true;
    }
  );
});

test("deployment rejects an invalid Daytona network allowlist before cloud mutation", async () => {
  await assert.rejects(
    execFileAsync("bash", ["scripts/cloud-build-deploy.sh"], {
      env: {
        ...process.env,
        GCP_PROJECT_ID: "quality-project",
        GCP_REGION: "us-east1",
        CLOUD_BUILD_ID: "quality-build",
        JINA_CONTEXT_DAYTONA_SNAPSHOT: "snapshot-v1",
        JINA_CONTEXT_DAYTONA_MODEL_SECRET: "openai-model-secret",
        JINA_CONTEXT_DAYTONA_MODEL_DOMAINS: "api.openai.com,https://example.com"
      }
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(
        error.stderr,
        /JINA_CONTEXT_DAYTONA_MODEL_DOMAINS must contain 1\.\.8 valid comma-separated domains/
      );
      assert.doesNotMatch(error.stderr, /gcloud/);
      return true;
    }
  );
});
