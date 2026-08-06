#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FIXED_TARGETS = Object.freeze({
  context: {
    service: "jina-context-worker",
    serviceAccount: "jina-context-worker@jina-v2.iam.gserviceaccount.com"
  },
  task: {
    service: "jina-task-worker",
    serviceAccount: "jina-task-worker@jina-v2.iam.gserviceaccount.com"
  }
});
const PROJECT = "jina-v2";
const REGION = "us-east1";
const CONTEXT_TOPICS = [
  "run-context-input-snapshot",
  "run-context-page-plan",
  "run-context-page-build",
  "run-context-publication"
].join("|");
const REQUIRED_SECRETS = Object.freeze({
  context: [
    "INTERNAL_API_TOKEN",
    "JINA_PRODUCT_INTERNAL_API_TOKEN",
    "DAYTONA_API_KEY",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_CLONE_TOKEN"
  ],
  task: ["INTERNAL_API_TOKEN", "OPENAI_API_KEY", "GITHUB_CLONE_TOKEN", "TRIGGER_SECRET_KEY"]
});

export function validateWorkerCandidateManifest(value) {
  const raw = object(value, "manifest");
  exactKeys(
    raw,
    ["schema_version", "release_id", "source_sha", "image", "api_url", "candidate", "workers"],
    "manifest"
  );
  if (raw.schema_version !== 1) fail("schema_version must be 1");
  const releaseId = matchingString(raw.release_id, /^[a-z0-9][a-z0-9-]{2,40}$/, "release_id");
  const sourceSha = matchingString(raw.source_sha, /^[0-9a-f]{40}$/, "source_sha");
  const image = matchingString(
    raw.image,
    /^us-east1-docker\.pkg\.dev\/jina-v2\/jina\/worker@sha256:[0-9a-f]{64}$/,
    "image must be the digest-pinned monorepo worker image"
  );
  const apiUrl = matchingString(raw.api_url, /^https:\/\/[^/~\s]+$/, "api_url");
  const candidate = object(raw.candidate, "candidate");
  exactKeys(candidate, ["revision_suffix", "tag"], "candidate");
  const revisionSuffix = matchingString(
    candidate.revision_suffix,
    /^[a-z0-9][a-z0-9-]{0,35}$/,
    "candidate.revision_suffix"
  );
  const tag = matchingString(candidate.tag, /^[a-z][a-z0-9-]{0,24}$/, "candidate.tag");

  const workersRaw = object(raw.workers, "workers");
  exactKeys(workersRaw, ["context", "task"], "workers");
  const workers = {};
  for (const kind of ["context", "task"]) {
    const worker = object(workersRaw[kind], `workers.${kind}`);
    exactKeys(worker, ["runtime", "environment", "secrets"], `workers.${kind}`);
    const runtime = normalizeRuntime(worker.runtime, `workers.${kind}.runtime`);
    const environment = stringMap(worker.environment, `workers.${kind}.environment`);
    const secrets = secretMap(worker.secrets, `workers.${kind}.secrets`);
    validateWorkerEnvironment(kind, environment, apiUrl);
    for (const name of REQUIRED_SECRETS[kind]) {
      if (!secrets[name]) fail(`workers.${kind}.secrets.${name} is required`);
    }
    if (environment.JINA_WORKER_RELEASE_ID || secrets.JINA_WORKER_RELEASE_CREDENTIAL) {
      fail(`workers.${kind} candidate cannot receive an accepted release identity`);
    }
    workers[kind] = { runtime, environment, secrets, ...FIXED_TARGETS[kind] };
  }
  return {
    schemaVersion: 1,
    releaseId,
    sourceSha,
    image,
    apiUrl,
    candidate: { revisionSuffix, tag },
    workers,
    project: PROJECT,
    region: REGION
  };
}

export function buildWorkerCandidateDeployArgs(manifest, kind) {
  const worker = manifest.workers[kind];
  if (!worker) fail(`unknown worker kind ${kind}`);
  const environment = Object.entries(worker.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("~");
  const secrets = Object.entries(worker.secrets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, secret]) => `${name}=projects/${secret.project}/secrets/${secret.name}:${secret.version}`)
    .join(",");
  return [
    "run",
    "deploy",
    worker.service,
    `--project=${manifest.project}`,
    `--region=${manifest.region}`,
    `--image=${manifest.image}`,
    `--service-account=${worker.serviceAccount}`,
    "--no-allow-unauthenticated",
    `--concurrency=${worker.runtime.concurrency}`,
    `--timeout=${worker.runtime.timeoutSeconds}`,
    `--min-instances=${worker.runtime.minInstances}`,
    `--max-instances=${worker.runtime.maxInstances}`,
    `--cpu=${worker.runtime.cpu}`,
    `--memory=${worker.runtime.memory}`,
    "--no-cpu-throttling",
    `--set-env-vars=^~^${environment}`,
    `--set-secrets=${secrets}`,
    "--no-traffic",
    `--tag=${manifest.candidate.tag}`,
    `--revision-suffix=${manifest.candidate.revisionSuffix}`,
    "--quiet"
  ];
}

export async function validateWorkerCandidateState(manifest, runner = runCommand) {
  const image = (
    await runner("gcloud", [
      "artifacts",
      "docker",
      "images",
      "describe",
      manifest.image,
      "--format=value(image_summary.fully_qualified_digest)"
    ])
  ).trim();
  if (image !== manifest.image) fail("Artifact Registry did not resolve the exact worker digest");

  const serving = {};
  for (const kind of ["context", "task"]) {
    const worker = manifest.workers[kind];
    const service = JSON.parse(
      await runner("gcloud", [
        "run",
        "services",
        "describe",
        worker.service,
        `--project=${manifest.project}`,
        `--region=${manifest.region}`,
        "--format=json"
      ])
    );
    if (service?.spec?.template?.spec?.serviceAccountName !== worker.serviceAccount) {
      fail(`${worker.service} live service account differs from its fixed identity`);
    }
    serving[kind] = servingRevisionAtOneHundredPercent(service);
    for (const secret of Object.values(worker.secrets)) {
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
      if (state !== "ENABLED") {
        fail(`secret ${secret.project}/${secret.name}:${secret.version} is not enabled`);
      }
    }
  }
  return serving;
}

export async function deployWorkerCandidates(manifest, dependencies = {}) {
  const runner = dependencies.runner ?? runCommand;
  const before = await validateWorkerCandidateState(manifest, runner);
  const deployed = {};
  for (const kind of ["context", "task"]) {
    const worker = manifest.workers[kind];
    await runner("gcloud", buildWorkerCandidateDeployArgs(manifest, kind), { inherit: true });
    const service = JSON.parse(
      await runner("gcloud", [
        "run",
        "services",
        "describe",
        worker.service,
        `--project=${manifest.project}`,
        `--region=${manifest.region}`,
        "--format=json"
      ])
    );
    if (servingRevisionAtOneHundredPercent(service) !== before[kind]) {
      fail(`${worker.service} candidate deployment changed serving traffic`);
    }
    const revisionName = `${worker.service}-${manifest.candidate.revisionSuffix}`;
    const tagged = service.status?.traffic?.find(
      (target) => target.tag === manifest.candidate.tag && target.revisionName === revisionName
    );
    if (!tagged?.url) fail(`${worker.service} candidate tag is missing`);
    const revision = JSON.parse(
      await runner("gcloud", [
        "run",
        "revisions",
        "describe",
        revisionName,
        `--project=${manifest.project}`,
        `--region=${manifest.region}`,
        "--format=json"
      ])
    );
    validatePausedRevision(revision, worker);
    deployed[kind] = { revision: revisionName, taggedUrl: tagged.url };
  }
  return deployed;
}

function validateWorkerEnvironment(kind, environment, apiUrl) {
  const required = {
    GOOGLE_CLOUD_PROJECT: PROJECT,
    JINA_API_URL: apiUrl,
    JINA_WORKER_CLAIM_MODE: "paused",
    ...(kind === "context"
      ? { WORKER_TOPICS: CONTEXT_TOPICS, CONTEXT_BOARD_EXECUTOR: "daytona" }
      : { WORKER_TOPICS: "run-review", JINA_REVIEW_RUN_TOPIC_MODE: "relational" })
  };
  for (const [name, expected] of Object.entries(required)) {
    if (environment[name] !== expected) fail(`workers.${kind}.environment.${name} must be ${expected}`);
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail(`invalid environment name ${name}`);
    if (/[~\0\r\n]/.test(value)) fail(`environment ${name} contains a forbidden delimiter`);
    if (/(?:SECRET_KEY|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)$/.test(name)) {
      fail(`secret-looking ${name} must use the secrets map`);
    }
  }
}

function validatePausedRevision(revision, worker) {
  const ready = revision?.status?.conditions?.some(
    (condition) => condition.type === "Ready" && condition.status === "True"
  );
  if (!ready) fail(`${worker.service} candidate revision is not Ready`);
  if (revision?.spec?.serviceAccountName !== worker.serviceAccount) {
    fail(`${worker.service} candidate revision has the wrong service account`);
  }
  const env = serviceEnvironment(revision);
  if (env.get("JINA_WORKER_CLAIM_MODE")?.value !== "paused") {
    fail(`${worker.service} candidate is not paused`);
  }
  if (env.has("JINA_WORKER_RELEASE_ID") || env.has("JINA_WORKER_RELEASE_CREDENTIAL")) {
    fail(`${worker.service} candidate received a release identity`);
  }
}

function serviceEnvironment(resource) {
  const entries = resource?.spec?.containers?.[0]?.env ?? [];
  const result = new Map();
  for (const entry of entries) {
    if (typeof entry.name !== "string") continue;
    if (typeof entry.value === "string") result.set(entry.name, { value: entry.value });
    else if (entry.valueFrom?.secretKeyRef) result.set(entry.name, { secret: true });
  }
  return result;
}

function normalizeRuntime(value, label) {
  const runtime = object(value, label);
  exactKeys(runtime, ["concurrency", "timeout_seconds", "min_instances", "max_instances", "cpu", "memory"], label);
  const normalized = {
    concurrency: integer(runtime.concurrency, 1, 1_000, `${label}.concurrency`),
    timeoutSeconds: integer(runtime.timeout_seconds, 1, 3_600, `${label}.timeout_seconds`),
    minInstances: integer(runtime.min_instances, 0, 1_000, `${label}.min_instances`),
    maxInstances: integer(runtime.max_instances, 1, 1_000, `${label}.max_instances`),
    cpu: matchingString(runtime.cpu, /^[1-9][0-9]*(?:m)?$/, `${label}.cpu`),
    memory: matchingString(runtime.memory, /^[1-9][0-9]*(?:Mi|Gi)$/, `${label}.memory`)
  };
  if (normalized.minInstances > normalized.maxInstances) {
    fail(`${label}.min_instances cannot exceed max_instances`);
  }
  return normalized;
}

function secretMap(value, label) {
  const result = {};
  for (const [environmentName, raw] of Object.entries(object(value, label))) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(environmentName)) {
      fail(`invalid secret environment name ${environmentName}`);
    }
    const secret = object(raw, `${label}.${environmentName}`);
    exactKeys(secret, ["project", "name", "version"], `${label}.${environmentName}`);
    result[environmentName] = {
      project: matchingString(secret.project, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, `${label}.${environmentName}.project`),
      name: matchingString(secret.name, /^[A-Za-z][A-Za-z0-9_-]{0,254}$/, `${label}.${environmentName}.name`),
      version: matchingString(secret.version, /^[1-9][0-9]*$/, `${label}.${environmentName}.version`)
    };
  }
  return result;
}

function servingRevisionAtOneHundredPercent(service) {
  const targets = (service?.status?.traffic ?? []).filter((target) => Number(target.percent) > 0);
  if (targets.length !== 1 || Number(targets[0].percent) !== 100 || !targets[0].revisionName) {
    fail("worker service must have one explicit revision at 100 percent");
  }
  return targets[0].revisionName;
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
  const result = {};
  for (const [key, entry] of Object.entries(object(value, label))) {
    if (typeof entry !== "string") fail(`${label}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
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
  const [action, manifestPath] = process.argv.slice(2);
  if (!action || !manifestPath) {
    fail("usage: deploy-production-worker-candidates.mjs validate|deploy MANIFEST");
  }
  const manifest = validateWorkerCandidateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (action === "validate") {
    const serving = await validateWorkerCandidateState(manifest);
    console.log(JSON.stringify({ action, serving }));
    return;
  }
  if (action === "deploy") {
    const deployed = await deployWorkerCandidates(manifest);
    console.log(JSON.stringify({ action, deployed }));
    return;
  }
  fail(`unsupported action ${action}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
