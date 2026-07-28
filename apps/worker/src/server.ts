import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  REVIEW_FINDINGS_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  parseReviewOutput,
  prepareDiff,
  type ReviewRequest
} from "@jina/ai";
import { DaytonaCodexKnowledgeDocumentGenerator } from "@jina/daytona";
import { createGitHubInstallationAccessToken } from "@jina/github";
import { createLogger, errorLogFields, generateTraceContext, MetricsRegistry } from "@jina/observability";
import type {
  DerivationDetail,
  FocusBundle,
  GitChange,
  GitSnapshotMetadata,
  IngestEvidenceInput,
  PriorKnowledgeRevision,
  RefManifestEntry,
  ProviderObservationInput
} from "@jina/context-engine";
import { buildKnowledgeRepairPrompt, repositoryAclFingerprint } from "@jina/context-engine";
import { workerFailureCategory, type WorkerFailureCategory } from "./diagnostics.js";
import { assertExpectedRemoteHead } from "./git-ref.js";
import { parseGitTreeEntries } from "./git-tree.js";

const execFileAsync = promisify(execFile);
const CONTEXT_TOPICS = ["run-ingest-evidence", "run-derive-knowledge", "run-index-context"] as const;
const SUPPORTED_TOPICS = ["run-review", "run-research", "run-publish", "run-cleanup", ...CONTEXT_TOPICS] as const;
type WorkerTopic = (typeof SUPPORTED_TOPICS)[number];
type ContextWorkerTopic = (typeof CONTEXT_TOPICS)[number];

interface RepositoryContextMetadata {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha?: string;
  readonly checkpointId?: string;
  readonly githubInstallationId?: number;
}

interface WorkMetadataByTopic {
  readonly "run-review": {
    readonly tenantId: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
  };
  readonly "run-research": {
    readonly tenantId: string;
    readonly question?: string;
    readonly sourceUrls?: readonly string[];
  };
  readonly "run-publish": Record<string, unknown> & { readonly tenantId: string };
  readonly "run-cleanup": Record<string, unknown> & { readonly tenantId: string };
  readonly "run-ingest-evidence": RepositoryContextMetadata;
  readonly "run-derive-knowledge": RepositoryContextMetadata & {
    readonly checkpointId: string;
    readonly commitSha: string;
  };
  readonly "run-index-context": RepositoryContextMetadata & {
    readonly checkpointId: string;
    readonly commitSha: string;
  };
}

type ClaimedWork<T extends WorkerTopic = WorkerTopic> = T extends WorkerTopic
  ? {
      readonly topic: T;
      readonly message: {
        readonly id: string;
        readonly topic: T;
        readonly leaseId: string;
        readonly leaseExpiresAt: string;
        readonly attempt?: number;
        readonly writeFenceToken?: string;
      };
      readonly task: {
        readonly id: string;
        readonly metadata: WorkMetadataByTopic[T];
      };
    }
  : never;

type WorkResult =
  | { readonly outcome: "done"; readonly result?: Record<string, unknown> }
  | { readonly outcome: "failed"; readonly reason: string };

interface LeaseExecutionState {
  readonly controller: AbortController;
  githubToken?: string;
  lostReason?: string;
  renewalInFlight?: boolean;
}

class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseLostError";
  }
}

const logger = createLogger({ service: process.env.K_SERVICE ?? "jina-worker" });
const metrics = new MetricsRegistry();
const port = Number(process.env.PORT ?? 8080);
const apiUrl = requiredEnv("JINA_API_URL").replace(/\/$/, "");
const token = requiredEnv("INTERNAL_API_TOKEN");
const topics = configuredTopics(process.env.WORKER_TOPICS);
const workerId = process.env.WORKER_ID?.trim() || `worker-${process.pid}`;
const pollIntervalMs = positiveInt(process.env.WORKER_POLL_INTERVAL_MS, 2_000);
const workerApiTimeoutMs = positiveInt(process.env.WORKER_API_TIMEOUT_MS, 30_000);
const contextApiTimeoutMs = positiveInt(process.env.CONTEXT_API_TIMEOUT_MS, 62 * 60_000);
const contextCompletionTimeoutMs = positiveInt(process.env.CONTEXT_COMPLETION_TIMEOUT_MS, 10 * 60_000);
// The whole derive stage, across its repair run, when the build did not name its
// own. Kept under CONTEXT_API_TIMEOUT_MS so the operation bounding this stage is
// still the outer bound.
const deriveBudgetSeconds = positiveInt(process.env.CONTEXT_DERIVE_BUDGET_SECONDS, 40 * 60);
/** Below this a repair run cannot reach a first document, so it is not started. */
const MIN_DERIVE_REPAIR_SECONDS = 300;
const heartbeatIntervalMs = positiveInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 60_000);
const requireGithubInstallation = process.env.JINA_REQUIRE_GITHUB_INSTALLATION === "true";
const knowledgeGenerator = topics.includes("run-derive-knowledge")
  ? new DaytonaCodexKnowledgeDocumentGenerator()
  : undefined;
let stopping = false;
let active = false;
let activeLease: LeaseExecutionState | undefined;
let activeWork: ClaimedWork | undefined;
let lastApiSuccessAt: string | undefined;
let hasApiError = false;
let lastApiErrorAt: string | undefined;
let consecutiveApiFailures = 0;
let lastWork:
  | {
      readonly topic: WorkerTopic;
      readonly outcome: WorkResult["outcome"] | "lease_lost";
      readonly finishedAt: string;
      readonly failureCategory?: WorkerFailureCategory;
    }
  | undefined;

const server = createServer((request, response) => {
  if (request.url === "/health" || request.url === "/healthz") {
    const ok = Boolean(lastApiSuccessAt) && !hasApiError;
    response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok,
        workerId,
        topics,
        active,
        lastApiSuccessAt,
        lastApiErrorAt,
        consecutiveApiFailures,
        lastWork,
        metrics: metrics.snapshot()
      })
    );
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not found"}');
});

server.listen(port, () => {
  logger.info(`worker listening on ${port} for ${topics.join(", ")}`, {
    event: "worker.started",
    workerId,
    port,
    topics
  });
  void poll();
});

async function poll(): Promise<void> {
  while (!stopping) {
    try {
      const work = await claim();
      if (work) await execute(work);
    } catch (error) {
      recordApiFailure(error);
      metrics.count("worker.poll_failures");
      logger.error("worker poll failed", { event: "worker.poll_failed", workerId, ...errorLogFields(error) });
    }
    if (!stopping) await delay(pollIntervalMs);
  }
}

async function claim(): Promise<ClaimedWork | undefined> {
  const response = await apiRequest("/internal/worker/claim", { workerId, topics });
  if (response.status === 204) {
    recordApiSuccess();
    return undefined;
  }
  if (!response.ok) throw new Error(`claim failed with ${response.status}: ${await boundedFailureDetail(response)}`);
  recordApiSuccess();
  return parseClaimedWork(await response.json());
}

async function execute(work: ClaimedWork): Promise<void> {
  active = true;
  activeWork = work;
  const startedAt = Date.now();
  const lease: LeaseExecutionState = { controller: new AbortController() };
  activeLease = lease;
  const heartbeat = setInterval(() => {
    if (lease.renewalInFlight) return;
    lease.renewalInFlight = true;
    void renew(work)
      .catch((error) => {
        if (error instanceof LeaseLostError) {
          loseLease(lease, error);
          metrics.count("worker.lease_lost", { topic: work.message.topic });
          return;
        }
        recordApiFailure(error);
        logger.warn("worker lease renewal failed, retrying", {
          event: "worker.lease_renewal_retry",
          workerId,
          taskId: work.task.id,
          ...errorLogFields(error)
        });
      })
      .finally(() => {
        lease.renewalInFlight = false;
      });
  }, heartbeatIntervalMs);
  heartbeat.unref();

  let result: WorkResult | undefined;
  try {
    result = await executeTopic(work);
  } catch (error) {
    if (!lease.lostReason) result = { outcome: "failed", reason: errorMessage(error).slice(0, 2_000) };
  } finally {
    clearInterval(heartbeat);
  }

  try {
    if (lease.lostReason || !result) {
      lastWork = { topic: work.message.topic, outcome: "lease_lost", finishedAt: new Date().toISOString() };
      logStageOutcome(work, startedAt, undefined, lease.lostReason ?? "lease lost");
      return;
    }
    await complete(work, result);
    lastWork = {
      topic: work.message.topic,
      outcome: result.outcome,
      finishedAt: new Date().toISOString(),
      ...(result.outcome === "failed" ? { failureCategory: workerFailureCategory(result.reason) } : {})
    };
    logStageOutcome(work, startedAt, result);
  } finally {
    activeLease = undefined;
    activeWork = undefined;
    active = false;
  }
}

function logStageOutcome(
  work: ClaimedWork,
  startedAt: number,
  result: WorkResult | undefined,
  failureReason?: string
): void {
  const metadata = work.task.metadata as Record<string, unknown>;
  const durationMs = Date.now() - startedAt;
  const base = {
    workerId,
    topic: work.message.topic,
    taskId: work.task.id,
    ...(typeof metadata.repository === "string" ? { repository: metadata.repository } : {}),
    ...(typeof metadata.ref === "string" ? { ref: metadata.ref } : {}),
    durationMs
  };
  const stageLogger = logger.withTrace(generateTraceContext());
  metrics.observe("worker.stage.duration_ms", durationMs, { topic: work.message.topic });
  const reason =
    failureReason ?? (result?.outcome === "failed" ? result.reason : result === undefined ? "unknown" : undefined);
  if (reason !== undefined) {
    const failureCategory = workerFailureCategory(reason);
    metrics.count("worker.tasks", { topic: work.message.topic, outcome: "failed", category: failureCategory });
    stageLogger.error(`${work.message.topic} failed for task ${work.task.id}`, {
      event: "stage.failed",
      ...base,
      failureCategory,
      reason: reason.slice(0, 500)
    });
    return;
  }
  metrics.count("worker.tasks", { topic: work.message.topic, outcome: "done" });
  stageLogger.info(`${work.message.topic} completed for task ${work.task.id}`, {
    event: "stage.completed",
    ...base,
    ...(result?.outcome === "done" && typeof result.result?.effect === "string" ? { effect: result.result.effect } : {})
  });
}

async function executeTopic(work: ClaimedWork): Promise<WorkResult> {
  switch (work.topic) {
    case "run-ingest-evidence":
      return { outcome: "done", result: await runIngestEvidence(work) };
    case "run-derive-knowledge":
      return { outcome: "done", result: await runDeriveKnowledge(work) };
    case "run-index-context":
      return { outcome: "done", result: await runIndexContext(work) };
    case "run-review":
      return { outcome: "done", result: await runReview(work) };
    case "run-research":
      return {
        outcome: "done",
        result: {
          question: stringValue(work.task.metadata.question),
          sources: stringArray(work.task.metadata.sourceUrls),
          note: "Context request recorded for the review worker"
        }
      };
    case "run-publish":
      return { outcome: "done", result: { published: true, target: "summary" } };
    case "run-cleanup":
      return { outcome: "done", result: { cleaned: true } };
  }
}

async function runIngestEvidence(work: ClaimedWork<"run-ingest-evidence">): Promise<Record<string, unknown>> {
  const { tenantId, repository, ref, commitSha: expectedCommitSha, githubInstallationId } = work.task.metadata;
  if (requireGithubInstallation && !githubInstallationId) {
    throw new Error("provisioned GitHub installation is required for context ingestion");
  }
  if (githubInstallationId) {
    const access = await createGitHubInstallationAccessToken(githubInstallationId);
    assertLeaseOwned();
    if (!activeLease) throw new Error("GitHub installation token was minted outside an active worker lease");
    activeLease.githubToken = access.token;
    logger.info(`GitHub installation access ready for ${repository}`, {
      event: "github.installation_access_ready",
      workerId,
      repository,
      githubInstallationId,
      ...(access.expiresAt ? { expiresAt: access.expiresAt } : {})
    });
  }
  const checkout = await checkoutRepository(repository, ref, expectedCommitSha);
  try {
    const [files, provider, git, history] = await Promise.all([
      readRepositoryFiles(checkout.directory, checkout.commitSha),
      loadProviderObservations(repository, checkout.commitSha),
      readGitSnapshotMetadata(checkout.directory, checkout.commitSha),
      readGitHistoryMetadata(checkout.directory, checkout.commitSha)
    ]);
    const omittedFiles = files.filter((file) => file.contentOmitted).map((file) => file.path);
    const input: IngestEvidenceInput = {
      tenantId,
      repository,
      ref,
      refSequence: work.task.metadata.refSequence,
      commitSha: checkout.commitSha,
      files,
      observations: provider.observations,
      git: { ...git, history: history.commits },
      aclFingerprint: repositoryAclFingerprint(tenantId, repository),
      observationFrontier: JSON.stringify({
        commitSha: checkout.commitSha,
        git: {
          observedCommitCount: history.commits.length,
          complete: history.complete,
          oldestObservedCommit: history.commits.at(-1)?.sha ?? checkout.commitSha
        },
        github: provider.frontier,
        omittedFiles
      }),
      createdAt: new Date().toISOString(),
      sourceComplete: history.complete && provider.complete && omittedFiles.length === 0
    };
    return await internalApiJson("/internal/context/ingest", leaseBody(work, { input }));
  } finally {
    await rm(checkout.directory, { recursive: true, force: true });
  }
}

async function runDeriveKnowledge(work: ClaimedWork<"run-derive-knowledge">): Promise<Record<string, unknown>> {
  if (!knowledgeGenerator) throw new Error("knowledge generator is not configured for this worker");
  const prepared = await internalApiJson<{
    readonly prompt: string;
    readonly detail?: DerivationDetail;
    readonly budgetSeconds?: number;
    readonly checkpointId: string;
    readonly bundle: FocusBundle;
    readonly manifest: RefManifestEntry[];
    readonly priorKnowledge: PriorKnowledgeRevision[];
  }>("/internal/context/derive/prepare", leaseBody(work, { checkpointId: work.task.metadata.checkpointId }));
  const { repository, ref, commitSha } = work.task.metadata;
  if (
    prepared.bundle.checkpoint.repository !== repository ||
    prepared.bundle.checkpoint.ref !== ref ||
    prepared.bundle.checkpoint.commitSha !== commitSha
  ) {
    throw new Error("prepared derivation checkpoint does not match the leased repository scope");
  }
  const checkout = await checkoutRepository(repository, ref, commitSha, false);
  try {
    let diagnostics: readonly string[] = [];
    // The budget belongs to the stage, not to one run: a failed run is followed
    // by a repair run, and a per-run limit would let the stage take a multiple
    // of what it was granted. Each run gets what is left, so the lease and the
    // deploy step that wait on this stage bound it whatever happens inside.
    const budgetSeconds = prepared.budgetSeconds ?? deriveBudgetSeconds;
    const deadline = Date.now() + budgetSeconds * 1000;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingSeconds = Math.floor((deadline - Date.now()) / 1000);
      // Too little left to reach a first document, so a repair run would only
      // spend the rest of the lease restating the failure it already reported.
      if (attempt > 0 && remainingSeconds < MIN_DERIVE_REPAIR_SECONDS) break;
      const rawOutput = await knowledgeGenerator.generate({
        prompt: attempt === 0 ? prepared.prompt : buildKnowledgeRepairPrompt(prepared.prompt, diagnostics),
        bundle: prepared.bundle,
        repairErrors: [...diagnostics],
        budgetSeconds: Math.max(remainingSeconds, MIN_DERIVE_REPAIR_SECONDS),
        // Reported as pages appear rather than at the end, so a run stopped by a
        // deploy or a lost lease keeps what it wrote and can be watched while it
        // writes. Failures are swallowed: this observes a derivation, it must
        // never be the reason one fails.
        onProgress: async (pages) => {
          await internalApiJson(
            "/internal/context/derive/progress",
            leaseBody(work, { checkpointId: work.task.metadata.checkpointId, pages })
          ).catch(() => undefined);
        },
        ...(prepared.detail ? { detail: prepared.detail } : {}),
        workspace: {
          repositoryDirectory: checkout.directory,
          manifest: prepared.manifest,
          priorKnowledge: prepared.priorKnowledge
        }
      });
      const result = await internalApiJson<{
        readonly status: "succeeded" | "failed";
        readonly diagnostics?: readonly string[];
        readonly revisionIds?: readonly string[];
        readonly runId: string;
        readonly enrichedGenerationId?: string;
      }>(
        "/internal/context/derive/commit",
        leaseBody(work, {
          checkpointId: prepared.checkpointId,
          rawOutput
        })
      );
      if (result.status === "succeeded") {
        return {
          effect: result.revisionIds?.length ? "changed" : "noop",
          runId: result.runId,
          revisionIds: result.revisionIds ?? [],
          ...(result.enrichedGenerationId ? { generationId: result.enrichedGenerationId } : {})
        };
      }
      diagnostics = result.diagnostics ?? ["knowledge validation failed"];
    }
    throw new Error(`knowledge derivation failed: ${diagnostics.join("; ")}`);
  } finally {
    await rm(checkout.directory, { recursive: true, force: true });
  }
}

async function runIndexContext(work: ClaimedWork<"run-index-context">): Promise<Record<string, unknown>> {
  return internalApiJson(
    "/internal/context/index",
    leaseBody(work, {
      checkpointId: work.task.metadata.checkpointId,
      repository: work.task.metadata.repository,
      ref: work.task.metadata.ref,
      commitSha: work.task.metadata.commitSha
    })
  );
}

function leaseBody(work: ClaimedWork, value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    taskId: work.task.id,
    messageId: work.message.id,
    leaseId: work.message.leaseId,
    ...(work.message.attempt === undefined ? {} : { attempt: work.message.attempt }),
    ...(work.message.writeFenceToken === undefined ? {} : { writeFenceToken: work.message.writeFenceToken })
  };
}

async function checkoutRepository(
  repository: string,
  ref: string,
  expectedCommitSha?: string,
  requireExpectedRemoteHead = true
): Promise<{ readonly directory: string; readonly commitSha: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("repository must be owner/name");
  const directory = await mkdtemp(join(tmpdir(), "jina-context-"));
  const environment = gitEnvironment();
  try {
    await execFileAsync("git", ["check-ref-format", "--branch", ref], {
      env: environment,
      maxBuffer: 1024
    });
    await execFileAsync(
      "git",
      [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--branch",
        ref,
        `https://github.com/${repository}.git`,
        directory
      ],
      { env: environment, maxBuffer: 10 * 1024 * 1024 }
    );
    await execFileAsync("git", ["fetch", "origin", `+refs/heads/${ref}:refs/remotes/origin/${ref}`], {
      cwd: directory,
      env: environment,
      maxBuffer: 10 * 1024 * 1024
    });
    const { stdout: remoteHead } = await execFileAsync("git", ["rev-parse", `refs/remotes/origin/${ref}`], {
      cwd: directory,
      env: environment,
      maxBuffer: 1024
    });
    const targetCommitSha =
      expectedCommitSha && !requireExpectedRemoteHead
        ? requiredGitSha(expectedCommitSha, "checkpoint commit SHA")
        : assertExpectedRemoteHead(repository, ref, remoteHead, expectedCommitSha);
    if (expectedCommitSha && !requireExpectedRemoteHead) {
      await execFileAsync("git", ["fetch", "origin", targetCommitSha], {
        cwd: directory,
        env: environment,
        maxBuffer: 10 * 1024 * 1024
      });
    }
    await execFileAsync("git", ["checkout", "--detach", targetCommitSha], {
      cwd: directory,
      env: environment,
      maxBuffer: 10 * 1024 * 1024
    });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      env: environment,
      maxBuffer: 1024
    });
    const commitSha = requiredGitSha(stdout.trim(), "checked out commit SHA");
    if (commitSha !== targetCommitSha) {
      throw new Error(`checked out commit ${commitSha} does not match fetched ref head ${targetCommitSha}`);
    }
    return { directory, commitSha };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function readGitSnapshotMetadata(directory: string, commitSha: string): Promise<GitSnapshotMetadata> {
  const environment = gitEnvironment();
  const { stdout: description } = await execFileAsync(
    "git",
    ["show", "-s", "--format=%T%x00%P%x00%an <%ae>%x00%aI%x00%cI%x00%B", commitSha],
    { cwd: directory, env: environment, maxBuffer: 10 * 1024 * 1024 }
  );
  const [treeShaValue, parentsValue, authorValue, authoredAtValue, committedAtValue, ...messageParts] =
    description.split("\0");
  const treeSha = requiredGitSha(treeShaValue?.trim(), "commit tree SHA");
  const parentShas = (parentsValue ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((sha) => requiredGitSha(sha, "parent commit SHA"));
  const diffArguments =
    parentShas.length === 0
      ? ["diff-tree", "--root", "--no-commit-id", "-r", "--raw", "-z", "--abbrev=40", "-M", "-C", commitSha]
      : ["diff-tree", "--no-commit-id", "-r", "--raw", "-z", "--abbrev=40", "-M", "-C", parentShas[0]!, commitSha];
  const { stdout: rawChanges } = await execFileAsync("git", diffArguments, {
    cwd: directory,
    env: environment,
    maxBuffer: 100 * 1024 * 1024
  });
  return {
    commit: {
      treeSha,
      parentShas,
      ...(authorValue?.trim() ? { author: authorValue.trim() } : {}),
      ...(authoredAtValue?.trim() ? { authoredAt: authoredAtValue.trim() } : {}),
      ...(committedAtValue?.trim() ? { committedAt: committedAtValue.trim() } : {}),
      message: messageParts.join("\0").trim()
    },
    changes: parseRawGitChanges(rawChanges)
  };
}

async function readGitHistoryMetadata(
  directory: string,
  commitSha: string
): Promise<{
  readonly commits: NonNullable<GitSnapshotMetadata["history"]>;
  readonly complete: boolean;
}> {
  const maximum = Math.min(positiveInt(process.env.CONTEXT_GIT_HISTORY_LIMIT, 5_000), 50_000);
  const { stdout } = await execFileAsync(
    "git",
    [
      "log",
      "--topo-order",
      `--max-count=${maximum + 1}`,
      "--format=%H%x00%T%x00%P%x00%an <%ae>%x00%aI%x00%cI%x00%B%x1e",
      commitSha
    ],
    { cwd: directory, env: gitEnvironment(), maxBuffer: 100 * 1024 * 1024 }
  );
  const parsed = stdout
    .split("\x1e")
    .map((value) => value.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean)
    .map((value) => {
      const [shaValue, treeValue, parentsValue, authorValue, authoredAtValue, committedAtValue, ...messageParts] =
        value.split("\0");
      return {
        sha: requiredGitSha(shaValue?.trim(), "history commit SHA"),
        treeSha: requiredGitSha(treeValue?.trim(), "history tree SHA"),
        parentShas: (parentsValue ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((sha) => requiredGitSha(sha, "history parent SHA")),
        ...(authorValue?.trim() ? { author: authorValue.trim() } : {}),
        ...(authoredAtValue?.trim() ? { authoredAt: authoredAtValue.trim() } : {}),
        ...(committedAtValue?.trim() ? { committedAt: committedAtValue.trim() } : {}),
        message: messageParts.join("\0").trim()
      };
    });
  return { commits: parsed.slice(0, maximum), complete: parsed.length <= maximum };
}

function parseRawGitChanges(value: string): GitChange[] {
  const tokens = value.split("\0").filter(Boolean);
  const changes: GitChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++]!;
    const match = /^:\d{6} \d{6} ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*$/.exec(header);
    if (!match) throw new Error(`unsupported git change entry: ${header.slice(0, 160)}`);
    const oldBlobSha = match[1]!;
    const newBlobSha = match[2]!;
    const code = match[3]!;
    const firstPath = tokens[index++];
    if (!firstPath) throw new Error("git change entry is missing a path");
    if (code === "R" || code === "C") {
      const path = tokens[index++];
      if (!path) throw new Error("git rename/copy entry is missing its destination path");
      changes.push({
        kind: code === "R" ? "rename" : "copy",
        oldPath: firstPath,
        path,
        oldBlobSha,
        newBlobSha
      });
      continue;
    }
    if (code === "A") {
      changes.push({ kind: "add", path: firstPath, newBlobSha });
    } else if (code === "D") {
      changes.push({ kind: "delete", path: firstPath, oldBlobSha });
    } else {
      changes.push({ kind: "modify", path: firstPath, oldBlobSha, newBlobSha });
    }
  }
  return changes;
}

async function readRepositoryFiles(directory: string, commitSha: string): Promise<IngestEvidenceInput["files"]> {
  const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "-l", "-z", commitSha], {
    cwd: directory,
    env: gitEnvironment(),
    maxBuffer: 100 * 1024 * 1024
  });
  const maximumFileBytes = positiveInt(process.env.CONTEXT_MAX_FILE_BYTES, 5 * 1024 * 1024);
  const maximumTotalBytes = positiveInt(process.env.CONTEXT_MAX_SNAPSHOT_BYTES, 8 * 1024 * 1024);
  const entries = parseGitTreeEntries(stdout);
  let selectedBytes = 0;
  const selected = entries.map((entry) => {
    const includeContent =
      entry.entryType === "file" && entry.size <= maximumFileBytes && selectedBytes + entry.size <= maximumTotalBytes;
    if (includeContent) selectedBytes += entry.size;
    return { ...entry, includeContent };
  });
  return mapWithConcurrency(selected, 12, async (entry) => {
    if (entry.entryType === "gitlink") {
      return {
        path: entry.path,
        blobSha: entry.objectId,
        body: "",
        executable: false,
        contentOmitted: true,
        entryType: "gitlink" as const
      };
    }
    if (entry.entryType === "symlink") {
      let linkTarget: string | undefined;
      if (entry.size <= maximumFileBytes) {
        const { stdout: blob } = await execFileAsync("git", ["cat-file", "blob", entry.objectId], {
          cwd: directory,
          env: gitEnvironment(),
          encoding: "buffer",
          maxBuffer: maximumFileBytes + 1
        });
        const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(String(blob));
        if (!isProbablyBinary(buffer)) linkTarget = buffer.toString("utf8");
      }
      return {
        path: entry.path,
        blobSha: entry.objectId,
        body: "",
        executable: false,
        contentOmitted: true,
        entryType: "symlink" as const,
        ...(linkTarget === undefined ? {} : { linkTarget })
      };
    }
    const language = languageForPath(entry.path);
    if (!entry.includeContent) {
      return {
        path: entry.path,
        blobSha: entry.objectId,
        body: "",
        ...(language ? { language } : {}),
        executable: entry.mode === "100755",
        contentOmitted: true
      };
    }
    const { stdout: blob } = await execFileAsync("git", ["cat-file", "blob", entry.objectId], {
      cwd: directory,
      env: gitEnvironment(),
      encoding: "buffer",
      maxBuffer: maximumFileBytes + 1
    });
    const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(String(blob));
    const contentOmitted = isProbablyBinary(buffer);
    const body = contentOmitted ? "" : buffer.toString("utf8");
    return {
      path: entry.path,
      blobSha: entry.objectId,
      body,
      ...(language ? { language } : {}),
      executable: entry.mode === "100755",
      ...(contentOmitted ? { contentOmitted: true } : {})
    };
  });
}

function isProbablyBinary(value: Buffer): boolean {
  if (value.includes(0)) return true;
  if (value.length === 0) return false;
  const sample = value.subarray(0, Math.min(value.length, 8_192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.1;
}

async function loadProviderObservations(
  repository: string,
  commitSha: string
): Promise<{
  readonly observations: ProviderObservationInput[];
  readonly complete: boolean;
  readonly frontier: Record<string, unknown>;
}> {
  const observedAt = new Date().toISOString();
  const [metadata, pullRequests, issues, issueComments, reviewComments, commitComments] = await Promise.all([
    githubJson(`/repos/${repository}`),
    githubOptionalPaginatedArray(`/repos/${repository}/pulls?state=all&sort=updated&direction=desc`),
    githubOptionalPaginatedArray(`/repos/${repository}/issues?state=all&sort=updated&direction=desc`),
    githubOptionalPaginatedArray(`/repos/${repository}/issues/comments?sort=updated&direction=desc`),
    githubOptionalPaginatedArray(`/repos/${repository}/pulls/comments?sort=updated&direction=desc`),
    githubOptionalPaginatedArray(`/repos/${repository}/comments`)
  ]);
  const observations: ProviderObservationInput[] = [
    {
      sourceType: "observation",
      sourceId: `github:repository:${repository}:${commitSha}`,
      title: repository,
      payload: metadata,
      ...(typeof metadata.html_url === "string" ? { pathOrUrl: metadata.html_url } : {}),
      observedAt,
      metadata: { provider: "github", kind: "repository" }
    }
  ];
  for (const pullRequest of pullRequests.values) {
    const number = Number(pullRequest.number);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const pathOrUrl = stringValue(pullRequest.html_url);
    observations.push({
      sourceType: "pull_request",
      sourceId: `github:pull_request:${repository}#${number}`,
      title: stringValue(pullRequest.title) || `Pull request #${number}`,
      payload: pullRequest,
      ...(pathOrUrl ? { pathOrUrl } : {}),
      observedAt: stringValue(pullRequest.updated_at) || observedAt,
      metadata: { provider: "github", number }
    });
  }
  for (const issue of issues.values) {
    if (issue.pull_request) continue;
    const number = Number(issue.number);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const pathOrUrl = stringValue(issue.html_url);
    observations.push({
      sourceType: "issue",
      sourceId: `github:issue:${repository}#${number}`,
      title: stringValue(issue.title) || `Issue #${number}`,
      payload: issue,
      ...(pathOrUrl ? { pathOrUrl } : {}),
      observedAt: stringValue(issue.updated_at) || observedAt,
      metadata: { provider: "github", number }
    });
  }
  for (const comment of issueComments.values) {
    const id = Number(comment.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const pathOrUrl = stringValue(comment.html_url);
    observations.push({
      sourceType: "observation",
      sourceId: `github:issue_comment:${repository}:${id}`,
      title: `GitHub issue discussion comment ${id}`,
      payload: comment,
      ...(pathOrUrl ? { pathOrUrl } : {}),
      observedAt: stringValue(comment.updated_at) || stringValue(comment.created_at) || observedAt,
      metadata: {
        provider: "github",
        kind: "issue_comment",
        ...(stringValue(comment.issue_url) ? { issueUrl: stringValue(comment.issue_url) } : {})
      }
    });
  }
  for (const comment of reviewComments.values) {
    const id = Number(comment.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const pathOrUrl = stringValue(comment.html_url);
    observations.push({
      sourceType: "observation",
      sourceId: `github:pull_request_review_comment:${repository}:${id}`,
      title: `GitHub pull request review comment ${id}`,
      payload: comment,
      ...(pathOrUrl ? { pathOrUrl } : {}),
      observedAt: stringValue(comment.updated_at) || stringValue(comment.created_at) || observedAt,
      metadata: {
        provider: "github",
        kind: "pull_request_review_comment",
        ...(stringValue(comment.pull_request_url) ? { pullRequestUrl: stringValue(comment.pull_request_url) } : {})
      }
    });
  }
  for (const comment of commitComments.values) {
    const id = Number(comment.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const pathOrUrl = stringValue(comment.html_url);
    observations.push({
      sourceType: "observation",
      sourceId: `github:commit_comment:${repository}:${id}`,
      title: `GitHub commit discussion comment ${id}`,
      payload: comment,
      ...(pathOrUrl ? { pathOrUrl } : {}),
      observedAt: stringValue(comment.updated_at) || stringValue(comment.created_at) || observedAt,
      metadata: {
        provider: "github",
        kind: "commit_comment",
        ...(stringValue(comment.commit_id) ? { commitSha: stringValue(comment.commit_id) } : {})
      }
    });
  }
  return {
    observations,
    complete:
      pullRequests.complete &&
      issues.complete &&
      issueComments.complete &&
      reviewComments.complete &&
      commitComments.complete,
    frontier: {
      pullRequests: {
        observed: pullRequests.values.length,
        complete: pullRequests.complete,
        ...(pullRequests.reason ? { reason: pullRequests.reason } : {})
      },
      issues: {
        observed: issues.values.length,
        complete: issues.complete,
        ...(issues.reason ? { reason: issues.reason } : {})
      },
      issueComments: {
        observed: issueComments.values.length,
        complete: issueComments.complete,
        ...(issueComments.reason ? { reason: issueComments.reason } : {})
      },
      reviewComments: {
        observed: reviewComments.values.length,
        complete: reviewComments.complete,
        ...(reviewComments.reason ? { reason: reviewComments.reason } : {})
      },
      commitComments: {
        observed: commitComments.values.length,
        complete: commitComments.complete,
        ...(commitComments.reason ? { reason: commitComments.reason } : {})
      }
    }
  };
}

async function runReview(work: ClaimedWork<"run-review">): Promise<Record<string, unknown>> {
  const { repository, pullRequestNumber } = work.task.metadata;
  const [pullRequest, diff] = await Promise.all([
    githubJson(`/repos/${repository}/pulls/${pullRequestNumber}`),
    githubText(`/repos/${repository}/pulls/${pullRequestNumber}`, "application/vnd.github.v3.diff")
  ]);
  const reviewRequest: ReviewRequest = {
    repository,
    pullRequestNumber,
    title: typeof pullRequest.title === "string" ? pullRequest.title : `Pull request #${pullRequestNumber}`,
    diff
  };
  const prepared = prepareDiff(reviewRequest.diff);
  const model = process.env.REVIEW_MODEL?.trim() || "gpt-5.6-sol";
  const apiKey = requiredEnv("OPENAI_API_KEY");
  const baseUrl = (process.env.OPENAI_API_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: REVIEW_SYSTEM_PROMPT,
      input: buildReviewPrompt(reviewRequest, prepared),
      text: { format: { type: "json_schema", name: "review_findings", schema: REVIEW_FINDINGS_SCHEMA, strict: true } },
      store: false
    }),
    signal: requestSignal(10 * 60 * 1000)
  });
  if (!response.ok) {
    throw new Error(`OpenAI review failed with ${response.status}: ${await boundedFailureDetail(response, [apiKey])}`);
  }
  const parsed = parseReviewOutput(extractOutputText((await response.json()) as Record<string, unknown>));
  return {
    model,
    summary: parsed.summary,
    findingCount: parsed.findings.length,
    findings: parsed.findings,
    diffTruncated: prepared.truncated
  };
}

async function renew(work: ClaimedWork): Promise<void> {
  const response = await apiRequest(
    "/internal/worker/renew",
    {
      messageId: work.message.id,
      leaseId: work.message.leaseId,
      ...(work.message.attempt === undefined ? {} : { attempt: work.message.attempt }),
      ...(work.message.writeFenceToken === undefined ? {} : { writeFenceToken: work.message.writeFenceToken })
    },
    isContextTopic(work.topic) ? contextApiTimeoutMs : workerApiTimeoutMs
  );
  if (!response.ok) {
    const message = `renewal failed with ${response.status}: ${await boundedFailureDetail(response)}`;
    if (response.status === 409) throw new LeaseLostError(message);
    throw new Error(message);
  }
  recordApiSuccess();
}

async function complete(work: ClaimedWork, result: WorkResult): Promise<void> {
  const response = await apiRequest(
    "/internal/worker/complete",
    {
      messageId: work.message.id,
      leaseId: work.message.leaseId,
      taskId: work.task.id,
      ...(work.message.attempt === undefined ? {} : { attempt: work.message.attempt }),
      ...(work.message.writeFenceToken === undefined ? {} : { writeFenceToken: work.message.writeFenceToken }),
      ...result
    },
    isContextTopic(work.topic) ? contextCompletionTimeoutMs : workerApiTimeoutMs
  );
  if (response.status === 409) {
    throw new LeaseLostError(`completion rejected after lease loss: ${await boundedFailureDetail(response)}`);
  }
  if (!response.ok)
    throw new Error(`completion failed with ${response.status}: ${await boundedFailureDetail(response)}`);
  recordApiSuccess();
}

function apiRequest(path: string, body: unknown, timeoutMs = workerApiTimeoutMs): Promise<Response> {
  assertLeaseOwned();
  const tenantId = activeWork?.task.metadata.tenantId;
  return fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(tenantId ? { "x-jina-tenant-id": tenantId } : {})
    },
    body: JSON.stringify(body),
    signal: requestSignal(timeoutMs)
  });
}

async function internalApiJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const response = await apiRequest(path, body, contextApiTimeoutMs);
  if (!response.ok) {
    throw new Error(`Context API ${path} failed with ${response.status}: ${await boundedFailureDetail(response)}`);
  }
  return (await response.json()) as T;
}

async function githubJson(path: string): Promise<Record<string, unknown>> {
  const response = await githubRequest(path, "application/vnd.github+json");
  return (await response.json()) as Record<string, unknown>;
}

async function githubOptionalJsonArray(
  path: string
): Promise<{ values: Record<string, unknown>[]; complete: boolean; reason?: string }> {
  try {
    const response = await githubRequest(path, "application/vnd.github+json");
    const value: unknown = await response.json();
    if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
      throw new Error(`GitHub response ${path} is not an object array`);
    }
    return { values: value as Record<string, unknown>[], complete: true };
  } catch (error) {
    if (!/GitHub request failed with (?:403|404):/.test(errorMessage(error))) throw error;
    logger.warn(`optional GitHub source unavailable: ${path}`, {
      event: "ingest.github_source_unavailable",
      path
    });
    return { values: [], complete: false, reason: errorMessage(error).slice(0, 200) };
  }
}

async function githubOptionalPaginatedArray(
  path: string
): Promise<{ values: Record<string, unknown>[]; complete: boolean; reason?: string }> {
  const maximum = Math.min(positiveInt(process.env.CONTEXT_GITHUB_HISTORY_LIMIT, 500), 5_000);
  const values: Record<string, unknown>[] = [];
  for (let page = 1; values.length < maximum; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await githubOptionalJsonArray(`${path}${separator}per_page=100&page=${page}`);
    if (!batch.complete) return { values, complete: false, ...(batch.reason ? { reason: batch.reason } : {}) };
    values.push(...batch.values.slice(0, maximum - values.length));
    if (batch.values.length < 100) return { values, complete: true };
  }
  return { values, complete: false, reason: `history limit ${maximum} reached` };
}

async function githubText(path: string, accept: string): Promise<string> {
  const response = await githubRequest(path, accept);
  return response.text();
}

async function githubRequest(path: string, accept: string): Promise<Response> {
  const githubToken =
    activeLease?.githubToken ?? (process.env.GITHUB_API_TOKEN ?? process.env.GITHUB_CLONE_TOKEN)?.trim();
  const baseUrl = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/$/, "");
  const attempts = positiveInt(process.env.GITHUB_RETRY_ATTEMPTS, 4);
  for (let attempt = 0; ; attempt += 1) {
    assertLeaseOwned();
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "jina-worker",
        ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {})
      },
      signal: requestSignal(60_000)
    });
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt + 1 < attempts) {
      await delay(Math.min(positiveInt(process.env.GITHUB_RETRY_BASE_MS, 1_000) * 2 ** attempt, 60_000));
      continue;
    }
    throw new Error(`GitHub request failed with ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const cloneToken =
    activeLease?.githubToken ?? (process.env.GITHUB_API_TOKEN ?? process.env.GITHUB_CLONE_TOKEN)?.trim();
  if (!cloneToken) return process.env;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${cloneToken}`).toString("base64")}`,
    GIT_TERMINAL_PROMPT: "0"
  };
}

function languageForPath(path: string): string | undefined {
  const extension = path.toLowerCase().split(".").pop();
  return {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    rb: "ruby",
    php: "php",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    kt: "kotlin"
  }[extension ?? ""];
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string" && content.text.trim()) return content.text;
    }
  }
  throw new Error("OpenAI response did not contain output text");
}

function configuredTopics(value: string | undefined): WorkerTopic[] {
  const requested = (value ?? "run-review|run-research|run-publish|run-cleanup")
    .split(/[|,]/)
    .map((topic) => topic.trim())
    .filter(Boolean);
  const unknown = requested.filter((topic) => !SUPPORTED_TOPICS.includes(topic as WorkerTopic));
  if (unknown.length > 0) throw new Error(`WORKER_TOPICS contains unsupported topics: ${unknown.join(", ")}`);
  if (requested.length === 0) throw new Error("WORKER_TOPICS must contain at least one topic");
  return [...new Set(requested as WorkerTopic[])];
}

function parseClaimedWork(value: unknown): ClaimedWork {
  if (!isRecord(value) || !isRecord(value.message) || !isRecord(value.task) || !isRecord(value.task.metadata)) {
    throw new Error("claim response must include message, task, and task metadata");
  }
  const topicValue = requiredString(value.message.topic, "claim message topic");
  if (!SUPPORTED_TOPICS.includes(topicValue as WorkerTopic)) throw new Error(`unsupported claimed topic ${topicValue}`);
  const topic = topicValue as WorkerTopic;
  const message = {
    id: requiredString(value.message.id, "claim message id"),
    leaseId: requiredString(value.message.leaseId, "claim lease id"),
    leaseExpiresAt: requiredString(value.message.leaseExpiresAt, "claim lease expiry"),
    ...(value.message.attempt === undefined
      ? {}
      : { attempt: requiredPositiveInteger(value.message.attempt, "claim attempt") }),
    ...(value.message.writeFenceToken === undefined
      ? {}
      : { writeFenceToken: requiredString(value.message.writeFenceToken, "claim write fence token") })
  };
  const taskId = requiredString(value.task.id, "claim task id");
  const metadata = value.task.metadata;
  if (topic === "run-review") {
    return {
      topic,
      message: { ...message, topic },
      task: {
        id: taskId,
        metadata: {
          tenantId: requiredString(metadata.tenantId, "task tenantId"),
          repository: requiredString(metadata.repository, "task repository"),
          pullRequestNumber: requiredPositiveInteger(metadata.pullRequestNumber, "task pullRequestNumber")
        }
      }
    };
  }
  if (topic === "run-research") {
    return {
      topic,
      message: { ...message, topic },
      task: {
        id: taskId,
        metadata: {
          tenantId: requiredString(metadata.tenantId, "task tenantId"),
          ...(metadata.question === undefined ? {} : { question: requiredString(metadata.question, "task question") }),
          ...(metadata.sourceUrls === undefined
            ? {}
            : { sourceUrls: requiredStringArray(metadata.sourceUrls, "task sourceUrls") })
        }
      }
    };
  }
  if (isContextTopic(topic)) {
    const common = repositoryMetadata(metadata);
    const contextMetadata =
      topic === "run-ingest-evidence"
        ? {
            ...common,
            ...(metadata.commitSha === undefined
              ? {}
              : { commitSha: requiredGitSha(metadata.commitSha, "task commitSha") })
          }
        : {
            ...common,
            commitSha: requiredGitSha(metadata.commitSha, "task commitSha"),
            checkpointId: requiredString(metadata.checkpointId, "task checkpointId")
          };
    return {
      topic,
      message: { ...message, topic },
      task: { id: taskId, metadata: contextMetadata }
    } as ClaimedWork;
  }
  return {
    topic,
    message: { ...message, topic },
    task: {
      id: taskId,
      metadata: { ...metadata, tenantId: requiredString(metadata.tenantId, "task tenantId") }
    }
  } as ClaimedWork;
}

function repositoryMetadata(metadata: Record<string, unknown>): RepositoryContextMetadata {
  return {
    tenantId: requiredString(metadata.tenantId, "task tenantId"),
    repository: requiredString(metadata.repository, "task repository"),
    ref: requiredString(metadata.ref, "task ref"),
    refSequence: requiredPositiveInteger(metadata.refSequence, "task refSequence"),
    ...(metadata.githubInstallationId === undefined
      ? {}
      : {
          githubInstallationId: requiredPositiveInteger(metadata.githubInstallationId, "task githubInstallationId")
        })
  };
}

function isContextTopic(topic: string): topic is ContextWorkerTopic {
  return CONTEXT_TOPICS.includes(topic as ContextWorkerTopic);
}

function requiredStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a string array`);
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function assertLeaseOwned(): void {
  if (activeLease?.lostReason) throw new LeaseLostError(activeLease.lostReason);
}

function requestSignal(timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return activeLease ? AbortSignal.any([activeLease.controller.signal, timeout]) : timeout;
}

function loseLease(lease: LeaseExecutionState, error: unknown): void {
  if (lease.lostReason) return;
  lease.lostReason = errorMessage(error);
  recordApiFailure(new LeaseLostError(lease.lostReason));
  lease.controller.abort(new LeaseLostError(lease.lostReason));
}

function recordApiSuccess(clearError = true): void {
  lastApiSuccessAt = new Date().toISOString();
  if (!clearError) return;
  hasApiError = false;
  lastApiErrorAt = undefined;
  consecutiveApiFailures = 0;
}

function recordApiFailure(_error: unknown): void {
  hasApiError = true;
  lastApiErrorAt = new Date().toISOString();
  consecutiveApiFailures += 1;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredGitSha(value: unknown, name: string): string {
  const sha = requiredString(value, name).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${name} must be a full Git SHA`);
  return sha;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function boundedFailureDetail(response: Response, secrets: readonly string[] = []): Promise<string> {
  let detail = (await response.text().catch(() => "unreadable body")).slice(0, 500);
  for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, "[REDACTED]");
  return detail;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(values.length, Math.max(1, limit)) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function releaseContextLeaseOnShutdown(work: ClaimedWork): Promise<void> {
  if (!isContextTopic(work.topic)) return;
  const response = await fetch(`${apiUrl}/internal/worker/release`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-jina-tenant-id": work.task.metadata.tenantId
    },
    body: JSON.stringify({
      messageId: work.message.id,
      leaseId: work.message.leaseId,
      ...(work.message.attempt === undefined ? {} : { attempt: work.message.attempt }),
      ...(work.message.writeFenceToken === undefined ? {} : { writeFenceToken: work.message.writeFenceToken }),
      reason: "worker shutdown"
    }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`lease release failed with ${response.status}: ${await boundedFailureDetail(response)}`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    const work = activeWork;
    if (activeLease) loseLease(activeLease, new LeaseLostError(`worker received ${signal}`));
    if (work) {
      void releaseContextLeaseOnShutdown(work).catch((error) => {
        logger.error("worker lease release failed", {
          event: "worker.lease_release_failed",
          workerId,
          taskId: work.task.id,
          ...errorLogFields(error)
        });
      });
    }
    server.close(() => undefined);
  });
}
