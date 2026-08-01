import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  REVIEW_FINDINGS_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  parseReviewOutput,
  prepareDiff,
  type ReviewRequest
} from "@jina/ai";
import {
  DOCUMENTATION_STAGE_SCHEMA,
  CITATION_AUDIT_STAGE_SCHEMA,
  CRITIC_STAGE_SCHEMA,
  RESEARCH_STAGE_SCHEMA,
  SOURCE_CHALLENGE_STAGE_SCHEMA,
  boardPageAuditInventory,
  boardPublicPageDigest,
  citationAuditReferenceGroups,
  citationAuditRepairPrompt,
  citationAuditStagePrompt,
  contextGapRepairPrompt,
  criticStagePrompt,
  documentationWriterPrompt,
  documentationPlannerPrompt,
  documentationPlannerRepairPrompt,
  parseCitationAuditStageResult,
  parseCriticStageResult,
  parseResearchStagePlan,
  researchPlannerRepairPrompt,
  researchPlannerPrompt,
  researchWorkerPrompt,
  sourceChallengeStagePrompt,
  sourceChallengeValidationRepairPrompt,
  type BoardAgentModelUsage,
  type CitationAuditStageResult,
  type CitationAuditReference,
  type ChallengeAnswerPart,
  type DocumentationStagePlan,
  type ResearchStagePlan
} from "@jina/daytona";
import { createGitHubInstallationAccessToken } from "@jina/github";
import { createLogger, errorLogFields, generateTraceContext, MetricsRegistry } from "@jina/observability";
import type {
  ContextArtifactKind,
  ContextArtifactRef,
  GitChange,
  GitSnapshotMetadata,
  IngestEvidenceInput,
  ProviderObservationInput
} from "@jina/context-engine";
import {
  LocalPageIndexClient,
  MAX_CONTEXT_REPAIR_PASS,
  assertContextPriorReleaseMatches,
  contextGateRepairMustChangeSnapshot,
  contextPriorReleaseCatalog,
  contextArtifactKey,
  parseCertifiedContextReleaseArtifact,
  parseContextPriorReleaseSeed,
  repositoryAclFingerprint,
  repositoryContextAreas,
  type CertifiedContextReleaseArtifactV1,
  type ContextPageChange,
  type ContextPriorPage,
  type ContextPriorReleaseSeed
} from "@jina/context-engine";
import {
  addBoardAgentModelUsage,
  boardAgentModelUsageForCompletion,
  configuredPortableContextBoardAgentStageRunner,
  type PortableContextBoardAgentStageRunner
} from "./board-agent-stage-adapter.js";
import { parseBoardSourceChallengeStageResultWithRepair } from "./board-source-challenge.js";
import { citationAuditDelta, retryCitationAuditValidation } from "./citation-audit-validation.js";
import {
  assertNoGitHubOperationalCredentials,
  sanitizeGitHubCommitCommentPayload,
  sanitizeGitHubIssueCommentPayload,
  sanitizeGitHubIssuePayload,
  sanitizeGitHubPullRequestPayload,
  sanitizeGitHubRepositoryPayload,
  sanitizeGitHubReviewCommentPayload
} from "./github-provider-sanitizer.js";
import { buildBoardPageIndex } from "./board-pageindex.js";
import {
  canonicalPublicPageMarkdown,
  contextBoardPublicSnapshot,
  nextPageRepairCheckpointDiagnostics,
  pagePlanStructuralProblems,
  pageRepairCoveragePrompt,
  pageRepairNoProgressProblems,
  pageRepairRegressionProblems,
  pageRepairScopeRegressionProblems,
  retainedPageRepairCheckpoint
} from "./board-page-repair.js";
import type { PageRepairCheckpointDiagnostics } from "./board-page-repair.js";
import {
  parsePublicationPlanWithRepair,
  promoteUnsafeRetainedPages,
  retainedPublicationPlanProblems
} from "./board-publication-plan.js";
import { parseResearchPlanWithRepair } from "./board-research-plan.js";
import { shouldRetryWorkerFailure, workerFailureCategory, type WorkerFailureCategory } from "./diagnostics.js";
import { assertExpectedRemoteHead } from "./git-ref.js";
import { parseGitTreeEntries } from "./git-tree.js";
import {
  CONTEXT_BOARD_TOPICS,
  SUPPORTED_WORKER_TOPICS,
  configuredWorkerClaimMode,
  configuredWorkerTopics,
  requiresContextBoardExecutor,
  type ContextWorkerTopic,
  type WorkerTopic
} from "./worker-topics.js";

const execFileAsync = promisify(execFile);
const CONTEXT_MODEL_TOPICS = new Set<WorkerTopic>([
  "run-context-research-plan",
  "run-context-research",
  "run-context-publication-plan",
  "run-context-page-write",
  "run-context-page-audit",
  "run-context-page-repair",
  "run-context-source-challenge",
  "run-context-task-evaluation",
  "run-context-gap-repair"
]);

interface RepositoryContextMetadata {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha?: string;
  readonly githubInstallationId?: number;
}

interface ContextBoardDependencyResult {
  readonly taskId: string;
  readonly taskType: string;
  readonly pass?: number;
  readonly pageTaskId?: string;
  readonly documentPath?: string;
  readonly result: {
    readonly version: 1;
    readonly outputArtifact: ContextArtifactRef;
  };
}

interface ContextBoardWorkerMetadata extends RepositoryContextMetadata {
  readonly contextBuildId: string;
  readonly derivationDeadlineAt?: string;
  readonly dependencyResults: readonly ContextBoardDependencyResult[];
  readonly inputArtifact?: ContextArtifactRef;
  readonly planArtifact?: ContextArtifactRef;
  readonly workKey?: string;
  readonly pageKey?: string;
  readonly documentPath?: string;
  readonly pageTaskId?: string;
  readonly findingsArtifact?: ContextArtifactRef;
  readonly pass?: number;
  readonly priorRelease?: ContextPriorReleaseSeed;
  readonly pageChange?: ContextPageChange;
}

interface WorkMetadataByTopic {
  readonly "run-review": {
    readonly tenantId: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
  };
  readonly "run-context-input-snapshot": ContextBoardWorkerMetadata;
  readonly "run-context-research-plan": ContextBoardWorkerMetadata & {
    readonly inputArtifact: ContextArtifactRef;
  };
  readonly "run-context-research": ContextBoardWorkerMetadata & {
    readonly inputArtifact: ContextArtifactRef;
    readonly planArtifact: ContextArtifactRef;
    readonly workKey: string;
  };
  readonly "run-context-publication-plan": ContextBoardWorkerMetadata & {
    readonly planArtifact: ContextArtifactRef;
  };
  readonly "run-context-page-write": ContextBoardWorkerMetadata & {
    readonly inputArtifact: ContextArtifactRef;
    readonly planArtifact: ContextArtifactRef;
    readonly pageKey: string;
    readonly documentPath: string;
    readonly pageTaskId: string;
    readonly pass: number;
    readonly pageChange: ContextPageChange;
  };
  readonly "run-context-page-audit": ContextBoardWorkerMetadata & {
    readonly pageKey: string;
    readonly documentPath: string;
    readonly pageTaskId: string;
    readonly pass: number;
  };
  readonly "run-context-page-repair": ContextBoardWorkerMetadata & {
    readonly findingsArtifact: ContextArtifactRef;
    readonly documentPath: string;
    readonly pageTaskId: string;
    readonly pass: number;
  };
  readonly "run-context-source-challenge": ContextBoardWorkerMetadata & {
    readonly planArtifact: ContextArtifactRef;
    readonly pass: number;
  };
  readonly "run-context-task-evaluation": ContextBoardWorkerMetadata & {
    readonly planArtifact: ContextArtifactRef;
    readonly pass: number;
  };
  readonly "run-context-gap-repair": ContextBoardWorkerMetadata & {
    readonly planArtifact: ContextArtifactRef;
    readonly pass: number;
  };
  readonly "run-context-certification": ContextBoardWorkerMetadata & {
    readonly planArtifact: ContextArtifactRef;
  };
  readonly "run-context-publication": ContextBoardWorkerMetadata & {
    readonly planArtifact: ContextArtifactRef;
  };
  readonly "run-context-pageindex": ContextBoardWorkerMetadata & {
    readonly planArtifact: ContextArtifactRef;
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
  | {
      readonly outcome: "retry";
      readonly reason: string;
      readonly failureCategory: WorkerFailureCategory;
    }
  | {
      readonly outcome: "failed";
      readonly reason: string;
      readonly failureCategory: WorkerFailureCategory;
    };

interface LeaseExecutionState {
  readonly controller: AbortController;
  githubToken?: string;
  lostReason?: string;
  renewalInFlight?: boolean;
  releasePromise?: Promise<void>;
}

interface WorkerReleaseIdentity {
  readonly releaseId: string;
  readonly credential: string;
  readonly service: "jina-context-worker" | "jina-task-worker";
  readonly revision: string;
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
const topics = configuredWorkerTopics(process.env.WORKER_TOPICS);
const claimMode = configuredWorkerClaimMode(process.env.JINA_WORKER_CLAIM_MODE);
const workerRelease = configuredWorkerReleaseIdentity();
const workerId =
  process.env.WORKER_ID?.trim() ||
  (workerRelease ? `${workerRelease.revision}:${process.pid}` : `worker-${process.pid}`);
const pollIntervalMs = positiveInt(process.env.WORKER_POLL_INTERVAL_MS, 2_000);
const workerApiTimeoutMs = positiveInt(process.env.WORKER_API_TIMEOUT_MS, 30_000);
const contextApiTimeoutMs = positiveInt(process.env.CONTEXT_API_TIMEOUT_MS, 62 * 60_000);
const contextCompletionTimeoutMs = positiveInt(process.env.CONTEXT_COMPLETION_TIMEOUT_MS, 10 * 60_000);
const heartbeatIntervalMs = positiveInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 60_000);
const claimBackpressureLogIntervalMs = 60_000;
const MAX_CRITIC_CONTRACT_ATTEMPTS = 3;
const contextBoardMaxAttempts = boardMaxAttempts(process.env.CONTEXT_BOARD_MAX_ATTEMPTS);
const requireGithubInstallation = process.env.JINA_REQUIRE_GITHUB_INSTALLATION === "true";
const configuredBoardAgentStageRunner =
  claimMode === "enabled" && requiresContextBoardExecutor(topics)
    ? configuredPortableContextBoardAgentStageRunner({
        protectedValues: [token],
        attemptContext: () => {
          const activeMetadata = activeWork ? Object.fromEntries(Object.entries(activeWork.task.metadata)) : undefined;
          return {
            commitSha: requiredGitSha(activeMetadata?.commitSha, "board agent commitSha"),
            attempt: activeWork?.message.attempt ?? 1,
            tenantId: requiredString(activeMetadata?.tenantId, "board agent tenantId"),
            buildId: requiredString(activeMetadata?.contextBuildId, "board agent contextBuildId"),
            ...(activeLease ? { signal: activeLease.controller.signal } : {})
          };
        }
      })
    : undefined;
const boardAgentStageRunner: PortableContextBoardAgentStageRunner | undefined = configuredBoardAgentStageRunner
  ? {
      async run(input) {
        const output = await configuredBoardAgentStageRunner.run(input);
        if (!activeWork || !CONTEXT_MODEL_TOPICS.has(activeWork.topic) || !activeModelUsage) {
          throw new Error("board agent usage was produced outside an active model-backed lease");
        }
        activeModelUsage = addBoardAgentModelUsage(activeModelUsage, output.usage);
        activeModelUsageObserved = true;
        return output;
      }
    }
  : undefined;
const boardPageIndexClient =
  claimMode === "enabled" && topics.includes("run-context-pageindex")
    ? new LocalPageIndexClient({
        timeoutMs: positiveInt(process.env.CONTEXT_PAGEINDEX_PROCESS_TIMEOUT_MS, 5 * 60_000)
      })
    : undefined;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;
let pollPromise: Promise<void> | undefined;
let active = false;
let activeLease: LeaseExecutionState | undefined;
let activeWork: ClaimedWork | undefined;
let activeModelUsage: BoardAgentModelUsage | undefined;
let activeModelUsageObserved = false;
let lastApiSuccessAt: string | undefined;
let hasApiError = false;
let lastApiErrorAt: string | undefined;
let consecutiveApiFailures = 0;
let lastClaimBackpressureLogAt = 0;
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
    const ok = claimMode === "paused" || (Boolean(lastApiSuccessAt) && !hasApiError);
    response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok,
        workerId,
        claimMode,
        ...(workerRelease
          ? {
              workerReleaseId: workerRelease.releaseId,
              workerService: workerRelease.service,
              workerRevision: workerRelease.revision
            }
          : {}),
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
  logger.info(`worker listening on ${port} for ${topics.join(", ")} (${claimMode})`, {
    event: "worker.started",
    workerId,
    port,
    claimMode,
    topics
  });
  pollPromise = claimMode === "enabled" ? poll() : Promise.resolve();
});

async function poll(): Promise<void> {
  while (!stopping) {
    try {
      const work = await claim();
      if (work) {
        if (stopping) {
          const lease: LeaseExecutionState = { controller: new AbortController() };
          await releaseContextLeaseOnce(work, lease, "worker shutdown").catch((error) => {
            logger.error("worker lease release failed for a claim received during shutdown", {
              event: "worker.lease_release_failed",
              workerId,
              taskId: work.task.id,
              ...errorLogFields(error)
            });
          });
        } else {
          await execute(work);
        }
      }
    } catch (error) {
      if (stopping) continue;
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
  if (!response.ok) {
    const detail = await boundedFailureDetail(response);
    if (response.status === 429 && failureCode(detail) === "context_quota_exceeded") {
      recordClaimBackpressure();
      return undefined;
    }
    throw new Error(`claim failed with ${response.status}: ${detail}`);
  }
  recordApiSuccess();
  return parseClaimedWork(await response.json());
}

async function execute(work: ClaimedWork): Promise<void> {
  active = true;
  activeWork = work;
  activeModelUsage = CONTEXT_MODEL_TOPICS.has(work.topic)
    ? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    : undefined;
  activeModelUsageObserved = false;
  const startedAt = Date.now();
  const startedMetadata = work.task.metadata as Record<string, unknown>;
  logger.info(`${work.message.topic} started for task ${work.task.id}`, {
    event: "stage.started",
    workerId,
    topic: work.message.topic,
    taskId: work.task.id,
    attempt: work.message.attempt ?? 1,
    ...(typeof startedMetadata.contextBuildId === "string" ? { contextBuildId: startedMetadata.contextBuildId } : {}),
    ...(typeof startedMetadata.repository === "string" ? { repository: startedMetadata.repository } : {}),
    ...(typeof startedMetadata.ref === "string" ? { ref: startedMetadata.ref } : {})
  });
  const lease: LeaseExecutionState = { controller: new AbortController() };
  activeLease = lease;
  const buildDeadlineTimer = scheduleBuildDeadline(work, lease.controller);
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
    if (!lease.lostReason) {
      const reason = errorMessage(error).slice(0, 2_000);
      const failureCategory = workerFailureCategory(reason);
      result =
        isContextTopic(work.topic) &&
        shouldRetryWorkerFailure(reason, {
          attempt: work.message.attempt ?? 1,
          maxAttempts: contextBoardMaxAttempts
        })
          ? { outcome: "retry", reason, failureCategory }
          : { outcome: "failed", reason, failureCategory };
    }
  } finally {
    clearInterval(heartbeat);
    if (buildDeadlineTimer) clearTimeout(buildDeadlineTimer);
  }

  try {
    if (lease.lostReason || !result) {
      logStageOutcome(work, startedAt, undefined, lease.lostReason ?? "lease lost");
      await releaseContextLeaseOnce(work, lease, lease.lostReason ?? "worker lost its lease").catch((error) => {
        logger.error("worker lease release failed", {
          event: "worker.lease_release_failed",
          workerId,
          taskId: work.task.id,
          ...errorLogFields(error)
        });
      });
      // Health is the operator-visible completion signal. Publish it only
      // after the best-effort fenced release has returned, otherwise observers
      // can race the release request and conclude that terminal cleanup did
      // not happen.
      lastWork = { topic: work.message.topic, outcome: "lease_lost", finishedAt: new Date().toISOString() };
      return;
    }
    try {
      await complete(work, result);
    } catch (error) {
      if (!(error instanceof LeaseLostError) && isContextTopic(work.topic)) {
        await releaseContextLeaseOnce(work, lease, `completion failed: ${errorMessage(error)}`).catch(
          (releaseError) => {
            logger.error("worker lease release failed after completion failure", {
              event: "worker.completion_failure_release_failed",
              workerId,
              taskId: work.task.id,
              ...errorLogFields(releaseError)
            });
          }
        );
      }
      throw error;
    }
    lastWork = {
      topic: work.message.topic,
      outcome: result.outcome,
      finishedAt: new Date().toISOString(),
      ...(result.outcome === "failed" || result.outcome === "retry" ? { failureCategory: result.failureCategory } : {})
    };
    logStageOutcome(work, startedAt, result);
  } finally {
    activeLease = undefined;
    activeWork = undefined;
    activeModelUsage = undefined;
    activeModelUsageObserved = false;
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
    attempt: work.message.attempt ?? 1,
    ...(typeof metadata.contextBuildId === "string" ? { contextBuildId: metadata.contextBuildId } : {}),
    ...(typeof metadata.repository === "string" ? { repository: metadata.repository } : {}),
    ...(typeof metadata.ref === "string" ? { ref: metadata.ref } : {}),
    durationMs,
    ...(activeModelUsage
      ? {
          modelInputTokens: activeModelUsage.inputTokens,
          modelCachedInputTokens: activeModelUsage.cachedInputTokens,
          modelOutputTokens: activeModelUsage.outputTokens,
          modelTotalTokens: activeModelUsage.inputTokens + activeModelUsage.outputTokens,
          modelUsageObserved: activeModelUsageObserved
        }
      : {})
  };
  const stageLogger = logger.withTrace(generateTraceContext());
  metrics.observe("worker.stage.duration_ms", durationMs, { topic: work.message.topic });
  const reason =
    failureReason ??
    (result?.outcome === "failed" || result?.outcome === "retry"
      ? result.reason
      : result === undefined
        ? "unknown"
        : undefined);
  if (reason !== undefined) {
    const failureCategory =
      result?.outcome === "retry" || result?.outcome === "failed"
        ? result.failureCategory
        : workerFailureCategory(reason);
    const outcome = result?.outcome === "retry" ? "retry" : "failed";
    metrics.count("worker.tasks", {
      topic: work.message.topic,
      outcome,
      category: failureCategory
    });
    const detail = {
      event: outcome === "retry" ? "stage.retry_scheduled" : "stage.failed",
      ...base,
      failureCategory,
      reason: reason.slice(0, 500)
    };
    if (outcome === "retry") {
      stageLogger.warn(`${work.message.topic} scheduled retry for task ${work.task.id}`, detail);
    } else {
      stageLogger.error(`${work.message.topic} failed for task ${work.task.id}`, detail);
    }
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
    case "run-context-input-snapshot":
      return { outcome: "done", result: await runContextInputSnapshot(work) };
    case "run-context-research-plan":
      return { outcome: "done", result: await runContextResearchPlan(work) };
    case "run-context-research":
      return { outcome: "done", result: await runContextResearch(work) };
    case "run-context-publication-plan":
      return { outcome: "done", result: await runContextPublicationPlan(work) };
    case "run-context-page-write":
      return { outcome: "done", result: await runContextPageWrite(work) };
    case "run-context-page-audit":
      return { outcome: "done", result: await runContextPageAudit(work) };
    case "run-context-page-repair":
      return { outcome: "done", result: await runContextPageRepair(work) };
    case "run-context-source-challenge":
      return { outcome: "done", result: await runContextSourceChallenge(work) };
    case "run-context-task-evaluation":
      return { outcome: "done", result: await runContextTaskEvaluation(work) };
    case "run-context-gap-repair":
      return { outcome: "done", result: await runContextGapRepair(work) };
    case "run-context-certification":
      return { outcome: "done", result: await runContextCertification(work) };
    case "run-context-publication":
      return { outcome: "done", result: await runContextPublication(work) };
    case "run-context-pageindex":
      return { outcome: "done", result: await runContextPageIndex(work) };
    case "run-review":
      return { outcome: "done", result: await runReview(work) };
  }
}

async function runContextInputSnapshot(
  work: ClaimedWork<"run-context-input-snapshot">
): Promise<Record<string, unknown>> {
  const input = await captureContextInput(work);
  const outputArtifact = await uploadContextBoardArtifact(work, {
    kind: "evidence-snapshot",
    name: "snapshot.json",
    contentType: "application/json",
    content: Buffer.from(JSON.stringify(input), "utf8")
  });
  return { version: 1, outputArtifact, commitSha: input.commitSha };
}

async function runContextPageIndex(work: ClaimedWork<"run-context-pageindex">): Promise<Record<string, unknown>> {
  if (!boardPageIndexClient) throw new Error("self-hosted PageIndex client is not configured");
  const publicationArtifact = latestDependencyArtifact(
    work.task.metadata.dependencyResults,
    ["publish-context-release"],
    "PageIndex publication"
  );
  const releaseBytes = await readContextBoardArtifact(work, publicationArtifact);
  let release: unknown;
  try {
    release = JSON.parse(Buffer.from(releaseBytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("published Context release artifact is not valid JSON");
  }
  const built = await buildBoardPageIndex(boardPageIndexClient, release, {
    timeoutMs: positiveInt(process.env.CONTEXT_PAGEINDEX_BUILD_TIMEOUT_MS, 5 * 60_000),
    maxDocumentCharacters: positiveInt(process.env.CONTEXT_PAGEINDEX_MAX_DOCUMENT_CHARACTERS, 2_000_000),
    maxNodes: positiveInt(process.env.CONTEXT_PAGEINDEX_MAX_NODES, 20_000)
  });
  assertLeaseOwned();
  const outputArtifact = await uploadContextBoardArtifact(work, {
    kind: "pageindex-tree",
    name: `${built.releaseMetadata.releaseId}.json`,
    contentType: "application/json",
    content: Buffer.from(built.artifactContent, "utf8")
  });
  if (
    outputArtifact.sha256 !== built.artifactSha256 ||
    outputArtifact.bytes !== Buffer.byteLength(built.artifactContent, "utf8")
  ) {
    throw new Error("uploaded PageIndex tree does not match its verified immutable bytes");
  }
  const attached = await internalApiJson<Record<string, unknown>>(
    "/internal/context/board/pageindex/attach",
    leaseBody(work, {
      releaseId: built.releaseMetadata.releaseId,
      treeArtifact: outputArtifact
    })
  );
  if (
    attached.version !== 1 ||
    requiredString(attached.releaseId, "PageIndex attached releaseId") !== built.releaseMetadata.releaseId
  ) {
    throw new Error("PageIndex attachment did not bind the expected published release");
  }
  const attachedArtifact = parseArtifactRef(attached.outputArtifact, "PageIndex attached outputArtifact");
  if (
    attachedArtifact.key !== outputArtifact.key ||
    attachedArtifact.sha256 !== outputArtifact.sha256 ||
    attachedArtifact.bytes !== outputArtifact.bytes
  ) {
    throw new Error("PageIndex attachment changed the immutable tree artifact identity");
  }
  return {
    version: 1,
    outputArtifact,
    releaseId: built.releaseMetadata.releaseId
  };
}

async function runContextPublication(work: ClaimedWork<"run-context-publication">): Promise<Record<string, unknown>> {
  const certificationArtifact = latestDependencyArtifact(
    work.task.metadata.dependencyResults,
    ["certify-context-release"],
    "Context publication certification"
  );
  const result = await internalApiJson<Record<string, unknown>>(
    "/internal/context/board/publish",
    leaseBody(work, { certificationArtifact })
  );
  if (result.version !== 1) throw new Error("Context publication result version must be 1");
  const outputArtifact = parseArtifactRef(result.outputArtifact, "Context publication outputArtifact");
  const releaseId = requiredString(result.releaseId, "Context publication releaseId");
  return { version: 1, outputArtifact, releaseId };
}

async function captureContextInput(work: ClaimedWork<"run-context-input-snapshot">): Promise<IngestEvidenceInput> {
  const { tenantId, repository, ref, commitSha: expectedCommitSha, githubInstallationId } = work.task.metadata;
  if (requireGithubInstallation && !githubInstallationId) {
    throw new Error("provisioned GitHub installation is required for the context input snapshot");
  }
  if (githubInstallationId) {
    const access = await createGitHubInstallationAccessToken(githubInstallationId, { repository });
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
    return input;
  } finally {
    await rm(checkout.directory, { recursive: true, force: true });
  }
}

async function uploadContextBoardArtifact(
  work: ClaimedWork<ContextWorkerTopic>,
  input: {
    readonly kind: ContextArtifactKind;
    readonly name: string;
    readonly contentType: string;
    readonly content: Uint8Array;
  }
): Promise<ContextArtifactRef> {
  const result = await internalApiJson<{ readonly artifact: ContextArtifactRef }>(
    "/internal/context/board/artifacts",
    leaseBody(work, {
      kind: input.kind,
      name: input.name,
      contentType: input.contentType,
      contentBase64: Buffer.from(input.content).toString("base64")
    })
  );
  const expectedKey = contextArtifactKey({
    tenantId: work.task.metadata.tenantId,
    repository: work.task.metadata.repository,
    buildId: work.task.metadata.contextBuildId,
    kind: input.kind,
    name: `${work.task.id}-attempt-${work.message.attempt}-${input.name}`,
    contentType: input.contentType,
    content: input.content
  });
  if (
    result.artifact.key !== expectedKey ||
    result.artifact.contentType !== input.contentType ||
    result.artifact.bytes !== input.content.byteLength ||
    result.artifact.sha256 !== createHash("sha256").update(input.content).digest("hex")
  ) {
    throw new Error("context board artifact upload returned a mismatched immutable reference");
  }
  return result.artifact;
}

async function readContextBoardArtifact(work: ClaimedWork, artifact: ContextArtifactRef): Promise<Uint8Array> {
  const result = await internalApiJson<{
    readonly artifact: ContextArtifactRef;
    readonly contentBase64: string;
  }>("/internal/context/board/artifacts/read", leaseBody(work, { artifact }));
  if (Buffer.from(result.contentBase64, "base64").toString("base64") !== result.contentBase64) {
    throw new Error("context board artifact response is not canonical base64");
  }
  const content = Buffer.from(result.contentBase64, "base64");
  if (
    result.artifact.uri !== artifact.uri ||
    result.artifact.key !== artifact.key ||
    result.artifact.contentType !== artifact.contentType ||
    result.artifact.bytes !== artifact.bytes ||
    result.artifact.sha256 !== artifact.sha256 ||
    result.artifact.objectGeneration !== artifact.objectGeneration ||
    content.byteLength !== artifact.bytes ||
    createHash("sha256").update(content).digest("hex") !== artifact.sha256
  ) {
    throw new Error("context board artifact content does not match its dependency reference");
  }
  return content;
}

async function loadPriorContext(work: ClaimedWork<ContextWorkerTopic>): Promise<PriorContextPacket | undefined> {
  const seed = work.task.metadata.priorRelease;
  if (!seed) return undefined;
  if (
    seed.tenantId !== work.task.metadata.tenantId ||
    seed.repository !== work.task.metadata.repository ||
    seed.ref !== work.task.metadata.ref ||
    seed.refSequence >= work.task.metadata.refSequence
  ) {
    throw new Error("prior Context release seed does not precede the exact worker scope");
  }
  const content = await readContextBoardArtifact(work, seed.releaseArtifact);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch {
    throw new Error("prior Context release artifact is not valid JSON");
  }
  const release = parseCertifiedContextReleaseArtifact(value);
  assertContextPriorReleaseMatches(seed, release);
  return {
    version: 1,
    seed,
    release: release.release,
    pages: contextPriorReleaseCatalog(release),
    certifiedPages: release.pages
  };
}

async function writePriorContextPacket(
  directory: string,
  packet: PriorContextPacket | undefined
): Promise<string | undefined> {
  if (!packet) return undefined;
  const target = join(directory, "prior-context.json");
  const { certifiedPages: _certifiedPages, ...agentPacket } = packet;
  await writeFile(target, `${JSON.stringify(agentPacket, null, 2)}\n`, "utf8");
  return target;
}

async function runContextResearchPlan(
  work: ClaimedWork<"run-context-research-plan">
): Promise<Record<string, unknown>> {
  const snapshotArtifact = work.task.metadata.inputArtifact;
  const snapshot = parseEvidenceSnapshot(await readContextBoardArtifact(work, snapshotArtifact), work.task.metadata);
  const priorContext = await loadPriorContext(work);
  const checkout = await checkoutRepository(snapshot.repository, snapshot.ref, snapshot.commitSha, false);
  const inputDirectory = await mkdtemp(join(tmpdir(), "jina-context-research-plan-"));
  try {
    const evidencePath = join(inputDirectory, "evidence.json");
    const manifestPath = join(inputDirectory, "repository-manifest.json");
    const priorContextPath = await writePriorContextPacket(inputDirectory, priorContext);
    await Promise.all([
      writeFile(evidencePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"),
      writeFile(
        manifestPath,
        `${JSON.stringify(
          snapshot.files.map((file) => ({
            path: file.path,
            blobSha: file.blobSha,
            contentAvailable: !file.contentOmitted
          })),
          null,
          2
        )}\n`,
        "utf8"
      )
    ]);
    const runner = requireBoardAgentStageRunner();
    const output = await runner.run({
      id: "research-planner",
      prompt: researchPlannerPrompt({
        repository: snapshot.repository,
        repositoryDirectory: checkout.directory,
        manifestPath,
        evidencePath,
        ...(priorContextPath ? { priorContextPath } : {})
      }),
      schema: RESEARCH_STAGE_SCHEMA,
      workingDirectory: checkout.directory,
      additionalDirectories: [inputDirectory],
      readOnly: true,
      budgetSeconds: stageBudgetSeconds("CONTEXT_RESEARCH_PLANNER_SECONDS", 240)
    });
    const validationOptions = {
      repositoryFiles: snapshot.files.map((file) => ({
        path: file.path,
        contentAvailable: !file.contentOmitted
      })),
      repositoryAreas: repositoryContextAreas(snapshot.files)
    };
    const plan = await parseResearchPlanWithRepair({
      candidate: output.parsed,
      options: validationOptions,
      repair: async ({ invalidPlan, diagnostic }) => {
        const repaired = await runner.run({
          id: "research-planner-repair",
          prompt: researchPlannerRepairPrompt({
            repository: snapshot.repository,
            repositoryDirectory: checkout.directory,
            manifestPath,
            evidencePath,
            ...(priorContextPath ? { priorContextPath } : {}),
            invalidPlan,
            diagnostic
          }),
          schema: RESEARCH_STAGE_SCHEMA,
          workingDirectory: checkout.directory,
          additionalDirectories: [inputDirectory],
          readOnly: true,
          budgetSeconds: stageBudgetSeconds("CONTEXT_RESEARCH_PLANNER_REPAIR_SECONDS", 180)
        });
        return repaired.parsed;
      }
    });
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "research-plan",
      name: "research-plan.json",
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          plan,
          snapshotArtifact,
          ...(priorContext ? { priorRelease: priorContext.seed } : {})
        }),
        "utf8"
      )
    });
    return {
      version: 1,
      outputArtifact,
      work: plan.assignments.map((assignment) => ({
        key: assignment.id,
        title: `Research ${assignment.id}: ${assignment.objective}`.slice(0, 240),
        inputArtifact: outputArtifact
      }))
    };
  } finally {
    await Promise.all([
      rm(checkout.directory, { recursive: true, force: true }),
      rm(inputDirectory, { recursive: true, force: true })
    ]);
  }
}

async function runContextResearch(work: ClaimedWork<"run-context-research">): Promise<Record<string, unknown>> {
  const planPacket = parseResearchPlanArtifact(await readContextBoardArtifact(work, work.task.metadata.planArtifact));
  const assignment = planPacket.plan.assignments.find((candidate) => candidate.id === work.task.metadata.workKey);
  if (!assignment) throw new Error(`research plan does not contain assignment ${work.task.metadata.workKey}`);
  const snapshot = parseEvidenceSnapshot(
    await readContextBoardArtifact(work, planPacket.snapshotArtifact),
    work.task.metadata
  );
  const priorContext = await loadPriorContext(work);
  const checkout = await checkoutRepository(snapshot.repository, snapshot.ref, snapshot.commitSha, false);
  const inputDirectory = await mkdtemp(join(tmpdir(), "jina-context-research-"));
  try {
    const evidencePath = join(inputDirectory, "evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const priorContextPath = await writePriorContextPacket(inputDirectory, priorContext);
    const output = await requireBoardAgentStageRunner().run({
      id: `research-${assignment.id}`,
      prompt: researchWorkerPrompt({
        repository: snapshot.repository,
        repositoryDirectory: checkout.directory,
        evidencePath,
        assignment,
        ...(priorContextPath ? { priorContextPath } : {})
      }),
      workingDirectory: checkout.directory,
      additionalDirectories: [inputDirectory],
      readOnly: true,
      budgetSeconds: stageBudgetSeconds("CONTEXT_RESEARCH_WORKER_SECONDS", 600)
    });
    if (output.text.length < 200) throw new Error(`research worker ${assignment.id} returned a shallow report`);
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "research-report",
      name: `${assignment.id}.json`,
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          assignmentId: assignment.id,
          report: output.text,
          planArtifact: work.task.metadata.planArtifact,
          snapshotArtifact: planPacket.snapshotArtifact
        }),
        "utf8"
      )
    });
    return { version: 1, outputArtifact };
  } finally {
    await Promise.all([
      rm(checkout.directory, { recursive: true, force: true }),
      rm(inputDirectory, { recursive: true, force: true })
    ]);
  }
}

async function runContextPublicationPlan(
  work: ClaimedWork<"run-context-publication-plan">
): Promise<Record<string, unknown>> {
  const planPacket = parseResearchPlanArtifact(await readContextBoardArtifact(work, work.task.metadata.planArtifact));
  const reportArtifacts = work.task.metadata.dependencyResults
    .filter((dependency) => dependency.taskType === "research-context-subject")
    .map((dependency) => dependency.result.outputArtifact);
  const reportPackets = await Promise.all(
    reportArtifacts.map((artifact) => readContextBoardArtifact(work, artifact).then(parseResearchReportArtifact))
  );
  const researchPackets = Object.fromEntries(reportPackets.map((packet) => [packet.assignmentId, packet.report]));
  for (const assignment of planPacket.plan.assignments) {
    if (!researchPackets[assignment.id])
      throw new Error(`publication plan is missing research report ${assignment.id}`);
  }
  const snapshot = parseEvidenceSnapshot(
    await readContextBoardArtifact(work, planPacket.snapshotArtifact),
    work.task.metadata
  );
  const priorContext = await loadPriorContext(work);
  const repositoryAreas = repositoryContextAreas(
    snapshot.files.map((file) => ({
      checkpointId: `snapshot:${snapshot.commitSha}`,
      path: file.path,
      blobSha: file.blobSha,
      contentDigest: createHash("sha256").update(file.body).digest("hex"),
      contentAvailable: !file.contentOmitted,
      executable: file.executable,
      entryType: file.entryType ?? "file"
    }))
  );
  const stageRoot = await mkdtemp(join(tmpdir(), "jina-context-publication-plan-"));
  try {
    const priorContextPath = await writePriorContextPacket(stageRoot, priorContext);
    const runner = requireBoardAgentStageRunner();
    const output = await runner.run({
      id: "documentation-planner",
      prompt: documentationPlannerPrompt({
        repository: snapshot.repository,
        repositoryAreas,
        researchPlan: planPacket.plan,
        researchPackets,
        ...(priorContextPath ? { priorContextPath } : {})
      }),
      schema: DOCUMENTATION_STAGE_SCHEMA,
      workingDirectory: stageRoot,
      readOnly: true,
      budgetSeconds: stageBudgetSeconds("CONTEXT_DOCUMENTATION_PLANNER_SECONDS", 600)
    });
    const plan = await parsePublicationPlanWithRepair({
      candidate: output.parsed,
      options: {
        researchAssignments: planPacket.plan.assignments,
        repositoryAreas,
        ...(priorContext ? { priorPages: priorContext.pages } : {})
      },
      ...(priorContext
        ? {
            normalize: (candidate: unknown) =>
              promoteUnsafeRetainedPages({
                candidate,
                options: {
                  researchAssignments: planPacket.plan.assignments,
                  repositoryAreas,
                  priorPages: priorContext.pages
                },
                priorPages: priorContext.certifiedPages,
                snapshot
              }),
            validate: (candidate: DocumentationStagePlan) => {
              const problems = retainedPublicationPlanProblems({
                plan: candidate,
                priorPages: priorContext.certifiedPages,
                snapshot
              });
              if (problems.length > 0) {
                throw new Error(`incremental retain validation requires revise: ${problems.slice(0, 12).join("; ")}`);
              }
            }
          }
        : {}),
      repair: async ({ invalidPlan, diagnostic }) => {
        const repaired = await runner.run({
          id: "documentation-planner-repair",
          prompt: documentationPlannerRepairPrompt({
            repository: snapshot.repository,
            repositoryAreas,
            researchPlan: planPacket.plan,
            ...(priorContextPath ? { priorContextPath } : {}),
            invalidPlan,
            diagnostic
          }),
          schema: DOCUMENTATION_STAGE_SCHEMA,
          workingDirectory: stageRoot,
          readOnly: true,
          budgetSeconds: stageBudgetSeconds("CONTEXT_DOCUMENTATION_PLANNER_REPAIR_SECONDS", 300)
        });
        return repaired.parsed;
      }
    });
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "publication-plan",
      name: "publication-plan.json",
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          plan,
          researchPlanArtifact: work.task.metadata.planArtifact,
          researchReportArtifacts: reportArtifacts,
          snapshotArtifact: planPacket.snapshotArtifact,
          ...(priorContext ? { priorRelease: priorContext.seed } : {})
        }),
        "utf8"
      )
    });
    return {
      version: 1,
      outputArtifact,
      pages: plan.pages.map((page) => ({
        key: page.id,
        path: page.path,
        title: page.title,
        change: page.change ?? "add",
        inputArtifact: outputArtifact
      }))
    };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

interface PublicationPlanArtifact {
  readonly plan: DocumentationStagePlan;
  readonly researchPlanArtifact: ContextArtifactRef;
  readonly researchReportArtifacts: readonly ContextArtifactRef[];
  readonly snapshotArtifact: ContextArtifactRef;
  readonly priorRelease?: ContextPriorReleaseSeed;
}

interface PriorContextPacket {
  readonly version: 1;
  readonly seed: ContextPriorReleaseSeed;
  readonly release: CertifiedContextReleaseArtifactV1["release"];
  readonly pages: readonly ContextPriorPage[];
  /** Host-only certified bindings; omitted from the agent's prior-context file. */
  readonly certifiedPages: CertifiedContextReleaseArtifactV1["pages"];
}

interface ContextPageArtifact {
  readonly documentPath: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly publicationPlanArtifact: ContextArtifactRef;
  readonly snapshotArtifact: ContextArtifactRef;
  /**
   * Host-only convergence state. It is stored in the checkpoint artifact, not
   * rendered into public Context or exposed in task results.
   */
  readonly repairCheckpoint?: PageRepairCheckpointDiagnostics;
  /** Host-only link to the semantic audit that caused the latest repair. */
  readonly findingsArtifact?: ContextArtifactRef;
}

interface ContextDraftArtifact {
  readonly pages: readonly ContextPageArtifact[];
  readonly publicationPlanArtifact: ContextArtifactRef;
  readonly snapshotArtifact: ContextArtifactRef;
  readonly citationAuditInput: {
    readonly inputDigest: string;
    readonly publicSnapshotDigest: string;
    readonly references: readonly CitationAuditReference[];
  };
  readonly citationAudit: CitationAuditStageResult;
  readonly citationAuditDigest: string;
}

interface ContextPageAuditArtifact {
  readonly pageArtifact: ContextArtifactRef;
  readonly snapshotArtifact: ContextArtifactRef;
  readonly publicSnapshotDigest: string;
  readonly inputDigest: string;
  readonly references: ReturnType<typeof boardPageAuditInventory>["references"];
  readonly structuralProblems: readonly string[];
  readonly audit?: CitationAuditStageResult;
}

async function runContextPageWrite(work: ClaimedWork<"run-context-page-write">): Promise<Record<string, unknown>> {
  const publicationArtifact = work.task.metadata.inputArtifact;
  const publication = parsePublicationPlanArtifact(await readContextBoardArtifact(work, publicationArtifact));
  const page = publication.plan.pages.find((candidate) => candidate.id === work.task.metadata.pageKey);
  if (!page || page.path !== work.task.metadata.documentPath) {
    throw new Error("page work metadata does not match the publication plan");
  }
  const change = page.change ?? "add";
  if (change !== work.task.metadata.pageChange) {
    throw new Error("page work change does not match the publication plan");
  }
  const priorContext = await loadPriorContext(work);
  if ((publication.priorRelease === undefined) !== (priorContext === undefined)) {
    throw new Error("publication plan prior-release binding does not match the Board task");
  }
  if (publication.priorRelease && priorContext && !samePriorReleaseSeed(publication.priorRelease, priorContext.seed)) {
    throw new Error("publication plan references a different prior Context release");
  }
  if (change === "retain") {
    const priorPage = priorContext?.pages.find((candidate) => candidate.documentPath === page.path);
    if (!priorPage) throw new Error(`retained Context page ${page.path} is absent from the prior release`);
    const bodyMarkdown = canonicalPublicPageMarkdown(priorPage.bodyMarkdown);
    const publicSnapshotDigest = boardPublicPageDigest(page.path, bodyMarkdown);
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "context-page",
      name: pageArtifactName(page.path),
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          documentPath: page.path,
          title: priorPage.title,
          bodyMarkdown,
          publicationPlanArtifact: publicationArtifact,
          snapshotArtifact: publication.snapshotArtifact,
          change,
          priorLogicalId: priorPage.logicalId,
          priorRevisionId: priorPage.revisionId
        }),
        "utf8"
      )
    });
    return { version: 1, outputArtifact, publicSnapshotDigest };
  }
  const sourceWriter = publication.plan.writers.find((candidate) => candidate.pageIds.includes(page.id));
  if (!sourceWriter) throw new Error(`publication plan has no writer for ${page.id}`);
  const reportPackets = await Promise.all(
    publication.researchReportArtifacts.map((artifact) =>
      readContextBoardArtifact(work, artifact).then(parseResearchReportArtifact)
    )
  );
  const researchPackets = Object.fromEntries(reportPackets.map((packet) => [packet.assignmentId, packet.report]));
  const snapshot = parseEvidenceSnapshot(
    await readContextBoardArtifact(work, publication.snapshotArtifact),
    work.task.metadata
  );
  const checkout = await checkoutRepository(snapshot.repository, snapshot.ref, snapshot.commitSha, false);
  const stageRoot = await mkdtemp(join(tmpdir(), "jina-context-page-write-"));
  const outputDirectory = join(stageRoot, "context");
  await mkdir(outputDirectory, { recursive: true });
  try {
    const priorContextPath = await writePriorContextPacket(stageRoot, priorContext);
    await requireBoardAgentStageRunner().run({
      id: `write-${safeStageId(page.id)}`,
      prompt: documentationWriterPrompt({
        repository: snapshot.repository,
        repositoryDirectory: checkout.directory,
        outputDirectory,
        writer: { ...sourceWriter, pageIds: [page.id] },
        plan: publication.plan,
        researchPackets,
        ...(priorContextPath ? { priorContextPath } : {})
      }),
      workingDirectory: stageRoot,
      additionalDirectories: [checkout.directory],
      writableDirectories: [outputDirectory],
      outputFiles: [join(outputDirectory, page.path)],
      budgetSeconds: stageBudgetSeconds("CONTEXT_DOCUMENTATION_WRITER_SECONDS", 1_200)
    });
    await assertOnlyContextPage(outputDirectory, page.path);
    const bodyMarkdown = canonicalPublicPageMarkdown(await readFile(join(outputDirectory, page.path), "utf8"));
    if (bodyMarkdown.trim().length < 400) throw new Error(`page writer returned a shallow page for ${page.path}`);
    const draftInventory = boardPageAuditInventory({
      documentPath: page.path,
      bodyMarkdown,
      snapshot
    });
    const draftStructuralProblems = [
      ...draftInventory.structuralProblems,
      ...pagePlanStructuralProblems(page, publication.plan.pages, bodyMarkdown)
    ];
    logger.info(`page writer produced ${page.path}`, {
      event: "context.page_draft_created",
      workerId,
      taskId: work.task.id,
      contextBuildId: work.task.metadata.contextBuildId,
      repository: snapshot.repository,
      ref: snapshot.ref,
      documentPath: page.path,
      bytes: Buffer.byteLength(bodyMarkdown, "utf8"),
      referenceCount: draftInventory.references.length,
      structuralProblemCount: draftStructuralProblems.length,
      structuralProblems: draftStructuralProblems.slice(0, 32).map((problem) => problem.slice(0, 500))
    });
    const publicSnapshotDigest = boardPublicPageDigest(page.path, bodyMarkdown);
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "context-page",
      name: pageArtifactName(page.path),
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          documentPath: page.path,
          title: page.title,
          bodyMarkdown,
          publicationPlanArtifact: publicationArtifact,
          snapshotArtifact: publication.snapshotArtifact,
          change
        }),
        "utf8"
      )
    });
    return { version: 1, outputArtifact, publicSnapshotDigest };
  } finally {
    await Promise.all([
      rm(checkout.directory, { recursive: true, force: true }),
      rm(stageRoot, { recursive: true, force: true })
    ]);
  }
}

async function runContextPageAudit(work: ClaimedWork<"run-context-page-audit">): Promise<Record<string, unknown>> {
  const pageArtifact = latestDependencyArtifact(
    work.task.metadata.dependencyResults,
    ["repair-context-page", "write-context-page"],
    "page audit",
    {
      pageTaskId: work.task.metadata.pageTaskId,
      documentPath: work.task.metadata.documentPath
    }
  );
  const page = parseContextPageArtifact(await readContextBoardArtifact(work, pageArtifact));
  if (page.documentPath !== work.task.metadata.documentPath) {
    throw new Error("page audit dependency does not match its document path");
  }
  const publication = parsePublicationPlanArtifact(await readContextBoardArtifact(work, page.publicationPlanArtifact));
  const plannedPage = publication.plan.pages.find((candidate) => candidate.path === page.documentPath);
  if (!plannedPage) throw new Error(`page audit cannot find ${page.documentPath} in its publication plan`);
  const snapshot = parseEvidenceSnapshot(
    await readContextBoardArtifact(work, page.snapshotArtifact),
    work.task.metadata
  );
  const publicSnapshotDigest = boardPublicPageDigest(page.documentPath, page.bodyMarkdown);
  const inventory = boardPageAuditInventory({
    documentPath: page.documentPath,
    bodyMarkdown: page.bodyMarkdown,
    snapshot
  });
  const structuralProblems = [
    ...inventory.structuralProblems,
    ...pagePlanStructuralProblems(plannedPage, publication.plan.pages, page.bodyMarkdown)
  ];
  const inputDigest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        checkpoint: {
          repository: snapshot.repository,
          ref: snapshot.ref,
          commitSha: snapshot.commitSha
        },
        publicSnapshotDigest,
        references: inventory.references,
        structuralProblems
      })
    )
    .digest("hex");
  let audit: CitationAuditStageResult | undefined;
  if (structuralProblems.length === 0) {
    const workerId = `citation-audit-${safeStageId(work.task.metadata.pageKey).slice(0, 60)}`;
    let priorReferences: readonly CitationAuditReference[] | undefined;
    let priorAudit: CitationAuditStageResult | undefined;
    if (page.findingsArtifact) {
      const prior = parseContextPageAuditArtifact(await readContextBoardArtifact(work, page.findingsArtifact));
      if (prior.audit && prior.structuralProblems.length === 0) {
        priorReferences = prior.references;
        priorAudit = parseCitationAuditStageResult(prior.audit, {
          workerId: prior.audit.worker.id,
          inputDigest: prior.inputDigest,
          publicSnapshotDigest: prior.publicSnapshotDigest,
          citationIds: prior.references.map((reference) => reference.citationId)
        });
      }
    }
    const delta = citationAuditDelta({
      references: inventory.references,
      ...(priorReferences ? { priorReferences } : {}),
      ...(priorAudit ? { priorAudit } : {}),
      ...(page.repairCheckpoint ? { reuseAllExactVerdicts: true } : {})
    });
    const batchAudits: CitationAuditStageResult[] = [];
    if (delta.pendingReferences.length > 0) {
      const checkout = await checkoutRepository(snapshot.repository, snapshot.ref, snapshot.commitSha, false);
      const auditRoot = await mkdtemp(join(tmpdir(), "jina-context-page-audit-"));
      try {
        const evidencePath = join(auditRoot, "evidence.json");
        await writeFile(evidencePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        const batches = citationReferenceBatches(delta.pendingReferences);
        for (let index = 0; index < batches.length; index += 1) {
          const references = batches[index]!;
          batchAudits.push(
            await retryCitationAuditValidation({
              attempts: 2,
              run: async (attempt, priorDiagnostic) => {
                const expectedCitationIds = references.map((reference) => reference.citationId);
                const basePrompt = citationAuditStagePrompt({
                  workerId,
                  repository: snapshot.repository,
                  repositoryDirectory: checkout.directory,
                  evidencePath,
                  references,
                  inputDigest,
                  publicSnapshotDigest
                });
                const prompt = priorDiagnostic
                  ? [
                      basePrompt,
                      "The preceding result failed deterministic host validation. This is the one bounded format-correction retry; do not change the citation judgments merely to satisfy the schema.",
                      `Exact host diagnostic: ${priorDiagnostic}`,
                      `Expected worker ID: ${workerId}`,
                      `Expected inputDigest: ${inputDigest}`,
                      `Expected publicSnapshotDigest: ${publicSnapshotDigest}`,
                      `Expected citation IDs, each exactly once and no others:\n${JSON.stringify(expectedCitationIds, null, 2)}`
                    ].join("\n\n")
                  : basePrompt;
                const output = await requireBoardAgentStageRunner().run({
                  id: `${safeStageId(workerId)}-${index + 1}-format-${attempt}`,
                  prompt,
                  schema: CITATION_AUDIT_STAGE_SCHEMA,
                  workingDirectory: checkout.directory,
                  additionalDirectories: [auditRoot],
                  readOnly: true,
                  budgetSeconds: stageBudgetSeconds("CONTEXT_CITATION_AUDIT_SECONDS", 600)
                });
                return output.parsed;
              },
              parse: (value) =>
                parseCitationAuditStageResult(value, {
                  workerId,
                  inputDigest,
                  publicSnapshotDigest,
                  citationIds: references.map((reference) => reference.citationId)
                })
            })
          );
        }
      } finally {
        await Promise.all([
          rm(checkout.directory, { recursive: true, force: true }),
          rm(auditRoot, { recursive: true, force: true })
        ]);
      }
    }
    const resultByCitationId = new Map(
      [...delta.reusedResults, ...batchAudits.flatMap((candidate) => candidate.results)].map((result) => [
        result.citationId,
        result
      ])
    );
    const results = inventory.references.map((reference) => {
      const result = resultByCitationId.get(reference.citationId);
      if (!result) throw new Error(`citation audit omitted ${reference.citationId}`);
      return result;
    });
    const modelSummaries = batchAudits.map((candidate) => candidate.worker.summary);
    const reuseSummary =
      delta.reusedResults.length > 0
        ? `Reused ${delta.reusedResults.length} exact digest-bound citation verdicts.`
        : "";
    audit = parseCitationAuditStageResult(
      {
        version: 1,
        inputDigest,
        publicSnapshotDigest,
        worker: {
          id: workerId,
          summary: [reuseSummary, ...modelSummaries].filter(Boolean).join(" ").slice(0, 2_000)
        },
        results,
        summary: [reuseSummary, ...batchAudits.map((candidate) => candidate.summary)]
          .filter(Boolean)
          .join(" ")
          .slice(0, 4_000)
      },
      {
        workerId,
        inputDigest,
        publicSnapshotDigest,
        citationIds: inventory.references.map((reference) => reference.citationId)
      }
    );
  }
  const unsupportedCitationCount =
    structuralProblems.length + (audit?.results.filter((candidate) => candidate.verdict === "unsupported").length ?? 0);
  const diagnostics = [
    ...structuralProblems,
    ...(audit?.results
      .filter((candidate) => candidate.verdict === "unsupported")
      .map((candidate) => `Unsupported ${candidate.citationId}: ${candidate.rationale}`) ?? [])
  ]
    .slice(0, 32)
    .map((diagnostic) => diagnostic.slice(0, 500));
  logger.info(`citation audit evaluated ${page.documentPath}`, {
    event: "context.page_audit_evaluated",
    workerId,
    taskId: work.task.id,
    contextBuildId: work.task.metadata.contextBuildId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    documentPath: page.documentPath,
    pass: work.task.metadata.pass,
    referenceCount: inventory.references.length,
    structuralProblemCount: structuralProblems.length,
    unsupportedCitationCount,
    diagnostics
  });
  const outputArtifact = await uploadContextBoardArtifact(work, {
    kind: "citation-audit",
    name: `${pageArtifactName(page.documentPath)}.json`,
    contentType: "application/json",
    content: Buffer.from(
      JSON.stringify({
        version: 1,
        pageArtifact,
        snapshotArtifact: page.snapshotArtifact,
        publicSnapshotDigest,
        inputDigest,
        references: inventory.references,
        structuralProblems,
        ...(audit ? { audit } : {})
      }),
      "utf8"
    )
  });
  return {
    version: 1,
    outputArtifact,
    verdict: unsupportedCitationCount === 0 ? "supported" : "unsupported",
    publicSnapshotDigest,
    unsupportedCitationCount,
    diagnostics
  };
}

async function runContextPageRepair(work: ClaimedWork<"run-context-page-repair">): Promise<Record<string, unknown>> {
  const findingsArtifact = work.task.metadata.findingsArtifact;
  const findings = parseContextPageAuditArtifact(await readContextBoardArtifact(work, findingsArtifact));
  const priorPageBytes = await readContextBoardArtifact(work, findings.pageArtifact);
  const page = parseContextPageArtifact(priorPageBytes);
  if (page.documentPath !== work.task.metadata.documentPath) {
    throw new Error("page repair findings do not match its document path");
  }
  const publication = parsePublicationPlanArtifact(await readContextBoardArtifact(work, page.publicationPlanArtifact));
  const plannedPage = publication.plan.pages.find((candidate) => candidate.path === page.documentPath);
  if (!plannedPage) throw new Error(`page repair cannot find ${page.documentPath} in its publication plan`);
  const snapshot = parseEvidenceSnapshot(
    await readContextBoardArtifact(work, findings.snapshotArtifact),
    work.task.metadata
  );
  const checkout = await checkoutRepository(snapshot.repository, snapshot.ref, snapshot.commitSha, false);
  const stageRoot = await mkdtemp(join(tmpdir(), "jina-context-page-repair-"));
  const outputDirectory = join(stageRoot, "context");
  const auditInputPath = join(stageRoot, "citation-audit-input.json");
  const auditResultPath = join(stageRoot, "citation-audit-result.json");
  const targetPath = join(outputDirectory, page.documentPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, page.bodyMarkdown, "utf8");
  await writeFile(
    auditInputPath,
    `${JSON.stringify(
      {
        inputDigest: findings.inputDigest,
        publicSnapshotDigest: findings.publicSnapshotDigest,
        references: findings.references,
        structuralProblems: findings.structuralProblems
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(auditResultPath, `${JSON.stringify(findings.audit ?? {}, null, 2)}\n`, "utf8");
  try {
    const unsupportedCitationIds =
      findings.audit?.results
        .filter((candidate) => candidate.verdict === "unsupported")
        .map((candidate) => candidate.citationId) ?? [];
    const supportedCitationIds = findings.audit?.results
      .filter((candidate) => candidate.verdict === "supported")
      .map((candidate) => candidate.citationId);
    const prompt = [
      findings.structuralProblems.length > 0
        ? [
            "This is a bounded structural citation repair stage.",
            `Edit only ${targetPath}. Repair every host finding in ${auditInputPath}.`,
            "Restore a grounded lead and at least one core evidence binding in every named ungrounded substantive section. Cite consequential architecture, behavior, API/configuration, security/tenancy, state/invariant, failure/recovery, numeric/default, and history claims; do not add decorative links to connective prose or table labels. Remove or narrow unsupported core prose rather than inventing evidence. Preserve unrelated accurate prose, headings, navigation, and citations."
          ].join("\n\n")
        : "",
      unsupportedCitationIds.length > 0
        ? citationAuditRepairPrompt({
            repositoryDirectory: checkout.directory,
            outputDirectory,
            auditInputPath,
            auditResultPath,
            unsupportedCitationIds
          })
        : "",
      pageRepairCoveragePrompt(plannedPage, publication.plan.pages, {
        ...(supportedCitationIds === undefined ? {} : { supportedCitationIds }),
        ...(page.repairCheckpoint ? { priorCheckpoint: page.repairCheckpoint } : {}),
        ...(work.task.metadata.pass > MAX_CONTEXT_REPAIR_PASS
          ? { operatorRemediationPass: work.task.metadata.pass }
          : {})
      })
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!prompt) throw new Error("page repair received no actionable findings");
    await requireBoardAgentStageRunner().run({
      id: `repair-${safeStageId(page.documentPath)}-${work.task.metadata.pass}`,
      prompt,
      workingDirectory: stageRoot,
      additionalDirectories: [checkout.directory],
      writableDirectories: [outputDirectory],
      outputFiles: [targetPath],
      budgetSeconds: stageBudgetSeconds("CONTEXT_CITATION_REPAIR_SECONDS", 600)
    });
    await assertOnlyContextPage(outputDirectory, page.documentPath);
    const bodyMarkdown = canonicalPublicPageMarkdown(await readFile(targetPath, "utf8"));
    const priorPlanStructuralProblems = pagePlanStructuralProblems(
      plannedPage,
      publication.plan.pages,
      page.bodyMarkdown
    );
    const candidateInventory = boardPageAuditInventory({
      documentPath: page.documentPath,
      bodyMarkdown,
      snapshot
    });
    const candidatePlanStructuralProblems = pagePlanStructuralProblems(
      plannedPage,
      publication.plan.pages,
      bodyMarkdown
    );
    const candidateStructuralProblems = [...candidateInventory.structuralProblems, ...candidatePlanStructuralProblems];
    const regressionProblems = [
      ...pageRepairNoProgressProblems({
        priorBodyMarkdown: page.bodyMarkdown,
        candidateBodyMarkdown: bodyMarkdown,
        priorStructuralProblems: findings.structuralProblems,
        candidateStructuralProblems,
        semanticAuditPresent: findings.audit !== undefined
      }),
      ...pageRepairRegressionProblems({
        priorReferences: findings.references,
        priorStructuralProblems: findings.structuralProblems,
        priorPlanStructuralProblems,
        ...(supportedCitationIds === undefined ? {} : { priorSupportedCitationIds: supportedCitationIds }),
        candidateReferences: candidateInventory.references,
        candidateStructuralProblems,
        candidatePlanStructuralProblems
      }),
      ...pageRepairScopeRegressionProblems({
        page: plannedPage,
        priorBodyMarkdown: page.bodyMarkdown,
        candidateBodyMarkdown: bodyMarkdown
      })
    ];
    logger.info(`citation repair evaluated ${page.documentPath}`, {
      event: "context.page_repair_evaluated",
      workerId,
      taskId: work.task.id,
      contextBuildId: work.task.metadata.contextBuildId,
      repository: snapshot.repository,
      ref: snapshot.ref,
      documentPath: page.documentPath,
      pass: work.task.metadata.pass,
      priorStructuralProblemCount: findings.structuralProblems.length,
      candidateStructuralProblemCount: candidateStructuralProblems.length,
      regressionProblemCount: regressionProblems.length,
      regressionProblems: regressionProblems.slice(0, 16).map((problem) => problem.slice(0, 500))
    });
    const checkpointDiagnostics =
      regressionProblems.length === 0
        ? undefined
        : nextPageRepairCheckpointDiagnostics({
            ...(page.repairCheckpoint ? { priorCheckpoint: page.repairCheckpoint } : {}),
            attemptedBodyDigest: createHash("sha256").update(bodyMarkdown).digest("hex"),
            regressionProblems
          });
    const retainedArtifact =
      checkpointDiagnostics === undefined
        ? undefined
        : await uploadContextBoardArtifact(work, {
            kind: "context-page",
            name: pageArtifactName(page.documentPath),
            contentType: "application/json",
            content: Buffer.from(
              JSON.stringify({
                ...(JSON.parse(Buffer.from(priorPageBytes).toString("utf8")) as Record<string, unknown>),
                bodyMarkdown: page.bodyMarkdown,
                repairCheckpoint: checkpointDiagnostics,
                findingsArtifact
              }),
              "utf8"
            )
          });
    const retainedCheckpoint =
      retainedArtifact === undefined
        ? undefined
        : retainedPageRepairCheckpoint({
            regressionProblems,
            retainedArtifact,
            priorPublicSnapshotDigest: findings.publicSnapshotDigest
          });
    if (retainedCheckpoint) return retainedCheckpoint;
    const publicSnapshotDigest = boardPublicPageDigest(page.documentPath, bodyMarkdown);
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "context-page",
      name: pageArtifactName(page.documentPath),
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          documentPath: page.documentPath,
          title: page.title,
          bodyMarkdown,
          publicationPlanArtifact: page.publicationPlanArtifact,
          snapshotArtifact: page.snapshotArtifact,
          priorPageArtifact: findings.pageArtifact,
          findingsArtifact
        }),
        "utf8"
      )
    });
    return { version: 1, outputArtifact, publicSnapshotDigest };
  } finally {
    await Promise.all([
      rm(checkout.directory, { recursive: true, force: true }),
      rm(stageRoot, { recursive: true, force: true })
    ]);
  }
}

interface ContextGateArtifact {
  readonly gate: "source-challenge" | "task-evaluation";
  readonly verdict: "pass" | "repair_required";
  readonly publicSnapshotDigest: string;
  readonly blockingGapCount: number;
  readonly publicationPlanArtifact: ContextArtifactRef;
  readonly pageArtifacts: readonly ContextArtifactRef[];
  /** Exact global draft audited by this gate, absent for the initial per-page draft. */
  readonly contextDraftArtifact?: ContextArtifactRef;
  readonly result: unknown;
}

async function runContextSourceChallenge(
  work: ClaimedWork<"run-context-source-challenge">
): Promise<Record<string, unknown>> {
  const publicationArtifact = work.task.metadata.planArtifact;
  const publication = parsePublicationPlanArtifact(await readContextBoardArtifact(work, publicationArtifact));
  const pages = await contextPagesFromDependencies(work);
  const contextDraftArtifact = latestContextDraftArtifact(work.task.metadata.dependencyResults);
  const publicContext = publicContextSnapshot(pages);
  const publicSnapshotDigest = createHash("sha256").update(publicContext).digest("hex");
  const researchPlan = parseResearchPlanArtifact(
    await readContextBoardArtifact(work, publication.researchPlanArtifact)
  ).plan;
  const reportPackets = await Promise.all(
    publication.researchReportArtifacts.map((artifact) =>
      readContextBoardArtifact(work, artifact).then(parseResearchReportArtifact)
    )
  );
  const researchPackets = Object.fromEntries(reportPackets.map((packet) => [packet.assignmentId, packet.report]));
  const snapshot = parseEvidenceSnapshot(
    await readContextBoardArtifact(work, publication.snapshotArtifact),
    work.task.metadata
  );
  const challengedTasks = await previousMaterialChallengeTasks(work, work.task.metadata.pass);
  const existingTasks = maintenanceTaskCatalog(publication.plan, challengedTasks);
  const repositoryInventory = {
    areas: repositoryContextAreas(
      snapshot.files.map((file) => ({
        checkpointId: `snapshot:${snapshot.commitSha}`,
        path: file.path,
        blobSha: file.blobSha,
        contentDigest: createHash("sha256").update(file.body).digest("hex"),
        contentAvailable: !file.contentOmitted,
        executable: file.executable,
        entryType: file.entryType ?? "file"
      }))
    ),
    paths: snapshot.files.map((file) => file.path).sort()
  };
  const inputDigest = createHash("sha256")
    .update(
      JSON.stringify({
        checkpoint: {
          repository: snapshot.repository,
          ref: snapshot.ref,
          commitSha: snapshot.commitSha
        },
        repositoryInventory,
        researchPlan,
        researchPackets,
        existingTasks,
        publicSnapshotDigest
      })
    )
    .digest("hex");
  const workerId = `source-challenge-${work.task.metadata.pass}`;
  const checkout = await checkoutRepository(snapshot.repository, snapshot.ref, snapshot.commitSha, false);
  const stageRoot = await mkdtemp(join(tmpdir(), "jina-context-source-challenge-"));
  try {
    const evidencePath = join(stageRoot, "evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const runner = requireBoardAgentStageRunner();
    const stageInput = {
      id: workerId,
      prompt: sourceChallengeStagePrompt({
        workerId,
        repository: snapshot.repository,
        repositoryDirectory: checkout.directory,
        evidencePath,
        repositoryInventory,
        researchPlan,
        researchPackets,
        existingTasks,
        publicContext,
        inputDigest,
        publicSnapshotDigest
      }),
      schema: SOURCE_CHALLENGE_STAGE_SCHEMA,
      workingDirectory: checkout.directory,
      additionalDirectories: [stageRoot],
      readOnly: true,
      budgetSeconds: stageBudgetSeconds("CONTEXT_SOURCE_CHALLENGE_SECONDS", 900)
    } as const;
    const output = await runner.run(stageInput);
    const result = await parseBoardSourceChallengeStageResultWithRepair(
      output.parsed,
      {
        workerId,
        inputDigest,
        publicSnapshotDigest,
        existingTasks,
        researchPlan,
        repositoryPaths: repositoryInventory.paths
      },
      async (diagnostic, previousResult) => {
        const repaired = await runner.run({
          ...stageInput,
          id: `${workerId}-validation-repair`,
          prompt: sourceChallengeValidationRepairPrompt({
            workerId,
            repositoryDirectory: checkout.directory,
            evidencePath,
            repositoryPaths: repositoryInventory.paths,
            diagnostic,
            previousResult
          })
        });
        return repaired.parsed;
      }
    );
    const blockingTaskIds = new Set(result.addedTasks.filter((task) => task.material).map((task) => task.id));
    const blockingGapCount = blockingTaskIds.size;
    const verdict = blockingGapCount === 0 ? "pass" : "repair_required";
    const pageArtifacts = pages.map((page) => page.artifact);
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "gate-evaluation",
      name: `source-challenge-${work.task.metadata.pass}.json`,
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          gate: "source-challenge",
          verdict,
          publicSnapshotDigest,
          blockingGapCount,
          publicationPlanArtifact: publicationArtifact,
          pageArtifacts,
          ...(contextDraftArtifact ? { contextDraftArtifact } : {}),
          result
        }),
        "utf8"
      )
    });
    return { version: 1, outputArtifact, verdict, publicSnapshotDigest, blockingGapCount };
  } finally {
    await Promise.all([
      rm(checkout.directory, { recursive: true, force: true }),
      rm(stageRoot, { recursive: true, force: true })
    ]);
  }
}

async function runContextTaskEvaluation(
  work: ClaimedWork<"run-context-task-evaluation">
): Promise<Record<string, unknown>> {
  const publicationArtifact = work.task.metadata.planArtifact;
  const publication = parsePublicationPlanArtifact(await readContextBoardArtifact(work, publicationArtifact));
  const pages = await contextPagesFromDependencies(work);
  const contextDraftArtifact = latestContextDraftArtifact(work.task.metadata.dependencyResults);
  const publicContext = publicContextSnapshot(pages);
  const publicSnapshotDigest = createHash("sha256").update(publicContext).digest("hex");
  const challengedTasks = await previousMaterialChallengeTasks(work, work.task.metadata.pass);
  const questions = maintenanceTaskCatalog(publication.plan, challengedTasks);
  const taskCatalog = JSON.stringify(questions, null, 2);
  const taskCatalogDigest = createHash("sha256").update(taskCatalog).digest("hex");
  const workerId = `critic-context-${work.task.metadata.pass}`;
  const prompt = criticStagePrompt({
    workerId,
    publicContext,
    questions: taskCatalog,
    snapshotDigest: publicSnapshotDigest,
    taskCatalogDigest
  });
  const expected = {
    snapshotDigest: publicSnapshotDigest,
    taskCatalogDigest,
    questionIds: questions.map((question) => question.id),
    requiredAnswerPartsByQuestionId: Object.fromEntries(
      questions
        .filter((question) => (question.requiredAnswerParts?.length ?? 0) > 0)
        .map((question) => [question.id, question.requiredAnswerParts!])
    )
  };
  const stageRoot = await mkdtemp(join(tmpdir(), "jina-context-task-evaluation-"));
  try {
    let result: ReturnType<typeof parseCriticStageResult> | undefined;
    const contractRejections: string[] = [];
    for (let contractAttempt = 1; contractAttempt <= MAX_CRITIC_CONTRACT_ATTEMPTS; contractAttempt += 1) {
      const output = await requireBoardAgentStageRunner().run({
        id: contractAttempt === 1 ? workerId : `${workerId}-contract-repair-${contractAttempt - 1}`,
        prompt:
          contractAttempt === 1
            ? prompt
            : [
                prompt,
                `Previous results violated the host contract:\n${contractRejections.map((reason, index) => `${index + 1}. ${reason}`).join("\n")}`,
                "Re-evaluate every task and return one corrected complete result. A task with any blocking unknown must be partial or fail and reference a concrete blocking gap; never label it pass. Every question, attempt, and gap ID must be unique, and every referenced gap ID must be defined exactly once."
              ].join("\n\n"),
        schema: CRITIC_STAGE_SCHEMA,
        workingDirectory: stageRoot,
        readOnly: true,
        budgetSeconds: stageBudgetSeconds("CONTEXT_CRITIC_SECONDS", 900)
      });
      try {
        result = parseCriticStageResult(output.parsed, workerId, expected);
        break;
      } catch (error) {
        const rejection = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        if (contractAttempt === MAX_CRITIC_CONTRACT_ATTEMPTS) throw error;
        contractRejections.push(rejection);
        logger.warn("task evaluator contract rejected model output; scheduling bounded correction", {
          event: "context.contract_retry",
          buildId: work.task.metadata.contextBuildId,
          taskId: work.task.id,
          stage: "task-evaluation",
          contractAttempt,
          nextContractAttempt: contractAttempt + 1,
          maxContractAttempts: MAX_CRITIC_CONTRACT_ATTEMPTS,
          reason: rejection
        });
      }
    }
    if (!result) throw new Error("task evaluator exhausted its semantic contract attempts");
    const hostPlanStructuralProblems = pages.flatMap(({ page }) => {
      const plannedPage = publication.plan.pages.find((candidate) => candidate.path === page.documentPath);
      if (!plannedPage) return [`${page.documentPath} is absent from the binding publication plan`];
      return pagePlanStructuralProblems(plannedPage, publication.plan.pages, page.bodyMarkdown);
    });
    const explicitBlockingGapCount = new Set(
      result.gaps.filter((gap) => gap.severity === "blocking").map((gap) => gap.id)
    ).size;
    const nonPassingTaskCount = result.review.results.filter((review) => review.verdict !== "pass").length;
    const blockingGapCount = Math.max(explicitBlockingGapCount, nonPassingTaskCount, hostPlanStructuralProblems.length);
    const verdict = blockingGapCount === 0 ? "pass" : "repair_required";
    const resultWithHostChecks =
      hostPlanStructuralProblems.length === 0 ? result : { ...result, hostPlanStructuralProblems };
    const pageArtifacts = pages.map((page) => page.artifact);
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "gate-evaluation",
      name: `task-evaluation-${work.task.metadata.pass}.json`,
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          gate: "task-evaluation",
          verdict,
          publicSnapshotDigest,
          blockingGapCount,
          publicationPlanArtifact: publicationArtifact,
          pageArtifacts,
          ...(contextDraftArtifact ? { contextDraftArtifact } : {}),
          result: resultWithHostChecks
        }),
        "utf8"
      )
    });
    return { version: 1, outputArtifact, verdict, publicSnapshotDigest, blockingGapCount };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

async function runContextGapRepair(work: ClaimedWork<"run-context-gap-repair">): Promise<Record<string, unknown>> {
  const publicationArtifact = work.task.metadata.planArtifact;
  const publication = parsePublicationPlanArtifact(await readContextBoardArtifact(work, publicationArtifact));
  const priorPass = work.task.metadata.pass - 1;
  const challengeArtifact = dependencyArtifactByTypeAndPass(
    work.task.metadata.dependencyResults,
    "challenge-context-sources",
    priorPass,
    "gap repair source challenge"
  );
  const evaluationArtifact = dependencyArtifactByTypeAndPass(
    work.task.metadata.dependencyResults,
    "evaluate-context-tasks",
    priorPass,
    "gap repair task evaluation"
  );
  const [challenge, evaluation, currentPages] = await Promise.all([
    readContextBoardArtifact(work, challengeArtifact).then(parseContextGateArtifact),
    readContextBoardArtifact(work, evaluationArtifact).then(parseContextGateArtifact),
    contextPagesFromDependencies(work)
  ]);
  if (challenge.verdict === "pass" && evaluation.verdict === "pass") {
    throw new Error("context gap repair has no repair-required gate");
  }
  const snapshot = parseEvidenceSnapshot(
    await readContextBoardArtifact(work, publication.snapshotArtifact),
    work.task.metadata
  );
  const checkout = await checkoutRepository(snapshot.repository, snapshot.ref, snapshot.commitSha, false);
  const stageRoot = await mkdtemp(join(tmpdir(), "jina-context-gap-repair-"));
  const outputDirectory = join(stageRoot, "context");
  const priorCitationAudit = await contextCitationAuditCheckpoint(work, currentPages, challenge, evaluation);
  await mkdir(outputDirectory, { recursive: true });
  try {
    for (const { page } of currentPages) {
      const target = join(outputDirectory, page.documentPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, page.bodyMarkdown, "utf8");
    }
    const priorSnapshotDigest = createHash("sha256").update(publicContextSnapshot(currentPages)).digest("hex");
    await requireBoardAgentStageRunner().run({
      id: `gap-repair-${work.task.metadata.pass}`,
      prompt: contextGapRepairPrompt({
        repository: snapshot.repository,
        repositoryDirectory: checkout.directory,
        outputDirectory,
        publicationPlan: publication.plan,
        sourceChallenge: challenge.result,
        taskEvaluation: evaluation.result,
        pass: work.task.metadata.pass
      }),
      workingDirectory: stageRoot,
      additionalDirectories: [checkout.directory],
      writableDirectories: [outputDirectory],
      outputFiles: currentPages.map(({ page }) => join(outputDirectory, page.documentPath)),
      budgetSeconds: stageBudgetSeconds("CONTEXT_GAP_REPAIR_SECONDS", 1_200)
    });
    let pages: ContextPageArtifact[] = [];
    let citationAudit: Awaited<ReturnType<typeof auditContextDraftCitations>> | undefined;
    let priorReferences = priorCitationAudit.references;
    let priorResults = priorCitationAudit.results;
    const maximumCitationAuditPasses = 3;
    for (let auditPass = 1; auditPass <= maximumCitationAuditPasses; auditPass += 1) {
      pages = await loadContextDraftPages({
        outputDirectory,
        snapshot,
        publicationPlan: publication.plan,
        publicationPlanArtifact: publicationArtifact,
        snapshotArtifact: publication.snapshotArtifact
      });
      citationAudit = await auditContextDraftCitations({
        work,
        snapshot,
        checkoutDirectory: checkout.directory,
        stageRoot,
        pages,
        pass: work.task.metadata.pass,
        auditPass,
        ...(priorReferences.length > 0 ? { priorReferences, priorResults } : {})
      });
      const unsupported = citationAudit.result.results.filter((candidate) => candidate.verdict === "unsupported");
      if (unsupported.length === 0) break;
      if (auditPass === maximumCitationAuditPasses) {
        throw new Error(
          `context gap repair still has ${unsupported.length} unsupported citations after bounded repair`
        );
      }
      priorReferences = citationAudit.input.references;
      priorResults = citationAudit.result.results;
      const auditInputPath = join(stageRoot, "citation-audit-input.json");
      const auditResultPath = join(stageRoot, "citation-audit-result.json");
      await Promise.all([
        writeFile(auditInputPath, `${JSON.stringify(citationAudit.input, null, 2)}\n`, "utf8"),
        writeFile(auditResultPath, `${JSON.stringify(citationAudit.result, null, 2)}\n`, "utf8")
      ]);
      await requireBoardAgentStageRunner().run({
        id: `gap-citation-repair-${work.task.metadata.pass}-${auditPass}`,
        prompt: citationAuditRepairPrompt({
          repositoryDirectory: checkout.directory,
          outputDirectory,
          auditInputPath,
          auditResultPath,
          unsupportedCitationIds: unsupported.map((candidate) => candidate.citationId)
        }),
        workingDirectory: stageRoot,
        additionalDirectories: [checkout.directory],
        writableDirectories: [outputDirectory],
        outputFiles: pages.map((page) => join(outputDirectory, page.documentPath)),
        budgetSeconds: stageBudgetSeconds("CONTEXT_CITATION_REPAIR_SECONDS", 600)
      });
    }
    if (!citationAudit) throw new Error("context gap repair citation audit did not run");
    const publicSnapshotDigest = citationAudit.publicSnapshotDigest;
    if (publicSnapshotDigest === priorSnapshotDigest && contextGateRepairMustChangeSnapshot(work.task.metadata.pass)) {
      throw new Error("context gap repair did not change the repair-required public snapshot");
    }
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "context-draft",
      name: `context-draft-${work.task.metadata.pass}.json`,
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          pages,
          publicationPlanArtifact: publicationArtifact,
          snapshotArtifact: publication.snapshotArtifact,
          priorPageArtifacts: currentPages.map((page) => page.artifact),
          sourceChallengeArtifact: challengeArtifact,
          taskEvaluationArtifact: evaluationArtifact,
          citationAuditInput: citationAudit.input,
          citationAudit: citationAudit.result,
          citationAuditDigest: citationAudit.resultDigest
        }),
        "utf8"
      )
    });
    return { version: 1, outputArtifact, publicSnapshotDigest };
  } finally {
    await Promise.all([
      rm(checkout.directory, { recursive: true, force: true }),
      rm(stageRoot, { recursive: true, force: true })
    ]);
  }
}

async function loadContextDraftPages(input: {
  readonly outputDirectory: string;
  readonly snapshot: IngestEvidenceInput;
  readonly publicationPlan: DocumentationStagePlan;
  readonly publicationPlanArtifact: ContextArtifactRef;
  readonly snapshotArtifact: ContextArtifactRef;
}): Promise<ContextPageArtifact[]> {
  const documentPaths = await contextMarkdownPaths(input.outputDirectory);
  if (!documentPaths.includes("architecture.md")) {
    throw new Error("context gap repair removed architecture.md");
  }
  if (documentPaths.length === 0 || documentPaths.length > 96) {
    throw new Error("context gap repair produced an invalid page count");
  }
  const pages: ContextPageArtifact[] = [];
  const structuralProblems: string[] = [];
  for (const documentPath of documentPaths) {
    const bodyMarkdown = canonicalPublicPageMarkdown(await readFile(join(input.outputDirectory, documentPath), "utf8"));
    if (bodyMarkdown.trim().length < 400) {
      structuralProblems.push(`${documentPath} is too shallow`);
      continue;
    }
    const inventory = boardPageAuditInventory({
      documentPath,
      bodyMarkdown,
      snapshot: input.snapshot
    });
    structuralProblems.push(...inventory.structuralProblems.map((problem) => `${documentPath}: ${problem}`));
    const plannedPage = input.publicationPlan.pages.find((candidate) => candidate.path === documentPath);
    if (!plannedPage) {
      structuralProblems.push(`${documentPath} is absent from the binding publication plan`);
    } else {
      structuralProblems.push(
        ...pagePlanStructuralProblems(plannedPage, input.publicationPlan.pages, bodyMarkdown).map(
          (problem) => `${documentPath}: ${problem}`
        )
      );
    }
    pages.push({
      documentPath,
      title: markdownTitle(bodyMarkdown, documentPath),
      bodyMarkdown,
      publicationPlanArtifact: input.publicationPlanArtifact,
      snapshotArtifact: input.snapshotArtifact
    });
  }
  if (structuralProblems.length > 0) {
    throw new Error(
      `context gap repair produced ${structuralProblems.length} structurally unsupported claims: ${structuralProblems
        .slice(0, 8)
        .join("; ")}`
    );
  }
  return pages;
}

async function auditContextDraftCitations(input: {
  readonly work: ClaimedWork<"run-context-gap-repair">;
  readonly snapshot: IngestEvidenceInput;
  readonly checkoutDirectory: string;
  readonly stageRoot: string;
  readonly pages: readonly ContextPageArtifact[];
  readonly pass: number;
  readonly auditPass: number;
  readonly priorReferences?: readonly CitationAuditReference[];
  readonly priorResults?: CitationAuditStageResult["results"];
}): Promise<{
  readonly input: Record<string, unknown> & {
    readonly references: readonly CitationAuditReference[];
  };
  readonly result: CitationAuditStageResult;
  readonly resultDigest: string;
  readonly publicSnapshotDigest: string;
}> {
  const references = input.pages.flatMap(
    (page) =>
      boardPageAuditInventory({
        documentPath: page.documentPath,
        bodyMarkdown: page.bodyMarkdown,
        snapshot: input.snapshot
      }).references
  );
  const publicSnapshotDigest = createHash("sha256")
    .update(
      publicContextSnapshot(
        input.pages.map((page) => ({
          artifact: page.publicationPlanArtifact,
          page
        }))
      )
    )
    .digest("hex");
  const inputPayload = {
    version: 1,
    checkpoint: {
      repository: input.snapshot.repository,
      ref: input.snapshot.ref,
      commitSha: input.snapshot.commitSha
    },
    publicSnapshotDigest,
    references
  };
  const inputDigest = createHash("sha256").update(JSON.stringify(inputPayload)).digest("hex");
  const evidencePath = join(input.stageRoot, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(input.snapshot, null, 2)}\n`, "utf8");
  const workerId = `citation-audit-gap-${input.pass}`;
  const delta = citationAuditDelta({
    references,
    ...(input.priorReferences ? { priorReferences: input.priorReferences } : {}),
    ...(input.priorResults ? { priorResults: input.priorResults } : {})
  });
  const batchAudits: CitationAuditStageResult[] = [];
  const batches = citationReferenceBatches(delta.pendingReferences);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    const output = await requireBoardAgentStageRunner().run({
      id: `gap-audit-${input.pass}-${input.auditPass}-${index + 1}`,
      prompt: citationAuditStagePrompt({
        workerId,
        repository: input.snapshot.repository,
        repositoryDirectory: input.checkoutDirectory,
        evidencePath,
        references: batch,
        inputDigest,
        publicSnapshotDigest
      }),
      schema: CITATION_AUDIT_STAGE_SCHEMA,
      workingDirectory: input.checkoutDirectory,
      additionalDirectories: [input.stageRoot],
      readOnly: true,
      budgetSeconds: stageBudgetSeconds("CONTEXT_CITATION_AUDIT_SECONDS", 600)
    });
    batchAudits.push(
      parseCitationAuditStageResult(output.parsed, {
        workerId,
        inputDigest,
        publicSnapshotDigest,
        citationIds: batch.map((reference) => reference.citationId)
      })
    );
  }
  const result = parseCitationAuditStageResult(
    {
      version: 1,
      inputDigest,
      publicSnapshotDigest,
      worker: {
        id: workerId,
        summary: [
          ...(delta.reusedResults.length > 0
            ? [`Reused ${delta.reusedResults.length} exact digest-bound supported citation verdicts.`]
            : []),
          ...batchAudits.map((audit) => audit.worker.summary)
        ]
          .join(" ")
          .slice(0, 2_000)
      },
      results: [...delta.reusedResults, ...batchAudits.flatMap((audit) => audit.results)],
      summary: [
        ...(delta.reusedResults.length > 0
          ? [`Reused ${delta.reusedResults.length} exact supported citation verdicts.`]
          : []),
        ...batchAudits.map((audit) => audit.summary)
      ]
        .join(" ")
        .slice(0, 4_000)
    },
    {
      workerId,
      inputDigest,
      publicSnapshotDigest,
      citationIds: references.map((reference) => reference.citationId)
    }
  );
  return {
    input: { ...inputPayload, inputDigest },
    result,
    resultDigest: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    publicSnapshotDigest
  };
}

async function runContextCertification(
  work: ClaimedWork<"run-context-certification">
): Promise<Record<string, unknown>> {
  const challengeArtifact = dependencyArtifactByType(
    work.task.metadata.dependencyResults,
    "challenge-context-sources",
    "certification source challenge"
  );
  const evaluationArtifact = dependencyArtifactByType(
    work.task.metadata.dependencyResults,
    "evaluate-context-tasks",
    "certification task evaluation"
  );
  const [challenge, evaluation, pages] = await Promise.all([
    readContextBoardArtifact(work, challengeArtifact).then(parseContextGateArtifact),
    readContextBoardArtifact(work, evaluationArtifact).then(parseContextGateArtifact),
    contextPagesFromDependencies(work)
  ]);
  const publicSnapshotDigest = createHash("sha256").update(publicContextSnapshot(pages)).digest("hex");
  const citationCertified = await contextCitationEvidenceCertified(work, pages, publicSnapshotDigest);
  const pageArtifactKeys = pages.map((page) => page.artifact.key).sort();
  const certified =
    challenge.gate === "source-challenge" &&
    evaluation.gate === "task-evaluation" &&
    challenge.verdict === "pass" &&
    evaluation.verdict === "pass" &&
    challenge.blockingGapCount === 0 &&
    evaluation.blockingGapCount === 0 &&
    challenge.publicSnapshotDigest === publicSnapshotDigest &&
    evaluation.publicSnapshotDigest === publicSnapshotDigest &&
    JSON.stringify(challenge.pageArtifacts.map((artifact) => artifact.key).sort()) ===
      JSON.stringify(pageArtifactKeys) &&
    JSON.stringify(evaluation.pageArtifacts.map((artifact) => artifact.key).sort()) ===
      JSON.stringify(pageArtifactKeys) &&
    challenge.publicationPlanArtifact.key === work.task.metadata.planArtifact.key &&
    evaluation.publicationPlanArtifact.key === work.task.metadata.planArtifact.key &&
    citationCertified;
  const outputArtifact = await uploadContextBoardArtifact(work, {
    kind: "certification",
    name: "certification.json",
    contentType: "application/json",
    content: Buffer.from(
      JSON.stringify({
        version: 1,
        verdict: certified ? "certified" : "rejected",
        publicSnapshotDigest,
        publicationPlanArtifact: work.task.metadata.planArtifact,
        pageArtifacts: pages.map((page) => page.artifact),
        sourceChallengeArtifact: challengeArtifact,
        taskEvaluationArtifact: evaluationArtifact
      }),
      "utf8"
    )
  });
  return {
    version: 1,
    outputArtifact,
    verdict: certified ? "certified" : "rejected",
    publicSnapshotDigest
  };
}

async function contextCitationEvidenceCertified(
  work: ClaimedWork<"run-context-certification">,
  pages: readonly { readonly artifact: ContextArtifactRef; readonly page: ContextPageArtifact }[],
  publicSnapshotDigest: string
): Promise<boolean> {
  const latestDraftDependency = work.task.metadata.dependencyResults
    .filter((dependency) => dependency.taskType === "repair-context-gaps")
    .sort((left, right) => (right.pass ?? -1) - (left.pass ?? -1))[0];
  if (latestDraftDependency) {
    const draft = parseContextDraftArtifact(
      await readContextBoardArtifact(work, latestDraftDependency.result.outputArtifact)
    );
    const expectedPages = [...pages]
      .map(({ page }) => page)
      .sort((left, right) => left.documentPath.localeCompare(right.documentPath));
    const recordedPages = [...draft.pages].sort((left, right) => left.documentPath.localeCompare(right.documentPath));
    if (
      expectedPages.length !== recordedPages.length ||
      expectedPages.some(
        (page, index) =>
          page.documentPath !== recordedPages[index]?.documentPath ||
          page.bodyMarkdown !== recordedPages[index]?.bodyMarkdown
      )
    ) {
      return false;
    }
    const snapshot = parseEvidenceSnapshot(
      await readContextBoardArtifact(work, draft.snapshotArtifact),
      work.task.metadata
    );
    const references = expectedPages.flatMap(
      (page) =>
        boardPageAuditInventory({
          documentPath: page.documentPath,
          bodyMarkdown: page.bodyMarkdown,
          snapshot
        }).references
    );
    const expectedInputPayload = {
      version: 1,
      checkpoint: {
        repository: snapshot.repository,
        ref: snapshot.ref,
        commitSha: snapshot.commitSha
      },
      publicSnapshotDigest,
      references
    };
    const expectedInputDigest = createHash("sha256").update(JSON.stringify(expectedInputPayload)).digest("hex");
    return (
      draft.citationAuditInput.inputDigest === expectedInputDigest &&
      draft.citationAuditInput.publicSnapshotDigest === publicSnapshotDigest &&
      JSON.stringify(draft.citationAuditInput.references) === JSON.stringify(references) &&
      draft.citationAudit.inputDigest === expectedInputDigest &&
      draft.citationAudit.publicSnapshotDigest === publicSnapshotDigest &&
      draft.citationAudit.results.length === references.length &&
      draft.citationAudit.results.every((result) => result.verdict === "supported")
    );
  }

  const auditDependencies = work.task.metadata.dependencyResults
    .filter((dependency) => dependency.taskType === "audit-context-page")
    .sort((left, right) => (right.pass ?? -1) - (left.pass ?? -1));
  const loadedAudits = await Promise.all(
    auditDependencies.map(async (dependency) => ({
      dependency,
      audit: parseContextPageAuditArtifact(await readContextBoardArtifact(work, dependency.result.outputArtifact))
    }))
  );
  for (const { artifact: pageArtifact, page } of pages) {
    const matching = loadedAudits.find((candidate) => candidate.audit.pageArtifact.key === pageArtifact.key);
    if (!matching?.audit.audit || matching.audit.structuralProblems.length > 0) {
      return false;
    }
    const snapshot = parseEvidenceSnapshot(
      await readContextBoardArtifact(work, matching.audit.snapshotArtifact),
      work.task.metadata
    );
    const inventory = boardPageAuditInventory({
      documentPath: page.documentPath,
      bodyMarkdown: page.bodyMarkdown,
      snapshot
    });
    if (inventory.structuralProblems.length > 0) return false;
    const pageDigest = boardPublicPageDigest(page.documentPath, page.bodyMarkdown);
    const inputPayload = {
      version: 1,
      checkpoint: {
        repository: snapshot.repository,
        ref: snapshot.ref,
        commitSha: snapshot.commitSha
      },
      publicSnapshotDigest: pageDigest,
      references: inventory.references,
      structuralProblems: inventory.structuralProblems
    };
    const inputDigest = createHash("sha256").update(JSON.stringify(inputPayload)).digest("hex");
    const audit = parseCitationAuditStageResult(matching.audit.audit, {
      workerId: matching.audit.audit.worker.id,
      inputDigest,
      publicSnapshotDigest: pageDigest,
      citationIds: inventory.references.map((reference) => reference.citationId)
    });
    if (
      matching.audit.inputDigest !== inputDigest ||
      matching.audit.publicSnapshotDigest !== pageDigest ||
      audit.results.some((result) => result.verdict !== "supported")
    ) {
      return false;
    }
  }
  return pages.length > 0;
}

function parseContextGateArtifact(content: Uint8Array): ContextGateArtifact {
  const value = JSON.parse(Buffer.from(content).toString("utf8")) as Record<string, unknown>;
  const gate = requiredString(value.gate, "context gate");
  const verdict = requiredString(value.verdict, "context gate verdict");
  if (gate !== "source-challenge" && gate !== "task-evaluation") {
    throw new Error("context gate artifact has an invalid gate");
  }
  if (verdict !== "pass" && verdict !== "repair_required") {
    throw new Error("context gate artifact has an invalid verdict");
  }
  if (!Array.isArray(value.pageArtifacts)) throw new Error("context gate artifact has no page manifest");
  return {
    gate,
    verdict,
    publicSnapshotDigest: requiredDigest(value.publicSnapshotDigest, "context gate publicSnapshotDigest"),
    blockingGapCount: requiredNonNegativeInteger(value.blockingGapCount, "context gate blockingGapCount"),
    publicationPlanArtifact: parseArtifactRef(value.publicationPlanArtifact, "context gate publicationPlanArtifact"),
    pageArtifacts: value.pageArtifacts.map((artifact, index) =>
      parseArtifactRef(artifact, `context gate pageArtifacts[${index}]`)
    ),
    ...(value.contextDraftArtifact === undefined
      ? {}
      : {
          contextDraftArtifact: parseArtifactRef(value.contextDraftArtifact, "context gate contextDraftArtifact")
        }),
    result: value.result
  };
}

function maintenanceTaskCatalog(
  plan: DocumentationStagePlan,
  challengedTasks: readonly MaterialChallengeTask[] = []
): {
  readonly id: string;
  readonly question: string;
  readonly priority: "required";
  readonly requiredAnswerParts?: readonly ChallengeAnswerPart[];
}[] {
  const byQuestion = new Map<
    string,
    {
      id: string;
      question: string;
      priority: "required";
      requiredAnswerParts?: readonly ChallengeAnswerPart[];
    }
  >();
  for (const page of plan.pages) {
    for (const question of page.maintenanceQuestions) {
      const normalized = question.trim().replace(/\s+/g, " ").toLowerCase();
      if (!byQuestion.has(normalized)) {
        byQuestion.set(normalized, {
          id: `task-${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`,
          question,
          priority: "required"
        });
      }
    }
  }
  for (const task of challengedTasks) {
    const normalized = task.question.trim().replace(/\s+/g, " ").toLowerCase();
    if (!byQuestion.has(normalized)) {
      byQuestion.set(normalized, {
        id: task.id,
        question: task.question,
        priority: "required",
        requiredAnswerParts: task.requiredAnswerParts
      });
    }
  }
  return [...byQuestion.values()].sort((left, right) => left.id.localeCompare(right.id));
}

interface MaterialChallengeTask {
  readonly id: string;
  readonly question: string;
  readonly requiredAnswerParts: readonly ChallengeAnswerPart[];
}

async function previousMaterialChallengeTasks(
  work: ClaimedWork<(typeof CONTEXT_BOARD_TOPICS)[number]>,
  beforePass: number
): Promise<MaterialChallengeTask[]> {
  const previous = work.task.metadata.dependencyResults
    .filter((dependency) => dependency.taskType === "challenge-context-sources" && (dependency.pass ?? -1) < beforePass)
    .sort((left, right) => (right.pass ?? -1) - (left.pass ?? -1))[0];
  if (!previous) return [];
  const gate = parseContextGateArtifact(await readContextBoardArtifact(work, previous.result.outputArtifact));
  if (!isRecord(gate.result) || !Array.isArray(gate.result.addedTasks)) return [];
  const answerParts = new Set<ChallengeAnswerPart>([
    "entrypoints",
    "important_symbols",
    "control_flow",
    "state",
    "invariants",
    "failure_triage",
    "configuration",
    "verification"
  ]);
  return gate.result.addedTasks.flatMap((task, index) => {
    if (!isRecord(task) || task.material !== true || !Array.isArray(task.requiredAnswerParts)) {
      return [];
    }
    const requiredAnswerParts = task.requiredAnswerParts.map((part, partIndex) => {
      const value = requiredString(
        part,
        `source challenge addedTasks[${index}].requiredAnswerParts[${partIndex}]`
      ) as ChallengeAnswerPart;
      if (!answerParts.has(value)) throw new Error(`source challenge has invalid answer part ${value}`);
      return value;
    });
    return [
      {
        id: requiredString(task.id, `source challenge addedTasks[${index}].id`),
        question: requiredString(task.question, `source challenge addedTasks[${index}].question`),
        requiredAnswerParts
      }
    ];
  });
}

async function contextPagesFromDependencies(
  work: ClaimedWork<(typeof CONTEXT_BOARD_TOPICS)[number]>
): Promise<{ readonly artifact: ContextArtifactRef; readonly page: ContextPageArtifact }[]> {
  const latestDraftArtifact = latestContextDraftArtifact(work.task.metadata.dependencyResults);
  if (latestDraftArtifact) {
    const draft = parseContextDraftArtifact(await readContextBoardArtifact(work, latestDraftArtifact));
    if (draft.pages.length === 0) throw new Error("latest context draft has no pages");
    return [...draft.pages]
      .sort((left, right) => left.documentPath.localeCompare(right.documentPath))
      .map((page) => ({ artifact: latestDraftArtifact, page }));
  }
  const candidates = work.task.metadata.dependencyResults.filter((dependency) =>
    ["write-context-page", "repair-context-page"].includes(dependency.taskType)
  );
  const loaded = await Promise.all(
    candidates.map(async (dependency) => ({
      dependency,
      artifact: dependency.result.outputArtifact,
      page: parseContextPageArtifact(await readContextBoardArtifact(work, dependency.result.outputArtifact))
    }))
  );
  const selected = new Map<string, (typeof loaded)[number]>();
  for (const candidate of loaded) {
    const current = selected.get(candidate.page.documentPath);
    if (
      !current ||
      (candidate.dependency.pass ?? -1) > (current.dependency.pass ?? -1) ||
      ((candidate.dependency.pass ?? -1) === (current.dependency.pass ?? -1) &&
        candidate.dependency.taskType === "repair-context-page")
    ) {
      selected.set(candidate.page.documentPath, candidate);
    }
  }
  if (selected.size === 0) throw new Error("context gate has no completed page artifacts");
  return [...selected.values()]
    .sort((left, right) => left.page.documentPath.localeCompare(right.page.documentPath))
    .map(({ artifact, page }) => ({ artifact, page }));
}

function latestContextDraftArtifact(
  dependencies: readonly ContextBoardDependencyResult[]
): ContextArtifactRef | undefined {
  return dependencies
    .filter((dependency) => dependency.taskType === "repair-context-gaps")
    .sort((left, right) => (right.pass ?? -1) - (left.pass ?? -1))[0]?.result.outputArtifact;
}

async function contextCitationAuditCheckpoint(
  work: ClaimedWork<"run-context-gap-repair">,
  pages: readonly { readonly artifact: ContextArtifactRef; readonly page: ContextPageArtifact }[],
  challenge: ContextGateArtifact,
  evaluation: ContextGateArtifact
): Promise<{
  readonly references: readonly CitationAuditReference[];
  readonly results: CitationAuditStageResult["results"];
}> {
  const latestDraft = latestContextDraftArtifact(work.task.metadata.dependencyResults);
  const challengeDraft = challenge.contextDraftArtifact ?? latestDraft;
  const evaluationDraft = evaluation.contextDraftArtifact ?? latestDraft;
  if (!challengeDraft && !evaluationDraft) {
    return contextPageCitationAuditCheckpoint(work, pages);
  }
  if (
    !challengeDraft ||
    !evaluationDraft ||
    challengeDraft.key !== evaluationDraft.key ||
    challengeDraft.sha256 !== evaluationDraft.sha256
  ) {
    throw new Error("context gates disagree about their audited global draft");
  }
  const sameDraft = (artifact: ContextArtifactRef): boolean =>
    artifact.key === challengeDraft.key && artifact.sha256 === challengeDraft.sha256;
  if (
    pages.length === 0 ||
    pages.some((entry) => !sameDraft(entry.artifact)) ||
    challenge.pageArtifacts.length !== pages.length ||
    evaluation.pageArtifacts.length !== pages.length ||
    challenge.pageArtifacts.some((artifact) => !sameDraft(artifact)) ||
    evaluation.pageArtifacts.some((artifact) => !sameDraft(artifact))
  ) {
    throw new Error("context gate global draft binding does not match its page manifest");
  }
  const draft = parseContextDraftArtifact(await readContextBoardArtifact(work, challengeDraft));
  const expectedPages = [...pages]
    .map(({ page }) => page)
    .sort((left, right) => left.documentPath.localeCompare(right.documentPath));
  const recordedPages = [...draft.pages].sort((left, right) => left.documentPath.localeCompare(right.documentPath));
  if (
    expectedPages.length !== recordedPages.length ||
    expectedPages.some(
      (page, index) =>
        page.documentPath !== recordedPages[index]?.documentPath ||
        page.bodyMarkdown !== recordedPages[index]?.bodyMarkdown
    )
  ) {
    throw new Error("context gate global draft content does not match its pages");
  }
  const publicSnapshotDigest = createHash("sha256").update(publicContextSnapshot(pages)).digest("hex");
  if (
    challenge.publicSnapshotDigest !== publicSnapshotDigest ||
    evaluation.publicSnapshotDigest !== publicSnapshotDigest ||
    draft.citationAuditInput.publicSnapshotDigest !== publicSnapshotDigest ||
    draft.citationAudit.publicSnapshotDigest !== publicSnapshotDigest ||
    draft.citationAudit.results.length !== draft.citationAuditInput.references.length ||
    draft.citationAudit.results.some((result) => result.verdict !== "supported")
  ) {
    throw new Error("context gate global draft has no complete supported citation checkpoint");
  }
  return {
    references: draft.citationAuditInput.references,
    results: draft.citationAudit.results
  };
}

async function contextPageCitationAuditCheckpoint(
  work: ClaimedWork<"run-context-gap-repair">,
  pages: readonly { readonly artifact: ContextArtifactRef; readonly page: ContextPageArtifact }[]
): Promise<{
  readonly references: readonly CitationAuditReference[];
  readonly results: CitationAuditStageResult["results"];
}> {
  const auditDependencies = work.task.metadata.dependencyResults
    .filter((dependency) => dependency.taskType === "audit-context-page")
    .sort((left, right) => (right.pass ?? -1) - (left.pass ?? -1));
  const loaded = await Promise.all(
    auditDependencies.map(async (dependency) => ({
      dependency,
      audit: parseContextPageAuditArtifact(await readContextBoardArtifact(work, dependency.result.outputArtifact))
    }))
  );
  const selected = new Map<
    string,
    {
      readonly references: readonly CitationAuditReference[];
      readonly results: CitationAuditStageResult["results"];
    }
  >();
  for (const candidate of loaded) {
    const page = pages.find(
      (entry) =>
        entry.artifact.key === candidate.audit.pageArtifact.key &&
        entry.artifact.sha256 === candidate.audit.pageArtifact.sha256
    );
    if (
      !page ||
      selected.has(page.page.documentPath) ||
      candidate.audit.structuralProblems.length > 0 ||
      !candidate.audit.audit ||
      candidate.audit.publicSnapshotDigest !== boardPublicPageDigest(page.page.documentPath, page.page.bodyMarkdown)
    ) {
      continue;
    }
    const audit = parseCitationAuditStageResult(candidate.audit.audit, {
      workerId: candidate.audit.audit.worker.id,
      inputDigest: candidate.audit.inputDigest,
      publicSnapshotDigest: candidate.audit.publicSnapshotDigest,
      citationIds: candidate.audit.references.map((reference) => reference.citationId)
    });
    selected.set(page.page.documentPath, {
      references: candidate.audit.references,
      results: audit.results
    });
  }
  return {
    references: [...selected.values()].flatMap((candidate) => candidate.references),
    results: [...selected.values()].flatMap((candidate) => candidate.results)
  };
}

function publicContextSnapshot(pages: readonly { readonly page: ContextPageArtifact }[]): string {
  return contextBoardPublicSnapshot(pages.map(({ page }) => page));
}

function dependencyArtifactByType(
  dependencies: readonly ContextBoardDependencyResult[],
  taskType: string,
  name: string
): ContextArtifactRef {
  const dependency = dependencies
    .filter((candidate) => candidate.taskType === taskType)
    .sort((left, right) => (right.pass ?? -1) - (left.pass ?? -1))[0];
  if (!dependency) throw new Error(`${name} artifact is missing`);
  return dependency.result.outputArtifact;
}

function dependencyArtifactByTypeAndPass(
  dependencies: readonly ContextBoardDependencyResult[],
  taskType: string,
  pass: number,
  name: string
): ContextArtifactRef {
  const dependency = dependencies.find((candidate) => candidate.taskType === taskType && candidate.pass === pass);
  if (!dependency) throw new Error(`${name} artifact for pass ${pass} is missing`);
  return dependency.result.outputArtifact;
}

function parsePublicationPlanArtifact(content: Uint8Array): PublicationPlanArtifact {
  const value = JSON.parse(Buffer.from(content).toString("utf8")) as Record<string, unknown>;
  const researchReportArtifacts = Array.isArray(value.researchReportArtifacts)
    ? value.researchReportArtifacts.map((artifact, index) =>
        parseArtifactRef(artifact, `publication plan researchReportArtifacts[${index}]`)
      )
    : [];
  if (!isRecord(value.plan)) throw new Error("publication plan artifact has no plan");
  return {
    plan: value.plan as unknown as DocumentationStagePlan,
    researchPlanArtifact: parseArtifactRef(value.researchPlanArtifact, "publication plan researchPlanArtifact"),
    researchReportArtifacts,
    snapshotArtifact: parseArtifactRef(value.snapshotArtifact, "publication plan snapshotArtifact"),
    ...(value.priorRelease === undefined ? {} : { priorRelease: parseContextPriorReleaseSeed(value.priorRelease) })
  };
}

function parseContextPageArtifact(content: Uint8Array): ContextPageArtifact {
  const value = JSON.parse(Buffer.from(content).toString("utf8")) as Record<string, unknown>;
  return {
    documentPath: requiredString(value.documentPath, "context page documentPath"),
    title: requiredString(value.title, "context page title"),
    bodyMarkdown: canonicalPublicPageMarkdown(requiredString(value.bodyMarkdown, "context page bodyMarkdown")),
    publicationPlanArtifact: parseArtifactRef(value.publicationPlanArtifact, "context page publicationPlanArtifact"),
    snapshotArtifact: parseArtifactRef(value.snapshotArtifact, "context page snapshotArtifact"),
    ...(value.repairCheckpoint === undefined
      ? {}
      : { repairCheckpoint: parsePageRepairCheckpointDiagnostics(value.repairCheckpoint) }),
    ...(value.findingsArtifact === undefined
      ? {}
      : { findingsArtifact: parseArtifactRef(value.findingsArtifact, "context page findingsArtifact") })
  };
}

function parsePageRepairCheckpointDiagnostics(value: unknown): PageRepairCheckpointDiagnostics {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.regressionProblems)) {
    throw new Error("context page repair checkpoint is invalid");
  }
  return {
    version: 1,
    consecutiveNoProgressPasses: requiredPositiveInteger(
      value.consecutiveNoProgressPasses,
      "context page repair checkpoint consecutiveNoProgressPasses"
    ),
    attemptedBodyDigest: requiredDigest(
      value.attemptedBodyDigest,
      "context page repair checkpoint attemptedBodyDigest"
    ),
    regressionProblems: value.regressionProblems.map((problem, index) =>
      requiredString(problem, `context page repair checkpoint regressionProblems[${index}]`)
    )
  };
}

function parseContextDraftArtifact(content: Uint8Array): ContextDraftArtifact {
  const value = JSON.parse(Buffer.from(content).toString("utf8")) as Record<string, unknown>;
  if (!Array.isArray(value.pages) || value.pages.length === 0 || value.pages.length > 96) {
    throw new Error("context draft has an invalid page manifest");
  }
  if (!isRecord(value.citationAuditInput) || !Array.isArray(value.citationAuditInput.references)) {
    throw new Error("context draft has no citation audit input");
  }
  const citationAuditInput = {
    inputDigest: requiredDigest(value.citationAuditInput.inputDigest, "context draft citationAuditInput.inputDigest"),
    publicSnapshotDigest: requiredDigest(
      value.citationAuditInput.publicSnapshotDigest,
      "context draft citationAuditInput.publicSnapshotDigest"
    ),
    references: value.citationAuditInput.references as CitationAuditReference[]
  };
  const citationAudit = parseCitationAuditStageResult(value.citationAudit, {
    workerId: requiredString(
      isRecord(value.citationAudit) && isRecord(value.citationAudit.worker) ? value.citationAudit.worker.id : undefined,
      "context draft citation audit worker"
    ),
    inputDigest: citationAuditInput.inputDigest,
    publicSnapshotDigest: citationAuditInput.publicSnapshotDigest,
    citationIds: citationAuditInput.references.map((reference) =>
      requiredString(reference.citationId, "context draft citation ID")
    )
  });
  const citationAuditDigest = requiredDigest(value.citationAuditDigest, "context draft citationAuditDigest");
  if (createHash("sha256").update(JSON.stringify(citationAudit)).digest("hex") !== citationAuditDigest) {
    throw new Error("context draft citation audit digest mismatch");
  }
  return {
    pages: value.pages.map((page, index) => {
      if (!isRecord(page)) throw new Error(`context draft page ${index} is invalid`);
      return {
        documentPath: requiredString(page.documentPath, `context draft pages[${index}].documentPath`),
        title: requiredString(page.title, `context draft pages[${index}].title`),
        bodyMarkdown: canonicalPublicPageMarkdown(
          requiredString(page.bodyMarkdown, `context draft pages[${index}].bodyMarkdown`)
        ),
        publicationPlanArtifact: parseArtifactRef(
          page.publicationPlanArtifact,
          `context draft pages[${index}].publicationPlanArtifact`
        ),
        snapshotArtifact: parseArtifactRef(page.snapshotArtifact, `context draft pages[${index}].snapshotArtifact`)
      };
    }),
    publicationPlanArtifact: parseArtifactRef(value.publicationPlanArtifact, "context draft publicationPlanArtifact"),
    snapshotArtifact: parseArtifactRef(value.snapshotArtifact, "context draft snapshotArtifact"),
    citationAuditInput,
    citationAudit,
    citationAuditDigest
  };
}

function parseContextPageAuditArtifact(content: Uint8Array): ContextPageAuditArtifact {
  const value = JSON.parse(Buffer.from(content).toString("utf8")) as Record<string, unknown>;
  if (!Array.isArray(value.references) || !Array.isArray(value.structuralProblems)) {
    throw new Error("context page audit artifact is incomplete");
  }
  return {
    pageArtifact: parseArtifactRef(value.pageArtifact, "page audit pageArtifact"),
    snapshotArtifact: parseArtifactRef(value.snapshotArtifact, "page audit snapshotArtifact"),
    publicSnapshotDigest: requiredDigest(value.publicSnapshotDigest, "page audit publicSnapshotDigest"),
    inputDigest: requiredDigest(value.inputDigest, "page audit inputDigest"),
    references: value.references as ContextPageAuditArtifact["references"],
    structuralProblems: value.structuralProblems.map((problem, index) =>
      requiredString(problem, `page audit structuralProblems[${index}]`)
    ),
    ...(isRecord(value.audit) ? { audit: value.audit as unknown as CitationAuditStageResult } : {})
  };
}

function latestDependencyArtifact(
  dependencies: readonly ContextBoardDependencyResult[],
  taskTypes: readonly string[],
  stage: string,
  page?: { readonly pageTaskId: string; readonly documentPath: string }
): ContextArtifactRef {
  for (const taskType of taskTypes) {
    const match = dependencies
      .filter(
        (dependency) =>
          dependency.taskType === taskType &&
          (!page || (dependency.pageTaskId === page.pageTaskId && dependency.documentPath === page.documentPath))
      )
      .sort((left, right) => (right.pass ?? -1) - (left.pass ?? -1))[0];
    if (match) return match.result.outputArtifact;
  }
  throw new Error(`${stage} has no matching artifact dependency`);
}

function citationReferenceBatches(
  references: ReturnType<typeof boardPageAuditInventory>["references"]
): ReturnType<typeof boardPageAuditInventory>["references"][] {
  const batches: ReturnType<typeof boardPageAuditInventory>["references"][] = [];
  let batch: ReturnType<typeof boardPageAuditInventory>["references"][number][] = [];
  for (const group of citationAuditReferenceGroups(references)) {
    if (group.length > 60) {
      throw new Error(`citation audit claim has ${group.length} references; per-stage maximum is 60`);
    }
    if (batch.length > 0 && batch.length + group.length > 60) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function assertOnlyContextPage(outputDirectory: string, expectedPath: string): Promise<void> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(outputDirectory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`page task emitted a symbolic link: ${child}`);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) throw new Error(`page task emitted an internal directory: ${child}`);
        await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      } else {
        throw new Error(`page task emitted an unsupported artifact: ${child}`);
      }
    }
  };
  await walk("");
  if (files.length !== 1 || files[0] !== expectedPath) {
    throw new Error(
      `page task must emit only ${expectedPath}; observed ${files.length > 0 ? files.join(", ") : "no files"}`
    );
  }
}

async function contextMarkdownPaths(outputDirectory: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(outputDirectory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`context repair emitted a symbolic link: ${child}`);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) throw new Error(`context repair emitted an internal directory: ${child}`);
        await walk(child);
      } else if (entry.isFile()) {
        if (!/^(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\.md$/.test(child)) {
          throw new Error(`context repair emitted a non-public file: ${child}`);
        }
        files.push(child);
      } else {
        throw new Error(`context repair emitted an unsupported artifact: ${child}`);
      }
    }
  };
  await walk("");
  return files.sort();
}

function markdownTitle(bodyMarkdown: string, documentPath: string): string {
  const headings = bodyMarkdown.match(/^#\s+(.+)$/gm) ?? [];
  if (headings.length !== 1) throw new Error(`${documentPath} must contain exactly one H1`);
  return headings[0].replace(/^#\s+/, "").trim();
}

function safeStageId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page"
  );
}

function pageArtifactName(documentPath: string): string {
  return `${safeStageId(documentPath).slice(0, 160)}.json`;
}

function requireBoardAgentStageRunner(): PortableContextBoardAgentStageRunner {
  if (!boardAgentStageRunner) throw new Error("board agent stage runner is not configured for this worker");
  return boardAgentStageRunner;
}

function stageBudgetSeconds(environmentName: string, fallback: number): number {
  const configured = positiveInt(process.env[environmentName], fallback);
  const deadline =
    activeWork && isContextTopic(activeWork.topic)
      ? (activeWork.task.metadata as ContextBoardWorkerMetadata).derivationDeadlineAt
      : undefined;
  if (!deadline) return configured;
  const remainingSeconds = Math.floor((Date.parse(deadline) - Date.now()) / 1_000);
  if (!Number.isSafeInteger(remainingSeconds) || remainingSeconds < 1) {
    throw new Error("Context build derivation deadline exceeded");
  }
  return Math.min(configured, remainingSeconds);
}

function parseEvidenceSnapshot(content: Uint8Array, metadata: RepositoryContextMetadata): IngestEvidenceInput {
  const value = JSON.parse(Buffer.from(content).toString("utf8")) as IngestEvidenceInput;
  if (
    value.tenantId !== metadata.tenantId ||
    value.repository !== metadata.repository ||
    value.ref !== metadata.ref ||
    value.refSequence !== metadata.refSequence ||
    !/^[0-9a-f]{40}$/.test(value.commitSha) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.observations)
  ) {
    throw new Error("evidence snapshot does not match the leased board build");
  }
  return value;
}

function parseResearchPlanArtifact(content: Uint8Array): {
  readonly plan: ResearchStagePlan;
  readonly snapshotArtifact: ContextArtifactRef;
} {
  const value = JSON.parse(Buffer.from(content).toString("utf8")) as Record<string, unknown>;
  return {
    plan: parseResearchStagePlan(value.plan),
    snapshotArtifact: parseArtifactRef(value.snapshotArtifact, "research plan snapshotArtifact")
  };
}

function parseResearchReportArtifact(content: Uint8Array): {
  readonly assignmentId: string;
  readonly report: string;
} {
  const value = JSON.parse(Buffer.from(content).toString("utf8")) as Record<string, unknown>;
  return {
    assignmentId: requiredString(value.assignmentId, "research report assignmentId"),
    report: requiredString(value.report, "research report")
  };
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
    const pullRequestRef = /^pull\/([1-9][0-9]*)\/head$/.exec(ref);
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
        ...(pullRequestRef ? [] : ["--branch", ref]),
        `https://github.com/${repository}.git`,
        directory
      ],
      { env: environment, maxBuffer: 10 * 1024 * 1024 }
    );
    const remoteSource = pullRequestRef ? `refs/pull/${pullRequestRef[1]}/head` : `refs/heads/${ref}`;
    await execFileAsync("git", ["fetch", "origin", `+${remoteSource}:refs/remotes/origin/${ref}`], {
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
  const repositoryPayload = sanitizeGitHubRepositoryPayload(metadata);
  const observations: ProviderObservationInput[] = [
    {
      sourceType: "observation",
      sourceId: `github:repository:${repository}:${commitSha}`,
      title: repository,
      payload: repositoryPayload,
      ...(typeof repositoryPayload.html_url === "string" ? { pathOrUrl: repositoryPayload.html_url } : {}),
      observedAt,
      metadata: { provider: "github", kind: "repository" }
    }
  ];
  for (const pullRequest of pullRequests.values) {
    const number = Number(pullRequest.number);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const payload = sanitizeGitHubPullRequestPayload(pullRequest);
    const pathOrUrl = stringValue(payload.html_url);
    observations.push({
      sourceType: "pull_request",
      sourceId: `github:pull_request:${repository}#${number}`,
      title: stringValue(pullRequest.title) || `Pull request #${number}`,
      payload,
      ...(pathOrUrl ? { pathOrUrl } : {}),
      observedAt: stringValue(pullRequest.updated_at) || observedAt,
      metadata: { provider: "github", number }
    });
  }
  for (const issue of issues.values) {
    if (issue.pull_request) continue;
    const number = Number(issue.number);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const payload = sanitizeGitHubIssuePayload(issue);
    const pathOrUrl = stringValue(payload.html_url);
    observations.push({
      sourceType: "issue",
      sourceId: `github:issue:${repository}#${number}`,
      title: stringValue(issue.title) || `Issue #${number}`,
      payload,
      ...(pathOrUrl ? { pathOrUrl } : {}),
      observedAt: stringValue(issue.updated_at) || observedAt,
      metadata: { provider: "github", number }
    });
  }
  for (const comment of issueComments.values) {
    const id = Number(comment.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const payload = sanitizeGitHubIssueCommentPayload(comment);
    const pathOrUrl = stringValue(payload.html_url);
    observations.push({
      sourceType: "observation",
      sourceId: `github:issue_comment:${repository}:${id}`,
      title: `GitHub issue discussion comment ${id}`,
      payload,
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
    const payload = sanitizeGitHubReviewCommentPayload(comment);
    const pathOrUrl = stringValue(payload.html_url);
    observations.push({
      sourceType: "observation",
      sourceId: `github:pull_request_review_comment:${repository}:${id}`,
      title: `GitHub pull request review comment ${id}`,
      payload,
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
    const payload = sanitizeGitHubCommitCommentPayload(comment);
    const pathOrUrl = stringValue(payload.html_url);
    observations.push({
      sourceType: "observation",
      sourceId: `github:commit_comment:${repository}:${id}`,
      title: `GitHub commit discussion comment ${id}`,
      payload,
      ...(pathOrUrl ? { pathOrUrl } : {}),
      observedAt: stringValue(comment.updated_at) || stringValue(comment.created_at) || observedAt,
      metadata: {
        provider: "github",
        kind: "commit_comment",
        ...(stringValue(comment.commit_id) ? { commitSha: stringValue(comment.commit_id) } : {})
      }
    });
  }
  assertNoGitHubOperationalCredentials(observations.map((observation) => observation.payload));
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
  const modelUsage =
    CONTEXT_MODEL_TOPICS.has(work.topic) && activeModelUsage
      ? boardAgentModelUsageForCompletion({
          outcome: result.outcome,
          observed: activeModelUsageObserved,
          usage: activeModelUsage
        })
      : undefined;
  if (result.outcome === "done" && CONTEXT_MODEL_TOPICS.has(work.topic) && !modelUsage) {
    throw new Error("model-backed task completed without an exact usage accumulator");
  }
  const response = await apiRequest(
    "/internal/worker/complete",
    {
      messageId: work.message.id,
      leaseId: work.message.leaseId,
      taskId: work.task.id,
      ...(work.message.attempt === undefined ? {} : { attempt: work.message.attempt }),
      ...(work.message.writeFenceToken === undefined ? {} : { writeFenceToken: work.message.writeFenceToken }),
      ...(modelUsage ? { modelUsage } : {}),
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
  const requestBody =
    workerRelease && path.startsWith("/internal/worker/") && isRecord(body)
      ? { ...body, ...workerReleaseRequestBody(workerRelease) }
      : body;
  return fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(tenantId ? { "x-jina-tenant-id": tenantId } : {})
    },
    body: JSON.stringify(requestBody),
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

function parseClaimedWork(value: unknown): ClaimedWork {
  if (!isRecord(value) || !isRecord(value.message) || !isRecord(value.task) || !isRecord(value.task.metadata)) {
    throw new Error("claim response must include message, task, and task metadata");
  }
  const topicValue = requiredString(value.message.topic, "claim message topic");
  if (!SUPPORTED_WORKER_TOPICS.includes(topicValue as WorkerTopic)) {
    throw new Error(`unsupported claimed topic ${topicValue}`);
  }
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
  if (isContextTopic(topic)) {
    const common = repositoryMetadata(metadata);
    const contextMetadata = {
      ...common,
      ...(metadata.commitSha === undefined ? {} : { commitSha: requiredGitSha(metadata.commitSha, "task commitSha") }),
      ...contextBoardMetadata(metadata, topic)
    };
    return {
      topic,
      message: { ...message, topic },
      task: { id: taskId, metadata: contextMetadata }
    } as ClaimedWork;
  }
  throw new Error("unsupported claimed topic");
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
  return CONTEXT_BOARD_TOPICS.includes(topic as (typeof CONTEXT_BOARD_TOPICS)[number]);
}

function contextBoardMetadata(
  metadata: Record<string, unknown>,
  topic: (typeof CONTEXT_BOARD_TOPICS)[number]
): Omit<ContextBoardWorkerMetadata, keyof RepositoryContextMetadata> {
  const dependencyResults = parseContextBoardDependencyResults(metadata.dependencyResults);
  const base = {
    contextBuildId: requiredString(metadata.contextBuildId, "task contextBuildId"),
    dependencyResults,
    ...(metadata.derivationDeadlineAt === undefined
      ? {}
      : { derivationDeadlineAt: requiredIsoTimestamp(metadata.derivationDeadlineAt, "task derivationDeadlineAt") }),
    ...(metadata.priorRelease === undefined
      ? {}
      : { priorRelease: parseContextPriorReleaseSeed(metadata.priorRelease) })
  };
  switch (topic) {
    case "run-context-input-snapshot":
      return base;
    case "run-context-research-plan":
      return {
        ...base,
        inputArtifact: parseArtifactRef(metadata.inputArtifact, "task inputArtifact")
      };
    case "run-context-research":
      return {
        ...base,
        workKey: requiredString(metadata.workKey, "task workKey"),
        planArtifact: parseArtifactRef(metadata.planArtifact, "task planArtifact"),
        inputArtifact: parseArtifactRef(metadata.inputArtifact, "task inputArtifact")
      };
    case "run-context-publication-plan":
      return {
        ...base,
        planArtifact: parseArtifactRef(metadata.planArtifact, "task planArtifact")
      };
    case "run-context-page-write":
      return {
        ...base,
        pageTaskId: requiredString(metadata.pageTaskId, "task pageTaskId"),
        pageKey: requiredString(metadata.pageKey, "task pageKey"),
        documentPath: requiredString(metadata.documentPath, "task documentPath"),
        pass: requiredNonNegativeInteger(metadata.pass, "task pass"),
        pageChange: requiredPageChange(metadata.pageChange),
        planArtifact: parseArtifactRef(metadata.planArtifact, "task planArtifact"),
        inputArtifact: parseArtifactRef(metadata.inputArtifact, "task inputArtifact")
      };
    case "run-context-page-audit":
      return {
        ...base,
        pageTaskId: requiredString(metadata.pageTaskId, "task pageTaskId"),
        pageKey: requiredString(metadata.pageKey, "task pageKey"),
        documentPath: requiredString(metadata.documentPath, "task documentPath"),
        pass: requiredNonNegativeInteger(metadata.pass, "task pass")
      };
    case "run-context-page-repair":
      return {
        ...base,
        pageTaskId: requiredString(metadata.pageTaskId, "task pageTaskId"),
        documentPath: requiredString(metadata.documentPath, "task documentPath"),
        pass: requiredNonNegativeInteger(metadata.pass, "task pass"),
        findingsArtifact: parseArtifactRef(metadata.findingsArtifact, "task findingsArtifact")
      };
    case "run-context-source-challenge":
    case "run-context-task-evaluation":
    case "run-context-gap-repair":
      return {
        ...base,
        planArtifact: parseArtifactRef(metadata.planArtifact, "task planArtifact"),
        pass: requiredNonNegativeInteger(metadata.pass, "task pass")
      };
    case "run-context-certification":
    case "run-context-publication":
    case "run-context-pageindex":
      return {
        ...base,
        planArtifact: parseArtifactRef(metadata.planArtifact, "task planArtifact")
      };
  }
}

function scheduleBuildDeadline(work: ClaimedWork, controller: AbortController): NodeJS.Timeout | undefined {
  if (!isContextTopic(work.topic)) return undefined;
  const deadline = (work.task.metadata as ContextBoardWorkerMetadata).derivationDeadlineAt;
  if (!deadline) return undefined;
  const remainingMs = Date.parse(deadline) - Date.now();
  const abort = () => controller.abort(new Error("Context build derivation deadline exceeded"));
  if (remainingMs <= 0) {
    queueMicrotask(abort);
    return undefined;
  }
  const timer = setTimeout(abort, remainingMs);
  timer.unref();
  return timer;
}

function requiredIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function parseContextBoardDependencyResults(value: unknown): ContextBoardDependencyResult[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("task dependencyResults must be an array with at most 256 entries");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.result) || entry.result.version !== 1) {
      throw new Error(`task dependencyResults[${index}] is invalid`);
    }
    return {
      taskId: requiredString(entry.taskId, `task dependencyResults[${index}].taskId`),
      taskType: requiredString(entry.taskType, `task dependencyResults[${index}].taskType`),
      ...(entry.pass === undefined
        ? {}
        : { pass: requiredNonNegativeInteger(entry.pass, `task dependencyResults[${index}].pass`) }),
      ...(entry.pageTaskId === undefined
        ? {}
        : { pageTaskId: requiredString(entry.pageTaskId, `task dependencyResults[${index}].pageTaskId`) }),
      ...(entry.documentPath === undefined
        ? {}
        : { documentPath: requiredString(entry.documentPath, `task dependencyResults[${index}].documentPath`) }),
      result: {
        version: 1,
        outputArtifact: parseArtifactRef(
          entry.result.outputArtifact,
          `task dependencyResults[${index}].result.outputArtifact`
        )
      }
    };
  });
}

function parseArtifactRef(value: unknown, name: string): ContextArtifactRef {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  const bytes = Number(value.bytes);
  const sha256 = requiredString(value.sha256, `${name}.sha256`);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${name} has invalid size or digest`);
  }
  return {
    uri: requiredString(value.uri, `${name}.uri`),
    key: requiredString(value.key, `${name}.key`),
    contentType: requiredString(value.contentType, `${name}.contentType`),
    bytes,
    sha256,
    ...(value.objectGeneration === undefined
      ? {}
      : { objectGeneration: requiredString(value.objectGeneration, `${name}.objectGeneration`) })
  };
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

function recordClaimBackpressure(): void {
  recordApiSuccess();
  metrics.count("worker.claim_backpressure", { reason: "context_quota_exceeded" });
  const now = Date.now();
  if (now - lastClaimBackpressureLogAt < claimBackpressureLogIntervalMs) return;
  lastClaimBackpressureLogAt = now;
  logger.warn("worker claim deferred by tenant Context quota", {
    event: "worker.claim_backpressure",
    workerId,
    reason: "context_quota_exceeded"
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function configuredWorkerReleaseIdentity(): WorkerReleaseIdentity | undefined {
  const releaseId = process.env.JINA_WORKER_RELEASE_ID?.trim();
  const credential = process.env.JINA_WORKER_RELEASE_CREDENTIAL?.trim();
  const service = process.env.K_SERVICE?.trim();
  const revision = process.env.K_REVISION?.trim();
  if (!releaseId && !credential) return undefined;
  if (!releaseId || !credential || !service || !revision) {
    throw new Error(
      "JINA_WORKER_RELEASE_ID, JINA_WORKER_RELEASE_CREDENTIAL, K_SERVICE, and K_REVISION must be configured together"
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(releaseId)) {
    throw new Error("JINA_WORKER_RELEASE_ID is invalid");
  }
  if (credential.length < 32 || credential.length > 512) {
    throw new Error("JINA_WORKER_RELEASE_CREDENTIAL must contain 32..512 characters");
  }
  if (service !== "jina-context-worker" && service !== "jina-task-worker") {
    throw new Error("K_SERVICE is not a production worker service");
  }
  if (!revision.startsWith(`${service}-`)) {
    throw new Error("K_REVISION does not belong to K_SERVICE");
  }
  return { releaseId, credential, service, revision };
}

function workerReleaseRequestBody(identity: WorkerReleaseIdentity): Record<string, string> {
  return {
    workerReleaseId: identity.releaseId,
    workerReleaseCredential: identity.credential,
    workerService: identity.service,
    workerRevision: identity.revision
  };
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

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function requiredPageChange(value: unknown): ContextPageChange {
  const change = requiredString(value, "task pageChange");
  if (!["add", "retain", "revise"].includes(change)) {
    throw new Error("task pageChange must be add, retain, or revise");
  }
  return change as ContextPageChange;
}

function samePriorReleaseSeed(left: ContextPriorReleaseSeed, right: ContextPriorReleaseSeed): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.repository === right.repository &&
    left.ref === right.ref &&
    left.refSequence === right.refSequence &&
    left.commitSha === right.commitSha &&
    left.releaseId === right.releaseId &&
    left.publicSnapshotDigest === right.publicSnapshotDigest &&
    left.releaseArtifact.uri === right.releaseArtifact.uri &&
    left.releaseArtifact.key === right.releaseArtifact.key &&
    left.releaseArtifact.contentType === right.releaseArtifact.contentType &&
    left.releaseArtifact.bytes === right.releaseArtifact.bytes &&
    left.releaseArtifact.sha256 === right.releaseArtifact.sha256 &&
    left.releaseArtifact.objectGeneration === right.releaseArtifact.objectGeneration
  );
}

function requiredDigest(value: unknown, name: string): string {
  const digest = requiredString(value, name);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${name} must be a SHA-256 digest`);
  return digest;
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

function boardMaxAttempts(value: string | undefined): number {
  if (value === undefined || !value.trim()) return 4;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4) {
    throw new Error("CONTEXT_BOARD_MAX_ATTEMPTS must be an integer between 1 and 4");
  }
  return parsed;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function boundedFailureDetail(response: Response, secrets: readonly string[] = []): Promise<string> {
  let detail = (await response.text().catch(() => "unreadable body")).slice(0, 500);
  for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, "[REDACTED]");
  return detail;
}

function failureCode(detail: string): string | undefined {
  try {
    const value: unknown = JSON.parse(detail);
    return isRecord(value) && typeof value.code === "string" ? value.code : undefined;
  } catch {
    return undefined;
  }
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

async function releaseContextLease(work: ClaimedWork, reason: string): Promise<void> {
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
      taskId: work.task.id,
      leaseId: work.message.leaseId,
      ...(work.message.attempt === undefined ? {} : { attempt: work.message.attempt }),
      ...(work.message.writeFenceToken === undefined ? {} : { writeFenceToken: work.message.writeFenceToken }),
      reason: reason.slice(0, 2_000),
      ...(workerRelease ? workerReleaseRequestBody(workerRelease) : {})
    }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`lease release failed with ${response.status}: ${await boundedFailureDetail(response)}`);
  }
}

function releaseContextLeaseOnce(work: ClaimedWork, lease: LeaseExecutionState, reason: string): Promise<void> {
  lease.releasePromise ??= releaseContextLease(work, reason);
  return lease.releasePromise;
}

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    stopping = true;
    const work = activeWork;
    const lease = activeLease;
    if (lease) loseLease(lease, new LeaseLostError(`worker received ${signal}`));
    if (work && lease) {
      await releaseContextLeaseOnce(work, lease, "worker shutdown").catch((error) => {
        logger.error("worker lease release failed", {
          event: "worker.lease_release_failed",
          workerId,
          taskId: work.task.id,
          ...errorLogFields(error)
        });
      });
    }
    await pollPromise;
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
