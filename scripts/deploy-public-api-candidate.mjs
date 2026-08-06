#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const FIXED_TARGET = Object.freeze({
  project: "jina-463721",
  region: "us-east1",
  service: "jina-code-review-api",
  serviceAccount: "jina-api-runtime@jina-463721.iam.gserviceaccount.com"
});
const FIXED_SCHEDULER = Object.freeze({
  job: "jina-github-webhook-inbox-production",
  location: "us-east1",
  schedule: "* * * * *",
  timeZone: "Etc/UTC",
  oidcServiceAccount: FIXED_TARGET.serviceAccount,
  oidcAudience: "https://api.usejina.com"
});
const FIXED_INBOX_KEY = Object.freeze({
  project: FIXED_TARGET.project,
  name: "jina-github-webhook-inbox-encryption-key"
});

const REQUIRED_LITERAL_ENV = Object.freeze({
  API_BASE_URL: "https://api.usejina.com",
  DASHBOARD_AUTH_MODE: "github",
  DASHBOARD_URL: "https://app.usejina.com",
  DASHBOARD_COOKIE_SAMESITE: "None",
  DASHBOARD_COOKIE_SECURE: "true",
  GITHUB_APP_ID: "4040260",
  GITHUB_APP_SLUG: "jina-review-bot",
  GITHUB_APP_INSTALL_URL: "https://github.com/apps/jina-review-bot/installations/new",
  GITHUB_OAUTH_CLIENT_ID: "Ov23lix0k1McZctAzJu0",
  JINA_PRODUCT_API_ENABLED: "true",
  JINA_PRODUCT_DATABASE_MODE: "shared",
  JINA_TENANCY_MODE: "shared-db",
  JINA_REQUIRE_WORKER_RELEASE_GATE: "true",
  JINA_DB_MANAGE_SCHEMA: "false",
  JINA_DB_POOL_MAX: "3",
  DB_NAME: "jina",
  DB_USER: "jina_v2_app",
  JINA_GITHUB_WEBHOOK_INBOX_ENABLED: "true",
  JINA_SCHEDULER_OIDC_AUDIENCE: FIXED_SCHEDULER.oidcAudience,
  JINA_SCHEDULER_OIDC_EMAIL: FIXED_SCHEDULER.oidcServiceAccount,
  JINA_REVIEW_BOARD_PIPELINE_MODE: "paused",
  JINA_BILLING_ENFORCE: "on"
});

const REQUIRED_SECRET_ENV = Object.freeze([
  "DB_PASS",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "INTERNAL_API_TOKEN",
  "JINA_PRODUCT_INTERNAL_API_TOKEN",
  "SECRETS_ENCRYPTION_KEY",
  "GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY",
  "AUTUMN_SECRET_KEY",
  "JINA_GRAPH_API_TOKEN",
  "JINA_GRAPH_INTERNAL_TOKEN"
]);
const REQUIRED_ACCEPTANCE_CHECKS = Object.freeze([
  "health",
  "github_oauth",
  "read_only_product",
  "encrypted_integration",
  "internal_callback",
  "autumn",
  "graph",
  "inbox_capture",
  "inbox_replay"
]);

export function validatePublicApiCandidateManifest(value) {
  const manifest = object(value, "manifest");
  exactKeys(
    manifest,
    [
      "schema_version",
      "mode",
      "release_id",
      "source_sha",
      "image",
      "target",
      "candidate",
      "runtime",
      "environment",
      "secrets",
      "scheduler",
      "allowed_environment_changes",
      "rollback_revision"
    ],
    "manifest"
  );
  if (manifest.schema_version !== 1) fail("schema_version must be 1");
  if (manifest.mode !== "monorepo-candidate" && manifest.mode !== "old-rollback-clone") {
    fail("mode must be monorepo-candidate or old-rollback-clone");
  }
  const releaseId = matchingString(manifest.release_id, /^[a-z0-9][a-z0-9-]{2,40}$/, "release_id");
  const sourceSha = matchingString(manifest.source_sha, /^[0-9a-f]{40}$/, "source_sha");
  const image = matchingString(manifest.image, /@sha256:[0-9a-f]{64}$/, "image must be digest-pinned");
  const monorepoPrefix = "us-east1-docker.pkg.dev/jina-v2/jina/api@sha256:";
  const oldImage = /^us-east1-docker\.pkg\.dev\/jina-463721\/[a-z0-9._-]+\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
  if (manifest.mode === "monorepo-candidate" && !image.startsWith(monorepoPrefix)) {
    fail("monorepo-candidate image must come from jina-v2/jina/api by digest");
  }
  if (manifest.mode === "old-rollback-clone" && !oldImage.test(image)) {
    fail("old-rollback-clone image must come from the recorded jina-463721 repository by digest");
  }

  const target = object(manifest.target, "target");
  exactKeys(
    target,
    ["project", "region", "service", "service_account", "cloud_sql_instance", "expected_serving_revision"],
    "target"
  );
  for (const [key, expected] of [
    ["project", FIXED_TARGET.project],
    ["region", FIXED_TARGET.region],
    ["service", FIXED_TARGET.service],
    ["service_account", FIXED_TARGET.serviceAccount]
  ]) {
    if (target[key] !== expected) fail(`target.${key} must be ${expected}`);
  }
  const cloudSqlInstance = matchingString(
    target.cloud_sql_instance,
    /^jina-463721:us-east1:[a-z][a-z0-9-]{0,97}$/,
    "target.cloud_sql_instance"
  );
  const expectedServingRevision = matchingString(
    target.expected_serving_revision,
    /^jina-code-review-api-[a-z0-9-]+$/,
    "target.expected_serving_revision"
  );

  const candidate = object(manifest.candidate, "candidate");
  exactKeys(candidate, ["revision_suffix", "tag"], "candidate");
  const revisionSuffix = matchingString(
    candidate.revision_suffix,
    /^[a-z0-9][a-z0-9-]{0,35}$/,
    "candidate.revision_suffix"
  );
  const tag = matchingString(candidate.tag, /^[a-z][a-z0-9-]{0,24}$/, "candidate.tag");

  const runtime = object(manifest.runtime, "runtime");
  exactKeys(
    runtime,
    ["concurrency", "timeout_seconds", "min_instances", "max_instances", "cpu", "memory", "port"],
    "runtime"
  );
  const normalizedRuntime = {
    concurrency: integer(runtime.concurrency, 1, 1_000, "runtime.concurrency"),
    timeoutSeconds: integer(runtime.timeout_seconds, 1, 3_600, "runtime.timeout_seconds"),
    minInstances: integer(runtime.min_instances, 0, 1_000, "runtime.min_instances"),
    maxInstances: integer(runtime.max_instances, 1, 1_000, "runtime.max_instances"),
    cpu: matchingString(runtime.cpu, /^[1-9][0-9]*(?:m)?$/, "runtime.cpu"),
    memory: matchingString(runtime.memory, /^[1-9][0-9]*(?:Mi|Gi)$/, "runtime.memory"),
    port: integer(runtime.port, 1, 65_535, "runtime.port")
  };
  if (normalizedRuntime.minInstances > normalizedRuntime.maxInstances) {
    fail("runtime.min_instances cannot exceed max_instances");
  }

  const environment = stringMap(manifest.environment, "environment");
  for (const [name, expected] of Object.entries(REQUIRED_LITERAL_ENV)) {
    if (environment[name] !== expected) fail(`environment.${name} must be ${expected}`);
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail(`invalid environment name ${name}`);
    if (/[~\0\r\n]/.test(value)) fail(`environment.${name} contains a forbidden delimiter`);
    if (/(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)$/.test(name)) {
      fail(`secret-looking ${name} must use the secrets map`);
    }
  }
  if (environment.INSTANCE_UNIX_SOCKET !== `/cloudsql/${cloudSqlInstance}`) {
    fail("environment.INSTANCE_UNIX_SOCKET must bind the fixed Cloud SQL instance");
  }
  const dashboardOrigins = new Set(
    (environment.DASHBOARD_ORIGIN ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (!dashboardOrigins.has("https://app.usejina.com") || dashboardOrigins.has("*")) {
    fail("environment.DASHBOARD_ORIGIN must explicitly allow app.usejina.com and cannot use wildcard");
  }
  const graphUrl = matchingString(
    environment.JINA_GRAPH_API_URL,
    /^https:\/\/[^/~\s]+$/,
    "environment.JINA_GRAPH_API_URL"
  );
  if (new URL(graphUrl).origin === "https://api.usejina.com") {
    fail("environment.JINA_GRAPH_API_URL cannot loop back to the public product API");
  }

  const secretsObject = object(manifest.secrets, "secrets");
  const secrets = {};
  for (const [environmentName, rawSecret] of Object.entries(secretsObject)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(environmentName)) {
      fail(`invalid secret environment name ${environmentName}`);
    }
    const secret = object(rawSecret, `secrets.${environmentName}`);
    exactKeys(secret, ["project", "name", "version"], `secrets.${environmentName}`);
    secrets[environmentName] = {
      project: matchingString(secret.project, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, `secrets.${environmentName}.project`),
      name: matchingString(secret.name, /^[A-Za-z][A-Za-z0-9_-]{0,254}$/, `secrets.${environmentName}.name`),
      version: matchingString(secret.version, /^[1-9][0-9]*$/, `secrets.${environmentName}.version`)
    };
  }
  for (const name of REQUIRED_SECRET_ENV) {
    if (!secrets[name]) fail(`secrets.${name} is required`);
  }
  if (environment.GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION !== secrets.GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY.version) {
    fail(
      "inbox encryption key environment version " +
        `${environment.GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION ?? "<missing>"} must equal ` +
        `its numeric secret version ${secrets.GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY.version}`
    );
  }
  const inboxKey = secrets.GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY;
  if (inboxKey.project !== FIXED_INBOX_KEY.project || inboxKey.name !== FIXED_INBOX_KEY.name) {
    fail(`secrets.GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY must bind ${FIXED_INBOX_KEY.project}/${FIXED_INBOX_KEY.name}`);
  }

  const scheduler = object(manifest.scheduler, "scheduler");
  exactKeys(
    scheduler,
    ["job", "location", "schedule", "time_zone", "oidc_service_account", "oidc_audience"],
    "scheduler"
  );
  for (const [key, expected] of [
    ["job", FIXED_SCHEDULER.job],
    ["location", FIXED_SCHEDULER.location],
    ["schedule", FIXED_SCHEDULER.schedule],
    ["time_zone", FIXED_SCHEDULER.timeZone],
    ["oidc_service_account", FIXED_SCHEDULER.oidcServiceAccount],
    ["oidc_audience", FIXED_SCHEDULER.oidcAudience]
  ]) {
    if (scheduler[key] !== expected) fail(`scheduler.${key} must be ${expected}`);
  }

  const allowedEnvironmentChanges = stringArray(manifest.allowed_environment_changes, "allowed_environment_changes");
  for (const name of allowedEnvironmentChanges) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail(`invalid allowed environment change ${name}`);
  }
  const rollbackRevision = matchingString(
    manifest.rollback_revision,
    /^jina-code-review-api-[a-z0-9-]+$/,
    "rollback_revision"
  );

  return {
    schemaVersion: 1,
    mode: manifest.mode,
    releaseId,
    sourceSha,
    image,
    target: {
      ...FIXED_TARGET,
      cloudSqlInstance,
      expectedServingRevision
    },
    candidate: { revisionSuffix, tag },
    runtime: normalizedRuntime,
    environment,
    secrets,
    scheduler: FIXED_SCHEDULER,
    allowedEnvironmentChanges: new Set(allowedEnvironmentChanges),
    rollbackRevision
  };
}

export function buildPublicApiDeployArgs(manifest) {
  const env = Object.entries(manifest.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("~");
  const secrets = Object.entries(manifest.secrets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, secret]) => `${name}=projects/${secret.project}/secrets/${secret.name}:${secret.version}`)
    .join(",");
  return [
    "run",
    "deploy",
    manifest.target.service,
    `--project=${manifest.target.project}`,
    `--region=${manifest.target.region}`,
    `--image=${manifest.image}`,
    `--service-account=${manifest.target.serviceAccount}`,
    `--set-cloudsql-instances=${manifest.target.cloudSqlInstance}`,
    `--concurrency=${manifest.runtime.concurrency}`,
    `--timeout=${manifest.runtime.timeoutSeconds}`,
    `--min-instances=${manifest.runtime.minInstances}`,
    `--max-instances=${manifest.runtime.maxInstances}`,
    `--cpu=${manifest.runtime.cpu}`,
    `--memory=${manifest.runtime.memory}`,
    `--port=${manifest.runtime.port}`,
    "--allow-unauthenticated",
    "--no-traffic",
    `--tag=${manifest.candidate.tag}`,
    `--revision-suffix=${manifest.candidate.revisionSuffix}`,
    `--set-env-vars=^~^${env}`,
    `--set-secrets=${secrets}`,
    "--quiet"
  ];
}

export function validatePublicApiAcceptanceEvidence(value, manifest, now = new Date()) {
  const evidence = object(value, "acceptance evidence");
  exactKeys(
    evidence,
    ["schema_version", "release_id", "source_sha", "image", "revision", "tagged_url", "completed_at", "checks"],
    "acceptance evidence"
  );
  if (evidence.schema_version !== 1) fail("acceptance evidence schema_version must be 1");
  if (evidence.release_id !== manifest.releaseId) fail("acceptance evidence release_id differs");
  if (evidence.source_sha !== manifest.sourceSha) fail("acceptance evidence source_sha differs");
  if (evidence.image !== manifest.image) fail("acceptance evidence image differs");
  if (evidence.revision !== candidateRevision(manifest)) {
    fail("acceptance evidence revision is not the manifest candidate");
  }
  const taggedUrl = matchingString(
    evidence.tagged_url,
    /^https:\/\/[a-z0-9-]+---[a-z0-9-]+(?:-[a-z0-9]+)*-[a-z]+\.a\.run\.app$/,
    "acceptance evidence tagged_url"
  );
  const completedAt = matchingString(
    evidence.completed_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    "acceptance evidence completed_at"
  );
  const completedAtMs = Date.parse(completedAt);
  if (
    !Number.isFinite(completedAtMs) ||
    completedAtMs > now.getTime() + 5 * 60_000 ||
    completedAtMs < now.getTime() - 4 * 60 * 60_000
  ) {
    fail("acceptance evidence must be no more than four hours old and not in the future");
  }
  const checks = object(evidence.checks, "acceptance evidence checks");
  exactKeys(checks, REQUIRED_ACCEPTANCE_CHECKS, "acceptance evidence checks");
  for (const name of REQUIRED_ACCEPTANCE_CHECKS) {
    if (checks[name] !== true) fail(`acceptance evidence check ${name} must be true`);
  }
  return { taggedUrl, completedAt };
}

export async function validatePublicApiCandidateState(manifest, runner = runCommand, options = {}) {
  const service = JSON.parse(
    await runner("gcloud", [
      "run",
      "services",
      "describe",
      manifest.target.service,
      `--project=${manifest.target.project}`,
      `--region=${manifest.target.region}`,
      "--format=json"
    ])
  );
  const servingRevision = servingRevisionAtOneHundredPercent(service);
  const allowedServingRevisions = new Set(options.allowedServingRevisions ?? [manifest.target.expectedServingRevision]);
  if (!allowedServingRevisions.has(servingRevision)) {
    fail(`serving revision changed: allowed ${[...allowedServingRevisions].join(",")}, got ${servingRevision}`);
  }
  if (service?.spec?.template?.spec?.serviceAccountName !== manifest.target.serviceAccount) {
    fail("live service account does not match the fixed target");
  }
  const cloudSql = service?.spec?.template?.metadata?.annotations?.["run.googleapis.com/cloudsql-instances"];
  if (cloudSql !== manifest.target.cloudSqlInstance) fail("live Cloud SQL attachment does not match manifest");
  validateEnvironmentDelta(serviceEnvironment(service), manifest);

  const imageResult = (
    await runner("gcloud", [
      "artifacts",
      "docker",
      "images",
      "describe",
      manifest.image,
      "--format=value(image_summary.fully_qualified_digest)"
    ])
  ).trim();
  if (imageResult !== manifest.image) fail("Artifact Registry did not resolve the exact requested digest");

  for (const secret of Object.values(manifest.secrets)) {
    const state = (
      await runner("gcloud", [
        "secrets",
        "versions",
        "describe",
        secret.version,
        `--secret=${secret.name}`,
        `--project=${secret.project}`,
        "--format=value(state)"
      ])
    ).trim();
    if (state !== "ENABLED") fail(`secret ${secret.project}/${secret.name}:${secret.version} is not enabled`);
  }

  const policy = JSON.parse(
    await runner("gcloud", [
      "run",
      "services",
      "get-iam-policy",
      manifest.target.service,
      `--project=${manifest.target.project}`,
      `--region=${manifest.target.region}`,
      "--format=json"
    ])
  );
  const publicInvoker = policy.bindings?.some(
    (binding) => binding.role === "roles/run.invoker" && binding.members?.includes("allUsers")
  );
  if (!publicInvoker) fail("live webhook service is not publicly invokable");

  const domainMapping = JSON.parse(
    await runner("gcloud", [
      "beta",
      "run",
      "domain-mappings",
      "describe",
      "--domain=api.usejina.com",
      `--project=${manifest.target.project}`,
      `--region=${manifest.target.region}`,
      "--format=json"
    ])
  );
  if (domainMapping?.spec?.routeName !== manifest.target.service) {
    fail("api.usejina.com is not mapped to the fixed public service");
  }
  const certificateReady = domainMapping?.status?.conditions?.some(
    (condition) => condition.type === "CertificateProvisioned" && condition.status === "True"
  );
  if (!certificateReady) fail("api.usejina.com certificate is not ready");

  if (manifest.mode === "monorepo-candidate") {
    const projectNumber = matchingString(
      (
        await runner("gcloud", ["projects", "describe", manifest.target.project, "--format=value(projectNumber)"])
      ).trim(),
      /^[1-9][0-9]*$/,
      "target project number"
    );
    const serviceAgent = `serviceAccount:service-${projectNumber}@serverless-robot-prod.iam.gserviceaccount.com`;
    const repositoryPolicy = JSON.parse(
      await runner("gcloud", [
        "artifacts",
        "repositories",
        "get-iam-policy",
        "jina",
        "--project=jina-v2",
        "--location=us-east1",
        "--format=json"
      ])
    );
    const canPull = repositoryPolicy.bindings?.some(
      (binding) => binding.role === "roles/artifactregistry.reader" && binding.members?.includes(serviceAgent)
    );
    if (!canPull) fail("production Cloud Run service agent cannot pull the monorepo image");
  }
  return { service, servingRevision };
}

export async function deployPublicApiCandidate(manifest, dependencies = {}) {
  const runner = dependencies.runner ?? runCommand;
  const probe = dependencies.probe ?? probeHealth;
  const before = await validatePublicApiCandidateState(manifest, runner);
  await runner("gcloud", buildPublicApiDeployArgs(manifest), { inherit: true });
  const after = JSON.parse(
    await runner("gcloud", [
      "run",
      "services",
      "describe",
      manifest.target.service,
      `--project=${manifest.target.project}`,
      `--region=${manifest.target.region}`,
      "--format=json"
    ])
  );
  if (servingRevisionAtOneHundredPercent(after) !== before.servingRevision) {
    fail("candidate deployment changed serving traffic before acceptance");
  }
  const tagged = after.status?.traffic?.find(
    (target) => target.tag === manifest.candidate.tag && target.revisionName === candidateRevision(manifest)
  );
  if (!tagged?.url) fail("candidate tag does not resolve to the expected revision");
  await probe(`${tagged.url}/health`);
  return { revision: candidateRevision(manifest), taggedUrl: tagged.url };
}

export function validateInboxKeyCompatibility(snapshotValue, manifest) {
  const snapshot = object(snapshotValue, "GitHub webhook inbox snapshot");
  const versions = object(snapshot.activeKeyVersions, "GitHub webhook inbox activeKeyVersions");
  const expectedVersion = manifest.secrets.GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY.version;
  const incompatible = [];
  for (const [version, rawCount] of Object.entries(versions)) {
    if (!/^[1-9][0-9]*$/.test(version)) fail(`inbox snapshot has invalid key version ${version}`);
    const count = integer(rawCount, 0, Number.MAX_SAFE_INTEGER, `inbox active key version ${version}`);
    if (version !== expectedVersion && count > 0) incompatible.push(`${version}:${count}`);
  }
  if (incompatible.length > 0) {
    fail(`inbox key version ${expectedVersion} cannot process active rows encrypted by ${incompatible.join(",")}`);
  }
  return { expectedVersion, activeKeyVersions: versions };
}

export function validateServingInboxWriterKey(revision, manifest) {
  const environment = containerEnvironment(revision?.spec?.containers?.[0]);
  const enabled = environment.get("JINA_GITHUB_WEBHOOK_INBOX_ENABLED");
  if (enabled?.kind !== "literal" || enabled.value !== "true") return { enabled: false };
  const key = environment.get("GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY");
  const expectedIdentity = `${FIXED_INBOX_KEY.project}/${FIXED_INBOX_KEY.name}`;
  if (key?.kind !== "secret" || key.identity !== expectedIdentity) {
    fail(
      `currently serving inbox writer must bind secret ${expectedIdentity}; ` +
        `got ${key?.kind === "secret" ? key.identity : "<missing>"}`
    );
  }
  const expectedVersion = manifest.secrets.GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY.version;
  if (key.version !== expectedVersion) {
    fail(
      `currently serving inbox writer mounts key version ${key.version ?? "<missing>"}; ` +
        `zero-interruption promotion requires ${expectedVersion}`
    );
  }
  const version = environment.get("GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION");
  const actualVersion = version?.kind === "literal" ? version.value : undefined;
  if (actualVersion !== expectedVersion) {
    fail(
      `currently serving inbox writer uses key version ${actualVersion ?? "<missing>"}; ` +
        `zero-interruption promotion requires ${expectedVersion}`
    );
  }
  return { enabled: true, identity: key.identity, version: actualVersion, mountedVersion: key.version };
}

export async function ensureProductionInboxSchedulerPaused(manifest, taggedUrl, runner = runCommand) {
  const endpoint = `${taggedUrl}/internal/github-webhook-inbox/process`;
  await runner(
    "gcloud",
    ["services", "enable", "cloudscheduler.googleapis.com", `--project=${manifest.target.project}`, "--quiet"],
    { inherit: true }
  );

  const previousJob = await describeProductionInboxScheduler(manifest, runner);
  if (previousJob) validateOwnedSchedulerJob(previousJob, manifest);
  const transition = { previousJob, endpoint };
  try {
    if (!previousJob) {
      // The intentionally dormant bootstrap schedule prevents a newly-created job from
      // running before it can be paused and fully bound.
      await runner(
        "gcloud",
        [
          "scheduler",
          "jobs",
          "create",
          "http",
          manifest.scheduler.job,
          `--project=${manifest.target.project}`,
          `--location=${manifest.scheduler.location}`,
          "--schedule=0 0 1 1 *",
          `--time-zone=${manifest.scheduler.timeZone}`,
          `--uri=${endpoint}`,
          "--http-method=POST",
          "--headers=Content-Type=application/json",
          `--oidc-service-account-email=${manifest.scheduler.oidcServiceAccount}`,
          `--oidc-token-audience=${manifest.scheduler.oidcAudience}`,
          "--quiet"
        ],
        { inherit: true }
      );
    }
    await pauseProductionInboxScheduler(manifest, runner);
    await updateProductionInboxScheduler(manifest, endpoint, runner);
    const job = await requireProductionInboxScheduler(manifest, runner);
    validateSchedulerJob(job, manifest, endpoint, "PAUSED");
    return { ...transition, job };
  } catch (error) {
    try {
      await restoreProductionInboxScheduler(manifest, transition, runner);
    } catch (restoreError) {
      throw new Error(
        `production inbox scheduler preparation failed and prior state could not be restored: ${errorMessage(error)}; restore: ${errorMessage(restoreError)}`
      );
    }
    throw error;
  }
}

async function describeProductionInboxScheduler(manifest, runner) {
  try {
    return JSON.parse(await runner("gcloud", schedulerDescribeArgs(manifest)));
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

async function requireProductionInboxScheduler(manifest, runner) {
  const job = await describeProductionInboxScheduler(manifest, runner);
  if (!job) fail("production inbox scheduler does not exist");
  return job;
}

async function pauseProductionInboxScheduler(manifest, runner) {
  const before = await requireProductionInboxScheduler(manifest, runner);
  if (before.state === "PAUSED") return before;
  if (before.state !== "ENABLED") {
    fail(`production inbox scheduler cannot be paused from state ${before.state ?? "<missing>"}`);
  }
  await runner(
    "gcloud",
    [
      "scheduler",
      "jobs",
      "pause",
      manifest.scheduler.job,
      `--project=${manifest.target.project}`,
      `--location=${manifest.scheduler.location}`,
      "--quiet"
    ],
    { inherit: true }
  );
  const after = await requireProductionInboxScheduler(manifest, runner);
  if (after.state !== "PAUSED") fail("production inbox scheduler pause did not take effect");
  return after;
}

async function updateProductionInboxScheduler(manifest, endpoint, runner) {
  await runner(
    "gcloud",
    [
      "scheduler",
      "jobs",
      "update",
      "http",
      manifest.scheduler.job,
      `--project=${manifest.target.project}`,
      `--location=${manifest.scheduler.location}`,
      `--schedule=${manifest.scheduler.schedule}`,
      `--time-zone=${manifest.scheduler.timeZone}`,
      `--uri=${endpoint}`,
      "--http-method=POST",
      "--update-headers=Content-Type=application/json",
      `--oidc-service-account-email=${manifest.scheduler.oidcServiceAccount}`,
      `--oidc-token-audience=${manifest.scheduler.oidcAudience}`,
      "--quiet"
    ],
    { inherit: true }
  );
}

async function resumeProductionInboxScheduler(manifest, endpoint, runner) {
  const before = await requireProductionInboxScheduler(manifest, runner);
  validateSchedulerJob(before, manifest, endpoint, "PAUSED");
  await runner(
    "gcloud",
    [
      "scheduler",
      "jobs",
      "resume",
      manifest.scheduler.job,
      `--project=${manifest.target.project}`,
      `--location=${manifest.scheduler.location}`,
      "--quiet"
    ],
    { inherit: true }
  );
  const after = await requireProductionInboxScheduler(manifest, runner);
  validateSchedulerJob(after, manifest, endpoint, "ENABLED");
  return after;
}

export async function pauseProductionInboxSchedulerIfPresent(manifest, runner = runCommand) {
  const job = await describeProductionInboxScheduler(manifest, runner);
  if (!job) return false;
  validateOwnedSchedulerJob(job, manifest);
  const paused = await pauseProductionInboxScheduler(manifest, runner);
  validateSchedulerJob(paused, manifest, job.httpTarget.uri, "PAUSED");
  return true;
}

async function restoreProductionInboxScheduler(manifest, transition, runner) {
  let current = await describeProductionInboxScheduler(manifest, runner);
  if (!current) {
    if (!transition.previousJob) return;
    fail("production inbox scheduler disappeared during compensation");
  }
  if (current.state === "UPDATE_FAILED") {
    const recoveryEndpoint = transition.previousJob?.httpTarget?.uri ?? transition.endpoint;
    await updateProductionInboxScheduler(manifest, recoveryEndpoint, runner);
    current = await requireProductionInboxScheduler(manifest, runner);
    if (current.state === "UPDATE_FAILED") {
      fail("production inbox scheduler remained UPDATE_FAILED after recovery update");
    }
  }
  await pauseProductionInboxScheduler(manifest, runner);
  if (!transition.previousJob) {
    const paused = await requireProductionInboxScheduler(manifest, runner);
    if (paused.state !== "PAUSED" || paused.httpTarget?.uri !== transition.endpoint) {
      fail("new production inbox scheduler was not left safely paused");
    }
    return;
  }
  const previous = transition.previousJob;
  validateOwnedSchedulerJob(previous, manifest);
  await updateProductionInboxScheduler(manifest, previous.httpTarget.uri, runner);
  let restored = await requireProductionInboxScheduler(manifest, runner);
  validateSchedulerJob(restored, manifest, previous.httpTarget.uri, "PAUSED");
  if (previous.state === "ENABLED") {
    restored = await resumeProductionInboxScheduler(manifest, previous.httpTarget.uri, runner);
  }
  validateSchedulerJob(restored, manifest, previous.httpTarget.uri, previous.state);
}

async function runAndVerifyProductionInboxScheduler(manifest, endpoint, runner, waitForSuccess) {
  await resumeProductionInboxScheduler(manifest, endpoint, runner);
  const startedAt = new Date();
  await runner(
    "gcloud",
    [
      "scheduler",
      "jobs",
      "run",
      manifest.scheduler.job,
      `--project=${manifest.target.project}`,
      `--location=${manifest.scheduler.location}`,
      "--quiet"
    ],
    { inherit: true }
  );
  const attempt = await waitForSuccess(manifest, endpoint, startedAt, runner);
  validateSchedulerAttempt(attempt, manifest, endpoint, startedAt);
  return attempt;
}

function validateSchedulerAttempt(attemptValue, manifest, endpoint, startedAt) {
  const attempt = object(attemptValue, "scheduler attempt");
  const payload = object(attempt.jsonPayload, "scheduler attempt jsonPayload");
  const expectedJob = `projects/${manifest.target.project}/locations/${manifest.scheduler.location}/jobs/${manifest.scheduler.job}`;
  if (payload["@type"] !== "type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished") {
    fail("scheduler attempt is not an AttemptFinished record");
  }
  if (payload.jobName !== expectedJob || payload.url !== endpoint) {
    fail("scheduler attempt is not bound to the release job and endpoint");
  }
  const timestamp = Date.parse(attempt.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < startedAt.getTime()) {
    fail("scheduler attempt predates release activation");
  }
  const status = /Original HTTP response code number = ([0-9]{3})/.exec(payload.debugInfo ?? "")?.[1];
  if (!status || Number(status) < 200 || Number(status) >= 300) {
    fail(`scheduler attempt did not complete successfully${status ? ` (HTTP ${status})` : ""}`);
  }
  return attempt;
}

async function defaultWaitForSchedulerSuccess(manifest, endpoint, startedAt, runner) {
  const filter = [
    'resource.type="cloud_scheduler_job"',
    `resource.labels.job_id="${manifest.scheduler.job}"`,
    `resource.labels.location="${manifest.scheduler.location}"`,
    'jsonPayload."@type"="type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished"',
    `timestamp>="${startedAt.toISOString()}"`
  ].join(" AND ");
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const records = JSON.parse(
      await runner("gcloud", [
        "logging",
        "read",
        filter,
        `--project=${manifest.target.project}`,
        "--freshness=10m",
        "--order=desc",
        "--limit=20",
        "--format=json"
      ])
    );
    const matching = records.find((record) => record?.jsonPayload?.url === endpoint);
    if (matching) return matching;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail("scheduler produced no successful release-bound completion record within 45 seconds");
}

export async function updatePublicApiTraffic(manifest, revision, dependencies = {}) {
  if (revision !== candidateRevision(manifest) && revision !== manifest.rollbackRevision) {
    fail("traffic target is not the manifest candidate or rollback revision");
  }
  const runner = dependencies.runner ?? runCommand;
  const candidate = candidateRevision(manifest);
  let acceptance;
  if (revision === candidate) {
    if (!dependencies.acceptanceEvidence) {
      fail("candidate promotion requires complete acceptance evidence");
    }
    acceptance = validatePublicApiAcceptanceEvidence(
      dependencies.acceptanceEvidence,
      manifest,
      dependencies.now ?? new Date()
    );
  }
  const allowedServingRevisions =
    revision === candidate
      ? [manifest.target.expectedServingRevision, candidate]
      : [candidate, manifest.rollbackRevision];
  const before = await validatePublicApiCandidateState(manifest, runner, { allowedServingRevisions });
  if (revision === candidate) {
    const tagged = before.service.status?.traffic?.find(
      (target) => target.tag === manifest.candidate.tag && target.revisionName === candidate
    );
    if (!tagged?.url || tagged.url !== acceptance.taggedUrl) {
      fail("accepted tagged URL does not match the live candidate revision");
    }
    const candidateState = JSON.parse(
      await runner("gcloud", [
        "run",
        "revisions",
        "describe",
        candidate,
        `--project=${manifest.target.project}`,
        `--region=${manifest.target.region}`,
        "--format=json"
      ])
    );
    const ready = candidateState?.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True"
    );
    if (!ready) fail("accepted candidate revision is not Ready");
    const servingState = JSON.parse(
      await runner("gcloud", [
        "run",
        "revisions",
        "describe",
        before.servingRevision,
        `--project=${manifest.target.project}`,
        `--region=${manifest.target.region}`,
        "--format=json"
      ])
    );
    const servingInboxWriter = validateServingInboxWriterKey(servingState, manifest);
    const loadInboxSnapshot = dependencies.loadInboxSnapshot ?? defaultLoadInboxSnapshot;
    validateInboxKeyCompatibility(await loadInboxSnapshot(manifest, acceptance.taggedUrl, runner), manifest);
    const transition = await ensureProductionInboxSchedulerPaused(manifest, acceptance.taggedUrl, runner);
    try {
      await setPublicApiTraffic(manifest, revision, runner);
      await runAndVerifyProductionInboxScheduler(
        manifest,
        transition.endpoint,
        runner,
        dependencies.waitForSchedulerSuccess ?? defaultWaitForSchedulerSuccess
      );
    } catch (error) {
      let inboxTransition;
      try {
        inboxTransition = await (dependencies.fenceInboxProcessor ?? defaultFenceInboxProcessor)(
          manifest,
          acceptance.taggedUrl,
          runner
        );
      } catch (fenceError) {
        throw new Error(
          `candidate activation failed and inbox generation fencing failed; traffic was not rolled back: ${errorMessage(error)}; fence: ${errorMessage(fenceError)}`
        );
      }
      try {
        const paused = await pauseProductionInboxScheduler(manifest, runner);
        validateSchedulerJob(paused, manifest, transition.endpoint, "PAUSED");
      } catch (fenceError) {
        throw new Error(
          `candidate activation failed and scheduler fencing failed; traffic was not rolled back: ${errorMessage(error)}; fence: ${errorMessage(fenceError)}`
        );
      }
      try {
        await setPublicApiTraffic(manifest, before.servingRevision, runner);
      } catch (trafficError) {
        throw new Error(
          `candidate activation failed; scheduler is paused but prior traffic could not be restored: ${errorMessage(error)}; traffic: ${errorMessage(trafficError)}`
        );
      }
      try {
        await restoreProductionInboxScheduler(manifest, transition, runner);
      } catch (restoreError) {
        throw new Error(
          `candidate activation failed and traffic was restored to ${before.servingRevision}, but prior scheduler state could not be restored: ${errorMessage(error)}; scheduler: ${errorMessage(restoreError)}`
        );
      }
      if (servingInboxWriter.enabled) {
        try {
          await (dependencies.restoreInboxProcessor ?? defaultRestoreInboxProcessor)(
            manifest,
            acceptance.taggedUrl,
            inboxTransition,
            runner
          );
        } catch (restoreError) {
          throw new Error(
            `candidate activation failed and prior traffic/scheduler were restored, but the prior inbox mode could not be restored: ${errorMessage(error)}; inbox: ${errorMessage(restoreError)}`
          );
        }
      }
      throw new Error(
        `candidate activation failed; traffic and scheduler restored to their prior state: ${errorMessage(error)}`
      );
    }
    return revision;
  }

  const tagged = before.service.status?.traffic?.find(
    (target) => target.tag === manifest.candidate.tag && target.revisionName === candidate
  );
  if (!tagged?.url) fail("rollback requires the recorded candidate tagged URL for inbox fencing");
  const fenceInboxProcessor = dependencies.fenceInboxProcessor ?? defaultFenceInboxProcessor;
  const restoreInboxProcessor = dependencies.restoreInboxProcessor ?? defaultRestoreInboxProcessor;
  const inboxTransition = await fenceInboxProcessor(manifest, tagged.url, runner);
  const previousJob = await describeProductionInboxScheduler(manifest, runner);
  if (previousJob) validateOwnedSchedulerJob(previousJob, manifest);
  try {
    if (previousJob) await pauseProductionInboxScheduler(manifest, runner);
  } catch (error) {
    await restoreInboxProcessor(manifest, tagged.url, inboxTransition, runner);
    throw error;
  }
  try {
    await setPublicApiTraffic(manifest, revision, runner);
  } catch (error) {
    if (previousJob) {
      await restoreProductionInboxScheduler(manifest, { previousJob, endpoint: previousJob.httpTarget.uri }, runner);
    }
    await restoreInboxProcessor(manifest, tagged.url, inboxTransition, runner);
    throw error;
  }
  return revision;
}

async function defaultLoadInboxSnapshot(manifest, taggedUrl, runner) {
  const token = await loadProductInternalToken(manifest, runner);
  return loadInboxSnapshotWithToken(taggedUrl, token);
}

async function loadProductInternalToken(manifest, runner) {
  const secret = manifest.secrets.JINA_PRODUCT_INTERNAL_API_TOKEN;
  const value = await runner("gcloud", [
    "secrets",
    "versions",
    "access",
    secret.version,
    `--secret=${secret.name}`,
    `--project=${secret.project}`
  ]);
  const token = value.trim();
  if (!token) fail("product internal token is empty");
  return token;
}

async function loadInboxSnapshotWithToken(taggedUrl, token) {
  const response = await fetch(`${taggedUrl}/internal/github-webhook-inbox`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) fail(`candidate inbox snapshot failed with HTTP ${response.status}`);
  return response.json();
}

async function transitionInboxModeWithToken(taggedUrl, token, expectedGeneration, mode) {
  const response = await fetch(`${taggedUrl}/internal/github-webhook-inbox/mode`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-jina-principal-id": "production-cutover"
    },
    body: JSON.stringify({ expected_generation: expectedGeneration, mode }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) fail(`candidate inbox mode transition failed with HTTP ${response.status}`);
  return response.json();
}

async function defaultFenceInboxProcessor(manifest, taggedUrl, runner) {
  const token = await loadProductInternalToken(manifest, runner);
  const before = validateInboxFenceSnapshot(await loadInboxSnapshotWithToken(taggedUrl, token));
  const transition = {
    previousMode: before.control.mode,
    changed: before.control.mode !== "capture_only"
  };
  if (transition.changed) {
    await transitionInboxModeWithToken(taggedUrl, token, before.control.generation, "capture_only");
  }
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const snapshot = validateInboxFenceSnapshot(await loadInboxSnapshotWithToken(taggedUrl, token));
    if (isInboxFenceComplete(snapshot)) {
      return { ...transition, fencedGeneration: snapshot.control.generation };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail("inbox did not reach capture_only with zero active/prior-generation leases within 45 seconds");
}

async function defaultRestoreInboxProcessor(manifest, taggedUrl, transition, runner) {
  if (!transition?.changed || transition.previousMode === "capture_only") return;
  const token = await loadProductInternalToken(manifest, runner);
  validateInboxRestoreSnapshot(await loadInboxSnapshotWithToken(taggedUrl, token), transition);
  await transitionInboxModeWithToken(taggedUrl, token, transition.fencedGeneration, transition.previousMode);
}

export function validateInboxRestoreSnapshot(snapshotValue, transitionValue) {
  const snapshot = validateInboxFenceSnapshot(snapshotValue);
  const transition = object(transitionValue, "inbox fence transition");
  const fencedGeneration = integer(transition.fencedGeneration, 1, Number.MAX_SAFE_INTEGER, "inbox fenced generation");
  if (snapshot.control.generation !== fencedGeneration) {
    fail(`inbox mode compensation generation changed from ${fencedGeneration} to ${snapshot.control.generation}`);
  }
  if (snapshot.control.mode !== "capture_only" || snapshot.leased !== 0 || snapshot.priorGenerationLeases !== 0) {
    fail("inbox mode compensation requires a capture_only zero-lease fence");
  }
  return snapshot;
}

export function validateInboxFenceSnapshot(snapshotValue) {
  const snapshot = object(snapshotValue, "GitHub webhook inbox fence snapshot");
  const control = object(snapshot.control, "GitHub webhook inbox fence control");
  const modes = new Set(["capture_only", "canary_only", "capture_and_process", "legacy_forward"]);
  if (!modes.has(control.mode)) fail("GitHub webhook inbox fence mode is invalid");
  const generation = integer(control.generation, 1, Number.MAX_SAFE_INTEGER, "inbox fence generation");
  const leased = integer(snapshot.leased, 0, Number.MAX_SAFE_INTEGER, "inbox fence leased");
  const priorGenerationLeases = integer(
    snapshot.priorGenerationLeases,
    0,
    Number.MAX_SAFE_INTEGER,
    "inbox fence priorGenerationLeases"
  );
  return { control: { mode: control.mode, generation }, leased, priorGenerationLeases };
}

export function isInboxFenceComplete(snapshotValue) {
  const snapshot = validateInboxFenceSnapshot(snapshotValue);
  return snapshot.control.mode === "capture_only" && snapshot.leased === 0 && snapshot.priorGenerationLeases === 0;
}

async function setPublicApiTraffic(manifest, revision, runner) {
  await runner(
    "gcloud",
    [
      "run",
      "services",
      "update-traffic",
      manifest.target.service,
      `--project=${manifest.target.project}`,
      `--region=${manifest.target.region}`,
      `--to-revisions=${revision}=100`,
      "--quiet"
    ],
    { inherit: true }
  );
  const after = JSON.parse(
    await runner("gcloud", [
      "run",
      "services",
      "describe",
      manifest.target.service,
      `--project=${manifest.target.project}`,
      `--region=${manifest.target.region}`,
      "--format=json"
    ])
  );
  if (servingRevisionAtOneHundredPercent(after) !== revision) {
    fail(`traffic verification failed for ${revision}`);
  }
}

function schedulerDescribeArgs(manifest) {
  return [
    "scheduler",
    "jobs",
    "describe",
    manifest.scheduler.job,
    `--project=${manifest.target.project}`,
    `--location=${manifest.scheduler.location}`,
    "--format=json"
  ];
}

function validateSchedulerJob(job, manifest, endpoint, expectedState) {
  if (job.state !== expectedState) fail(`production inbox scheduler must be ${expectedState}`);
  if (job.schedule !== manifest.scheduler.schedule || job.timeZone !== manifest.scheduler.timeZone) {
    fail("production inbox scheduler cadence differs from manifest");
  }
  if (job.httpTarget?.uri !== endpoint || job.httpTarget?.httpMethod !== "POST") {
    fail("production inbox scheduler target differs from accepted candidate");
  }
  if (job.httpTarget?.headers?.["Content-Type"] !== "application/json") {
    fail("production inbox scheduler content type differs from manifest");
  }
  const customHeaders = Object.keys(job.httpTarget?.headers ?? {}).filter(
    (name) => name !== "Content-Type" && name !== "User-Agent"
  );
  if (customHeaders.length > 0) fail("production inbox scheduler contains unapproved custom headers");
  if (
    job.httpTarget?.oidcToken?.serviceAccountEmail !== manifest.scheduler.oidcServiceAccount ||
    job.httpTarget?.oidcToken?.audience !== manifest.scheduler.oidcAudience
  ) {
    fail("production inbox scheduler OIDC binding differs from manifest");
  }
}

function validateOwnedSchedulerJob(job, manifest) {
  if (job.state !== "ENABLED" && job.state !== "PAUSED") {
    fail(`production inbox scheduler has unsupported state ${job.state ?? "<missing>"}`);
  }
  const endpoint = job.httpTarget?.uri;
  if (
    typeof endpoint !== "string" ||
    !/^https:\/\/[a-z0-9-]+---[a-z0-9-]+(?:-[a-z0-9]+)*-[a-z]+\.a\.run\.app\/internal\/github-webhook-inbox\/process$/.test(
      endpoint
    )
  ) {
    fail("existing production inbox scheduler is not bound to an accepted tagged revision");
  }
  validateSchedulerJob(job, manifest, endpoint, job.state);
}

function validateEnvironmentDelta(live, manifest) {
  const candidate = new Map([
    ...Object.entries(manifest.environment).map(([name, value]) => [name, { kind: "literal", value }]),
    ...Object.entries(manifest.secrets).map(([name, secret]) => [
      name,
      {
        kind: "secret",
        identity: `${secret.project}/${secret.name}`,
        version: secret.version
      }
    ])
  ]);
  const names = new Set([...live.keys(), ...candidate.keys()]);
  for (const name of names) {
    const before = live.get(name);
    const after = candidate.get(name);
    if (sameEnvironmentBinding(before, after)) continue;
    if (!manifest.allowedEnvironmentChanges.has(name)) {
      fail(`environment binding ${name} differs without an explicit allowance`);
    }
  }
}

function serviceEnvironment(service) {
  return containerEnvironment(service?.spec?.template?.spec?.containers?.[0]);
}

function containerEnvironment(container) {
  const result = new Map();
  for (const entry of container?.env ?? []) {
    if (typeof entry.name !== "string") continue;
    if (typeof entry.value === "string") {
      result.set(entry.name, { kind: "literal", value: entry.value });
      continue;
    }
    const ref = entry.valueFrom?.secretKeyRef;
    if (ref?.name) {
      const project = ref.name.includes("/secrets/")
        ? ref.name.split("/secrets/")[0].replace(/^projects\//, "")
        : FIXED_TARGET.project;
      const name = ref.name.includes("/secrets/") ? ref.name.split("/secrets/")[1] : ref.name;
      result.set(entry.name, { kind: "secret", identity: `${project}/${name}`, version: ref.key });
    }
  }
  return result;
}

function isNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not[ _-]?found|does not exist/i.test(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sameEnvironmentBinding(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === "literal"
    ? left.value === right.value
    : left.identity === right.identity && left.version === right.version;
}

function servingRevisionAtOneHundredPercent(service) {
  const targets = (service?.status?.traffic ?? []).filter((target) => Number(target.percent) > 0);
  if (targets.length !== 1 || Number(targets[0].percent) !== 100 || !targets[0].revisionName) {
    fail("service must have exactly one explicit revision at 100 percent before mutation");
  }
  return targets[0].revisionName;
}

function candidateRevision(manifest) {
  return `${manifest.target.service}-${manifest.candidate.revisionSuffix}`;
}

async function probeHealth(url) {
  await runCommand("curl", ["--fail", "--silent", "--show-error", "--max-time", "15", url], { inherit: true });
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function stringMap(value, label) {
  const record = object(value, label);
  const result = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") fail(`${label}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${label} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`);
  return value;
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unexpected.length || missing.length) {
    fail(`${label} keys differ; missing=${missing.join(",")} unexpected=${unexpected.join(",")}`);
  }
}

function matchingString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function fail(message) {
  throw new Error(message);
}

async function main() {
  const [action, manifestPath, actionArgument] = process.argv.slice(2);
  if (!action || !manifestPath) {
    fail(
      "usage: deploy-public-api-candidate.mjs validate|deploy MANIFEST | promote MANIFEST EVIDENCE | rollback MANIFEST [REVISION]"
    );
  }
  const manifest = validatePublicApiCandidateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (action === "validate") {
    const result = await validatePublicApiCandidateState(manifest);
    console.log(JSON.stringify({ action, serving_revision: result.servingRevision }));
    return;
  }
  if (action === "deploy") {
    const result = await deployPublicApiCandidate(manifest);
    console.log(JSON.stringify({ action, revision: result.revision, tagged_url: result.taggedUrl }));
    return;
  }
  if (action === "promote") {
    if (!actionArgument) fail("promote requires an acceptance evidence JSON file");
    const revision = candidateRevision(manifest);
    const acceptanceEvidence = JSON.parse(await readFile(actionArgument, "utf8"));
    await updatePublicApiTraffic(manifest, revision, { acceptanceEvidence });
    console.log(JSON.stringify({ action, revision }));
    return;
  }
  if (action === "rollback") {
    const revision = actionArgument || manifest.rollbackRevision;
    await updatePublicApiTraffic(manifest, revision);
    console.log(JSON.stringify({ action, revision }));
    return;
  }
  fail(`unsupported action ${action}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
