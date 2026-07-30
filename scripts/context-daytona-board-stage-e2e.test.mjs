import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createCommitPinnedArchive,
  runContextDaytonaBoardStageAcceptance
} from "./context-daytona-board-stage-e2e.mjs";

const execFileAsync = promisify(execFile);
const DAYTONA_KEY = "daytona-acceptance-secret-value";
const COMMITTED_PACKAGE = "daytona-e2e-fixture";
const SNAPSHOT = "jina-context-board-codex-0-145-0-v1";
const SNAPSHOT_ID = "snapshot-immutable-id";
const STAGE_ID = "daytona-board-e2e-test";
const CREATED_AT = "2026-07-30T06:06:52.117Z";
const UPDATED_AT = "2026-07-30T07:02:15.856Z";

test("commit archive is deterministic and excludes dirty worktree content", async () => {
  await withGitFixture(async ({ repository, commitSha }) => {
    const first = await createCommitPinnedArchive({ repository, commitSha });
    try {
      await writeFile(join(repository, "README.md"), "dirty and not retained\n", "utf8");
      const second = await createCommitPinnedArchive({ repository, commitSha });
      try {
        assert.equal(first.commitSha, commitSha);
        assert.equal(first.packageName, COMMITTED_PACKAGE);
        assert.equal(first.sha256, digest(first.bytes));
        assert.equal(second.sha256, first.sha256);
        assert.deepEqual(second.bytes, first.bytes);
        assert.equal(Buffer.from(second.bytes).includes(Buffer.from("dirty and not retained")), false);
        await assertArchiveAcceptedByProductionRunner(first, commitSha);
      } finally {
        await rm(second.temporaryDirectory, { recursive: true, force: true });
      }
    } finally {
      await rm(first.temporaryDirectory, { recursive: true, force: true });
    }
  });
});

test("retains a canonical low-level Daytona envelope, usage, output hashes, metadata, and cleanup proof", async () => {
  await withGitFixture(async ({ root, repository, commitSha }) => {
    const outputDirectory = join(root, "retained");
    let runnerInput;
    let runnerConfiguration;
    let snapshotReads = 0;
    let sandboxReads = 0;
    const dependencies = {
      createRunner(configuration) {
        runnerConfiguration = configuration;
        return {
          mode: "daytona",
          async run(input) {
            runnerInput = input;
            return validEnvelope(COMMITTED_PACKAGE, commitSha);
          }
        };
      },
      async createObserver() {
        return {
          async getSnapshot() {
            snapshotReads += 1;
            return snapshotRecord({ lastUsedAt: `2026-07-30T07:02:${15 + snapshotReads}.856Z` });
          },
          async listStageSandboxes() {
            sandboxReads += 1;
            return [];
          },
          async dispose() {
            return undefined;
          }
        };
      },
      now: sequenceClock("2026-07-30T10:00:00.000Z", "2026-07-30T10:00:02.000Z"),
      sleep: async () => undefined
    };

    const report = await runContextDaytonaBoardStageAcceptance(
      fixtureOptions({ repository, commitSha, outputDirectory }),
      dependencies
    );

    assert.equal(report.status, "passed");
    assert.equal(snapshotReads, 2);
    assert.equal(sandboxReads, 2);
    assert.equal(report.source.commitSha, commitSha);
    assert.equal(report.source.packageName, COMMITTED_PACKAGE);
    assert.equal(report.source.archiveFormat, "ustar+gzip");
    assert.equal(report.source.dirtyWorktreeExcluded, true);
    assert.equal(report.executor.snapshot, SNAPSHOT);
    assert.equal(report.executor.modelSecretName, "jina-context-openai");
    assert.deepEqual(report.executor.allowedDomains, ["api.openai.com"]);
    assert.equal(report.executor.hostCodexSessionForwarded, false);
    assert.equal(report.executor.hostModelCredentialForwarded, false);
    assert.equal(report.snapshot.before.id, SNAPSHOT_ID);
    assert.equal(report.snapshot.after.id, SNAPSHOT_ID);
    assert.equal(report.cleanup.status, "passed");
    assert.equal(report.envelope.canonicalJson, true);
    assert.deepEqual(report.envelope.usage, { inputTokens: 31, cachedInputTokens: 7, outputTokens: 11 });
    assert.equal(report.envelope.declaredOutputs[0].sha256, report.retainedFiles[1].sha256);

    assert.equal(runnerConfiguration.environment.NODE_ENV, "production");
    assert.equal(runnerConfiguration.environment.CONTEXT_BOARD_EXECUTOR, "daytona");
    assert.equal(runnerConfiguration.environment.DAYTONA_API_KEY, DAYTONA_KEY);
    assert.equal("CODEX_HOME" in runnerConfiguration.environment, false);
    assert.equal("CONTEXT_CODEX_AUTH" in runnerConfiguration.environment, false);
    assert.equal("OPENAI_API_KEY" in runnerConfiguration.environment, false);
    assert.deepEqual(runnerConfiguration.protectedValues, [DAYTONA_KEY]);
    assert.equal(runnerInput.repository.commitSha, commitSha);
    assert.equal(runnerInput.repository.sha256, digest(runnerInput.repository.archive));
    assert.equal(runnerInput.schema.additionalProperties, false);
    assert.deepEqual(runnerInput.schema.required, ["completed", "packageName"]);
    assert.equal(runnerInput.outputFiles[0].path, "proof.md");

    const resultText = await readFile(join(outputDirectory, "result.json"), "utf8");
    const proofText = await readFile(join(outputDirectory, "files", "proof.md"), "utf8");
    const manifestText = await readFile(join(outputDirectory, "manifest.json"), "utf8");
    assert.equal(resultText, `{"completed":true,"packageName":"${COMMITTED_PACKAGE}"}`);
    assert.match(proofText, new RegExp(COMMITTED_PACKAGE));
    assert.match(proofText, new RegExp(commitSha));
    assert.equal(manifestText.includes(DAYTONA_KEY), false);
    assert.equal(resultText.includes(DAYTONA_KEY), false);
    assert.equal(proofText.includes(DAYTONA_KEY), false);
    assert.equal((await stat(join(outputDirectory, "manifest.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(outputDirectory, "result.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(outputDirectory, "files", "proof.md"))).mode & 0o777, 0o600);
  });
});

test("fails closed and retains evidence when the snapshot identity changes", async () => {
  await withGitFixture(async ({ root, repository, commitSha }) => {
    const outputDirectory = join(root, "retained-mismatch");
    let snapshotReads = 0;
    const report = await runContextDaytonaBoardStageAcceptance(
      fixtureOptions({ repository, commitSha, outputDirectory }),
      {
        createRunner: () => ({
          mode: "daytona",
          run: async () => validEnvelope(COMMITTED_PACKAGE, commitSha)
        }),
        createObserver: async () => ({
          async getSnapshot() {
            snapshotReads += 1;
            return snapshotRecord({ id: snapshotReads === 1 ? SNAPSHOT_ID : "replacement-snapshot-id" });
          },
          listStageSandboxes: async () => [],
          dispose: async () => undefined
        }),
        now: sequenceClock("2026-07-30T10:00:00.000Z", "2026-07-30T10:00:02.000Z"),
        sleep: async () => undefined
      }
    );

    assert.equal(report.status, "failed");
    assert.ok(report.violations.some((violation) => violation.code === "snapshot_metadata_mismatch"));
    assert.equal(report.cleanup.status, "passed");
    assert.equal((await readFile(join(outputDirectory, "manifest.json"), "utf8")).includes(DAYTONA_KEY), false);
  });
});

test("fails closed on residual sandboxes or cleanup observation uncertainty", async () => {
  await withGitFixture(async ({ root, repository, commitSha }) => {
    for (const scenario of ["residual", "uncertain"]) {
      const outputDirectory = join(root, `retained-${scenario}`);
      let sandboxReads = 0;
      const report = await runContextDaytonaBoardStageAcceptance(
        fixtureOptions({
          repository,
          commitSha,
          outputDirectory,
          cleanupAttempts: 1,
          cleanupIntervalMs: 0
        }),
        {
          createRunner: () => ({
            mode: "daytona",
            run: async () => validEnvelope(COMMITTED_PACKAGE, commitSha)
          }),
          createObserver: async () => ({
            getSnapshot: async () => snapshotRecord(),
            async listStageSandboxes() {
              sandboxReads += 1;
              if (sandboxReads === 1) return [];
              if (scenario === "uncertain") throw new Error(`cleanup read failed with ${DAYTONA_KEY}`);
              return [{ id: "residual-sandbox", state: "started" }];
            },
            dispose: async () => undefined
          }),
          now: sequenceClock("2026-07-30T10:00:00.000Z", "2026-07-30T10:00:02.000Z"),
          sleep: async () => undefined
        }
      );

      assert.equal(report.status, "failed");
      assert.equal(report.cleanup.status, scenario);
      assert.ok(
        report.violations.some((violation) =>
          scenario === "residual" ? violation.code === "residual_sandbox" : violation.code === "cleanup_uncertain"
        )
      );
      const manifest = await readFile(join(outputDirectory, "manifest.json"), "utf8");
      assert.equal(manifest.includes(DAYTONA_KEY), false);
      if (scenario === "uncertain") assert.match(manifest, /\[REDACTED\]/);
    }
  });
});

test("rejects a credential echo without retaining the credential bytes", async () => {
  await withGitFixture(async ({ root, repository, commitSha }) => {
    const outputDirectory = join(root, "retained-secret-echo");
    const unsafeBytes = Buffer.from(`{"completed":true,"packageName":"${DAYTONA_KEY}"}`, "utf8");
    const report = await runContextDaytonaBoardStageAcceptance(
      fixtureOptions({ repository, commitSha, outputDirectory }),
      {
        createRunner: () => ({
          mode: "daytona",
          run: async () => ({
            ...validEnvelope(COMMITTED_PACKAGE, commitSha),
            bytes: unsafeBytes,
            byteLength: unsafeBytes.byteLength,
            sha256: digest(unsafeBytes)
          })
        }),
        createObserver: async () => ({
          getSnapshot: async () => snapshotRecord(),
          listStageSandboxes: async () => [],
          dispose: async () => undefined
        }),
        now: sequenceClock("2026-07-30T10:00:00.000Z", "2026-07-30T10:00:02.000Z"),
        sleep: async () => undefined
      }
    );

    assert.equal(report.status, "failed");
    assert.ok(report.violations.some((violation) => violation.code === "stage_execution_failed"));
    const manifest = await readFile(join(outputDirectory, "manifest.json"), "utf8");
    assert.equal(manifest.includes(DAYTONA_KEY), false);
    await assert.rejects(() => readFile(join(outputDirectory, "result.json")), /ENOENT/);
  });
});

test("CLI refuses credential arguments without echoing their value", async () => {
  const result = await runProcess(process.execPath, [
    "scripts/context-daytona-board-stage-e2e.mjs",
    "--daytona-api-key",
    DAYTONA_KEY
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.includes(DAYTONA_KEY), false);
  assert.equal(result.stderr.includes(DAYTONA_KEY), false);
  assert.match(result.stderr, /acceptance failed/);
});

async function assertArchiveAcceptedByProductionRunner(archive, commitSha) {
  const { DaytonaBoardAgentStageRunner } = await import("../packages/daytona/dist/index.js");
  const runner = new DaytonaBoardAgentStageRunner({
    client: {
      async create() {
        throw new Error("ARCHIVE_ACCEPTED");
      }
    },
    snapshot: SNAPSHOT,
    modelSecret: { environmentVariable: "OPENAI_API_KEY", secretName: "jina-context-openai" },
    allowedDomains: ["api.openai.com"]
  });
  await assert.rejects(
    () =>
      runner.run({
        id: STAGE_ID,
        prompt: "Validate the prepared archive before creating a sandbox.",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["completed"],
          properties: { completed: { type: "boolean", const: true } }
        },
        repository: {
          commitSha,
          archive: archive.bytes,
          sha256: archive.sha256
        },
        artifacts: [],
        limits: {
          timeoutSeconds: 300,
          contextTokens: 128_000,
          compactTokens: 96_000,
          attempt: 1,
          maxAttempts: 1
        }
      }),
    /ARCHIVE_ACCEPTED/
  );
}

function validEnvelope(packageName, commitSha) {
  const bytes = Buffer.from(`{"completed":true,"packageName":"${packageName}"}`, "utf8");
  const markdown = Buffer.from(
    `# Daytona Board-stage proof\n\nPackage: ${packageName}\n\nCommit: ${commitSha}\n`,
    "utf8"
  );
  return {
    version: 1,
    contentType: "application/json",
    bytes,
    byteLength: bytes.byteLength,
    sha256: digest(bytes),
    usage: { inputTokens: 31, cachedInputTokens: 7, outputTokens: 11 },
    files: [
      {
        path: "proof.md",
        contentType: "text/markdown",
        maxBytes: 128 * 1024,
        bytes: markdown,
        sha256: digest(markdown)
      }
    ]
  };
}

function fixtureOptions({ repository, commitSha, outputDirectory, cleanupAttempts = 1, cleanupIntervalMs = 0 }) {
  return {
    repository,
    commitSha,
    outputDirectory,
    stageId: STAGE_ID,
    cleanupAttempts,
    cleanupIntervalMs,
    environment: {
      DAYTONA_API_KEY: DAYTONA_KEY,
      CONTEXT_DAYTONA_SNAPSHOT: SNAPSHOT,
      CONTEXT_DAYTONA_MODEL_SECRET: "jina-context-openai",
      CONTEXT_DAYTONA_MODEL_SECRET_ENV: "OPENAI_API_KEY",
      CONTEXT_DAYTONA_MODEL_DOMAINS: "api.openai.com",
      CONTEXT_CODEX_MODEL: "gpt-5.6-terra",
      CONTEXT_CODEX_EFFORT: "low",
      CONTEXT_CODEX_VERBOSITY: "high",
      CONTEXT_CODEX_CONTEXT_TOKENS: "128000",
      CONTEXT_CODEX_COMPACT_TOKENS: "96000",
      CODEX_HOME: "/must/not/be/forwarded",
      CONTEXT_CODEX_AUTH: "session"
    }
  };
}

function snapshotRecord(overrides = {}) {
  return {
    id: SNAPSHOT_ID,
    name: SNAPSHOT,
    state: "active",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    lastUsedAt: UPDATED_AT,
    cpu: 4,
    mem: 8,
    disk: 10,
    ...overrides
  };
}

function sequenceClock(...timestamps) {
  let index = 0;
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]);
}

async function withGitFixture(operation) {
  const root = await mkdtemp(join(tmpdir(), "jina-daytona-e2e-test-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  try {
    await execFileAsync("git", ["init", "--quiet", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Context Test"]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "context-test@example.invalid"]);
    await writeFile(
      join(repository, "package.json"),
      `${JSON.stringify({ name: COMMITTED_PACKAGE, private: true }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(join(repository, "README.md"), "# Committed fixture\n", "utf8");
    await execFileAsync("git", ["-C", repository, "add", "package.json", "README.md"]);
    await execFileAsync("git", ["-C", repository, "commit", "--quiet", "-m", "fixture"]);
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"], {
      encoding: "utf8"
    });
    await operation({ root, repository, commitSha: stdout.trim() });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: process.cwd(), encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.once("error", reject);
  });
}
