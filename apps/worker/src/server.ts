import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { DaytonaCodexContextGraphExecutor } from "@jina/daytona";
import { createGitHubInstallationAccessToken, type GitHubInstallationAccessToken } from "@jina/github";
import { createLogger, errorLogFields, generateTraceContext, MetricsRegistry } from "@jina/observability";
import {
  CONTEXT_GRAPH_GENERATOR_VERSION,
  CONTEXT_GRAPH_PARSER_VERSION,
  CONTEXT_GRAPH_REGISTRY_VERSION,
  analyzeSourceBlob,
  assertionEvidenceFingerprint,
  assertionsFromGeneratedContextGraph,
  codeCheckpoint,
  languageForPath,
  linkedIssueNumbers,
  isProblemEvidencePath,
  movedFromSimilarityCandidates,
  parseContextFrameworkModes,
  parseIncidentDocument,
  parseIncidentDocumentObservations,
  parsePackageManifest,
  parseServiceDefinitions,
  selectAssertionFocusPaths,
  validateSourceBackedModelEntities,
  type BlobAnalysis,
  type GitHubSourceObservation,
  type RepositorySourceObservation,
  type ContextGraphAssertionBatch,
  type ContextGraphIngestPlan,
  type ContextGraphSourceEvidence,
  type ContextGraphSourceIngestResult,
  type RepositorySnapshot,
  type RepositoryTreeDelta,
  type RepositoryTreeEntry
} from "@jina/context-graph";
import { workerFailureCategory, type WorkerFailureCategory } from "./diagnostics.js";
import { shouldReconcileRecentPullRequest } from "./github-reconciliation.js";
import { contextGraphHistoryPolicy, type ContextGraphHistoryPolicy } from "./history-limit.js";
import { retryAfterDelayMs } from "./internal-api-retry.js";
import { byteBoundedJsonArrayBatches, serializedJsonBytes } from "./json-batches.js";

const SUPPORTED_TOPICS = [
  "run-review",
  "run-research",
  "run-publish",
  "run-cleanup",
  "run-context-graph-ingest",
  "run-context-graph-assert",
  "run-context-graph-project"
] as const;
type WorkerTopic = (typeof SUPPORTED_TOPICS)[number];

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
  readonly "run-context-graph-ingest": {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly githubInstallationId: number;
    readonly pipelinePhase: "snapshot" | "history";
    readonly historyLimit?: number;
  };
  readonly "run-context-graph-assert": {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly githubInstallationId: number;
    readonly commitSha: string;
    readonly evidenceFingerprint: string;
    readonly analysisPaths?: readonly string[];
    readonly problemEvidencePullRequestNumbers?: readonly number[];
    readonly sourcePullRequestNumbers?: readonly number[];
    readonly resolvedPullRequestNumbers?: readonly number[];
  };
  readonly "run-context-graph-project": {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly githubInstallationId: number;
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
      };
      readonly task: {
        readonly id: string;
        readonly metadata: WorkMetadataByTopic[T];
      };
    }
  : never;

type WorkResult =
  | {
      readonly outcome: "done";
      readonly assertionBatch?: ContextGraphAssertionBatch;
      readonly result?: Record<string, unknown>;
    }
  | { readonly outcome: "failed"; readonly reason: string };

interface LeaseExecutionState {
  readonly controller: AbortController;
  githubToken?: string;
  lostReason?: string;
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
const contextGraphApiTimeoutMs = positiveInt(process.env.CONTEXT_GRAPH_API_TIMEOUT_MS, 15 * 60_000);
const internalApiRetryAttempts = positiveInt(process.env.INTERNAL_API_RETRY_ATTEMPTS, 6);
const internalApiRetryBaseMs = positiveInt(process.env.INTERNAL_API_RETRY_BASE_MS, 1_000);
const internalApiRetryMaxWaitMs = positiveInt(process.env.INTERNAL_API_RETRY_MAX_WAIT_MS, 10_000);
const maxBlobAnalysisRequestBytes = positiveInt(
  process.env.CONTEXT_GRAPH_BLOB_ANALYSIS_REQUEST_BYTES,
  2 * 1024 * 1024 - 64 * 1024
);
const heartbeatIntervalMs = positiveInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 60_000);
const contextFrameworkModes = parseContextFrameworkModes(process.env);
const drainsContextGraphProjections = topics.some((topic) => topic.startsWith("run-context-graph"));
const contextGraphExecutor = topics.includes("run-context-graph-assert")
  ? new DaytonaCodexContextGraphExecutor()
  : undefined;
let stopping = false;
let active = false;
let activeLease: LeaseExecutionState | undefined;
let activeWork: ClaimedWork | undefined;
let lastApiSuccessAt: string | undefined;
let lastApiError: string | undefined;
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
    const ok = Boolean(lastApiSuccessAt) && !lastApiError;
    response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok,
        workerId,
        topics,
        active,
        lastApiSuccessAt,
        lastApiError,
        lastApiErrorAt,
        consecutiveApiFailures,
        lastWork,
        contextFrameworkModes,
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
    topics,
    contextFrameworkModes
  });
  void poll();
});

const idleDrainIntervalMs = positiveInt(process.env.WORKER_IDLE_DRAIN_INTERVAL_MS, 60_000);
let lastIdleDrainAt = 0;

async function poll(): Promise<void> {
  while (!stopping) {
    try {
      const work = await claim();
      if (work) await execute(work);
      // Drain right after finishing work; while idle, only on the slow safety
      // interval so empty polls stop paying the projection sweep every tick.
      if (drainsContextGraphProjections && (work || Date.now() - lastIdleDrainAt >= idleDrainIntervalMs)) {
        lastIdleDrainAt = Date.now();
        await drainContextGraphProjectionEvents();
      }
    } catch (error) {
      recordApiFailure(error);
      metrics.count("worker.poll_failures");
      logger.error("worker poll failed", { event: "worker.poll_failed", workerId, ...errorLogFields(error) });
    }
    if (!stopping) await delay(pollIntervalMs);
  }
}

async function drainContextGraphProjectionEvents(): Promise<void> {
  await internalApiJson("/internal/context-graph/outbox/drain", {});
  recordApiSuccess();
}

async function claim(): Promise<ClaimedWork | undefined> {
  const response = await apiRequest("/internal/worker/claim", { workerId, topics, claimId: randomUUID() });
  if (response.status === 204) {
    recordApiSuccess(!drainsContextGraphProjections);
    return undefined;
  }
  if (!response.ok) throw new Error(`claim failed with ${response.status}: ${await boundedFailureDetail(response)}`);
  recordApiSuccess(!drainsContextGraphProjections);
  return parseClaimedWork(await response.json());
}

async function execute(work: ClaimedWork): Promise<void> {
  active = true;
  activeWork = work;
  const startedAt = Date.now();
  const lease: LeaseExecutionState = { controller: new AbortController() };
  activeLease = lease;
  const heartbeat = setInterval(() => {
    void renew(work).catch((error) => {
      if (error instanceof LeaseLostError) {
        loseLease(lease, error);
        metrics.count("worker.lease_lost", { topic: work.message.topic });
        logger.error("worker lease renewal failed", {
          event: "worker.lease_lost",
          workerId,
          taskId: work.task.id,
          reason: lease.lostReason
        });
        return;
      }
      recordApiFailure(error);
      logger.warn("worker lease renewal failed, retrying on next heartbeat", {
        event: "worker.lease_renewal_retry",
        workerId,
        taskId: work.task.id,
        ...errorLogFields(error)
      });
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
    logStageOutcome(work, startedAt, result, undefined);
  } catch (error) {
    if (error instanceof LeaseLostError) {
      loseLease(lease, error);
      lastWork = { topic: work.message.topic, outcome: "lease_lost", finishedAt: new Date().toISOString() };
      logStageOutcome(work, startedAt, undefined, lease.lostReason ?? "lease lost");
      return;
    }
    throw error;
  } finally {
    activeLease = undefined;
    activeWork = undefined;
    active = false;
  }
}

/**
 * One structured log line plus one metrics sample per finished task so stage
 * durations, outcomes, and failure categories are queryable in Cloud Logging
 * and countable through log-based metrics. Failure reasons reuse the
 * already-redacted error message (errorMessage + slice) rather than raw
 * exceptions, matching this file's failure-logging conventions.
 */
function logStageOutcome(
  work: ClaimedWork,
  startedAt: number,
  result: WorkResult | undefined,
  failureReason: string | undefined
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
    failureReason !== undefined || !result
      ? (failureReason ?? "unknown")
      : result.outcome === "failed"
        ? result.reason
        : undefined;
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
  const effect = result?.outcome === "done" ? result.result?.effect : undefined;
  stageLogger.info(`${work.message.topic} completed for task ${work.task.id}`, {
    event: "stage.completed",
    ...base,
    ...(typeof effect === "string" ? { effect } : {})
  });
}

async function executeTopic(work: ClaimedWork): Promise<WorkResult> {
  switch (work.topic) {
    case "run-context-graph-ingest":
      return { outcome: "done", result: await runContextGraphIngest(work) };
    case "run-context-graph-assert":
      return await runContextGraphAssertions(work);
    case "run-context-graph-project": {
      // Run the projection on its long-window route so completion stays a
      // fast status flip instead of racing the 30-second completion timeout.
      const projected = await internalApiJson<Record<string, unknown>>("/internal/context-graph/project/run", {
        taskId: work.task.id,
        messageId: work.message.id,
        leaseId: work.message.leaseId
      });
      return { outcome: "done", result: { projected } };
    }
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

async function activateGitHubInstallationAccess(
  installationId: number,
  repository: string
): Promise<GitHubInstallationAccessToken> {
  assertLeaseOwned();
  const access = await createGitHubInstallationAccessToken(installationId);
  assertLeaseOwned();
  if (!activeLease) throw new Error("GitHub installation token was minted outside an active worker lease");
  activeLease.githubToken = access.token;
  logger.info(`GitHub installation access ready for ${repository}`, {
    event: "github.installation_access_ready",
    workerId,
    repository,
    installationId,
    ...(access.expiresAt ? { expiresAt: access.expiresAt } : {})
  });
  return access;
}

async function runContextGraphIngest(work: ClaimedWork<"run-context-graph-ingest">): Promise<Record<string, unknown>> {
  const { tenantId, repository, ref, githubInstallationId } = work.task.metadata;
  const access = await activateGitHubInstallationAccess(githubInstallationId, repository);
  const lease = { messageId: work.message.id, leaseId: work.message.leaseId };
  if ((process.env.CONTEXT_GRAPH_INGEST_TRANSPORT?.trim() || "rest") === "git") {
    activeGitIngestTransport = new GitIngestTransport(repository, ref, access.token);
  }
  try {
    return await runContextGraphIngestWithTransport(work, tenantId, repository, ref, lease);
  } finally {
    await activeGitIngestTransport?.dispose();
    activeGitIngestTransport = undefined;
  }
}

async function runContextGraphIngestWithTransport(
  work: ClaimedWork<"run-context-graph-ingest">,
  tenantId: string,
  repository: string,
  ref: string,
  lease: { readonly messageId: string; readonly leaseId: string }
): Promise<Record<string, unknown>> {
  const [head, repositoryMetadata] = await Promise.all([
    githubJson(`/repos/${repository}/commits/${encodeURIComponent(ref)}`),
    githubJson(`/repos/${repository}`)
  ]);
  const commitSha = requiredGitSha(head.sha, "GitHub commit SHA");
  const serviceHistoryLimit = positiveInt(process.env.CONTEXT_GRAPH_HISTORY_LIMIT, 10_000);
  const historyPolicy =
    work.task.metadata.pipelinePhase === "history"
      ? contextGraphHistoryPolicy(work.task.metadata.historyLimit, serviceHistoryLimit)
      : contextGraphHistoryPolicy(undefined, serviceHistoryLimit);
  const discovery =
    work.task.metadata.pipelinePhase === "snapshot"
      ? { commits: new Map([[commitSha, head]]), knownCommitShas: new Set<string>(), truncated: false }
      : await discoverNewCommits(work, repository, head, historyPolicy);
  const orderedShas = topologicalCommitOrder(commitSha, discovery.commits);
  const defaultBranch =
    typeof repositoryMetadata.default_branch === "string" ? repositoryMetadata.default_branch : "main";
  let headPlan: ContextGraphIngestPlan | undefined;
  let parsedBlobCount = 0;
  let reusedBlobCount = 0;
  let discoveredBlobCount = 0;
  let fileCount = 0;
  let headPaths = new Set<string>();
  const changedPathsByCommit = new Map<string, readonly string[]>();
  let ownershipObservation: GitHubSourceObservation | undefined;
  const deterministicObservations: RepositorySourceObservation[] = [];
  const workItems = new Map<number, { item: Record<string, unknown>; commitShas: Set<string> }>();
  const recentTrees = new Map<string, ReadonlyMap<string, RepositoryTreeEntry>>();
  for (const sha of orderedShas) {
    const commit =
      discovery.commits.get(sha) ??
      (sha === commitSha ? head : await githubJson(`/repos/${repository}/commits/${sha}`));
    const snapshot = await repositorySnapshotFromGitHub({
      tenantId,
      repository,
      ref,
      taskId: work.task.id,
      commit,
      isHead: sha === commitSha,
      isDefaultRef: ref === defaultBranch
    });
    // Chain commits ship only their first-parent delta; the head keeps the full
    // tree so the ref manifest and blob backlog are re-checked end to end.
    const parentTree = snapshot.parents[0] ? recentTrees.get(snapshot.parents[0]) : undefined;
    const wireSnapshot: RepositorySnapshot =
      sha !== commitSha && parentTree
        ? { ...snapshot, mode: "delta", files: [], deltas: computeTreeDeltas(parentTree, snapshot.files) }
        : snapshot;
    recentTrees.set(sha, new Map(snapshot.files.map((file) => [file.path, file])));
    if (recentTrees.size > 8) {
      const oldest = recentTrees.keys().next().value;
      if (oldest !== undefined) recentTrees.delete(oldest);
    }
    const plan = await internalApiJson<ContextGraphIngestPlan>("/internal/context-graph/ingest/plan", {
      ...lease,
      snapshot: wireSnapshot
    });
    changedPathsByCommit.set(sha, plan.changedPaths);
    const analyses = await mapWithConcurrency(plan.missingBlobs, 8, (missing) =>
      analyzeGitHubBlob(repository, missing)
    );
    const emptyBlobRequest = blobAnalysisRequest(work, snapshot.commitSha, []);
    for (const batch of byteBoundedJsonArrayBatches(analyses, {
      maximumBytes: maxBlobAnalysisRequestBytes,
      emptyPayloadBytes: serializedJsonBytes(emptyBlobRequest)
    })) {
      await submitBlobAnalyses(work, snapshot.commitSha, batch);
    }
    parsedBlobCount += plan.missingBlobs.length;
    reusedBlobCount += plan.reusedBlobCount;
    discoveredBlobCount += plan.discoveredBlobCount;
    if (sha === commitSha) {
      headPlan = plan;
      headPaths = new Set(snapshot.files.map((file) => file.path));
      fileCount = plan.fileCount;
      const codeowners = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
        .map((path) => snapshot.files.find((file) => file.path === path))
        .find(Boolean);
      if (codeowners) {
        const source = await readGitHubBlob(repository, codeowners.blobSha);
        ownershipObservation = {
          tenantId,
          repository,
          kind: "codeowners",
          commitSha,
          path: codeowners.path,
          entries: parseCodeowners(source),
          recordedAt: snapshot.recordedAt
        };
      } else {
        const removedCodeowners = plan.changes.find(
          (change) =>
            change.change === "delete" && [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].includes(change.path)
        );
        if (removedCodeowners)
          ownershipObservation = {
            tenantId,
            repository,
            kind: "codeowners",
            commitSha,
            path: removedCodeowners.path,
            entries: [],
            recordedAt: snapshot.recordedAt
          };
      }
      const deterministicFiles = snapshot.files.filter((file) => isDeterministicSourcePath(file.path)).slice(0, 100);
      for (const file of deterministicFiles) {
        const source = await readGitHubBlob(repository, file.blobSha);
        const manifest = parsePackageManifest({
          tenantId,
          repository,
          commitSha,
          path: file.path,
          source,
          recordedAt: snapshot.recordedAt
        });
        if (manifest) deterministicObservations.push(manifest);
        deterministicObservations.push(
          ...parseServiceDefinitions({
            tenantId,
            repository,
            commitSha,
            path: file.path,
            content: source,
            recordedAt: snapshot.recordedAt
          })
        );
        deterministicObservations.push(
          ...parseIncidentDocumentObservations({
            tenantId,
            repository,
            path: file.path,
            content: source,
            recordedAt: snapshot.recordedAt
          })
        );
      }
      for (const removed of plan.changes.filter(
        (change) => change.change === "delete" && change.oldBlobSha && isDeterministicSourcePath(change.path)
      )) {
        const source = await readGitHubBlob(repository, removed.oldBlobSha!);
        const manifest = parsePackageManifest({
          tenantId,
          repository,
          commitSha,
          path: removed.path,
          source,
          recordedAt: snapshot.recordedAt
        });
        if (manifest) deterministicObservations.push({ ...manifest, dependencies: [], removed: true });
        deterministicObservations.push(
          ...parseServiceDefinitions({
            tenantId,
            repository,
            commitSha,
            path: removed.path,
            content: source,
            recordedAt: snapshot.recordedAt
          }).map((service) => ({ ...service, dependsOnServices: [], removed: true }))
        );
        const incident = parseIncidentDocument({
          tenantId,
          repository,
          path: removed.path,
          content: source,
          recordedAt: snapshot.recordedAt
        });
        if (incident) deterministicObservations.push({ ...incident, removed: true });
      }
    }
    for (const pullRequest of await githubJsonArray(`/repos/${repository}/commits/${sha}/pulls`)) {
      const number = requiredPositiveInteger(pullRequest.number, "GitHub pull request number");
      const existing = workItems.get(number) ?? { item: pullRequest, commitShas: new Set<string>() };
      existing.commitShas.add(sha);
      workItems.set(number, existing);
    }
  }
  if (!headPlan) throw new Error("head commit was not included in repository history ingestion");
  const moveCandidates = await buildMoveCandidates(repository, headPlan);
  if (moveCandidates.length > 0)
    deterministicObservations.push({
      tenantId,
      repository,
      kind: "move_candidate",
      commitSha,
      candidates: moveCandidates,
      recordedAt: new Date().toISOString()
    });
  if (discovery.knownCommitShas.has(commitSha)) {
    await hydrateRecentMergedPullRequestScope(repository, commitSha, discovery.knownCommitShas, workItems);
  }
  const problemEvidencePullRequestNumbers = await hydratePullRequestScope(repository, workItems, headPaths);
  const observations: RepositorySourceObservation[] = [
    ...(await githubWorkItemObservations(tenantId, repository, workItems)),
    ...deterministicObservations,
    ...(await githubDeploymentObservations(tenantId, repository)),
    ...(await githubIncidentObservations(tenantId, repository))
  ];
  if (ownershipObservation) observations.push(ownershipObservation);
  let sourceResult: ContextGraphSourceIngestResult = {
    observationCount: 0,
    observationIds: [],
    assertionCount: 0,
    newObservationCount: 0,
    updatedObservationCount: 0,
    confirmedObservationCount: 0
  };
  if (observations.length > 0) {
    sourceResult = await internalApiJson<ContextGraphSourceIngestResult>("/internal/context-graph/ingest/github", {
      taskId: work.task.id,
      ...lease,
      observations
    });
  }
  const currentCodeCheckpoint = codeCheckpoint(tenantId, repository, commitSha, CONTEXT_GRAPH_PARSER_VERSION);
  const newCommitCount = orderedShas.filter((sha) => !discovery.knownCommitShas.has(sha)).length;
  const confirmedCommitCount = orderedShas.length - newCommitCount;
  const newlyIngestedHistoricalPaths = orderedShas
    .slice(0, -1)
    .reverse()
    .flatMap((sha) => changedPathsByCommit.get(sha) ?? []);
  // If this commit is already known but a new generator version has no cache,
  // give that one run a bounded current-tree scan. The selector prioritizes
  // docs/tests before ordinary files; successful output is then cached.
  const historicalFocusPaths = newCommitCount === 0 ? [...headPaths] : newlyIngestedHistoricalPaths;
  const analysisPaths = selectAssertionFocusPaths(
    headPlan.changedPaths,
    historicalFocusPaths,
    headPaths,
    positiveInt(process.env.CONTEXT_GRAPH_ASSERTION_FOCUS_LIMIT, 200)
  );
  const evidenceFingerprint = assertionEvidenceFingerprint(currentCodeCheckpoint, observations, {
    focusPaths: analysisPaths,
    problemEvidencePullRequestNumbers
  });
  return {
    ...(work.task.metadata.pipelinePhase === "history"
      ? { historyCommitLimit: historyPolicy.limit, historyTruncated: discovery.truncated }
      : {}),
    effect:
      newCommitCount > 0 ||
      parsedBlobCount > 0 ||
      sourceResult.newObservationCount > 0 ||
      sourceResult.updatedObservationCount > 0
        ? "changed"
        : "confirmed",
    observationId: headPlan.observationId,
    commitSha,
    fileCount,
    ingestedCommitCount: newCommitCount,
    newCommitCount,
    confirmedCommitCount,
    workItemObservationCount: observations.length,
    sourceObservationIds: sourceResult.observationIds,
    sourcePullRequestNumbers: observations.flatMap((observation) =>
      observation.kind === "pull_request" ? [observation.number] : []
    ),
    resolvedPullRequestNumbers: observations.flatMap((observation) =>
      observation.kind === "pull_request" && (observation.resolvesIssueNumbers?.length ?? 0) > 0
        ? [observation.number]
        : []
    ),
    newWorkItemObservationCount: sourceResult.newObservationCount,
    updatedWorkItemObservationCount: sourceResult.updatedObservationCount,
    confirmedWorkItemObservationCount: sourceResult.confirmedObservationCount,
    discoveredBlobCount,
    reusedBlobCount,
    parsedBlobCount,
    analysisPaths,
    problemEvidencePullRequestNumbers,
    changeCount: headPlan.changes.length,
    parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
    codeCheckpoint: currentCodeCheckpoint,
    evidenceFingerprint
  };
}

async function discoverNewCommits(
  work: ClaimedWork,
  repository: string,
  head: Record<string, unknown>,
  policy: ContextGraphHistoryPolicy
): Promise<{
  readonly commits: Map<string, Record<string, unknown>>;
  readonly knownCommitShas: Set<string>;
  readonly truncated: boolean;
}> {
  const headSha = requiredGitSha(head.sha, "GitHub head SHA");
  const commits = new Map<string, Record<string, unknown>>([[headSha, head]]);
  const pending = [headSha];
  const expanded = new Set<string>();
  const knownCommitShas = new Set<string>();
  let truncated = false;
  while (pending.length > 0) {
    if (commits.size >= policy.limit) {
      truncated = true;
      break;
    }
    const batchSize = Math.min(25, policy.limit - commits.size);
    const batch = pending.splice(0, Math.max(1, batchSize)).filter((sha) => !expanded.has(sha));
    if (batch.length === 0) continue;
    const known = await internalApiJson<{ readonly knownCommitShas: readonly string[] }>(
      "/internal/context-graph/ingest/known",
      {
        taskId: work.task.id,
        messageId: work.message.id,
        leaseId: work.message.leaseId,
        commitShas: batch
      }
    );
    const knownSet = new Set(known.knownCommitShas);
    const unknownShas = batch.filter((sha) => !knownSet.has(sha) && !commits.has(sha));
    const fetchedCommits = new Map(
      await mapWithConcurrency(
        unknownShas,
        8,
        async (sha) => [sha, await githubJson(`/repos/${repository}/commits/${sha}`)] as const
      )
    );
    for (const sha of batch) {
      expanded.add(sha);
      if (knownSet.has(sha)) {
        knownCommitShas.add(sha);
        if (sha !== headSha) commits.delete(sha);
        continue;
      }
      const commit = commits.get(sha) ?? fetchedCommits.get(sha)!;
      commits.set(sha, commit);
      if (commits.size > policy.limit)
        throw new Error(`reachable Git history discovery exceeded its configured limit of ${policy.limit} commits`);
      for (const parent of Array.isArray(commit.parents) ? commit.parents : []) {
        if (!isRecord(parent)) throw new Error("GitHub commit parent is invalid");
        const parentSha = requiredGitSha(parent.sha, "GitHub parent SHA");
        if (!expanded.has(parentSha)) pending.push(parentSha);
      }
    }
  }
  return { commits, knownCommitShas, truncated };
}

function topologicalCommitOrder(headSha: string, commits: ReadonlyMap<string, Record<string, unknown>>): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (sha: string): void => {
    if (visited.has(sha)) return;
    visited.add(sha);
    const commit = commits.get(sha);
    if (!commit) return;
    for (const parent of Array.isArray(commit.parents) ? commit.parents : []) {
      if (isRecord(parent) && typeof parent.sha === "string") visit(parent.sha);
    }
    ordered.push(sha);
  };
  visit(headSha);
  return ordered;
}

const execFileAsync = promisify(execFile);

/**
 * Local-git read transport for ingest code data. One bare clone replaces the
 * per-commit recursive-tree fetches and per-blob REST reads; commit objects,
 * PRs, and issues stay on REST because git data carries no GitHub login.
 * Any failure marks the transport unusable and callers fall back to REST.
 */
class GitIngestTransport {
  private cloneDir: string | undefined;
  private failed = false;
  constructor(
    private readonly repository: string,
    private readonly ref: string,
    private readonly githubToken: string
  ) {}

  private async git(args: readonly string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
    assertLeaseOwned();
    const basic = Buffer.from(`x-access-token:${this.githubToken}`).toString("base64");
    const { stdout } = await execFileAsync("git", [...args], {
      maxBuffer,
      timeout: 600_000,
      ...(activeLease ? { signal: activeLease.controller.signal } : {}),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`
      }
    });
    return stdout;
  }

  async ensure(): Promise<boolean> {
    if (this.failed) return false;
    if (this.cloneDir) return true;
    const githubUrl = (process.env.GITHUB_CLONE_URL?.trim() || "https://github.com").replace(/\/$/, "");
    const dir = await mkdtemp(join(tmpdir(), "jina-ingest-"));
    try {
      // Bound the transfer to the ingested ref's history and to blobs the
      // parser would actually read (larger blobs are skipped by analysis and
      // lazily fetched only if something else needs them).
      await this.git([
        "clone",
        "--bare",
        "--quiet",
        "--single-branch",
        "--branch",
        this.ref,
        "--filter=blob:limit=524288",
        `${githubUrl}/${this.repository}.git`,
        dir
      ]);
      this.cloneDir = dir;
      return true;
    } catch (error) {
      this.failed = true;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      logger.warn(
        `git ingest transport unavailable for ${this.repository}: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
        { event: "ingest.git_transport_unavailable", repository: this.repository }
      );
      return false;
    }
  }

  async treeEntries(commitSha: string): Promise<readonly RepositoryTreeEntry[] | undefined> {
    if (!(await this.ensure()) || !this.cloneDir) return undefined;
    try {
      const output = await this.git(["-C", this.cloneDir, "ls-tree", "-r", "-l", "-z", commitSha]);
      return output.split("\0").flatMap((line) => {
        if (!line) return [];
        const tab = line.indexOf("\t");
        const [, type, sha, size] = line.slice(0, tab).split(/\s+/);
        if (type !== "blob" || !sha) return [];
        return [
          {
            path: line.slice(tab + 1),
            blobSha: requiredGitSha(sha, "git tree blob SHA"),
            size: Number.isSafeInteger(Number(size)) && Number(size) >= 0 ? Number(size) : 0
          }
        ];
      });
    } catch {
      this.failed = true;
      return undefined;
    }
  }

  async blob(blobSha: string): Promise<string | undefined> {
    if (!(await this.ensure()) || !this.cloneDir) return undefined;
    try {
      return await this.git(["-C", this.cloneDir, "cat-file", "blob", blobSha]);
    } catch {
      return undefined;
    }
  }

  async dispose(): Promise<void> {
    if (this.cloneDir) await rm(this.cloneDir, { recursive: true, force: true }).catch(() => undefined);
    this.cloneDir = undefined;
  }
}

/** Ingest-scoped transport; the worker executes one task at a time. */
let activeGitIngestTransport: GitIngestTransport | undefined;

function computeTreeDeltas(
  parentTree: ReadonlyMap<string, RepositoryTreeEntry>,
  files: readonly RepositoryTreeEntry[]
): readonly RepositoryTreeDelta[] {
  const deltas: RepositoryTreeDelta[] = [];
  const currentPaths = new Set<string>();
  for (const file of files) {
    currentPaths.add(file.path);
    const previous = parentTree.get(file.path);
    if (!previous || previous.blobSha !== file.blobSha) {
      deltas.push({ path: file.path, blobSha: file.blobSha, size: file.size });
    }
  }
  for (const path of parentTree.keys()) {
    if (!currentPaths.has(path)) deltas.push({ path, blobSha: null, size: 0 });
  }
  return deltas;
}

async function repositorySnapshotFromGitHub(input: {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly taskId: string;
  readonly commit: Record<string, unknown>;
  readonly isHead: boolean;
  readonly isDefaultRef: boolean;
}): Promise<RepositorySnapshot> {
  const commitSha = requiredGitSha(input.commit.sha, "GitHub commit SHA");
  const commitDetails = isRecord(input.commit.commit) ? input.commit.commit : {};
  const treeDetails = isRecord(commitDetails.tree) ? commitDetails.tree : {};
  const authorDetails = isRecord(commitDetails.author) ? commitDetails.author : {};
  const githubAuthor = isRecord(input.commit.author) ? input.commit.author : {};
  const treeSha = requiredGitSha(treeDetails.sha, "GitHub tree SHA");
  const localEntries = await activeGitIngestTransport?.treeEntries(commitSha);
  let entries: unknown[] = [];
  if (localEntries === undefined) {
    const tree = await githubJson(`/repos/${input.repository}/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated === true)
      throw new Error("GitHub repository tree is truncated; refusing a partial ContextGraph ingestion");
    entries = Array.isArray(tree.tree) ? tree.tree : [];
  }
  return {
    tenantId: input.tenantId,
    repository: input.repository,
    ref: input.ref,
    commitSha,
    treeSha,
    parents: (Array.isArray(input.commit.parents) ? input.commit.parents : []).map((parent) => {
      if (!isRecord(parent)) throw new Error("GitHub commit parent is invalid");
      return requiredGitSha(parent.sha, "GitHub parent SHA");
    }),
    ...(typeof authorDetails.email === "string" && authorDetails.email.trim()
      ? { authorExternalId: authorDetails.email.trim() }
      : {}),
    ...(typeof githubAuthor.login === "string" && githubAuthor.login.trim()
      ? { authorGitHubLogin: githubAuthor.login.trim() }
      : {}),
    ...(typeof authorDetails.name === "string" && authorDetails.name.trim()
      ? { authorName: authorDetails.name.trim() }
      : {}),
    ...(typeof authorDetails.date === "string" ? { committedAt: authorDetails.date } : {}),
    ...(typeof commitDetails.message === "string" ? { message: commitDetails.message } : {}),
    isDefaultRef: input.isDefaultRef,
    updateRef: input.isHead,
    recordedAt: new Date().toISOString(),
    taskId: input.taskId,
    files:
      localEntries ??
      entries.flatMap((entry) => {
        if (!isRecord(entry) || entry.type !== "blob") return [];
        return [
          {
            path: requiredString(entry.path, "GitHub tree path"),
            blobSha: requiredGitSha(entry.sha, "GitHub blob SHA"),
            size: typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : 0
          }
        ];
      })
  };
}

async function githubWorkItemObservations(
  tenantId: string,
  repository: string,
  pullRequests: ReadonlyMap<
    number,
    { readonly item: Record<string, unknown>; readonly commitShas: ReadonlySet<string> }
  >
): Promise<GitHubSourceObservation[]> {
  const recordedAt = new Date().toISOString();
  const observations: GitHubSourceObservation[] = [];
  const issueNumbers = new Set<number>();
  for (const [number, value] of pullRequests) {
    const item = value.item;
    const body = typeof item.body === "string" ? item.body : "";
    const title = requiredString(item.title, "GitHub pull request title");
    const links = linkedIssueNumbers(`${title}\n${body}`);
    links.resolves.forEach((issue) => issueNumbers.add(issue));
    links.references.forEach((issue) => issueNumbers.add(issue));
    const user = isRecord(item.user) ? item.user : {};
    observations.push({
      tenantId,
      repository,
      kind: "pull_request",
      number,
      title,
      body,
      state: requiredString(item.state, "GitHub pull request state"),
      url: requiredString(item.html_url, "GitHub pull request URL"),
      ...githubWorkItemAuthor(user),
      ...(typeof item.updated_at === "string" ? { occurredAt: item.updated_at } : {}),
      ...(typeof item.merged_at === "string" && item.merged_at ? { mergedAt: item.merged_at } : {}),
      ...(typeof item.merged_at === "string" && item.merged_at && typeof item.merge_commit_sha === "string"
        ? { mergeCommitSha: requiredGitSha(item.merge_commit_sha, "GitHub merge commit SHA") }
        : {}),
      recordedAt,
      commitShas: [...value.commitShas],
      resolvesIssueNumbers: links.resolves,
      referencesIssueNumbers: links.references
    });
  }
  for (const number of issueNumbers) {
    const item = await githubOptionalJson(`/repos/${repository}/issues/${number}`);
    if (Object.keys(item).length === 0) continue;
    const user = isRecord(item.user) ? item.user : {};
    observations.push({
      tenantId,
      repository,
      kind: "issue",
      number,
      title: requiredString(item.title, "GitHub issue title"),
      ...(typeof item.body === "string" ? { body: item.body } : {}),
      state: requiredString(item.state, "GitHub issue state"),
      url: requiredString(item.html_url, "GitHub issue URL"),
      ...githubWorkItemAuthor(user),
      ...(typeof item.updated_at === "string" ? { occurredAt: item.updated_at } : {}),
      recordedAt
    });
  }
  return observations;
}

async function hydrateRecentMergedPullRequestScope(
  repository: string,
  headCommitSha: string,
  knownCommitShas: ReadonlySet<string>,
  pullRequests: Map<number, { item: Record<string, unknown>; commitShas: Set<string> }>
): Promise<void> {
  const recent = await githubJsonArray(
    `/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100`
  );
  const candidates = recent.filter((item) =>
    shouldReconcileRecentPullRequest(
      item,
      typeof item.number === "number" && pullRequests.has(item.number),
      knownCommitShas
    )
  );
  const reachable = await mapWithConcurrency(
    candidates,
    positiveInt(process.env.CONTEXT_GRAPH_GITHUB_PR_CONCURRENCY, 4),
    async (item) => {
      const mergeCommitSha = requiredGitSha(item.merge_commit_sha, "GitHub pull request merge commit SHA");
      const comparison = await githubJson(`/repos/${repository}/compare/${mergeCommitSha}...${headCommitSha}`);
      return comparison.status === "ahead" || comparison.status === "identical" ? item : undefined;
    }
  );
  for (const item of reachable) {
    if (!item || typeof item.number !== "number") continue;
    const commitShas = new Set<string>();
    if (typeof item.merge_commit_sha === "string" && /^[a-f0-9]{40}$/i.test(item.merge_commit_sha)) {
      commitShas.add(item.merge_commit_sha.toLowerCase());
    }
    pullRequests.set(item.number, { item, commitShas });
  }
}

async function githubDeploymentObservations(
  tenantId: string,
  repository: string
): Promise<RepositorySourceObservation[]> {
  const recordedAt = new Date().toISOString();
  const deployments = await githubOptionalJsonArray(`/repos/${repository}/deployments?per_page=100`);
  const observations: RepositorySourceObservation[] = [];
  for (const deployment of deployments.slice(0, 50)) {
    if (
      typeof deployment.id !== "number" ||
      typeof deployment.sha !== "string" ||
      !/^[a-f0-9]{40}$/i.test(deployment.sha)
    )
      continue;
    const statuses = await githubOptionalJsonArray(
      `/repos/${repository}/deployments/${deployment.id}/statuses?per_page=1`
    );
    const latest = statuses[0] ?? {};
    const payload = isRecord(deployment.payload) ? deployment.payload : {};
    const service = isRecord(payload.service)
      ? {
          source: requiredString(payload.service.source, "GitHub deployment service source"),
          externalId: requiredString(payload.service.externalId, "GitHub deployment service external ID"),
          name: requiredString(payload.service.name, "GitHub deployment service name")
        }
      : typeof payload.service === "string" && payload.service.trim()
        ? {
            source: "github-deployment",
            externalId: `${repository}:${payload.service.trim()}`,
            name: payload.service.trim()
          }
        : undefined;
    observations.push({
      tenantId,
      repository,
      kind: "deployment",
      source: "github",
      externalId: `${repository}:${deployment.id}`,
      commitSha: deployment.sha.toLowerCase(),
      environment:
        typeof deployment.environment === "string" && deployment.environment.trim()
          ? deployment.environment
          : "unknown",
      status: typeof latest.state === "string" ? latest.state : "created",
      ...(service ? { service } : {}),
      ...(typeof latest.created_at === "string" ? { occurredAt: latest.created_at } : {}),
      recordedAt
    });
  }
  const workflowResponse = await githubOptionalJson(`/repos/${repository}/actions/runs?status=completed&per_page=100`);
  const workflowRuns = Array.isArray(workflowResponse.workflow_runs) ? workflowResponse.workflow_runs : [];
  for (const value of workflowRuns.slice(0, 100)) {
    if (
      !isRecord(value) ||
      typeof value.id !== "number" ||
      typeof value.head_sha !== "string" ||
      !/^[a-f0-9]{40}$/i.test(value.head_sha)
    )
      continue;
    const label = `${typeof value.name === "string" ? value.name : ""} ${typeof value.path === "string" ? value.path : ""}`;
    if (!/deploy|release|cloud\s*run/i.test(label)) continue;
    observations.push({
      tenantId,
      repository,
      kind: "deployment",
      source: "github-actions",
      externalId: `${repository}:${value.id}`,
      commitSha: value.head_sha.toLowerCase(),
      environment: "workflow",
      status: typeof value.conclusion === "string" ? value.conclusion : "completed",
      ...(typeof value.updated_at === "string" ? { occurredAt: value.updated_at } : {}),
      recordedAt
    });
  }
  return observations;
}

async function githubIncidentObservations(
  tenantId: string,
  repository: string
): Promise<RepositorySourceObservation[]> {
  const recordedAt = new Date().toISOString();
  const issues = await githubOptionalJsonArray(`/repos/${repository}/issues?state=all&labels=incident&per_page=100`);
  return issues.flatMap((item): RepositorySourceObservation[] => {
    if (isRecord(item.pull_request) || typeof item.number !== "number" || typeof item.title !== "string") return [];
    const user = isRecord(item.user) ? item.user : {};
    const issue: GitHubSourceObservation = {
      tenantId,
      repository,
      kind: "issue",
      number: item.number,
      title: item.title,
      ...(typeof item.body === "string" ? { body: item.body } : {}),
      state: typeof item.state === "string" ? item.state : "open",
      url: typeof item.html_url === "string" ? item.html_url : `https://github.com/${repository}/issues/${item.number}`,
      ...githubWorkItemAuthor(user),
      ...(typeof item.updated_at === "string" ? { occurredAt: item.updated_at } : {}),
      recordedAt
    };
    return [
      issue,
      {
        tenantId,
        repository,
        kind: "incident",
        source: "github",
        externalId: `${repository}#${item.number}`,
        title: item.title,
        url: issue.url,
        issueNumber: item.number,
        ...(typeof item.updated_at === "string" ? { occurredAt: item.updated_at } : {}),
        recordedAt
      }
    ];
  });
}

function githubWorkItemAuthor(user: Record<string, unknown>): {
  readonly authorId?: number;
  readonly authorLogin?: string;
  readonly authorName?: string;
  readonly authorAccountType?: string;
} {
  return {
    ...(typeof user.id === "number" && Number.isSafeInteger(user.id) && user.id > 0 ? { authorId: user.id } : {}),
    ...(typeof user.login === "string" && user.login.trim() ? { authorLogin: user.login.trim() } : {}),
    ...(typeof user.name === "string" && user.name.trim() ? { authorName: user.name.trim() } : {}),
    ...(typeof user.type === "string" && user.type.trim() ? { authorAccountType: user.type.trim() } : {})
  };
}

function isDeterministicSourcePath(path: string): boolean {
  return (
    /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.(?:toml|lock)|Gemfile\.lock|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|(?:docker-)?compose(?:\.[^.]+)?\.ya?ml|catalog-info\.ya?ml|service-catalog\.ya?ml)$/i.test(
      path
    ) ||
    /(?:^|\/)Dockerfile(?:\.[A-Za-z0-9_.-]+)?$/i.test(path) ||
    /^\.github\/workflows\/.*\.ya?ml$/i.test(path) ||
    /(?:^|\/)(?:k8s|kubernetes|deploy|deployment|cloudrun|cloud-run)\/.*\.ya?ml$/i.test(path) ||
    /(?:^|\/)(?:incidents?|postmortems?)(?:\/|[-_.]).*\.md(?:own)?$/i.test(path)
  );
}

async function buildMoveCandidates(repository: string, plan: ContextGraphIngestPlan) {
  const analyses = new Map<string, BlobAnalysis>();
  const candidates = plan.changes
    .filter(
      (change) =>
        (change.change === "add" && change.newBlobSha) ||
        (change.change === "delete" && change.oldBlobSha) ||
        (change.change === "rename" && change.oldBlobSha && change.newBlobSha)
    )
    .slice(0, 40);
  for (const change of candidates) {
    const blobSha = change.newBlobSha ?? change.oldBlobSha;
    const language = languageForPath(change.path);
    if (!blobSha || !language) continue;
    analyses.set(blobSha, analyzeSourceBlob(blobSha, language, await readGitHubBlob(repository, blobSha)));
  }
  return movedFromSimilarityCandidates(plan.changes, analyses);
}

async function hydratePullRequestScope(
  repository: string,
  pullRequests: Map<number, { item: Record<string, unknown>; commitShas: Set<string> }>,
  currentPaths: ReadonlySet<string>
): Promise<readonly number[]> {
  const results = await mapWithConcurrency(
    [...pullRequests.entries()],
    positiveInt(process.env.CONTEXT_GRAPH_GITHUB_PR_CONCURRENCY, 4),
    async ([number, value]) => {
      const [commitPage, filePage] = await Promise.all([
        githubJsonArrayPages(`/repos/${repository}/pulls/${number}/commits`),
        githubJsonArrayPages(`/repos/${repository}/pulls/${number}/files`, 30)
      ]);
      if (!commitPage.complete || !filePage.complete) {
        throw new Error(`GitHub PR #${number} exceeded the bounded commit/file pagination limit`);
      }
      const completeCommitShas = commitPage.items.flatMap((commit) =>
        typeof commit.sha === "string" && /^[a-f0-9]{40}$/i.test(commit.sha) ? [commit.sha.toLowerCase()] : []
      );
      if (completeCommitShas.length > 0) {
        value.commitShas.clear();
        completeCommitShas.forEach((sha) => value.commitShas.add(sha));
      }
      const hasCurrentProblemEvidence = filePage.items.some((file) => {
        const path = typeof file.filename === "string" ? file.filename : undefined;
        return Boolean(path && currentPaths.has(path) && isProblemEvidencePath(path));
      });
      return hasCurrentProblemEvidence ? number : undefined;
    }
  );
  return results.filter((number): number is number => number !== undefined).sort((a, b) => a - b);
}

async function runContextGraphAssertions(work: ClaimedWork<"run-context-graph-assert">): Promise<WorkResult> {
  if (!contextGraphExecutor) throw new Error("contextGraph executor is not configured for this worker");
  const { tenantId, repository, ref, githubInstallationId, commitSha, evidenceFingerprint } = work.task.metadata;
  const access = await activateGitHubInstallationAccess(githubInstallationId, repository);
  const focusPaths = work.task.metadata.analysisPaths ?? [];
  const problemEvidencePullRequestNumbers = work.task.metadata.problemEvidencePullRequestNumbers ?? [];
  const sourcePullRequestNumbers = work.task.metadata.sourcePullRequestNumbers ?? [];
  const resolvedPullRequestNumbers = work.task.metadata.resolvedPullRequestNumbers ?? [];
  const cache = await internalApiJson<{ readonly cached: Record<string, unknown> | null }>(
    "/internal/context-graph/assertions/cached",
    {
      taskId: work.task.id,
      messageId: work.message.id,
      leaseId: work.message.leaseId,
      commitSha,
      evidenceFingerprint
    }
  );
  if (cache.cached) return { outcome: "done", result: { cached: cache.cached } };
  const evidence = await internalApiJson<{ readonly evidence: readonly ContextGraphSourceEvidence[] }>(
    "/internal/context-graph/assertions/evidence",
    { taskId: work.task.id, messageId: work.message.id, leaseId: work.message.leaseId }
  );
  // A generator/schema version change intentionally performs one full semantic
  // scan for an unchanged head. The resulting generation is cached, so routine
  // retries and subsequent builds still avoid Daytona entirely.
  const graph = await contextGraphExecutor.buildAssertions(
    {
      tenantId,
      repository,
      ref,
      commitSha,
      focusPaths,
      problemEvidencePullRequestNumbers,
      sourcePullRequestNumbers,
      resolvedPullRequestNumbers,
      sourceEvidence: evidence.evidence,
      taskId: work.task.id,
      ...(activeLease ? { signal: activeLease.controller.signal } : {})
    },
    { githubToken: access.token }
  );
  assertLeaseOwned();
  const rawOutput = { summary: graph.summary, nodes: graph.nodes, edges: graph.edges };
  validateSourceBackedModelEntities(rawOutput, evidence.evidence);
  const assertions = assertionsFromGeneratedContextGraph(rawOutput, repository, {
    sourcePullRequestNumbers,
    resolvedPullRequestNumbers
  });
  // Persist the batch on the durable long-window route before completing, so
  // the completion request itself stays a fast status flip.
  const saved = await internalApiJson<Record<string, unknown>>("/internal/context-graph/assertions/save", {
    taskId: work.task.id,
    messageId: work.message.id,
    leaseId: work.message.leaseId,
    assertionBatch: {
      tenantId,
      repository,
      ref,
      commitSha,
      taskId: work.task.id,
      generatedAt: graph.generatedAt,
      generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
      registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
      evidenceFingerprint,
      evidenceObservationIds: evidence.evidence.map((observation) => observation.id),
      model: graph.generator.model,
      ...(graph.generator.sandboxId ? { sandboxId: graph.generator.sandboxId } : {}),
      summary: graph.summary,
      ...(graph.rawModelOutput !== undefined ? { modelOutputRaw: graph.rawModelOutput } : {}),
      rawOutput,
      assertions
    }
  });
  return { outcome: "done", result: { saved } };
}

async function analyzeGitHubBlob(
  repository: string,
  input: { readonly blobSha: string; readonly path: string; readonly size: number }
): Promise<BlobAnalysis> {
  const language = languageForPath(input.path);
  if (!language || input.size > 512_000) {
    return { blobSha: input.blobSha, parserVersion: CONTEXT_GRAPH_PARSER_VERSION, symbols: [], imports: [], edges: [] };
  }
  const source = await readGitHubBlob(repository, input.blobSha);
  return analyzeSourceBlob(input.blobSha, language, source);
}

async function readGitHubBlob(repository: string, blobSha: string): Promise<string> {
  const local = await activeGitIngestTransport?.blob(blobSha);
  if (local !== undefined) return local;
  const blob = await githubJson(`/repos/${repository}/git/blobs/${blobSha}`);
  if (blob.encoding !== "base64" || typeof blob.content !== "string")
    throw new Error(`GitHub blob ${blobSha} is not base64 encoded`);
  return Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
}

function parseCodeowners(source: string): readonly { readonly pattern: string; readonly owners: readonly string[] }[] {
  return source.split(/\r?\n/).flatMap((line) => {
    const value = line.replace(/\s+#.*$/, "").trim();
    if (!value || value.startsWith("#")) return [];
    const [pattern, ...owners] = value.split(/\s+/);
    return pattern && owners.length > 0 ? [{ pattern, owners }] : [];
  });
}

async function submitBlobAnalyses(
  work: ClaimedWork,
  commitSha: string,
  analyses: readonly BlobAnalysis[]
): Promise<void> {
  await internalApiJson("/internal/context-graph/ingest/blobs", blobAnalysisRequest(work, commitSha, analyses));
}

function blobAnalysisRequest(work: ClaimedWork, commitSha: string, analyses: readonly BlobAnalysis[]): unknown {
  return {
    taskId: work.task.id,
    messageId: work.message.id,
    leaseId: work.message.leaseId,
    commitSha,
    analyses
  };
}

async function internalApiJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  // Context graph mutations can persist large content-addressed blob batches. Keep
  // claim and completion calls on the short default timeout, but allow these durable
  // data calls to use the API service's longer processing window.
  const response = await apiRequest(path, body, contextGraphApiTimeoutMs);
  if (!response.ok)
    throw new Error(`ContextGraph API ${path} failed with ${response.status}: ${await boundedFailureDetail(response)}`);
  return (await response.json()) as T;
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
  const openAiApiKey = requiredEnv("OPENAI_API_KEY");
  const openAiApiUrl = (process.env.OPENAI_API_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${openAiApiUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${openAiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: REVIEW_SYSTEM_PROMPT,
      input: buildReviewPrompt(reviewRequest, prepared),
      text: {
        format: {
          type: "json_schema",
          name: "review_findings",
          schema: REVIEW_FINDINGS_SCHEMA,
          strict: true
        }
      },
      store: false
    }),
    signal: requestSignal(10 * 60 * 1000)
  });
  if (!response.ok)
    throw new Error(
      `OpenAI review failed with ${response.status}: ${await boundedFailureDetail(response, [openAiApiKey])}`
    );
  const payload = (await response.json()) as Record<string, unknown>;
  const outputText = extractOutputText(payload);
  const parsed = parseReviewOutput(outputText);
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
      leaseId: work.message.leaseId
    },
    contextGraphApiTimeoutMs
  );
  if (!response.ok) {
    const message = `renewal failed with ${response.status}: ${await boundedFailureDetail(response)}`;
    if (response.status === 409) throw new LeaseLostError(message);
    throw new Error(message);
  }
  recordApiSuccess(!drainsContextGraphProjections);
}

async function complete(work: ClaimedWork, result: WorkResult): Promise<void> {
  const response = await apiRequest("/internal/worker/complete", {
    messageId: work.message.id,
    leaseId: work.message.leaseId,
    taskId: work.task.id,
    ...result
  });
  if (response.status === 409) {
    throw new LeaseLostError(`completion rejected after lease loss: ${await boundedFailureDetail(response)}`);
  }
  if (!response.ok) {
    throw new Error(`completion failed with ${response.status}: ${await boundedFailureDetail(response)}`);
  }
  recordApiSuccess(!drainsContextGraphProjections);
}

async function apiRequest(path: string, body: unknown, timeoutMs = 30_000): Promise<Response> {
  const serializedBody = JSON.stringify(body);
  const tenantId = activeWork?.task.metadata.tenantId;
  for (let attempt = 0; ; attempt += 1) {
    assertLeaseOwned();
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(tenantId ? { "x-jina-tenant-id": tenantId } : {})
        },
        body: serializedBody,
        signal: requestSignal(timeoutMs)
      });
    } catch (error) {
      if (attempt >= internalApiRetryAttempts - 1) throw error;
      assertLeaseOwned();
      await delay(internalApiRetryDelayMs(undefined, attempt));
      continue;
    }
    if (!isTransientInternalApiStatus(response.status) || attempt >= internalApiRetryAttempts - 1) return response;
    const waitMs = internalApiRetryDelayMs(response.headers.get("retry-after"), attempt);
    await response.body?.cancel().catch(() => undefined);
    assertLeaseOwned();
    await delay(waitMs);
  }
}

function isTransientInternalApiStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function internalApiRetryDelayMs(retryAfter: string | undefined | null, attempt: number): number {
  const requestedDelay = retryAfterDelayMs(retryAfter, internalApiRetryMaxWaitMs);
  if (requestedDelay !== undefined) return requestedDelay;
  const exponential = Math.min(internalApiRetryBaseMs * 2 ** attempt, internalApiRetryMaxWaitMs);
  return Math.max(1, Math.floor(exponential * (0.8 + Math.random() * 0.4)));
}

async function githubJson(path: string): Promise<Record<string, unknown>> {
  const response = await githubRequest(path, "application/vnd.github+json");
  return (await response.json()) as Record<string, unknown>;
}

async function githubJsonArray(path: string): Promise<Record<string, unknown>[]> {
  const response = await githubRequest(path, "application/vnd.github+json");
  const value = (await response.json()) as unknown;
  if (!Array.isArray(value) || value.some((item) => !isRecord(item)))
    throw new Error(`GitHub response ${path} is not an object array`);
  return value as Record<string, unknown>[];
}

async function githubOptionalJson(path: string): Promise<Record<string, unknown>> {
  try {
    return await githubJson(path);
  } catch (error) {
    if (!isUnavailableOptionalGitHubSource(error)) throw error;
    logger.warn(`optional GitHub source unavailable: ${path}`, { event: "ingest.github_source_unavailable", path });
    return {};
  }
}

async function githubOptionalJsonArray(path: string): Promise<Record<string, unknown>[]> {
  try {
    return await githubJsonArray(path);
  } catch (error) {
    if (!isUnavailableOptionalGitHubSource(error)) throw error;
    logger.warn(`optional GitHub source unavailable: ${path}`, { event: "ingest.github_source_unavailable", path });
    return [];
  }
}

function isUnavailableOptionalGitHubSource(error: unknown): boolean {
  const message = errorMessage(error);
  return /GitHub request failed with (?:403|404):/.test(message);
}

async function githubJsonArrayPages(
  path: string,
  maximumPages = 3
): Promise<{ readonly items: readonly Record<string, unknown>[]; readonly complete: boolean }> {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await githubJsonArray(`${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return { items, complete: true };
  }
  return { items, complete: false };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(values.length, Math.max(1, limit)) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function githubText(path: string, accept: string): Promise<string> {
  const response = await githubRequest(path, accept);
  return response.text();
}

const GITHUB_RETRY_ATTEMPTS = Math.max(1, Number(process.env.GITHUB_RETRY_ATTEMPTS ?? 4));
const GITHUB_RETRY_BASE_MS = Math.max(1, Number(process.env.GITHUB_RETRY_BASE_MS ?? 1_000));
const GITHUB_RETRY_MAX_WAIT_MS = 60_000;

async function githubRequest(path: string, accept: string): Promise<Response> {
  const githubToken =
    activeLease?.githubToken ?? (process.env.GITHUB_API_TOKEN ?? process.env.GITHUB_CLONE_TOKEN)?.trim();
  const githubApiUrl = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/$/, "");
  for (let attempt = 0; ; attempt += 1) {
    assertLeaseOwned();
    let response: Response;
    try {
      response = await fetch(`${githubApiUrl}${path}`, {
        headers: {
          accept,
          "x-github-api-version": "2022-11-28",
          "user-agent": "jina-review-worker",
          ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {})
        },
        signal: requestSignal(60_000)
      });
    } catch (error) {
      if (attempt >= GITHUB_RETRY_ATTEMPTS - 1) throw error;
      await delay(Math.min(GITHUB_RETRY_BASE_MS * 2 ** attempt, GITHUB_RETRY_MAX_WAIT_MS));
      continue;
    }
    if (response.ok) return response;
    const rateLimited =
      response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    if (attempt < GITHUB_RETRY_ATTEMPTS - 1 && (rateLimited || response.status >= 500)) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const resetEpochSeconds = Number(response.headers.get("x-ratelimit-reset"));
      const waitMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1_000
          : rateLimited && Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0
            ? Math.max(resetEpochSeconds * 1_000 - Date.now(), GITHUB_RETRY_BASE_MS)
            : GITHUB_RETRY_BASE_MS * 2 ** attempt;
      await delay(Math.min(waitMs, GITHUB_RETRY_MAX_WAIT_MS));
      continue;
    }
    throw new Error(`GitHub request failed with ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
  }
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string" && content.text.trim()) return content.text;
    }
  }
  throw new Error("OpenAI response did not contain output text");
}

function configuredTopics(value: string | undefined): WorkerTopic[] {
  const requested = (value ?? "run-review|run-research|run-publish|run-cleanup")
    // Cloud Run's CLI uses commas as its own key/value delimiter. Accept a
    // pipe-separated value so a multi-topic worker survives deployment intact.
    .split(/[|,]/)
    .map((topic) => topic.trim())
    .filter(Boolean);
  const unknown = requested.filter((topic) => !SUPPORTED_TOPICS.includes(topic as WorkerTopic));
  if (unknown.length > 0) throw new Error(`WORKER_TOPICS contains unsupported topics: ${unknown.join(", ")}`);
  const selected = requested as WorkerTopic[];
  if (selected.length === 0) throw new Error(`WORKER_TOPICS must contain at least one topic`);
  return [...new Set(selected)];
}

function parseClaimedWork(value: unknown): ClaimedWork {
  if (!isRecord(value) || !isRecord(value.message) || !isRecord(value.task) || !isRecord(value.task.metadata)) {
    throw new Error("claim response must include message, task, and task metadata objects");
  }
  const topicValue = requiredString(value.message.topic, "claim message topic");
  if (!SUPPORTED_TOPICS.includes(topicValue as WorkerTopic)) throw new Error(`unsupported claimed topic ${topicValue}`);
  const topic = topicValue as WorkerTopic;
  const message = {
    id: requiredString(value.message.id, "claim message id"),
    leaseId: requiredString(value.message.leaseId, "claim lease id"),
    leaseExpiresAt: requiredString(value.message.leaseExpiresAt, "claim lease expiry")
  };
  const taskId = requiredString(value.task.id, "claim task id");
  const metadata = value.task.metadata;

  switch (topic) {
    case "run-review":
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
    case "run-research":
      return {
        topic,
        message: { ...message, topic },
        task: {
          id: taskId,
          metadata: {
            tenantId: requiredString(metadata.tenantId, "task tenantId"),
            ...(metadata.question === undefined
              ? {}
              : { question: requiredString(metadata.question, "task question") }),
            ...(metadata.sourceUrls === undefined
              ? {}
              : { sourceUrls: requiredStringArray(metadata.sourceUrls, "task sourceUrls") })
          }
        }
      };
    case "run-context-graph-ingest":
      return {
        topic,
        message: { ...message, topic },
        task: { id: taskId, metadata: contextGraphIngestMetadata(metadata) }
      };
    case "run-context-graph-project":
      return {
        topic,
        message: { ...message, topic },
        task: { id: taskId, metadata: repositoryMetadata(metadata) }
      };
    case "run-context-graph-assert":
      return {
        topic,
        message: { ...message, topic },
        task: {
          id: taskId,
          metadata: {
            ...repositoryMetadata(metadata),
            commitSha: requiredGitSha(metadata.commitSha, "task commitSha"),
            evidenceFingerprint: requiredString(metadata.evidenceFingerprint, "task evidenceFingerprint"),
            ...(metadata.analysisPaths === undefined
              ? {}
              : { analysisPaths: requiredStringArray(metadata.analysisPaths, "task analysisPaths") }),
            ...(metadata.problemEvidencePullRequestNumbers === undefined
              ? {}
              : {
                  problemEvidencePullRequestNumbers: requiredPositiveIntegerArray(
                    metadata.problemEvidencePullRequestNumbers,
                    "task problemEvidencePullRequestNumbers"
                  )
                }),
            ...(metadata.sourcePullRequestNumbers === undefined
              ? {}
              : {
                  sourcePullRequestNumbers: requiredPositiveIntegerArray(
                    metadata.sourcePullRequestNumbers,
                    "task sourcePullRequestNumbers"
                  )
                }),
            ...(metadata.resolvedPullRequestNumbers === undefined
              ? {}
              : {
                  resolvedPullRequestNumbers: requiredPositiveIntegerArray(
                    metadata.resolvedPullRequestNumbers,
                    "task resolvedPullRequestNumbers"
                  )
                })
          }
        }
      };
    case "run-publish":
      return {
        topic,
        message: { ...message, topic },
        task: {
          id: taskId,
          metadata: { ...metadata, tenantId: requiredString(metadata.tenantId, "task tenantId") }
        }
      };
    case "run-cleanup":
      return {
        topic,
        message: { ...message, topic },
        task: {
          id: taskId,
          metadata: { ...metadata, tenantId: requiredString(metadata.tenantId, "task tenantId") }
        }
      };
  }
}

function repositoryMetadata(metadata: Record<string, unknown>): {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly githubInstallationId: number;
} {
  return {
    tenantId: requiredString(metadata.tenantId, "task tenantId"),
    repository: requiredString(metadata.repository, "task repository"),
    ref: requiredString(metadata.ref, "task ref"),
    githubInstallationId: requiredPositiveInteger(metadata.githubInstallationId, "task githubInstallationId")
  };
}

function contextGraphIngestMetadata(
  metadata: Record<string, unknown>
): WorkMetadataByTopic["run-context-graph-ingest"] {
  const repository = repositoryMetadata(metadata);
  const pipelinePhase = requiredString(metadata.pipelinePhase, "task pipelinePhase");
  if (pipelinePhase !== "snapshot" && pipelinePhase !== "history") throw new Error("task pipelinePhase is invalid");
  return { ...repository, pipelinePhase };
}

function requiredStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be a string array`);
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredPositiveIntegerArray(value: unknown, name: string): readonly number[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item) => requiredPositiveInteger(item, name));
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
  lastApiError = undefined;
  lastApiErrorAt = undefined;
  consecutiveApiFailures = 0;
}

function recordApiFailure(error: unknown): void {
  lastApiError = errorMessage(error);
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is required`);
  return value;
}

function requiredGitSha(value: unknown, name: string): string {
  const sha = requiredString(value, name);
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error(`${name} must be a full Git SHA`);
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

/**
 * Upstream failure bodies are untrusted and unbounded (a hostile or broken
 * upstream can echo secrets or megabytes); error messages built from them are
 * serialized into durable structured logs, so keep only a short prefix.
 */
async function boundedFailureDetail(response: Response, secrets: readonly string[] = []): Promise<string> {
  let detail = (await response.text().catch(() => "unreadable body")).slice(0, 200);
  for (const secret of secrets) {
    if (secret) detail = detail.replaceAll(secret, "[REDACTED]");
  }
  return detail;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function releaseContextGraphLeaseOnShutdown(work: ClaimedWork): Promise<void> {
  if (!work.message.id.startsWith("context-graph-stage_")) return;
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
      void releaseContextGraphLeaseOnShutdown(work).catch((error) => {
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
