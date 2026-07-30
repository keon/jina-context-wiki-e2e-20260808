#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_VERSION = "context-daytona-board-stage-e2e-v1";
const RESULT_FILE = "result.json";
const MANIFEST_FILE = "manifest.json";
const DECLARED_OUTPUT_PATH = "proof.md";
const DECLARED_OUTPUT_CONTENT_TYPE = "text/markdown";
const MAX_DECLARED_OUTPUT_BYTES = 128 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_CONTEXT_TOKENS = 128_000;
const DEFAULT_COMPACT_TOKENS = 96_000;
const DEFAULT_CLEANUP_ATTEMPTS = 12;
const DEFAULT_CLEANUP_INTERVAL_MS = 1_000;

const RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["completed", "packageName"],
  properties: {
    completed: { type: "boolean", const: true },
    packageName: { type: "string", minLength: 1, maxLength: 214 }
  }
});

const HELP = `Usage: context-daytona-board-stage-e2e.mjs [options]

Required:
  --repository PATH       Git repository to archive (JINA_CONTEXT_REPOSITORY_PATH)
  --commit SHA            Exact full commit SHA (JINA_CONTEXT_COMMIT_SHA)
  --output-dir PATH       New or empty retained-evidence directory

Required environment:
  DAYTONA_API_KEY
  CONTEXT_DAYTONA_SNAPSHOT
  CONTEXT_DAYTONA_MODEL_SECRET

Configured environment:
  CONTEXT_DAYTONA_MODEL_SECRET_ENV  Must be OPENAI_API_KEY (default)
  CONTEXT_DAYTONA_MODEL_DOMAINS     Must be api.openai.com (default)
  CONTEXT_CODEX_MODEL               Default: gpt-5.6-terra
  CONTEXT_CODEX_EFFORT              Default: low
  CONTEXT_CODEX_VERBOSITY           Default: high
  CONTEXT_CODEX_CONTEXT_TOKENS      Default: 128000
  CONTEXT_CODEX_COMPACT_TOKENS      Default: 96000

Optional:
  --stage-id ID           Unique retained stage ID
  --timeout-seconds N     Default: 300
  --cleanup-attempts N    Default: 12
  --cleanup-interval-ms N Default: 1000

Credentials are accepted only through the environment. The harness never
forwards host Codex session state or a model credential value. It passes the
Daytona API key only to the Daytona SDK and mounts the configured organization
Secret by name.
`;

export async function runContextDaytonaBoardStageAcceptance(options, dependencies = {}) {
  const config = normalizeOptions(options);
  const protectedValues = protectedEnvironmentValues(config.environment);
  await prepareOutputDirectory(config.outputDirectory);

  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const startedAt = now().toISOString();
  let archive;
  let observer;
  let snapshotBefore;
  let snapshotAfter;
  let baselineSandboxes;
  let cleanup = { status: "not_run", attempts: 0, residualSandboxes: [] };
  let envelope;
  let envelopeValidation;
  let executionError;
  const violations = [];

  try {
    archive = await (dependencies.createArchive ?? createCommitPinnedArchive)({
      repository: config.repository,
      commitSha: config.commitSha
    });
    observer = await (dependencies.createObserver ?? createDaytonaObserver)({
      daytonaApiKey: config.environment.DAYTONA_API_KEY
    });
    snapshotBefore = snapshotMetadata(await observer.getSnapshot(config.snapshot));
    validateActiveSnapshot(snapshotBefore, config.snapshot);
    baselineSandboxes = await observer.listStageSandboxes(config.stageId);
    if (!Array.isArray(baselineSandboxes)) throw new Error("Daytona sandbox observer returned a non-array baseline");
    if (baselineSandboxes.length > 0) {
      violations.push({
        code: "stage_id_not_unique",
        message: "The stage ID already identifies a Daytona sandbox; choose a new stage ID"
      });
    } else {
      const runner = await (dependencies.createRunner ?? createConfiguredDaytonaRunner)({
        environment: config.runnerEnvironment,
        protectedValues
      });
      if (!runner || runner.mode !== "daytona" || typeof runner.run !== "function") {
        throw new Error("configured low-level Board runner is not a Daytona runner");
      }
      try {
        envelope = await runner.run({
          id: config.stageId,
          prompt: proofPrompt(config.commitSha),
          schema: RESULT_SCHEMA,
          repository: {
            commitSha: archive.commitSha,
            archive: archive.bytes,
            sha256: archive.sha256
          },
          artifacts: [],
          limits: {
            timeoutSeconds: config.timeoutSeconds,
            contextTokens: config.contextTokens,
            compactTokens: config.compactTokens,
            attempt: 1,
            maxAttempts: 1,
            maxOutputBytes: 64 * 1024
          },
          outputFiles: [
            {
              path: DECLARED_OUTPUT_PATH,
              contentType: DECLARED_OUTPUT_CONTENT_TYPE,
              maxBytes: MAX_DECLARED_OUTPUT_BYTES
            }
          ]
        });
        envelopeValidation = validateEnvelope(envelope, {
          expectedPackageName: archive.packageName,
          commitSha: archive.commitSha,
          protectedValues
        });
      } catch (error) {
        executionError = safeError(error, protectedValues);
      }

      try {
        snapshotAfter = snapshotMetadata(await observer.getSnapshot(config.snapshot));
        validateSnapshotContinuity(snapshotBefore, snapshotAfter);
      } catch (error) {
        violations.push({ code: "snapshot_metadata_mismatch", message: safeError(error, protectedValues) });
      }

      cleanup = await attestZeroResidualSandboxes({
        observer,
        stageId: config.stageId,
        attempts: config.cleanupAttempts,
        intervalMs: config.cleanupIntervalMs,
        sleep,
        protectedValues
      });
      if (cleanup.status !== "passed") {
        violations.push({
          code: cleanup.status === "residual" ? "residual_sandbox" : "cleanup_uncertain",
          message:
            cleanup.status === "residual"
              ? "A Daytona sandbox with the retained stage label still exists"
              : (cleanup.error ?? "The harness could not attest sandbox cleanup")
        });
      }
    }
  } catch (error) {
    executionError = safeError(error, protectedValues);
  } finally {
    if (observer?.dispose) {
      try {
        await observer.dispose();
      } catch (error) {
        violations.push({ code: "observer_dispose_failed", message: safeError(error, protectedValues) });
      }
    }
    if (archive?.temporaryDirectory) {
      await rm(archive.temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (executionError) {
    violations.push({ code: "stage_execution_failed", message: executionError });
  }
  if (!envelopeValidation && !executionError && baselineSandboxes?.length === 0) {
    violations.push({ code: "missing_envelope", message: "The Daytona Board stage returned no validated envelope" });
  }

  const completedAt = now().toISOString();
  const status = violations.length === 0 ? "passed" : "failed";
  const retainedFiles = [];
  if (envelopeValidation) {
    await writeSecure(join(config.outputDirectory, RESULT_FILE), envelope.bytes);
    retainedFiles.push({
      path: RESULT_FILE,
      contentType: envelope.contentType,
      byteLength: envelope.byteLength,
      sha256: envelope.sha256
    });
    for (const file of envelope.files) {
      const retainedPath = join("files", file.path);
      await writeSecure(join(config.outputDirectory, retainedPath), file.bytes);
      retainedFiles.push({
        path: retainedPath,
        sourcePath: file.path,
        contentType: file.contentType,
        byteLength: file.bytes.byteLength,
        sha256: file.sha256
      });
    }
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    status,
    startedAt,
    completedAt,
    stage: {
      id: config.stageId,
      strictSchemaSha256: sha256(Buffer.from(canonicalJson(RESULT_SCHEMA), "utf8")),
      declaredOutputs: [
        {
          path: DECLARED_OUTPUT_PATH,
          contentType: DECLARED_OUTPUT_CONTENT_TYPE,
          maxBytes: MAX_DECLARED_OUTPUT_BYTES
        }
      ],
      limits: {
        timeoutSeconds: config.timeoutSeconds,
        contextTokens: config.contextTokens,
        compactTokens: config.compactTokens,
        attempt: 1,
        maxAttempts: 1
      }
    },
    source: archive
      ? {
          repository: config.repository,
          commitSha: archive.commitSha,
          archiveByteLength: archive.bytes.byteLength,
          archiveSha256: archive.sha256,
          packageName: archive.packageName,
          dirtyWorktreeExcluded: true,
          archiveFormat: "ustar+gzip"
        }
      : {
          repository: config.repository,
          commitSha: config.commitSha,
          dirtyWorktreeExcluded: true,
          archiveFormat: "ustar+gzip"
        },
    executor: {
      mode: "daytona",
      snapshot: config.snapshot,
      modelSecretName: config.modelSecretName,
      modelSecretEnvironment: config.modelSecretEnvironment,
      allowedDomains: config.allowedDomains,
      model: config.model,
      effort: config.effort,
      verbosity: config.verbosity,
      hostCodexSessionForwarded: false,
      hostModelCredentialForwarded: false
    },
    snapshot: {
      ...(snapshotBefore ? { before: snapshotBefore } : {}),
      ...(snapshotAfter ? { after: snapshotAfter } : {})
    },
    cleanup: {
      status: cleanup.status,
      attempts: cleanup.attempts,
      residualSandboxes: cleanup.residualSandboxes,
      ...(cleanup.error ? { error: cleanup.error } : {})
    },
    ...(envelopeValidation
      ? {
          envelope: {
            version: envelope.version,
            contentType: envelope.contentType,
            byteLength: envelope.byteLength,
            sha256: envelope.sha256,
            canonicalJson: true,
            usage: envelope.usage,
            result: envelopeValidation.result,
            declaredOutputs: envelopeValidation.files
          }
        }
      : {}),
    retainedFiles,
    violations
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assertNoProtectedValue(manifestBytes, protectedValues, "retained manifest");
  await writeSecure(join(config.outputDirectory, MANIFEST_FILE), manifestBytes);
  return manifest;
}

export async function createCommitPinnedArchive({ repository, commitSha }) {
  const repositoryRoot = resolve(repository);
  const normalizedCommit = requiredGitSha(commitSha, "commit");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "jina-daytona-board-e2e-"));
  try {
    const resolvedCommit = (
      await execFileText("git", ["-C", repositoryRoot, "rev-parse", "--verify", `${normalizedCommit}^{commit}`])
    ).trim();
    if (resolvedCommit.toLowerCase() !== normalizedCommit) {
      throw new Error("the requested commit did not resolve to the exact supplied SHA");
    }
    const sourceTar = join(temporaryDirectory, "source.tar");
    const snapshotRoot = join(temporaryDirectory, "snapshot");
    const archiveTarPath = join(temporaryDirectory, "repository.tar");
    await mkdir(snapshotRoot, { mode: 0o700 });
    await execFileBounded(
      "git",
      ["-C", repositoryRoot, "archive", "--format=tar", `--output=${sourceTar}`, resolvedCommit],
      repositoryRoot
    );
    await assertBoundedFile(sourceTar, 1, MAX_EXPANDED_ARCHIVE_BYTES, "Git commit archive");
    await execFileBounded("tar", ["--extract", "--file", sourceTar, "--directory", snapshotRoot], repositoryRoot);
    const entries = (await readdir(snapshotRoot)).sort();
    if (entries.length === 0) throw new Error("the commit archive contains no files");
    await execFileBounded(
      "tar",
      ["--format", "ustar", "-cf", archiveTarPath, "-C", snapshotRoot, "--", ...entries],
      repositoryRoot,
      { COPYFILE_DISABLE: "1", LC_ALL: "C", TZ: "UTC" }
    );
    await assertBoundedFile(archiveTarPath, 1, MAX_EXPANDED_ARCHIVE_BYTES, "ustar commit archive");
    const bytes = gzipSync(await readFile(archiveTarPath), { level: 9, mtime: 0 });
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`commit archive must be 1..${MAX_ARCHIVE_BYTES} bytes`);
    }
    const packagePath = join(snapshotRoot, "package.json");
    const packageSize = (await stat(packagePath)).size;
    if (!Number.isSafeInteger(packageSize) || packageSize < 2 || packageSize > MAX_PACKAGE_JSON_BYTES) {
      throw new Error("the committed root package.json is outside the proof bound");
    }
    const packageDocument = JSON.parse(await readFile(packagePath, "utf8"));
    const packageName = requiredString(packageDocument?.name, "committed root package name");
    return {
      commitSha: normalizedCommit,
      bytes,
      sha256: sha256(bytes),
      packageName,
      temporaryDirectory
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function createConfiguredDaytonaRunner({ environment, protectedValues }) {
  const modulePath = join(PROJECT_ROOT, "apps/worker/dist/board-agent-stage-adapter.js");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.configuredBoardAgentRunner !== "function") {
    throw new Error("built worker adapter does not export configuredBoardAgentRunner");
  }
  return module.configuredBoardAgentRunner(environment, protectedValues);
}

async function createDaytonaObserver({ daytonaApiKey }) {
  const daytonaModulePath = join(PROJECT_ROOT, "packages/daytona/dist/index.js");
  const daytonaRequire = createRequire(pathToFileURL(daytonaModulePath));
  const { Daytona } = await import(pathToFileURL(daytonaRequire.resolve("@daytona/sdk")).href);
  const daytona = new Daytona({ apiKey: daytonaApiKey });
  return {
    getSnapshot: (name) => daytona.snapshot.get(name),
    async listStageSandboxes(stageId) {
      const sandboxes = [];
      for await (const sandbox of daytona.list({ labels: { "jina-stage-id": stageId } })) {
        sandboxes.push(sandboxSummary(sandbox));
      }
      return sandboxes;
    },
    dispose: () => daytona[Symbol.asyncDispose]()
  };
}

async function attestZeroResidualSandboxes({ observer, stageId, attempts, intervalMs, sleep, protectedValues }) {
  let lastError;
  let residualSandboxes = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const observed = await observer.listStageSandboxes(stageId);
      if (!Array.isArray(observed)) throw new Error("Daytona sandbox observer returned a non-array result");
      residualSandboxes = observed.map(sandboxSummary);
      lastError = undefined;
      if (residualSandboxes.length === 0) {
        return { status: "passed", attempts: attempt, residualSandboxes: [] };
      }
    } catch (error) {
      lastError = safeError(error, protectedValues);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  return lastError
    ? { status: "uncertain", attempts, residualSandboxes, error: lastError }
    : { status: "residual", attempts, residualSandboxes };
}

function validateEnvelope(envelope, { expectedPackageName, commitSha, protectedValues }) {
  if (!envelope || envelope.version !== 1 || envelope.contentType !== "application/json") {
    throw new Error("Board stage returned an unsupported envelope");
  }
  if (!(envelope.bytes instanceof Uint8Array) || envelope.bytes.byteLength < 2) {
    throw new Error("Board stage returned empty or non-byte JSON");
  }
  if (envelope.byteLength !== envelope.bytes.byteLength || envelope.sha256 !== sha256(envelope.bytes)) {
    throw new Error("Board stage envelope length or digest does not match its canonical bytes");
  }
  assertNoProtectedValue(envelope.bytes, protectedValues, "Board stage result");
  const resultText = Buffer.from(envelope.bytes).toString("utf8");
  const result = JSON.parse(resultText);
  if (resultText !== canonicalJson(result)) throw new Error("Board stage result is not canonical JSON");
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).sort().join(",") !== "completed,packageName" ||
    result.completed !== true ||
    result.packageName !== expectedPackageName
  ) {
    throw new Error("Board stage result does not satisfy the retained strict-schema assertion");
  }
  const usage = envelope.usage;
  for (const name of ["inputTokens", "cachedInputTokens", "outputTokens"]) {
    if (!Number.isSafeInteger(usage?.[name]) || usage[name] < 0) {
      throw new Error(`Board stage envelope has invalid ${name}`);
    }
  }
  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new Error("Board stage cached input exceeds input usage");
  }
  if (!Array.isArray(envelope.files) || envelope.files.length !== 1) {
    throw new Error("Board stage did not return exactly one declared output");
  }
  const file = envelope.files[0];
  if (
    file.path !== DECLARED_OUTPUT_PATH ||
    file.contentType !== DECLARED_OUTPUT_CONTENT_TYPE ||
    file.maxBytes !== MAX_DECLARED_OUTPUT_BYTES ||
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength < 1 ||
    file.bytes.byteLength > file.maxBytes ||
    file.sha256 !== sha256(file.bytes)
  ) {
    throw new Error("Board stage declared-output metadata or digest is invalid");
  }
  assertNoProtectedValue(file.bytes, protectedValues, "Board stage declared output");
  const markdown = Buffer.from(file.bytes).toString("utf8");
  if (!markdown.includes(expectedPackageName) || !markdown.includes(commitSha)) {
    throw new Error("Board stage proof document is not bound to the expected package and commit");
  }
  return {
    result,
    files: [
      {
        path: file.path,
        contentType: file.contentType,
        maxBytes: file.maxBytes,
        byteLength: file.bytes.byteLength,
        sha256: file.sha256
      }
    ]
  };
}

function validateActiveSnapshot(snapshot, expectedName) {
  if (snapshot.name !== expectedName || snapshot.state !== "active") {
    throw new Error("configured Daytona snapshot is missing or not active");
  }
  requiredString(snapshot.id, "Daytona snapshot ID");
  requiredTimestamp(snapshot.createdAt, "Daytona snapshot createdAt");
  requiredTimestamp(snapshot.updatedAt, "Daytona snapshot updatedAt");
}

function validateSnapshotContinuity(before, after) {
  validateActiveSnapshot(after, before.name);
  if (
    after.id !== before.id ||
    after.createdAt !== before.createdAt ||
    after.cpu !== before.cpu ||
    after.memoryGiB !== before.memoryGiB ||
    after.diskGiB !== before.diskGiB ||
    Date.parse(after.updatedAt) < Date.parse(before.updatedAt)
  ) {
    throw new Error("configured Daytona snapshot identity changed during the Board stage");
  }
}

function snapshotMetadata(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Daytona snapshot metadata is unavailable");
  }
  return {
    id: requiredString(snapshot.id, "Daytona snapshot ID"),
    name: requiredString(snapshot.name, "Daytona snapshot name"),
    state: requiredString(snapshot.state, "Daytona snapshot state"),
    createdAt: timestampString(snapshot.createdAt, "Daytona snapshot createdAt"),
    updatedAt: timestampString(snapshot.updatedAt, "Daytona snapshot updatedAt"),
    ...(snapshot.lastUsedAt ? { lastUsedAt: timestampString(snapshot.lastUsedAt, "Daytona snapshot lastUsedAt") } : {}),
    ...(safeResource(snapshot.cpu) ? { cpu: snapshot.cpu } : {}),
    ...(safeResource(snapshot.mem) ? { memoryGiB: snapshot.mem } : {}),
    ...(safeResource(snapshot.disk) ? { diskGiB: snapshot.disk } : {})
  };
}

function sandboxSummary(sandbox) {
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) {
    throw new Error("Daytona returned invalid sandbox metadata");
  }
  return {
    id: requiredString(sandbox.id, "Daytona sandbox ID"),
    ...(typeof sandbox.name === "string" && sandbox.name.trim() ? { name: sandbox.name.trim() } : {}),
    ...(typeof sandbox.state === "string" && sandbox.state.trim() ? { state: sandbox.state.trim() } : {})
  };
}

function normalizeOptions(options) {
  const environment = options.environment ?? process.env;
  const repository = resolve(requiredString(options.repository, "repository"));
  const outputDirectory = resolve(requiredString(options.outputDirectory, "output directory"));
  if (repository === outputDirectory) throw new Error("output directory must not be the repository root");
  const commitSha = requiredGitSha(options.commitSha, "commit");
  const stageId =
    options.stageId ?? `daytona-board-e2e-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(stageId)) throw new Error("stage ID is invalid");
  const daytonaApiKey = requiredEnvironment(environment, "DAYTONA_API_KEY");
  if (daytonaApiKey.length < 8 || daytonaApiKey.length > 8_192) {
    throw new Error("DAYTONA_API_KEY is outside the accepted credential bound");
  }
  const snapshot = requiredEnvironment(environment, "CONTEXT_DAYTONA_SNAPSHOT");
  if (environment.CONTEXT_DAYTONA_IMAGE?.trim()) {
    throw new Error("retained Daytona Board-stage acceptance requires a snapshot, not an image");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(snapshot)) {
    throw new Error("CONTEXT_DAYTONA_SNAPSHOT is invalid");
  }
  const modelSecretName = requiredEnvironment(environment, "CONTEXT_DAYTONA_MODEL_SECRET");
  if (/^sk[-_]/i.test(modelSecretName)) {
    throw new Error("CONTEXT_DAYTONA_MODEL_SECRET must be an organization Secret name");
  }
  const modelSecretEnvironment = environment.CONTEXT_DAYTONA_MODEL_SECRET_ENV?.trim() || "OPENAI_API_KEY";
  if (modelSecretEnvironment !== "OPENAI_API_KEY") {
    throw new Error("retained Daytona Board-stage acceptance requires OPENAI_API_KEY organization-secret mapping");
  }
  const allowedDomains = commaSeparated(environment.CONTEXT_DAYTONA_MODEL_DOMAINS ?? "api.openai.com");
  if (allowedDomains.length !== 1 || allowedDomains[0] !== "api.openai.com") {
    throw new Error("retained Daytona Board-stage acceptance requires the exact api.openai.com allowlist");
  }
  const model = (environment.CONTEXT_CODEX_MODEL?.trim() || "gpt-5.6-terra").replace(/^openai\//, "");
  const effort = environment.CONTEXT_CODEX_EFFORT?.trim() || "low";
  const verbosity = environment.CONTEXT_CODEX_VERBOSITY?.trim() || "high";
  const contextTokens = boundedInt(
    options.contextTokens ?? environment.CONTEXT_CODEX_CONTEXT_TOKENS,
    DEFAULT_CONTEXT_TOKENS,
    4_096,
    256_000,
    "context tokens"
  );
  const compactTokens = boundedInt(
    options.compactTokens ?? environment.CONTEXT_CODEX_COMPACT_TOKENS,
    DEFAULT_COMPACT_TOKENS,
    1,
    contextTokens - 1,
    "compact tokens"
  );
  const timeoutSeconds = boundedInt(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 30, 7_200, "timeout seconds");
  const cleanupAttempts = boundedInt(options.cleanupAttempts, DEFAULT_CLEANUP_ATTEMPTS, 1, 120, "cleanup attempts");
  const cleanupIntervalMs = boundedInt(
    options.cleanupIntervalMs,
    DEFAULT_CLEANUP_INTERVAL_MS,
    0,
    10_000,
    "cleanup interval"
  );
  const runnerEnvironment = Object.freeze({
    NODE_ENV: "production",
    CONTEXT_BOARD_EXECUTOR: "daytona",
    DAYTONA_API_KEY: daytonaApiKey,
    CONTEXT_DAYTONA_SNAPSHOT: snapshot,
    CONTEXT_DAYTONA_MODEL_SECRET: modelSecretName,
    CONTEXT_DAYTONA_MODEL_SECRET_ENV: modelSecretEnvironment,
    CONTEXT_DAYTONA_MODEL_DOMAINS: allowedDomains.join(","),
    CONTEXT_CODEX_MODEL: model,
    CONTEXT_CODEX_EFFORT: effort,
    CONTEXT_CODEX_VERBOSITY: verbosity,
    CONTEXT_CODEX_CONTEXT_TOKENS: String(contextTokens),
    CONTEXT_CODEX_COMPACT_TOKENS: String(compactTokens)
  });
  return {
    environment,
    repository,
    outputDirectory,
    commitSha,
    stageId,
    snapshot,
    modelSecretName,
    modelSecretEnvironment,
    allowedDomains,
    model,
    effort,
    verbosity,
    contextTokens,
    compactTokens,
    timeoutSeconds,
    cleanupAttempts,
    cleanupIntervalMs,
    runnerEnvironment
  };
}

function proofPrompt(commitSha) {
  return [
    `This acceptance task is incomplete until output/${DECLARED_OUTPUT_PATH} exists and is non-empty. Do not return the final JSON before verifying that exact file with the shell tool.`,
    "Read repository/package.json from the supplied immutable repository snapshot.",
    `Use the shell tool to write output/${DECLARED_OUTPUT_PATH} as concise engineering documentation with a heading, the exact root package name, and commit ${commitSha}.`,
    'Return exactly the strict JSON object {"completed":true,"packageName":"<the exact root package name>"} after writing the declared file.',
    "Do not inspect credentials, environment variables, host configuration, or paths outside the supplied workspace."
  ].join("\n\n");
}

async function prepareOutputDirectory(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const entries = await readdir(outputDirectory);
  if (entries.length > 0) throw new Error("output directory must be empty");
}

async function writeSecure(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function assertBoundedFile(path, minimum, maximum, name) {
  const size = (await stat(path)).size;
  if (!Number.isSafeInteger(size) || size < minimum || size > maximum) {
    throw new Error(`${name} must be ${minimum}..${maximum} bytes`);
  }
}

async function execFileText(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: deterministicCommandEnvironment()
  });
  return stdout;
}

async function execFileBounded(command, args, cwd, extraEnvironment = {}) {
  await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...deterministicCommandEnvironment(), ...extraEnvironment }
  });
}

function deterministicCommandEnvironment() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? tmpdir(),
    LC_ALL: "C",
    TZ: "UTC"
  };
}

function protectedEnvironmentValues(environment) {
  return [
    environment.DAYTONA_API_KEY,
    environment.OPENAI_API_KEY,
    environment.OPENROUTER_API_KEY,
    environment.CODEX_API_KEY
  ].filter((value) => typeof value === "string" && value.length >= 8);
}

function assertNoProtectedValue(bytes, protectedValues, label) {
  const text = Buffer.from(bytes).toString("utf8");
  if (protectedValues.some((value) => text.includes(value))) {
    throw new Error(`${label} contains a protected credential value`);
  }
}

function safeError(error, protectedValues) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of protectedValues) message = message.replaceAll(value, "[REDACTED]");
  return message
    .replaceAll(/(?:jina_atk_|gh[opsu]_|sk[-_])[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replaceAll(/dtn_secret_[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .slice(0, 2_000);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  }
  throw new Error("non-JSON value");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredEnvironment(environment, name) {
  return requiredString(environment[name], name);
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredGitSha(value, name) {
  const sha = requiredString(value, name).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${name} must be a full Git SHA`);
  return sha;
}

function commaSeparated(value) {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function boundedInt(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be ${minimum}..${maximum}`);
  }
  return parsed;
}

function timestampString(value, name) {
  const text = value instanceof Date ? value.toISOString() : requiredString(value, name);
  requiredTimestamp(text, name);
  return text;
}

function requiredTimestamp(value, name) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`);
}

function safeResource(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseCli(argv, environment) {
  const values = {};
  const args = argv.filter((argument) => argument !== "--");
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--help" || name === "-h") return { help: true };
    if (["--daytona-api-key", "--model-secret-value", "--openai-api-key", "--codex-auth"].includes(name)) {
      throw new Error(
        "credentials and host Codex authentication are accepted only through isolated environment contracts"
      );
    }
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("invalid command-line option");
    }
    index += 1;
    const key = name.slice(2);
    if (Object.hasOwn(values, key)) throw new Error("duplicate command-line option");
    values[key] = value;
  }
  const allowed = new Set([
    "repository",
    "commit",
    "output-dir",
    "stage-id",
    "timeout-seconds",
    "cleanup-attempts",
    "cleanup-interval-ms"
  ]);
  if (Object.keys(values).some((name) => !allowed.has(name))) throw new Error("unknown command-line option");
  return {
    repository: values.repository ?? environment.JINA_CONTEXT_REPOSITORY_PATH,
    commitSha: values.commit ?? environment.JINA_CONTEXT_COMMIT_SHA,
    outputDirectory: values["output-dir"],
    stageId: values["stage-id"],
    timeoutSeconds: values["timeout-seconds"],
    cleanupAttempts: values["cleanup-attempts"],
    cleanupIntervalMs: values["cleanup-interval-ms"],
    environment
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let outputDirectory;
  try {
    const options = parseCli(process.argv.slice(2), process.env);
    if (options.help) {
      process.stdout.write(HELP);
    } else {
      outputDirectory = resolve(requiredString(options.outputDirectory, "output directory"));
      const report = await runContextDaytonaBoardStageAcceptance(options);
      process.stdout.write(
        `${JSON.stringify({
          status: report.status,
          stageId: report.stage.id,
          manifest: join(outputDirectory, MANIFEST_FILE),
          envelopeSha256: report.envelope?.sha256
        })}\n`
      );
      if (report.status !== "passed") process.exitCode = 1;
    }
  } catch {
    process.stderr.write(
      `Daytona Board-stage acceptance failed${outputDirectory ? `; inspect ${join(outputDirectory, MANIFEST_FILE)}` : ""}\n`
    );
    process.exitCode = 1;
  }
}
