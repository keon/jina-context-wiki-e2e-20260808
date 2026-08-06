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
  }
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
  return revision;
}

function validateEnvironmentDelta(live, manifest) {
  const candidate = new Map([
    ...Object.entries(manifest.environment).map(([name, value]) => [name, { kind: "literal", value }]),
    ...Object.entries(manifest.secrets).map(([name, secret]) => [
      name,
      {
        kind: "secret",
        identity: `${secret.project}/${secret.name}`
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
  const container = service?.spec?.template?.spec?.containers?.[0];
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
      result.set(entry.name, { kind: "secret", identity: `${project}/${name}` });
    }
  }
  return result;
}

function sameEnvironmentBinding(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === "literal" ? left.value === right.value : left.identity === right.identity;
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
