import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  DOCUMENTATION_STAGE_SCHEMA,
  CITATION_AUDIT_STAGE_SCHEMA,
  RESEARCH_STAGE_SCHEMA,
  boardPageAuditInventory,
  boardPublicPageDigest,
  citationAuditReferenceGroups,
  citationAuditRepairPrompt,
  citationAuditStagePrompt,
  documentationWriterPrompt,
  documentationPlannerPrompt,
  documentationPlannerRepairPrompt,
  parseCitationAuditStageResult,
  parseResearchStagePlan,
  researchPlannerRepairPrompt,
  researchPlannerPrompt,
  researchWorkerPrompt,
  type BoardAgentModelUsage,
  type CitationAuditStageResult,
  type CitationAuditReference,
  type DocumentationStagePlan,
  type ResearchStagePlan
} from "@jina/daytona";
import { createGitHubInstallationAccessToken } from "@jina/github";
import {
  activeTraceparent,
  createLogger,
  errorLogFields,
  generateTraceContext,
  MetricsRegistry,
  setOpenTelemetrySpanOutcome,
  startOpenTelemetry,
  withOpenTelemetrySpan
} from "@jina/observability";
import {
  createInstallationAccessToken,
  parseRepository,
  reviewProgressUpdateForStageResults,
  runReviewRuntimeStage,
  runReviewSummaryStage,
  safeUpsertReviewProgressComment,
  type ReviewPayload,
  type ReviewStagePayload,
  type ReviewStageResult,
  type ReviewSuperseded,
  type UsageRecordsFallback
} from "@jina/review-agent";
import type {
  ContextArtifactKind,
  ContextArtifactRef,
  GitChange,
  GitSnapshotMetadata,
  IngestEvidenceInput,
  ProviderObservationInput,
  IssueHistoryCommit
} from "@jina/context-engine";
import {
  LocalPageIndexClient,
  MAX_CONTEXT_REPAIR_PASS,
  CONTEXT_WORKFLOW_CONTRACT,
  CONTEXT_WORKFLOW_SCHEMA_REVISION,
  assertContextPriorReleaseMatches,
  boardWorkArtifactKindForTopic as existingBoardWorkArtifactKindForTopic,
  contextWorkflowBoardArtifactKindForTopic,
  contextPriorReleaseCatalog,
  contextArtifactKey,
  parseBoardPageIndexTreeArtifact,
  parseCertifiedContextReleaseArtifact,
  parseContextPriorReleaseSeed,
  repositoryAclFingerprint,
  repositoryContextAreas,
  deriveIssueCandidateLedger,
  materializeIssueGraph,
  minimumDerivedIssueCount,
  unlinkMarkdownDocumentTargets,
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
import { ISSUE_GRAPH_STAGE_SCHEMA, issueGraphPrompt } from "./causal-graph-derivation.js";
import { canonicalCausalGraphCommitTimestamp } from "./causal-graph-history.js";
import {
  bindCitationAuditHostIdentity,
  citationAuditDelta,
  retainAssignedCitationAuditResults,
  retryCitationAuditValidation
} from "./citation-audit-validation.js";
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
  pagePlanContentProblems,
  pagePlanStructuralProblems,
  pageRepairCoveragePrompt,
  pageRepairNoProgressProblems,
  pageRepairRegressionProblems,
  pageRepairScopeRegressionProblems,
  retainedPageRepairCheckpoint
} from "./board-page-repair.js";
import type { PageRepairCheckpointDiagnostics } from "./board-page-repair.js";
import {
  parseBoardPublicationPlan,
  parsePublicationPlanWithRepair,
  promoteUnsafeRetainedPages,
  retainedPublicationPlanProblems
} from "./board-publication-plan.js";
import { parseBoardResearchPlan, parseResearchPlanWithRepair } from "./board-research-plan.js";
import { parsedContextDependencyResult } from "./context-dependency-result.js";
import { contextPageArtifactName } from "./context-page-artifact-name.js";
import { contextPagePublicationDisposition, resolveContextPageOmission } from "./context-page-disposition.js";
import { shouldRetryWorkerFailure, workerFailureCategory, type WorkerFailureCategory } from "./diagnostics.js";
import { assertExpectedRemoteHead } from "./git-ref.js";
import { parseGitTreeEntries } from "./git-tree.js";
import { contextPhaseCandidateArtifact } from "./phase-checkpoint-artifact.js";
import {
  LEGACY_REVIEW_FINDINGS_SCHEMA,
  LEGACY_REVIEW_SYSTEM_PROMPT,
  legacyReviewPrompt,
  parseLegacyReviewOutput,
  prepareLegacyReviewDiff,
  type LegacyReviewRequest
} from "./legacy-review-contract.js";
import { runtimeWorkerId } from "./worker-identity.js";
import { GcsReviewArtifactStore, decodeReviewTaskResult, encodeReviewTaskResult } from "./review-artifacts.js";
import {
  REVIEW_TRIGGER_EFFECT_TYPE,
  REVIEW_TRIGGER_EFFECT_VERSION,
  REVIEW_TRIGGER_PROVIDER,
  compactCompletedReviewResult,
  createTriggerReviewClient,
  matchingReviewTriggerReceipt,
  parseRelationalReviewTaskMetadata,
  reviewTriggerEffectIdempotencyKey,
  triggerReviewPollIntervalMs,
  triggerReviewRunStatusKind,
  triggerRunDiagnostic,
  type RelationalReviewTaskMetadata,
  type TriggerReviewClient,
  type TriggerReviewEffectReceipt,
  type TriggerReviewRun
} from "./trigger-review-bridge.js";
import {
  CONTEXT_BOARD_TOPICS,
  CONTROL_BOARD_TOPICS,
  CAUSAL_GRAPH_TOPICS,
  REVIEW_BOARD_TOPICS,
  SUPPORTED_WORKER_TOPICS,
  configuredWorkerClaimMode,
  configuredReviewRunTopicMode,
  configuredWorkerPreferredRepository,
  configuredWorkerTopics,
  requiresBoardAgentExecutor,
  workerClaimTimeoutMs,
  type ContextWorkerTopic,
  type EmbeddedContextStageTopic,
  type ControlBoardWorkerTopic,
  type CausalGraphWorkerTopic,
  type ReviewBoardWorkerTopic,
  type SupportedWorkerTopic
} from "./worker-topics.js";

const execFileAsync = promisify(execFile);
const BOARD_MODEL_TOPICS = new Set<ExecutableWorkerTopic>([
  "run-context-page-plan",
  "run-context-page-build",
  "run-causal-graph-derive"
]);

function boardWorkArtifactKindForTopic(
  topic: ContextWorkerTopic | EmbeddedContextStageTopic | CausalGraphWorkerTopic
): ContextArtifactKind {
  if (CONTEXT_BOARD_TOPICS.includes(topic as ContextWorkerTopic)) {
    return contextWorkflowBoardArtifactKindForTopic(topic as ContextWorkerTopic);
  }
  return existingBoardWorkArtifactKindForTopic(topic as Parameters<typeof existingBoardWorkArtifactKindForTopic>[0]);
}

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
    readonly disposition?: unknown;
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
  readonly subjectId?: string;
  readonly briefArtifact?: ContextArtifactRef;
  readonly pageOperation?: "add" | "retain" | "revise" | "retire";
}

interface ReviewBoardDependencyResult {
  readonly taskId: string;
  readonly taskType: ReviewBoardWorkerTopic;
  readonly status: string;
  readonly resultArtifact?: Record<string, unknown>;
  readonly resultDigest?: string;
}

interface ReviewBoardWorkerMetadata {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly workflowType: "pr_review";
  readonly pipelineVersion: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly reviewRunId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly reviewPayload: ReviewPayload;
  readonly workflowMetadata: Record<string, unknown>;
  readonly dependencyResults: readonly ReviewBoardDependencyResult[];
}

interface InstallationBackfillWorkerMetadata {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly workflowType: "github_installation_backfill";
  readonly pipelineVersion: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly payload: Record<string, unknown>;
}

interface BillingRetryWorkerMetadata {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly workflowType: "billing_retry";
  readonly pipelineVersion: string;
  readonly traceId: string;
  readonly spanId: string;
}

interface WorkMetadataByTopic {
  readonly "run-review": LegacyReviewWorkerMetadata | RelationalReviewTaskMetadata;
  readonly "prepare-review": ReviewBoardWorkerMetadata;
  readonly "summary-review": ReviewBoardWorkerMetadata;
  readonly "runtime-review": ReviewBoardWorkerMetadata;
  readonly "finalize-review": ReviewBoardWorkerMetadata;
  readonly "publish-review": ReviewBoardWorkerMetadata;
  readonly "settle-review": ReviewBoardWorkerMetadata;
  readonly "github-installation-backfill": InstallationBackfillWorkerMetadata;
  readonly "billing-retry": BillingRetryWorkerMetadata;
  readonly "run-context-input-snapshot": ContextBoardWorkerMetadata;
  readonly "run-context-page-plan": ContextBoardWorkerMetadata & {
    readonly inputArtifact: ContextArtifactRef;
  };
  readonly "run-context-page-build": ContextBoardWorkerMetadata & {
    readonly subjectId: string;
    readonly documentPath: string;
    readonly planArtifact: ContextArtifactRef;
    readonly briefArtifact: ContextArtifactRef;
    readonly pageOperation: "add" | "revise";
  };
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
  readonly "run-context-publication": ContextBoardWorkerMetadata & {
    readonly planArtifact: ContextArtifactRef;
  };
  readonly "run-causal-graph-history": ContextBoardWorkerMetadata;
  readonly "run-causal-graph-derive": ContextBoardWorkerMetadata;
  readonly "run-causal-graph-publication": ContextBoardWorkerMetadata;
}

interface LegacyReviewWorkerMetadata {
  readonly tenantId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
}

type ExecutableWorkerTopic = SupportedWorkerTopic | EmbeddedContextStageTopic;

type ClaimedWork<T extends ExecutableWorkerTopic = ExecutableWorkerTopic> = T extends ExecutableWorkerTopic
  ? {
      readonly topic: T;
      readonly message: {
        readonly id: string;
        readonly topic: T;
        readonly leaseId: string;
        readonly leaseExpiresAt: string;
        readonly attempt?: number;
        readonly maxAttempts?: number;
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
    }
  | {
      readonly outcome: "waiting_external";
      readonly operation: "provider_handoff" | "reschedule";
      readonly transitionId: string;
      readonly effectIdempotencyKey: string;
      readonly providerId: string;
      readonly providerStatus?: string;
      readonly nextCheckAt: string;
      readonly requestDigest?: string;
      readonly resultDigest?: string;
    }
  | {
      readonly outcome: "effect_retry";
      readonly transitionId: string;
      readonly effectIdempotencyKey: string;
      readonly effectType: string;
      readonly effectVersion: number;
      readonly provider: string;
      readonly requestDigest: string;
      readonly receiptStatus: "failed" | "ambiguous";
      readonly diagnostic: string;
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
  readonly service: "jina-context-worker" | "jina-causal-graph-worker" | "jina-task-worker";
  readonly revision: string;
}

interface WorkerRuntimeIdentity {
  readonly service: WorkerReleaseIdentity["service"];
  readonly revision: string;
}

class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseLostError";
  }
}

class ReviewEffectStartUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewEffectStartUncertainError";
  }
}

const logger = createLogger({ service: process.env.K_SERVICE ?? "jina-worker" });
const openTelemetry = startOpenTelemetry({
  serviceName: process.env.K_SERVICE ?? "jina-worker",
  ...(process.env.K_REVISION ? { serviceVersion: process.env.K_REVISION } : {}),
  ...(process.env.JINA_ENVIRONMENT ? { environment: process.env.JINA_ENVIRONMENT } : {}),
  attributes: {
    ...(process.env.K_SERVICE ? { "gcp.cloud_run.service": process.env.K_SERVICE } : {}),
    ...(process.env.K_REVISION ? { "gcp.cloud_run.revision": process.env.K_REVISION } : {})
  }
});
const metrics = new MetricsRegistry();
const port = Number(process.env.PORT ?? 8080);
const apiUrl = requiredEnv("JINA_API_URL").replace(/\/$/, "");
const productApiUrl = (process.env.JINA_PRODUCT_API_URL?.trim() || apiUrl).replace(/\/$/, "");
const token = requiredEnv("INTERNAL_API_TOKEN");
const productInternalToken = process.env.JINA_PRODUCT_INTERNAL_API_TOKEN?.trim() || token;
const reviewRunTopicMode = configuredReviewRunTopicMode(
  process.env.JINA_REVIEW_RUN_TOPIC_MODE,
  process.env.JINA_LEGACY_REVIEW_PIPELINE_ENABLED === "true"
);
const topics = configuredWorkerTopics(process.env.WORKER_TOPICS, {
  reviewRunTopicMode
});
const triggerReviewClient: TriggerReviewClient | undefined =
  reviewRunTopicMode === "relational" && topics.includes("run-review") ? createTriggerReviewClient() : undefined;
const reviewTriggerPollMs = triggerReviewPollIntervalMs(process.env.JINA_REVIEW_TRIGGER_POLL_INTERVAL_MS);
const claimMode = configuredWorkerClaimMode(process.env.JINA_WORKER_CLAIM_MODE);
const preferredRepository = configuredWorkerPreferredRepository(process.env.WORKER_PREFERRED_REPOSITORY);
const workerRuntime = configuredWorkerRuntimeIdentity();
const workerRelease = configuredWorkerReleaseIdentity();
const workerId = runtimeWorkerId({
  ...(process.env.WORKER_ID !== undefined ? { configured: process.env.WORKER_ID } : {}),
  ...(workerRelease ? { revision: workerRelease.revision } : {})
});
const pollIntervalMs = positiveInt(process.env.WORKER_POLL_INTERVAL_MS, 2_000);
const workerApiTimeoutMs = positiveInt(process.env.WORKER_API_TIMEOUT_MS, 30_000);
const contextApiTimeoutMs = positiveInt(process.env.CONTEXT_API_TIMEOUT_MS, 62 * 60_000);
const contextCompletionTimeoutMs = positiveInt(process.env.CONTEXT_COMPLETION_TIMEOUT_MS, 10 * 60_000);
const heartbeatIntervalMs = positiveInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 60_000);
const completionSendAttempts = positiveInt(process.env.WORKER_COMPLETION_SEND_ATTEMPTS, 3);
const completionRetryDelayMs = positiveInt(process.env.WORKER_COMPLETION_RETRY_DELAY_MS, 1_000);
const gitCommandTimeoutMs = positiveInt(process.env.CONTEXT_GIT_COMMAND_TIMEOUT_MS, 5 * 60_000);
const claimBackpressureLogIntervalMs = 60_000;
const contextBoardMaxAttempts = boardMaxAttempts(process.env.CONTEXT_BOARD_MAX_ATTEMPTS);
const reviewArtifactStore = process.env.JINA_REVIEW_GCS_BUCKET
  ? new GcsReviewArtifactStore(process.env.JINA_REVIEW_GCS_BUCKET, {
      ...(process.env.GOOGLE_CLOUD_PROJECT ? { projectId: process.env.GOOGLE_CLOUD_PROJECT } : {}),
      ...(process.env.GOOGLE_APPLICATION_CREDENTIALS ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS } : {})
    })
  : undefined;
const requireGithubInstallation = process.env.JINA_REQUIRE_GITHUB_INSTALLATION === "true";
const causalGraphOpenAiApiKey = process.env.CAUSAL_GRAPH_OPENAI_API_KEY?.trim();
const causalGraphOnlyWorker =
  topics.length > 0 &&
  topics.every((topic) => CAUSAL_GRAPH_TOPICS.includes(topic as (typeof CAUSAL_GRAPH_TOPICS)[number]));
if (causalGraphOpenAiApiKey && !causalGraphOnlyWorker) {
  throw new Error("CAUSAL_GRAPH_OPENAI_API_KEY is allowed only on a causal-graph-only worker");
}
const configuredBoardAgentStageRunner =
  claimMode === "enabled" && requiresBoardAgentExecutor(topics)
    ? configuredPortableContextBoardAgentStageRunner({
        protectedValues: [token, ...(causalGraphOpenAiApiKey ? [causalGraphOpenAiApiKey] : [])],
        ...(causalGraphOpenAiApiKey
          ? {
              defaultExecution: {
                credential: {
                  kind: "api-key" as const,
                  environmentVariable: "OPENAI_API_KEY",
                  value: causalGraphOpenAiApiKey
                },
                model: (process.env.CAUSAL_GRAPH_CODEX_MODEL?.trim() || "gpt-5.6-terra").replace(/^openai\//, ""),
                effort: process.env.CONTEXT_CODEX_EFFORT?.trim() || "medium",
                domains: ["api.openai.com"]
              }
            }
          : {}),
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
        if (!activeWork || !BOARD_MODEL_TOPICS.has(activeWork.topic) || !activeModelUsage) {
          throw new Error("board agent usage was produced outside an active model-backed lease");
        }
        activeModelUsage = addBoardAgentModelUsage(activeModelUsage, output.usage);
        activeModelUsageObserved = true;
        return output;
      }
    }
  : undefined;
const boardPageIndexClient =
  claimMode === "enabled" && topics.includes("run-context-publication")
    ? new LocalPageIndexClient({
        timeoutMs: positiveInt(process.env.CONTEXT_PAGEINDEX_PROCESS_TIMEOUT_MS, 5 * 60_000)
      })
    : undefined;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;
let pollPromise: Promise<void> | undefined;
let active = false;
let activeLease: LeaseExecutionState | undefined;
let activeWork: ClaimedWork<SupportedWorkerTopic> | undefined;
let activeModelUsage: BoardAgentModelUsage | undefined;
let activeModelUsageObserved = false;
let lastApiSuccessAt: string | undefined;
let hasApiError = false;
let lastApiErrorAt: string | undefined;
let consecutiveApiFailures = 0;
let lastClaimBackpressureLogAt = 0;
let lastWork:
  | {
      readonly topic: SupportedWorkerTopic;
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
          await releaseBoardLeaseOnce(work, lease, "worker shutdown").catch((error) => {
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

async function claim(): Promise<ClaimedWork<SupportedWorkerTopic> | undefined> {
  const response = await apiRequest(
    "/internal/worker/claim",
    { workerId, topics, ...(preferredRepository ? { preferredRepository } : {}) },
    workerClaimTimeoutMs(topics, workerApiTimeoutMs, contextApiTimeoutMs)
  );
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
  const claimed: unknown = await response.json();
  try {
    return parseClaimedWork(claimed);
  } catch (error) {
    await failMalformedClaim(claimed, error);
    return undefined;
  }
}

interface MalformedClaimFence {
  readonly topic: SupportedWorkerTopic;
  readonly tenantId: string;
  readonly messageId: string;
  readonly taskId: string;
  readonly leaseId: string;
  readonly attempt: number;
  readonly writeFenceToken: string;
}

async function failMalformedClaim(value: unknown, parseError: unknown): Promise<void> {
  let fence: MalformedClaimFence;
  try {
    fence = malformedClaimFence(value);
  } catch (fenceError) {
    throw new Error(
      `claim response violated both the task contract (${errorMessage(parseError)}) and its fencing envelope: ${errorMessage(fenceError)}`,
      { cause: fenceError }
    );
  }
  const reason = `claimed work violated the worker contract: ${errorMessage(parseError)}`.slice(0, 2_000);
  const body = {
    messageId: fence.messageId,
    taskId: fence.taskId,
    leaseId: fence.leaseId,
    attempt: fence.attempt,
    writeFenceToken: fence.writeFenceToken,
    outcome: "failed",
    reason,
    failureCategory: "worker_execution",
    ...(workerRuntime ? workerRuntimeRequestBody(workerRuntime) : {}),
    ...(workerRelease ? workerReleaseRequestBody(workerRelease) : {})
  };
  let lastFailure: unknown;
  for (let sendAttempt = 1; sendAttempt <= completionSendAttempts; sendAttempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/internal/worker/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-jina-tenant-id": fence.tenantId
        },
        body: JSON.stringify(body),
        signal: requestSignal(workerApiTimeoutMs)
      });
      if (response.ok || response.status === 409) {
        recordApiSuccess();
        lastWork = {
          topic: fence.topic,
          outcome: response.ok ? "failed" : "lease_lost",
          finishedAt: new Date().toISOString(),
          ...(response.ok ? { failureCategory: "worker_execution" } : {})
        };
        metrics.count("worker.tasks", {
          topic: fence.topic,
          outcome: response.ok ? "failed" : "lease_lost",
          category: "worker_execution"
        });
        logger.error("malformed claimed work was terminalized", {
          event: "worker.claim_contract_failed",
          workerId,
          topic: fence.topic,
          taskId: fence.taskId,
          attempt: fence.attempt,
          terminalized: response.ok,
          reason: reason.slice(0, 500)
        });
        return;
      }
      lastFailure = new Error(
        `malformed claim completion failed with ${response.status}: ${await boundedFailureDetail(response)}`
      );
    } catch (error) {
      lastFailure = error;
    }
    if (sendAttempt < completionSendAttempts) {
      await delay(completionRetryDelayMs * 2 ** (sendAttempt - 1));
    }
  }
  throw lastFailure instanceof Error
    ? lastFailure
    : new Error("malformed claim completion failed without a diagnostic");
}

function malformedClaimFence(value: unknown): MalformedClaimFence {
  if (!isRecord(value) || !isRecord(value.message) || !isRecord(value.task) || !isRecord(value.task.metadata)) {
    throw new Error("claim response must include message, task, and task metadata");
  }
  const topicValue = requiredString(value.message.topic, "claim message topic");
  if (!SUPPORTED_WORKER_TOPICS.includes(topicValue as SupportedWorkerTopic)) {
    throw new Error(`unsupported claimed topic ${topicValue}`);
  }
  return {
    topic: topicValue as SupportedWorkerTopic,
    tenantId: requiredString(value.task.metadata.tenantId, "task tenantId"),
    messageId: requiredString(value.message.id, "claim message id"),
    taskId: requiredString(value.task.id, "claim task id"),
    leaseId: requiredString(value.message.leaseId, "claim lease id"),
    attempt: requiredPositiveInteger(value.message.attempt, "claim attempt"),
    writeFenceToken: requiredString(value.message.writeFenceToken, "claim write fence token")
  };
}

async function execute(work: ClaimedWork<SupportedWorkerTopic>): Promise<void> {
  const metadata = work.task.metadata as unknown as Record<string, unknown>;
  const traceId = typeof metadata.traceId === "string" ? metadata.traceId : undefined;
  const spanId = typeof metadata.spanId === "string" ? metadata.spanId : undefined;
  await withOpenTelemetrySpan({
    name: `board.task.${work.topic}`,
    automaticSuccessStatus: false,
    ...(traceId && spanId ? { parent: { traceId, spanId, sampled: true } } : {}),
    attributes: {
      "jina.board.task.id": work.task.id,
      "jina.board.task.topic": work.topic,
      "jina.board.task.attempt": work.message.attempt ?? 1,
      ...(typeof metadata.tenantId === "string" ? { "jina.tenant.id": metadata.tenantId } : {}),
      ...(typeof metadata.workflowId === "string" ? { "jina.board.workflow.id": metadata.workflowId } : {}),
      ...(typeof metadata.workflowType === "string" ? { "jina.board.workflow.type": metadata.workflowType } : {})
    },
    operation: async (span) => {
      span.addEvent("board.task.claimed", {
        "jina.board.delivery.id": work.message.id,
        "jina.board.lease.expires_at": work.message.leaseExpiresAt
      });
      await executeClaimedWork(work);
      const outcome = lastWork?.outcome ?? "unknown";
      const success = outcome === "done" || outcome === "waiting_external";
      span.addEvent("board.task.finished", {
        "jina.board.task.outcome": outcome,
        ...(lastWork?.failureCategory ? { "jina.board.task.failure_category": lastWork.failureCategory } : {})
      });
      setOpenTelemetrySpanOutcome(span, {
        outcome,
        success,
        ...(!success ? { message: `Board task ended with ${outcome}` } : {})
      });
    }
  });
}

async function executeClaimedWork(work: ClaimedWork<SupportedWorkerTopic>): Promise<void> {
  active = true;
  activeWork = work;
  activeModelUsage = BOARD_MODEL_TOPICS.has(work.topic)
    ? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    : undefined;
  activeModelUsageObserved = false;
  const startedAt = Date.now();
  const startedMetadata = work.task.metadata as unknown as Record<string, unknown>;
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
  const buildDeadlineTimer = scheduleBoardBuildDeadline(work, lease.controller);
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
    if (error instanceof ReviewEffectStartUncertainError) {
      lease.lostReason = error.message;
    }
    if (!lease.lostReason) {
      const reason = errorMessage(error).slice(0, 2_000);
      const failureCategory = workerFailureCategory(reason);
      result =
        isDurableBoardTopic(work.topic) &&
        shouldRetryWorkerFailure(reason, {
          attempt: work.message.attempt ?? 1,
          maxAttempts: work.message.maxAttempts ?? contextBoardMaxAttempts
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
      await releaseBoardLeaseOnce(work, lease, lease.lostReason ?? "worker lost its lease").catch((error) => {
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
      if (error instanceof LeaseLostError) {
        loseLease(lease, error, false);
        logStageOutcome(work, startedAt, undefined, lease.lostReason);
        lastWork = { topic: work.message.topic, outcome: "lease_lost", finishedAt: new Date().toISOString() };
        return;
      }
      if (!(error instanceof LeaseLostError) && isDurableBoardTopic(work.topic)) {
        await releaseBoardLeaseOnce(work, lease, `completion failed: ${errorMessage(error)}`).catch((releaseError) => {
          logger.error("worker lease release failed after completion failure", {
            event: "worker.completion_failure_release_failed",
            workerId,
            taskId: work.task.id,
            ...errorLogFields(releaseError)
          });
        });
      }
      throw error;
    }
    lastWork = {
      topic: work.message.topic,
      outcome: result.outcome,
      finishedAt: new Date().toISOString(),
      ...(result.outcome === "failed" || result.outcome === "retry" || result.outcome === "effect_retry"
        ? { failureCategory: result.failureCategory }
        : {})
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
  const metadata = work.task.metadata as unknown as Record<string, unknown>;
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
  const workflowTraceId = typeof metadata.traceId === "string" ? metadata.traceId : undefined;
  const attemptSpanId = typeof metadata.spanId === "string" ? metadata.spanId : undefined;
  const stageLogger = logger.withTrace(
    workflowTraceId && attemptSpanId
      ? { traceId: workflowTraceId, spanId: attemptSpanId, sampled: true }
      : generateTraceContext()
  );
  metrics.observe("worker.stage.duration_ms", durationMs, { topic: work.message.topic });
  const reason =
    failureReason ??
    (result?.outcome === "failed" || result?.outcome === "retry" || result?.outcome === "effect_retry"
      ? result.outcome === "effect_retry"
        ? result.diagnostic
        : result.reason
      : result === undefined
        ? "unknown"
        : undefined);
  if (reason !== undefined) {
    const failureCategory =
      result?.outcome === "retry" || result?.outcome === "failed" || result?.outcome === "effect_retry"
        ? result.failureCategory
        : workerFailureCategory(reason);
    const outcome = result?.outcome === "retry" || result?.outcome === "effect_retry" ? "retry" : "failed";
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
  const healthyOutcome = result?.outcome === "waiting_external" ? "waiting_external" : "done";
  metrics.count("worker.tasks", { topic: work.message.topic, outcome: healthyOutcome });
  stageLogger.info(
    result?.outcome === "waiting_external"
      ? `${work.message.topic} waiting on external run for task ${work.task.id}`
      : `${work.message.topic} completed for task ${work.task.id}`,
    {
      event: result?.outcome === "waiting_external" ? "stage.waiting_external" : "stage.completed",
      ...base,
      ...(result?.outcome === "done" && typeof result.result?.effect === "string"
        ? { effect: result.result.effect }
        : {})
    }
  );
}

type TopicHandler<T extends SupportedWorkerTopic> = (work: ClaimedWork<T>) => Promise<Record<string, unknown>>;
type TopicHandlers = { readonly [T in SupportedWorkerTopic]: TopicHandler<T> };

/** Claimable queue topics and their executors, checked as one exhaustive registry. */
const topicHandlers = {
  "prepare-review": runPrepareReview,
  "summary-review": runSummaryReview,
  "runtime-review": runRuntimeReview,
  "finalize-review": runFinalizeReview,
  "publish-review": runPublishReview,
  "settle-review": runSettleReview,
  "github-installation-backfill": runInstallationBackfill,
  "billing-retry": runBillingRetry,
  "run-context-input-snapshot": runContextInputSnapshot,
  "run-context-page-plan": runContextPagePlan,
  "run-context-page-build": runContextPageBuild,
  "run-context-publication": runContextPublication,
  "run-causal-graph-history": runCausalGraphHistory,
  "run-causal-graph-derive": runCausalGraphDerive,
  "run-causal-graph-publication": runCausalGraphPublication,
  "run-review": runLegacyReview
} satisfies TopicHandlers;

async function executeTopic<T extends SupportedWorkerTopic>(work: ClaimedWork<T>): Promise<WorkResult> {
  if (work.topic === "run-review" && reviewRunTopicMode === "relational") {
    return runRelationalReview(work);
  }
  // Indexing a mapped function registry loses the key/parameter correlation;
  // the exhaustive `satisfies` check above proves it once for every entry.
  const handler = topicHandlers[work.topic] as unknown as TopicHandler<T>;
  return { outcome: "done", result: await handler(work) };
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
  return {
    contract: CONTEXT_WORKFLOW_CONTRACT,
    schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    outputArtifact,
    commitSha: input.commitSha
  };
}

async function runContextPagePlan(work: ClaimedWork<"run-context-page-plan">): Promise<Record<string, unknown>> {
  const researchPlanResult = await runContextResearchPlan(
    internalStageWork(work, "run-context-research-plan", {
      ...work.task.metadata,
      inputArtifact: work.task.metadata.inputArtifact
    })
  );
  const researchPlanArtifact = parseArtifactRef(
    researchPlanResult.outputArtifact,
    "Context page plan researchPlanArtifact"
  );
  if (!Array.isArray(researchPlanResult.work)) {
    throw new Error("Context page plan research assignments are missing");
  }
  const researchEntries = researchPlanResult.work as unknown[];
  const researchResults: ContextBoardDependencyResult[] = [];
  for (let index = 0; index < researchEntries.length; index += 1) {
    const entry = researchEntries[index];
    if (!isRecord(entry)) throw new Error(`Context page plan research assignment ${index} is invalid`);
    const workKey = requiredString(entry.key, `Context page plan research assignment ${index} key`);
    const inputArtifact = parseArtifactRef(
      entry.inputArtifact,
      `Context page plan research assignment ${index} inputArtifact`
    );
    const result = await runContextResearch(
      internalStageWork(work, "run-context-research", {
        ...work.task.metadata,
        inputArtifact,
        planArtifact: researchPlanArtifact,
        workKey
      })
    );
    researchResults.push({
      taskId: `${work.task.id}:research:${workKey}`,
      taskType: "research-context-subject",
      result: {
        version: 1,
        outputArtifact: parseArtifactRef(result.outputArtifact, `Context research ${workKey} outputArtifact`)
      }
    });
  }

  const publicationPlanResult = await runContextPublicationPlan(
    internalStageWork(work, "run-context-publication-plan", {
      ...work.task.metadata,
      planArtifact: researchPlanArtifact,
      dependencyResults: researchResults
    })
  );
  const outputArtifact = parseArtifactRef(publicationPlanResult.outputArtifact, "Context page plan outputArtifact");
  const publication = parsePublicationPlanArtifact(await readContextBoardArtifact(work, outputArtifact));
  const pages = [
    ...publication.plan.pages.map((page) => {
      const operation = page.change ?? "add";
      return {
        subjectId: page.id,
        path: page.path,
        title: page.title,
        operation,
        ...(operation === "add" || operation === "revise" ? { briefArtifact: outputArtifact } : {})
      };
    }),
    ...(publication.plan.retiredPages ?? []).map((page) => ({
      subjectId: `retired-${createHash("sha256").update(page.path).digest("hex").slice(0, 20)}`,
      path: page.path,
      title: page.path.split("/").at(-1)!.replace(/\.md$/i, "").replace(/[-_]+/g, " "),
      operation: "retire" as const,
      reason: page.reason
    }))
  ];
  return {
    contract: CONTEXT_WORKFLOW_CONTRACT,
    schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    outputArtifact,
    pages
  };
}

async function runContextPageBuild(work: ClaimedWork<"run-context-page-build">): Promise<Record<string, unknown>> {
  const pageTaskId = work.task.id;
  const pageKey = work.task.metadata.subjectId;
  const documentPath = work.task.metadata.documentPath;
  const planArtifact = work.task.metadata.planArtifact;
  const writeResult = await runContextPageWrite(
    internalStageWork(work, "run-context-page-write", {
      ...work.task.metadata,
      inputArtifact: work.task.metadata.briefArtifact,
      planArtifact,
      pageKey,
      documentPath,
      pageTaskId,
      pass: 0,
      pageChange: work.task.metadata.pageOperation
    })
  );
  let pageArtifact = parseArtifactRef(writeResult.outputArtifact, "Context page draft outputArtifact");
  const phaseReceiptIds = [`${pageTaskId}:author:0`];
  let auditResult = await runContextPageAudit(
    internalStageWork(work, "run-context-page-audit", {
      ...work.task.metadata,
      pageKey,
      documentPath,
      pageTaskId,
      pass: 0,
      dependencyResults: [contextStageDependency(pageTaskId, "write-context-page", pageArtifact, 0, documentPath)]
    })
  );
  phaseReceiptIds.push(`${pageTaskId}:audit:0`);
  if (requiredString(auditResult.verdict, "Context page audit verdict") === "unsupported") {
    const findingsArtifact = parseArtifactRef(auditResult.outputArtifact, "Context page audit outputArtifact");
    const repairResult = await runContextPageRepair(
      internalStageWork(work, "run-context-page-repair", {
        ...work.task.metadata,
        documentPath,
        pageTaskId,
        pass: 1,
        findingsArtifact
      })
    );
    pageArtifact = parseArtifactRef(repairResult.outputArtifact, "Context page repair outputArtifact");
    phaseReceiptIds.push(`${pageTaskId}:repair:1`);
    auditResult = await runContextPageAudit(
      internalStageWork(work, "run-context-page-audit", {
        ...work.task.metadata,
        pageKey,
        documentPath,
        pageTaskId,
        pass: 1,
        dependencyResults: [contextStageDependency(pageTaskId, "repair-context-page", pageArtifact, 1, documentPath)]
      })
    );
    phaseReceiptIds.push(`${pageTaskId}:audit:1`);
  }
  const finalAuditArtifact = parseArtifactRef(auditResult.outputArtifact, "final audit outputArtifact");
  if (requiredString(auditResult.verdict, "Context page final audit verdict") !== "supported") {
    return {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: finalAuditArtifact,
      disposition: { status: "omitted", reasonCode: "unsupported_core_claims" },
      phaseReceiptIds
    };
  }
  const page = parseContextPageArtifact(await readContextBoardArtifact(work, pageArtifact));
  return {
    contract: CONTEXT_WORKFLOW_CONTRACT,
    schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    outputArtifact: pageArtifact,
    disposition: {
      status: "accepted",
      pageArtifact,
      evidenceFingerprint: page.snapshotArtifact.sha256,
      generationFingerprint: createHash("sha256")
        .update(`${pageArtifact.sha256}:${finalAuditArtifact.sha256}`)
        .digest("hex")
    },
    phaseReceiptIds
  };
}

function internalStageWork<T extends EmbeddedContextStageTopic>(
  work: ClaimedWork<ContextWorkerTopic>,
  topic: T,
  metadata: WorkMetadataByTopic[T]
): ClaimedWork<T> {
  return {
    topic,
    message: { ...work.message, topic },
    task: { id: work.task.id, metadata }
  } as unknown as ClaimedWork<T>;
}

function contextStageDependency(
  taskId: string,
  taskType: string,
  outputArtifact: ContextArtifactRef,
  pass: number,
  documentPath: string
): ContextBoardDependencyResult {
  return {
    taskId: `${taskId}:${taskType}:${pass}`,
    taskType,
    pass,
    pageTaskId: taskId,
    documentPath,
    result: { version: 1, outputArtifact }
  };
}

async function runCausalGraphHistory(work: ClaimedWork<"run-causal-graph-history">): Promise<Record<string, unknown>> {
  const { tenantId, repository, ref, commitSha: expectedCommitSha, githubInstallationId } = work.task.metadata;
  if (requireGithubInstallation && !githubInstallationId) {
    throw new Error("provisioned GitHub installation is required for the issue history snapshot");
  }
  if (githubInstallationId) {
    const access = await createGitHubInstallationAccessToken(githubInstallationId, { repository });
    assertLeaseOwned();
    if (!activeLease) throw new Error("GitHub installation token was minted outside an active worker lease");
    activeLease.githubToken = access.token;
  }
  const checkout = await checkoutRepository(repository, ref, expectedCommitSha);
  try {
    const history = await readGitHistoryMetadata(checkout.directory, checkout.commitSha);
    const packet = {
      version: 1 as const,
      tenantId,
      repository,
      ref,
      refSequence: work.task.metadata.refSequence,
      commitSha: checkout.commitSha,
      complete: history.complete,
      commits: history.commits.map((commit) => ({
        sha: commit.sha,
        parentShas: commit.parentShas,
        message: commit.message,
        ...(commit.committedAt
          ? {
              committedAt: canonicalCausalGraphCommitTimestamp(
                commit.committedAt,
                "causal graph history commit committedAt"
              )
            }
          : {})
      }))
    };
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "issue-history",
      name: "history.json",
      contentType: "application/json",
      content: Buffer.from(JSON.stringify(packet), "utf8")
    });
    return {
      version: 1,
      outputArtifact,
      commitSha: packet.commitSha,
      observedCommitCount: packet.commits.length,
      historyComplete: packet.complete
    };
  } finally {
    await rm(checkout.directory, { recursive: true, force: true });
  }
}

async function runCausalGraphDerive(work: ClaimedWork<"run-causal-graph-derive">): Promise<Record<string, unknown>> {
  const historyArtifact = latestDependencyArtifact(
    work.task.metadata.dependencyResults,
    ["snapshot-causal-graph-history"],
    "causal graph derivation"
  );
  const history = parseIssueHistoryPacket(await readContextBoardArtifact(work, historyArtifact), work.task.metadata);
  const inputDirectory = await mkdtemp(join(tmpdir(), "jina-causal-graph-"));
  try {
    const historyPath = join(inputDirectory, "commit-history.json");
    const candidateLedger = deriveIssueCandidateLedger(history.commits);
    const candidateLedgerPath = join(inputDirectory, "candidate-ledger.json");
    await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    await writeFile(candidateLedgerPath, `${JSON.stringify(candidateLedger, null, 2)}\n`, "utf8");
    const phase = "causal-graph-derive.candidate";
    const checkpointKey = contextPhaseCheckpointKey(work, "causal-graph-derive-phase-checkpoint-v5", phase, {
      historyArtifactSha256: historyArtifact.sha256,
      commitSha: history.commitSha
    });
    const checkpoint = await checkpointedContextCandidate(work, {
      phase,
      checkpointKey,
      generate: async () => {
        const output = await requireBoardAgentStageRunner().run({
          id: "issue-causality-derivation",
          prompt: issueGraphPrompt(
            history.repository,
            history.ref,
            historyPath,
            candidateLedgerPath,
            minimumDerivedIssueCount(candidateLedger.candidates.length)
          ),
          schema: ISSUE_GRAPH_STAGE_SCHEMA,
          workingDirectory: inputDirectory,
          additionalDirectories: [inputDirectory],
          readOnly: true,
          budgetSeconds: stageBudgetSeconds("CAUSAL_GRAPH_DERIVE_SECONDS", 900)
        });
        return { candidate: output.parsed, generatedAt: new Date().toISOString() };
      }
    });
    if (!isRecord(checkpoint)) throw new Error("causal graph derivation checkpoint is invalid");
    const graph = materializeIssueGraph({
      tenantId: history.tenantId,
      repository: history.repository,
      ref: history.ref,
      refSequence: history.refSequence,
      commitSha: history.commitSha,
      generatedAt: requiredString(checkpoint.generatedAt, "causal graph checkpoint generatedAt"),
      history: history.commits,
      historyComplete: history.complete,
      candidate: checkpoint.candidate,
      candidateLedger,
      generator: {
        name: "codex-agentic-issue-deriver",
        version: "1",
        model: (process.env.CAUSAL_GRAPH_CODEX_MODEL?.trim() || "gpt-5.6-terra").replace(/^openai\//, ""),
        promptVersion: "issue-causality-v5"
      }
    });
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "issue-graph",
      name: `${graph.id}.json`,
      contentType: "application/json",
      content: Buffer.from(JSON.stringify(graph), "utf8")
    });
    return {
      version: 1,
      outputArtifact,
      releaseId: graph.id,
      contentDigest: graph.contentDigest,
      issueCount: graph.issues.length,
      causalityCount: graph.causalities.length,
      historyComplete: graph.coverage.complete
    };
  } finally {
    await rm(inputDirectory, { recursive: true, force: true });
  }
}

async function runCausalGraphPublication(
  work: ClaimedWork<"run-causal-graph-publication">
): Promise<Record<string, unknown>> {
  const graphArtifact = latestDependencyArtifact(
    work.task.metadata.dependencyResults,
    ["derive-causal-graph"],
    "causal graph publication"
  );
  const result = await internalApiJson<Record<string, unknown>>(
    "/internal/causal-graph/board/publish",
    leaseBody(work, { graphArtifact })
  );
  if (result.version !== 1) throw new Error("causal graph publication result version must be 1");
  const releaseId = requiredString(result.releaseId, "causal graph publication releaseId");
  const receiptArtifact = await uploadContextBoardArtifact(work, {
    kind: "issue-graph",
    name: `${releaseId}-publication.json`,
    contentType: "application/json",
    content: Buffer.from(JSON.stringify({ version: 1, releaseId, graphArtifact }), "utf8")
  });
  return { version: 1, outputArtifact: receiptArtifact, releaseId };
}

async function runContextPublication(work: ClaimedWork<"run-context-publication">): Promise<Record<string, unknown>> {
  if (!boardPageIndexClient) throw new Error("self-hosted PageIndex client is not configured");
  const publicationPlanArtifact = work.task.metadata.planArtifact;
  const publicationPlan = parsePublicationPlanArtifact(await readContextBoardArtifact(work, publicationPlanArtifact));
  const sourcePageArtifacts: ContextArtifactRef[] = [];
  const omittedPages: { readonly path: string; readonly reasonCode: string }[] = [];
  const unsupportedPages: { readonly path: string; readonly reasonCode: string }[] = [];
  for (const dependency of work.task.metadata.dependencyResults.filter(
    (candidate) => candidate.taskType === "build-context-page"
  )) {
    const disposition = contextPagePublicationDisposition(dependency.result);
    if (disposition.status === "omitted") {
      unsupportedPages.push({
        path: requiredString(dependency.documentPath, `${dependency.taskId} documentPath`),
        reasonCode: disposition.reasonCode
      });
    } else {
      sourcePageArtifacts.push(
        parseArtifactRef(disposition.pageArtifact, `${dependency.taskId} disposition pageArtifact`)
      );
    }
  }
  const priorContext = await loadPriorContext(work);

  const uploadPriorPage = async (input: {
    readonly path: string;
    readonly change: "retain" | "revise";
  }): Promise<void> => {
    const priorPage = priorContext?.pages.find((page) => page.documentPath === input.path);
    if (!priorPage) throw new Error(`${input.change} Context page ${input.path} is absent from the prior release`);
    sourcePageArtifacts.push(
      await uploadContextBoardArtifact(work, {
        kind: "context-page",
        name: contextPageArtifactName(input.path, input.change === "retain" ? "retain" : "fallback"),
        contentType: "application/json",
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            documentPath: input.path,
            title: priorPage.title,
            bodyMarkdown: canonicalPublicPageMarkdown(priorPage.bodyMarkdown),
            publicationPlanArtifact,
            snapshotArtifact: publicationPlan.snapshotArtifact,
            change: input.change,
            priorLogicalId: priorPage.logicalId,
            priorRevisionId: priorPage.revisionId
          }),
          "utf8"
        )
      })
    );
  };

  for (const unsupported of unsupportedPages) {
    const plannedPage = publicationPlan.plan.pages.find((page) => page.path === unsupported.path);
    if (!plannedPage)
      throw new Error(`unsupported Context page ${unsupported.path} is absent from the publication plan`);
    const plannedChange = plannedPage.change ?? "add";
    const priorPage = priorContext?.pages.find((page) => page.documentPath === unsupported.path);
    const resolution = resolveContextPageOmission({ plannedChange, hasPriorPage: Boolean(priorPage) });
    if (resolution.status === "omit_new_page") {
      omittedPages.push(unsupported);
      continue;
    }
    await uploadPriorPage({ path: unsupported.path, change: plannedChange === "retain" ? "retain" : "revise" });
    logger.warn("unsupported Context revision retained the certified prior page", {
      event: "context.page.unsupported_revision_retained_prior",
      taskId: work.task.id,
      contextBuildId: work.task.metadata.contextBuildId,
      repository: work.task.metadata.repository,
      ref: work.task.metadata.ref,
      documentPath: unsupported.path,
      reasonCode: unsupported.reasonCode
    });
  }

  for (const plannedPage of publicationPlan.plan.pages.filter((page) => (page.change ?? "add") === "retain")) {
    await uploadPriorPage({ path: plannedPage.path, change: "retain" });
  }
  const loadedPages = await Promise.all(
    sourcePageArtifacts.map(async (artifact) => ({
      artifact,
      page: parseContextPageArtifact(await readContextBoardArtifact(work, artifact))
    }))
  );
  const omittedDocumentPaths = new Set(omittedPages.map((page) => page.path));
  const pages = await Promise.all(
    loadedPages.map(async ({ artifact, page }) => {
      const bodyMarkdown = unlinkMarkdownDocumentTargets(page.bodyMarkdown, page.documentPath, omittedDocumentPaths);
      if (bodyMarkdown === page.bodyMarkdown) return { artifact, page };
      const publicationPage = { ...page, bodyMarkdown };
      const publicationArtifact = await uploadContextBoardArtifact(work, {
        kind: "context-page",
        name: contextPageArtifactName(page.documentPath, "publication"),
        contentType: "application/json",
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            ...publicationPage,
            sourcePageArtifact: artifact,
            omittedDocumentPaths: [...omittedDocumentPaths].sort()
          }),
          "utf8"
        )
      });
      return { artifact: publicationArtifact, page: publicationPage };
    })
  );
  if (pages.length === 0) throw new Error("Context publication has no safely dispositioned pages");
  const publicationCoverageProblems = pages.flatMap(({ page }) => {
    const plannedPage = publicationPlan.plan.pages.find((candidate) => candidate.path === page.documentPath);
    if (!plannedPage) return [`${page.documentPath} is absent from the publication plan`];
    return pagePlanContentProblems(plannedPage, page.bodyMarkdown);
  });
  if (publicationCoverageProblems.length > 0) {
    throw new Error(
      `Context publication dropped required plan coverage: ${publicationCoverageProblems.slice(0, 32).join("; ")}`
    );
  }
  const publicSnapshotDigest = createHash("sha256")
    .update(contextBoardPublicSnapshot(pages.map(({ page }) => page)))
    .digest("hex");
  const certificationArtifact = await uploadContextBoardArtifact(work, {
    kind: "certification",
    name: "certification.json",
    contentType: "application/json",
    content: Buffer.from(
      JSON.stringify({
        version: 1,
        verdict: "certified",
        publicSnapshotDigest,
        publicationPlanArtifact,
        pageArtifacts: pages.map(({ artifact }) => artifact),
        omittedPages
      }),
      "utf8"
    )
  });
  const result = await internalApiJson<Record<string, unknown>>(
    "/internal/context/board/publish",
    leaseBody(work, { certificationArtifact })
  );
  if (result.version !== 1) throw new Error("Context publication result version must be 1");
  const outputArtifact = parseArtifactRef(result.outputArtifact, "Context publication outputArtifact");
  const releaseId = requiredString(result.releaseId, "Context publication releaseId");
  const releaseBytes = await readContextBoardArtifact(work, outputArtifact);
  let release: unknown;
  try {
    release = JSON.parse(Buffer.from(releaseBytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("published Context release artifact is not valid JSON");
  }
  const pageIndexPhase = "pageindex-tree.complete";
  const pageIndexCheckpointKey = contextPhaseCheckpointKey(
    work,
    "context-publication-pageindex-checkpoint-v1",
    pageIndexPhase,
    { releaseId, releaseArtifactSha256: outputArtifact.sha256 }
  );
  let selectedPageIndex = await loadContextBoardPhaseCheckpoint(work, pageIndexPhase, pageIndexCheckpointKey);
  if (!selectedPageIndex) {
    const built = await buildBoardPageIndex(boardPageIndexClient, release, {
      timeoutMs: positiveInt(process.env.CONTEXT_PAGEINDEX_BUILD_TIMEOUT_MS, 5 * 60_000),
      maxDocumentCharacters: positiveInt(process.env.CONTEXT_PAGEINDEX_MAX_DOCUMENT_CHARACTERS, 2_000_000),
      maxNodes: positiveInt(process.env.CONTEXT_PAGEINDEX_MAX_NODES, 20_000)
    });
    const treeArtifact = await uploadContextBoardArtifact(work, {
      kind: "pageindex-tree",
      // The pinned PageIndex adapter can legally return a different valid tree
      // after a response-loss retry. Keep candidates immutable and let the
      // durable checkpoint select the one attachment for this publication.
      name: `${releaseId}.${built.artifactSha256}.json`,
      contentType: "application/json",
      content: Buffer.from(built.artifactContent, "utf8")
    });
    await recordContextBoardPhaseCheckpoint(work, {
      phase: pageIndexPhase,
      checkpointKey: pageIndexCheckpointKey,
      artifact: treeArtifact
    });
    selectedPageIndex = await loadContextBoardPhaseCheckpoint(work, pageIndexPhase, pageIndexCheckpointKey);
    if (!selectedPageIndex) throw new Error("recorded publication PageIndex checkpoint is unavailable");
    logger.info("recorded durable publication PageIndex checkpoint", {
      event: "context.phase_checkpoint.recorded",
      taskId: work.task.id,
      contextBuildId: work.task.metadata.contextBuildId,
      phase: pageIndexPhase,
      checkpointKey: pageIndexCheckpointKey,
      checkpointAttempt: selectedPageIndex.checkpoint.attempt,
      artifactSha256: selectedPageIndex.checkpoint.artifact.sha256
    });
  } else {
    logger.info("resumed publication PageIndex from a durable checkpoint", {
      event: "context.phase_checkpoint.reused",
      taskId: work.task.id,
      contextBuildId: work.task.metadata.contextBuildId,
      phase: pageIndexPhase,
      checkpointKey: pageIndexCheckpointKey,
      checkpointAttempt: selectedPageIndex.checkpoint.attempt,
      artifactSha256: selectedPageIndex.checkpoint.artifact.sha256
    });
  }
  assertPublicationPageIndexCheckpoint(selectedPageIndex.value, work, releaseId);
  const treeArtifact = selectedPageIndex.checkpoint.artifact;
  const attached = await internalApiJson<Record<string, unknown>>(
    "/internal/context/board/pageindex/attach",
    leaseBody(work, { releaseId, releaseArtifact: outputArtifact, treeArtifact })
  );
  if (attached.version !== 1 || requiredString(attached.releaseId, "PageIndex attached releaseId") !== releaseId) {
    throw new Error("PageIndex attachment did not bind the published Context release");
  }
  const attachedArtifact = parseArtifactRef(attached.outputArtifact, "PageIndex attached outputArtifact");
  if (
    attachedArtifact.key !== treeArtifact.key ||
    attachedArtifact.sha256 !== treeArtifact.sha256 ||
    attachedArtifact.bytes !== treeArtifact.bytes
  ) {
    throw new Error("PageIndex attachment changed the selected immutable tree artifact identity");
  }
  return {
    contract: CONTEXT_WORKFLOW_CONTRACT,
    schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    outputArtifact,
    releaseId
  };
}

function assertPublicationPageIndexCheckpoint(
  value: unknown,
  work: ClaimedWork<"run-context-publication">,
  releaseId: string
): void {
  const tree = parseBoardPageIndexTreeArtifact(value);
  if (
    tree.release.releaseId !== releaseId ||
    tree.release.tenantId !== work.task.metadata.tenantId ||
    tree.release.repository !== work.task.metadata.repository ||
    tree.release.ref !== work.task.metadata.ref ||
    tree.release.refSequence !== work.task.metadata.refSequence ||
    tree.release.commitSha !== work.task.metadata.commitSha ||
    tree.release.buildId !== work.task.metadata.contextBuildId
  ) {
    throw new Error("publication PageIndex checkpoint does not match the exact leased release");
  }
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
  work: ClaimedWork<ContextWorkerTopic | EmbeddedContextStageTopic | CausalGraphWorkerTopic>,
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

interface WorkerPhaseCheckpoint {
  readonly phase: string;
  readonly checkpointKey: string;
  readonly attempt: number;
  readonly artifact: ContextArtifactRef;
  readonly recordedAt: string;
}

function contextPhaseCheckpointKey(
  work: ClaimedWork<ContextWorkerTopic | EmbeddedContextStageTopic | CausalGraphWorkerTopic>,
  contract: string,
  phase: string,
  input: unknown
): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, contract, phase, taskId: work.task.id, input }))
    .digest("hex");
}

async function loadContextBoardPhaseCheckpoint(
  work: ClaimedWork,
  phase: string,
  checkpointKey: string
): Promise<{ readonly checkpoint: WorkerPhaseCheckpoint; readonly value: unknown } | undefined> {
  const result = await internalApiJson<{ readonly checkpoint: WorkerPhaseCheckpoint | null }>(
    "/internal/context/board/phase-checkpoints/read",
    leaseBody(work, { phase, checkpointKey })
  );
  if (!result.checkpoint) return undefined;
  if (result.checkpoint.phase !== phase || result.checkpoint.checkpointKey !== checkpointKey) {
    throw new Error("Context phase checkpoint response does not match its request");
  }
  const content = await readContextBoardArtifact(work, result.checkpoint.artifact);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch {
    throw new Error(`Context phase checkpoint ${phase} is not valid JSON`);
  }
  return { checkpoint: result.checkpoint, value };
}

async function recordContextBoardPhaseCheckpoint(
  work: ClaimedWork,
  input: {
    readonly phase: string;
    readonly checkpointKey: string;
    readonly artifact: ContextArtifactRef;
  }
): Promise<WorkerPhaseCheckpoint> {
  const result = await internalApiJson<{ readonly checkpoint: WorkerPhaseCheckpoint }>(
    "/internal/context/board/phase-checkpoints",
    leaseBody(work, input)
  );
  if (result.checkpoint.phase !== input.phase || result.checkpoint.checkpointKey !== input.checkpointKey) {
    throw new Error("recorded Context phase checkpoint does not match its request");
  }
  return result.checkpoint;
}

async function checkpointedContextCandidate(
  work: ClaimedWork<ContextWorkerTopic | EmbeddedContextStageTopic | CausalGraphWorkerTopic>,
  input: {
    readonly phase: string;
    readonly checkpointKey: string;
    readonly generate: () => Promise<unknown>;
    readonly validate?: (candidate: unknown) => void | Promise<void>;
  }
): Promise<unknown> {
  const existing = await loadContextBoardPhaseCheckpoint(work, input.phase, input.checkpointKey);
  if (existing) {
    await input.validate?.(existing.value);
    logger.info(`resumed ${input.phase} from a durable checkpoint`, {
      event: "context.phase_checkpoint.reused",
      taskId: work.task.id,
      contextBuildId: work.task.metadata.contextBuildId,
      phase: input.phase,
      checkpointKey: input.checkpointKey,
      checkpointAttempt: existing.checkpoint.attempt,
      artifactSha256: existing.checkpoint.artifact.sha256
    });
    return existing.value;
  }
  const candidate = await input.generate();
  await input.validate?.(candidate);
  const candidateArtifact = contextPhaseCandidateArtifact(input.phase, candidate);
  const artifact = await uploadContextBoardArtifact(work, {
    kind: boardWorkArtifactKindForTopic(work.topic),
    // A Cloud Run instance can terminate after uploading a candidate but before
    // recording its checkpoint. A replacement worker then owns the same Board
    // attempt and may regenerate different model output. Content-address the
    // immutable object so both candidates can coexist while the checkpoint
    // transaction still selects exactly one of them.
    name: candidateArtifact.name,
    contentType: "application/json",
    content: candidateArtifact.content
  });
  const recorded = await recordContextBoardPhaseCheckpoint(work, {
    phase: input.phase,
    checkpointKey: input.checkpointKey,
    artifact
  });
  const selected = await loadContextBoardPhaseCheckpoint(work, input.phase, input.checkpointKey);
  if (!selected) throw new Error(`recorded Context phase checkpoint ${input.phase} is unavailable`);
  logger.info(`recorded durable ${input.phase} checkpoint`, {
    event: "context.phase_checkpoint.recorded",
    taskId: work.task.id,
    contextBuildId: work.task.metadata.contextBuildId,
    phase: input.phase,
    checkpointKey: input.checkpointKey,
    checkpointAttempt: recorded.attempt,
    artifactSha256: recorded.artifact.sha256
  });
  return selected.value;
}

async function loadPriorContext(
  work: ClaimedWork<ContextWorkerTopic | EmbeddedContextStageTopic>
): Promise<PriorContextPacket | undefined> {
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
    const repositoryAreas = repositoryContextAreas(snapshot.files);
    const checkpointKey = (phase: string) =>
      contextPhaseCheckpointKey(work, "research-plan-phase-checkpoints-v2", phase, {
        snapshotSha256: snapshotArtifact.sha256,
        priorReleaseSha256: priorContext?.seed.releaseArtifact.sha256 ?? null
      });
    const candidate = await checkpointedContextCandidate(work, {
      phase: "research-plan.candidate",
      checkpointKey: checkpointKey("research-plan.candidate"),
      generate: async () => {
        const output = await runner.run({
          id: "research-planner",
          prompt: researchPlannerPrompt({
            repository: snapshot.repository,
            repositoryDirectory: checkout.directory,
            manifestPath,
            evidencePath,
            repositoryAreas,
            ...(priorContextPath ? { priorContextPath } : {})
          }),
          schema: RESEARCH_STAGE_SCHEMA,
          workingDirectory: checkout.directory,
          additionalDirectories: [inputDirectory],
          readOnly: true,
          budgetSeconds: stageBudgetSeconds("CONTEXT_RESEARCH_PLANNER_SECONDS", 240)
        });
        return output.parsed;
      }
    });
    const validationOptions = {
      repositoryFiles: snapshot.files.map((file) => ({
        path: file.path,
        contentAvailable: !file.contentOmitted
      })),
      repositoryAreas
    };
    const plan = await parseResearchPlanWithRepair({
      candidate,
      options: validationOptions,
      repair: async ({ invalidPlan, diagnostic }) => {
        logger.warn("research planner contract rejected model output; scheduling bounded correction", {
          event: "context.research_plan.repair_scheduled",
          taskId: work.task.id,
          contextBuildId: work.task.metadata.contextBuildId,
          repository: snapshot.repository,
          ref: snapshot.ref,
          diagnostic: diagnostic.slice(0, 500)
        });
        return checkpointedContextCandidate(work, {
          phase: "research-plan.repair",
          checkpointKey: checkpointKey("research-plan.repair"),
          validate: (value) => {
            parseBoardResearchPlan(value, validationOptions);
          },
          generate: async () => {
            const repaired = await runner.run({
              id: "research-planner-repair",
              prompt: researchPlannerRepairPrompt({
                repository: snapshot.repository,
                repositoryDirectory: checkout.directory,
                manifestPath,
                evidencePath,
                repositoryAreas,
                ...(priorContextPath ? { priorContextPath } : {}),
                invalidPlan,
                diagnostic
              }),
              schema: RESEARCH_STAGE_SCHEMA,
              workingDirectory: checkout.directory,
              additionalDirectories: [inputDirectory],
              readOnly: true,
              budgetSeconds: stageBudgetSeconds("CONTEXT_RESEARCH_PLANNER_REPAIR_SECONDS", 300)
            });
            return repaired.parsed;
          }
        });
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
    const checkpointKey = contextPhaseCheckpointKey(
      work,
      "research-report-phase-checkpoint-v1",
      "research-report.candidate",
      {
        assignment,
        planArtifactSha256: work.task.metadata.planArtifact.sha256,
        snapshotArtifactSha256: planPacket.snapshotArtifact.sha256,
        priorReleaseSha256: priorContext?.seed.releaseArtifact.sha256 ?? null
      }
    );
    const candidate = await checkpointedContextCandidate(work, {
      phase: "research-report.candidate",
      checkpointKey,
      validate: (value) => {
        if (!isRecord(value) || typeof value.report !== "string") {
          throw new Error(`research worker ${assignment.id} checkpoint is invalid`);
        }
        if (value.report.length < 200) throw new Error(`research worker ${assignment.id} returned a shallow report`);
      },
      generate: async () => {
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
        return { report: output.text };
      }
    });
    if (!isRecord(candidate) || typeof candidate.report !== "string") throw new Error("validated report disappeared");
    const outputArtifact = await uploadContextBoardArtifact(work, {
      kind: "research-report",
      name: `${assignment.id}.json`,
      contentType: "application/json",
      content: Buffer.from(
        JSON.stringify({
          version: 1,
          assignmentId: assignment.id,
          report: candidate.report,
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
    const checkpointKey = (phase: string) =>
      contextPhaseCheckpointKey(work, "publication-plan-phase-checkpoints-v2", phase, {
        researchPlanSha256: work.task.metadata.planArtifact.sha256,
        researchReportSha256s: reportArtifacts.map((artifact) => artifact.sha256).sort(),
        priorReleaseSha256: priorContext?.seed.releaseArtifact.sha256 ?? null
      });
    const publicationPlanValidation = {
      options: {
        researchAssignments: planPacket.plan.assignments,
        repositoryAreas,
        ...(priorContext ? { priorPages: priorContext.pages } : {})
      },
      ...(priorContext
        ? {
            normalize: (value: unknown) =>
              promoteUnsafeRetainedPages({
                candidate: value,
                options: {
                  researchAssignments: planPacket.plan.assignments,
                  repositoryAreas,
                  priorPages: priorContext.pages
                },
                priorPages: priorContext.certifiedPages,
                snapshot
              }),
            validate: (value: DocumentationStagePlan) => {
              const problems = retainedPublicationPlanProblems({
                plan: value,
                priorPages: priorContext.certifiedPages,
                snapshot
              });
              if (problems.length > 0) {
                throw new Error(`incremental retain validation requires revise: ${problems.slice(0, 12).join("; ")}`);
              }
            }
          }
        : {})
    };
    const candidate = await checkpointedContextCandidate(work, {
      phase: "publication-plan.candidate",
      checkpointKey: checkpointKey("publication-plan.candidate"),
      generate: async () => {
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
        return output.parsed;
      }
    });
    const plan = await parsePublicationPlanWithRepair({
      candidate,
      ...publicationPlanValidation,
      repair: async ({ invalidPlan, diagnostic }) => {
        logger.warn("publication planner contract rejected model output; scheduling bounded correction", {
          event: "context.publication_plan.repair_scheduled",
          taskId: work.task.id,
          contextBuildId: work.task.metadata.contextBuildId,
          repository: snapshot.repository,
          ref: snapshot.ref,
          diagnostic: diagnostic.slice(0, 500)
        });
        return checkpointedContextCandidate(work, {
          phase: "publication-plan.repair",
          checkpointKey: checkpointKey("publication-plan.repair"),
          validate: (value) => {
            parseBoardPublicationPlan(value, publicationPlanValidation);
          },
          generate: async () => {
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
      name: contextPageArtifactName(page.path, `write-${work.task.metadata.pass}`),
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
    const checkpointKey = contextPhaseCheckpointKey(
      work,
      "context-page-write-phase-checkpoint-v1",
      "context-page-write.candidate",
      {
        page,
        publicationArtifactSha256: publicationArtifact.sha256,
        priorReleaseSha256: priorContext?.seed.releaseArtifact.sha256 ?? null
      }
    );
    const candidate = await checkpointedContextCandidate(work, {
      phase: "context-page-write.candidate",
      checkpointKey,
      validate: (value) => {
        if (!isRecord(value) || typeof value.bodyMarkdown !== "string") {
          throw new Error(`page writer checkpoint is invalid for ${page.path}`);
        }
        if (canonicalPublicPageMarkdown(value.bodyMarkdown).trim().length < 400) {
          throw new Error(`page writer returned a shallow page for ${page.path}`);
        }
      },
      generate: async () => {
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
        return {
          bodyMarkdown: canonicalPublicPageMarkdown(await readFile(join(outputDirectory, page.path), "utf8"))
        };
      }
    });
    if (!isRecord(candidate) || typeof candidate.bodyMarkdown !== "string")
      throw new Error("validated page disappeared");
    const bodyMarkdown = canonicalPublicPageMarkdown(candidate.bodyMarkdown);
    const draftInventory = boardPageAuditInventory({
      documentPath: page.path,
      bodyMarkdown,
      snapshot
    });
    const draftStructuralProblems = [
      ...draftInventory.structuralProblems,
      ...pagePlanStructuralProblems(page, publication.plan.pages, bodyMarkdown),
      ...pagePlanContentProblems(page, bodyMarkdown)
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
      name: contextPageArtifactName(page.path, `write-${work.task.metadata.pass}`),
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
    ...pagePlanStructuralProblems(plannedPage, publication.plan.pages, page.bodyMarkdown),
    ...pagePlanContentProblems(plannedPage, page.bodyMarkdown)
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
  if (inventory.references.length > 0 && inventory.references.length <= 500) {
    const workerId = `citation-audit-${safeStageId(work.task.metadata.pageKey).slice(0, 60)}`;
    let priorReferences: readonly CitationAuditReference[] | undefined;
    let priorAudit: CitationAuditStageResult | undefined;
    if (page.findingsArtifact) {
      const prior = parseContextPageAuditArtifact(await readContextBoardArtifact(work, page.findingsArtifact));
      if (prior.audit) {
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
                const phase = `page-audit.batch-${index + 1}.attempt-${attempt}`;
                const checkpointKey = contextPhaseCheckpointKey(work, "page-audit-phase-checkpoints-v1", phase, {
                  inputDigest,
                  expectedCitationIds,
                  priorDiagnostic: priorDiagnostic ?? null
                });
                return checkpointedContextCandidate(work, {
                  phase,
                  checkpointKey,
                  generate: async () => {
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
                  }
                });
              },
              parse: (value) => {
                const citationIds = references.map((reference) => reference.citationId);
                const expected = {
                  workerId,
                  inputDigest,
                  publicSnapshotDigest,
                  citationIds
                };
                return parseCitationAuditStageResult(
                  retainAssignedCitationAuditResults(bindCitationAuditHostIdentity(value, expected), citationIds),
                  expected
                );
              }
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
    name: contextPageArtifactName(page.documentPath, `audit-${work.task.metadata.pass}`),
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
    const checkpointKey = contextPhaseCheckpointKey(
      work,
      "context-page-repair-phase-checkpoint-v1",
      "context-page-repair.candidate",
      {
        findingsArtifactSha256: findingsArtifact.sha256,
        priorPageArtifactSha256: findings.pageArtifact.sha256,
        pass: work.task.metadata.pass
      }
    );
    const candidate = await checkpointedContextCandidate(work, {
      phase: "context-page-repair.candidate",
      checkpointKey,
      validate: (value) => {
        if (!isRecord(value) || typeof value.bodyMarkdown !== "string") {
          throw new Error(`page repair checkpoint is invalid for ${page.documentPath}`);
        }
      },
      generate: async () => {
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
        return { bodyMarkdown: canonicalPublicPageMarkdown(await readFile(targetPath, "utf8")) };
      }
    });
    if (!isRecord(candidate) || typeof candidate.bodyMarkdown !== "string") {
      throw new Error("validated page repair disappeared");
    }
    const bodyMarkdown = canonicalPublicPageMarkdown(candidate.bodyMarkdown);
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
            name: contextPageArtifactName(page.documentPath, `repair-${work.task.metadata.pass}`),
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
      name: contextPageArtifactName(page.documentPath, `repair-${work.task.metadata.pass}`),
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

function safeStageId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page"
  );
}

function requireBoardAgentStageRunner(): PortableContextBoardAgentStageRunner {
  if (!boardAgentStageRunner) throw new Error("board agent stage runner is not configured for this worker");
  return boardAgentStageRunner;
}

function stageBudgetSeconds(environmentName: string, fallback: number): number {
  const configured = positiveInt(process.env[environmentName], fallback);
  const deadline =
    activeWork && isBoardTopic(activeWork.topic)
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
      { env: environment, maxBuffer: 10 * 1024 * 1024, timeout: gitCommandTimeoutMs }
    );
    const remoteSource = pullRequestRef ? `refs/pull/${pullRequestRef[1]}/head` : `refs/heads/${ref}`;
    await execFileAsync("git", ["fetch", "origin", `+${remoteSource}:refs/remotes/origin/${ref}`], {
      cwd: directory,
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
      timeout: gitCommandTimeoutMs
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
        maxBuffer: 10 * 1024 * 1024,
        timeout: gitCommandTimeoutMs
      });
    }
    await execFileAsync("git", ["checkout", "--detach", targetCommitSha], {
      cwd: directory,
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
      timeout: gitCommandTimeoutMs
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
    if (isRecord(error) && error.killed === true) {
      throw new Error(`GitHub repository checkout timed out after ${gitCommandTimeoutMs}ms`, { cause: error });
    }
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

interface ReviewCompletion {
  readonly status: "completed" | "completed_superseded" | "failed";
  readonly error?: string;
  readonly superseded?: ReviewSuperseded;
}

async function runPrepareReview(work: ClaimedWork<"prepare-review">): Promise<Record<string, unknown>> {
  const payload = work.task.metadata.reviewPayload;
  const idempotencyKey =
    payload.review_idempotency_key ??
    `review:${payload.github_installation_id}:${payload.repository.github_repo_id}:${payload.pull_request.number}:${payload.pull_request.head_sha}:code_review`;
  const prepared = await productInternalJson<Record<string, unknown>>("/internal/reviews/prepare", {
    trigger_run_id: work.task.metadata.workflowId,
    idempotency_key: idempotencyKey,
    workflow: "review",
    payload
  });
  const reviewRunId = requiredString(prepared.review_run_id, "prepare response review_run_id");
  if (reviewRunId !== work.task.metadata.reviewRunId) {
    throw new Error(`prepare response review run ${reviewRunId} does not match admitted run`);
  }
  const modelSettings =
    prepared.model_settings === undefined
      ? undefined
      : isRecord(prepared.model_settings)
        ? (prepared.model_settings as ReviewStagePayload["model_settings"])
        : (() => {
            throw new Error("prepare response model_settings must be an object");
          })();
  const stagePayload = reviewStagePayload(work.task.metadata, modelSettings);
  const githubToken = await createInstallationAccessToken(payload.github_installation_id);
  if (activeLease) activeLease.githubToken = githubToken;
  await safeUpsertReviewProgressComment({
    token: githubToken,
    payload: stagePayload,
    triggerRunId: work.message.id,
    status: "github_review_progress_in_progress",
    update: { status: "In progress", findings: "Pending" }
  });
  return encodeReviewResult(work, "review-prepare", {
    reviewRunId,
    stagePayload: { ...stagePayload }
  });
}

async function runSummaryReview(work: ClaimedWork<"summary-review">): Promise<Record<string, unknown>> {
  const stagePayload = await preparedReviewStagePayload(work);
  const stageResult = await runReviewSummaryStage(stagePayload, work.message.id);
  return encodeReviewResult(work, "review-summary", { stageResult: { ...stageResult } });
}

async function runRuntimeReview(work: ClaimedWork<"runtime-review">): Promise<Record<string, unknown>> {
  const stagePayload = await preparedReviewStagePayload(work);
  const stageResult = await runReviewRuntimeStage(stagePayload, work.message.id);
  return encodeReviewResult(work, "review-runtime", { stageResult: { ...stageResult } });
}

async function runFinalizeReview(work: ClaimedWork<"finalize-review">): Promise<Record<string, unknown>> {
  const stageResults = await Promise.all(
    (["summary-review", "runtime-review"] as const).map(async (taskType) => {
      const dependency = work.task.metadata.dependencyResults.find((candidate) => candidate.taskType === taskType);
      const stage = taskType === "summary-review" ? "summary" : "runtime";
      if (!dependency) return failedDependencyStageResult(stage, "dependency result is missing");
      if (dependency.status !== "succeeded" || !dependency.resultArtifact) {
        return failedDependencyStageResult(stage, `Board task ended ${dependency.status}`);
      }
      const decoded = await decodeReviewTaskResult(
        dependency.resultArtifact,
        taskType === "summary-review" ? "review-summary" : "review-runtime",
        reviewArtifactStore
      );
      return parseReviewStageResult(decoded.stageResult, stage);
    })
  );
  const completion = reviewCompletionForBoardStageResults(stageResults);
  const payload = work.task.metadata.reviewPayload;
  const completionPayload = {
    workflow: "review",
    status: completion.status,
    repository: work.task.metadata.repository,
    pull_request_number: payload.pull_request.number,
    head_sha: payload.pull_request.head_sha,
    stage_results: stageResults,
    findings: stageResults.flatMap((result) => result.findings ?? []),
    usage_records_fallback: stageResults
      .map((result) => result.usage_records_fallback)
      .filter((fallback): fallback is UsageRecordsFallback => Boolean(fallback)),
    ...(completion.error ? { error: completion.error } : {}),
    ...(completion.superseded ? { superseded: completion.superseded } : {})
  };
  return encodeReviewResult(work, "review-finalize", {
    completion: { ...completion },
    completionPayload
  });
}

async function runPublishReview(work: ClaimedWork<"publish-review">): Promise<Record<string, unknown>> {
  const dependency = requiredReviewDependency(work.task.metadata, "finalize-review");
  if (dependency.status !== "succeeded" || !dependency.resultArtifact) {
    throw new Error(`finalize-review dependency ended ${dependency.status}`);
  }
  const finalized = await decodeReviewTaskResult(dependency.resultArtifact, "review-finalize", reviewArtifactStore);
  const completionPayload = requiredRecord(finalized.completionPayload, "finalized completionPayload");
  const stageResults = parseReviewStageResults(completionPayload.stage_results);
  const completion = parseReviewCompletion(finalized.completion);
  const stagePayload = reviewStagePayload(work.task.metadata);
  const githubToken = await createInstallationAccessToken(stagePayload.installation_id);
  if (activeLease) activeLease.githubToken = githubToken;
  const progressUpdate = reviewProgressUpdateForStageResults({
    reviewRunId: work.task.metadata.reviewRunId,
    headSha: work.task.metadata.reviewPayload.pull_request.head_sha,
    stageResults,
    failed: completion.status === "failed",
    superseded: completion.status === "completed_superseded"
  });
  const comment = await safeUpsertReviewProgressComment({
    token: githubToken,
    payload: stagePayload,
    triggerRunId: work.message.id,
    status: "github_review_progress_finalized",
    update: {
      ...(progressUpdate.status ? { status: progressUpdate.status } : {}),
      ...(progressUpdate.findings ? { findings: progressUpdate.findings } : {})
    }
  });
  const runtime = stageResults.find((result) => result.stage === "runtime");
  return encodeReviewResult(work, "review-publish", {
    finalizationEnvelope: dependency.resultArtifact,
    completionStatus: completion.status,
    publicationStatus: runtime?.publicationStatus ?? "not_attempted",
    ...(runtime?.publicationReason ? { publicationReason: runtime.publicationReason } : {}),
    ...(runtime?.githubReviewUrl ? { githubReviewUrl: runtime.githubReviewUrl } : {}),
    ...(comment?.html_url ? { progressCommentUrl: comment.html_url } : {})
  });
}

async function runSettleReview(work: ClaimedWork<"settle-review">): Promise<Record<string, unknown>> {
  const publish = work.task.metadata.dependencyResults.find((candidate) => candidate.taskType === "publish-review");
  let completionPayload: Record<string, unknown>;
  if (publish?.status === "succeeded" && publish.resultArtifact) {
    const published = await decodeReviewTaskResult(publish.resultArtifact, "review-publish", reviewArtifactStore);
    const finalizationEnvelope = requiredRecord(published.finalizationEnvelope, "published finalizationEnvelope");
    const finalized = await decodeReviewTaskResult(finalizationEnvelope, "review-finalize", reviewArtifactStore);
    completionPayload = requiredRecord(finalized.completionPayload, "finalized completionPayload");
  } else {
    completionPayload = {
      workflow: "review",
      status: "failed",
      repository: work.task.metadata.repository,
      pull_request_number: work.task.metadata.pullRequestNumber,
      head_sha: work.task.metadata.reviewPayload.pull_request.head_sha,
      stage_results: [],
      findings: [],
      usage_records_fallback: [],
      error: `review publication task ended ${publish?.status ?? "without a dependency result"}`
    };
  }
  const response = await productInternalJson<Record<string, unknown>>(
    `/internal/reviews/${encodeURIComponent(work.task.metadata.reviewRunId)}/complete`,
    {
      trigger_run_id: work.task.metadata.workflowId,
      payload: completionPayload
    }
  );
  return encodeReviewResult(work, "review-settle", {
    status: requiredString(completionPayload.status, "completion status"),
    persisted: response.updated !== false
  });
}

function reviewStagePayload(
  metadata: ReviewBoardWorkerMetadata,
  modelSettings?: ReviewStagePayload["model_settings"]
): ReviewStagePayload {
  const payload = metadata.reviewPayload;
  const repository = parseRepository(payload.repository.full_name);
  return {
    review_run_id: metadata.reviewRunId,
    parent_trigger_run_id: metadata.workflowId,
    repository: {
      ...repository,
      githubRepoId: payload.repository.github_repo_id,
      ...(payload.repository.default_branch ? { defaultBranch: payload.repository.default_branch } : {}),
      ...(payload.repository.private === undefined ? {} : { private: payload.repository.private })
    },
    pull_request_number: payload.pull_request.number,
    ...(payload.pull_request.title ? { title: payload.pull_request.title } : {}),
    ...(payload.pull_request.author ? { author: payload.pull_request.author } : {}),
    base_ref: payload.pull_request.base_ref ?? payload.repository.default_branch ?? "main",
    ...(payload.pull_request.head_ref ? { head_ref: payload.pull_request.head_ref } : {}),
    head_sha: payload.pull_request.head_sha,
    installation_id: payload.github_installation_id,
    ...(payload.manual_command_tag ? { manual_command_tag: payload.manual_command_tag } : {}),
    ...(payload.review_instructions ? { review_instructions: payload.review_instructions } : {}),
    ...(modelSettings ? { model_settings: modelSettings } : {})
  };
}

async function preparedReviewStagePayload(
  work: ClaimedWork<"summary-review" | "runtime-review">
): Promise<ReviewStagePayload> {
  const dependency = requiredReviewDependency(work.task.metadata, "prepare-review");
  if (dependency.status !== "succeeded" || !dependency.resultArtifact) {
    throw new Error(`prepare-review dependency ended ${dependency.status}`);
  }
  const prepared = await decodeReviewTaskResult(dependency.resultArtifact, "review-prepare", reviewArtifactStore);
  const saved = requiredRecord(prepared.stagePayload, "prepared stagePayload");
  if (requiredString(saved.review_run_id, "prepared review_run_id") !== work.task.metadata.reviewRunId) {
    throw new Error("prepared stage payload belongs to a different review run");
  }
  const modelSettings = saved.model_settings;
  if (modelSettings !== undefined && !isRecord(modelSettings)) {
    throw new Error("prepared model_settings must be an object");
  }
  return reviewStagePayload(work.task.metadata, modelSettings);
}

async function encodeReviewResult(
  work: ClaimedWork<ReviewBoardWorkerTopic>,
  kind: string,
  value: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const envelope = await encodeReviewTaskResult({
    tenantId: work.task.metadata.tenantId,
    workflowId: work.task.metadata.workflowId,
    taskId: work.task.id,
    kind,
    value,
    ...(reviewArtifactStore ? { store: reviewArtifactStore } : {})
  });
  return { ...envelope };
}

function requiredReviewDependency(
  metadata: ReviewBoardWorkerMetadata,
  taskType: ReviewBoardWorkerTopic
): ReviewBoardDependencyResult {
  const dependency = metadata.dependencyResults.find((candidate) => candidate.taskType === taskType);
  if (!dependency) throw new Error(`${taskType} dependency result is missing`);
  return dependency;
}

function failedDependencyStageResult(stage: "summary" | "runtime", reason: string): ReviewStageResult {
  const now = new Date().toISOString();
  return { stage, status: "failed", startedAt: now, completedAt: now, durationMs: 0, error: reason };
}

function reviewCompletionForBoardStageResults(stageResults: ReviewStageResult[]): ReviewCompletion {
  const summaryCount = stageResults.filter((result) => result.stage === "summary").length;
  const runtimeCount = stageResults.filter((result) => result.stage === "runtime").length;
  if (stageResults.length !== 2 || summaryCount !== 1 || runtimeCount !== 1) {
    return {
      status: "failed",
      error: `invalid stage results: received ${summaryCount} summary and ${runtimeCount} runtime`
    };
  }
  const failed = stageResults.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    return {
      status: "failed",
      error: failed.map((result) => `${result.stage}: ${result.error ?? "failed"}`).join("\n")
    };
  }
  if (stageResults.some((result) => result.stage === "runtime" && result.status === "success")) {
    return { status: "completed" };
  }
  const superseded = stageResults.find((result) => result.superseded)?.superseded;
  return superseded ? { status: "completed_superseded", superseded } : { status: "completed" };
}

function parseReviewStageResults(value: unknown): ReviewStageResult[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error("review stage_results must be an array");
  return value.map((result, index) => parseReviewStageResult(result, index === 0 ? "summary" : "runtime"));
}

function parseReviewStageResult(value: unknown, expectedStage: "summary" | "runtime"): ReviewStageResult {
  if (!isRecord(value)) throw new Error(`${expectedStage} stage result must be an object`);
  const stage = requiredString(value.stage, `${expectedStage} stage result stage`);
  const status = requiredString(value.status, `${expectedStage} stage result status`);
  if (stage !== expectedStage || !["success", "skipped", "failed"].includes(status)) {
    throw new Error(`${expectedStage} stage result has an invalid stage or status`);
  }
  if (!Number.isFinite(value.durationMs) || Number(value.durationMs) < 0) {
    throw new Error(`${expectedStage} stage result duration is invalid`);
  }
  requiredIsoTimestamp(value.startedAt, `${expectedStage} stage result startedAt`);
  requiredIsoTimestamp(value.completedAt, `${expectedStage} stage result completedAt`);
  return value as unknown as ReviewStageResult;
}

function parseReviewCompletion(value: unknown): ReviewCompletion {
  if (!isRecord(value)) throw new Error("review completion must be an object");
  const status = requiredString(value.status, "review completion status");
  if (status !== "completed" && status !== "completed_superseded" && status !== "failed") {
    throw new Error("review completion status is invalid");
  }
  return value as unknown as ReviewCompletion;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

async function runInstallationBackfill(
  work: ClaimedWork<"github-installation-backfill">
): Promise<Record<string, unknown>> {
  const response = await productInternalJson<Record<string, unknown>>("/internal/installations/backfill", {
    trigger_run_id: work.task.metadata.workflowId,
    payload: work.task.metadata.payload
  });
  if (response.ok !== true || typeof response.customer_provisioned !== "boolean") {
    throw new Error("installation backfill returned an invalid provisioning result");
  }
  return {
    status: "completed",
    githubInstallationId: requiredPositiveInteger(
      work.task.metadata.payload.github_installation_id,
      "github_installation_id"
    ),
    customerProvisioned: response.customer_provisioned
  };
}

async function runBillingRetry(work: ClaimedWork<"billing-retry">): Promise<Record<string, unknown>> {
  const response = await productInternalJson<Record<string, unknown>>("/internal/billing/retry", {
    workflow_id: work.task.metadata.workflowId
  });
  if (response.ok !== true) {
    throw new Error("billing retry returned an invalid result");
  }
  return { status: "completed", ...response };
}

async function productInternalJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  assertLeaseOwned();
  const traceparent = activeTraceparent();
  const response = await fetch(`${productApiUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${productInternalToken}`,
      "content-type": "application/json",
      "x-jina-tenant-id": activeWork!.task.metadata.tenantId,
      ...(traceparent ? { traceparent } : {})
    },
    body: JSON.stringify(body),
    signal: requestSignal(contextApiTimeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Product API ${path} failed with ${response.status}: ${await boundedFailureDetail(response)}`);
  }
  return (await response.json()) as T;
}

async function runRelationalReview(work: ClaimedWork<"run-review">): Promise<WorkResult> {
  if (!("workflowId" in work.task.metadata)) {
    throw new Error("legacy run-review work reached the relational Trigger bridge");
  }
  const metadata = work.task.metadata;
  const client = triggerReviewClient;
  if (!client) throw new Error("Trigger client is not configured for relational run-review work");
  const effectIdempotencyKey = reviewTriggerEffectIdempotencyKey(metadata.workflowId);
  let receipt = matchingReviewTriggerReceipt(metadata);

  if (receipt?.status === "succeeded") {
    if (!receipt.providerId) throw new Error("succeeded Trigger dispatch receipt is missing providerId");
    return observeRelationalReview(work, metadata, client, receipt.providerId, effectIdempotencyKey);
  }

  try {
    receipt = await beginReviewTriggerEffect(work, metadata, effectIdempotencyKey);
  } catch (error) {
    throw new ReviewEffectStartUncertainError(
      `Trigger effect-start acknowledgement is uncertain: ${errorMessage(error).slice(0, 1_000)}`
    );
  }
  if (receipt.status === "succeeded") {
    if (!receipt.providerId) throw new Error("replayed Trigger dispatch receipt is missing providerId");
    return observeRelationalReview(work, metadata, client, receipt.providerId, effectIdempotencyKey);
  }

  let handle: { readonly id: string };
  try {
    assertLeaseOwned();
    handle = await client.trigger(metadata.triggerTaskIdentifier, metadata.triggerPayload, metadata.triggerOptions);
    assertLeaseOwned();
  } catch (error) {
    const failure = triggerDispatchFailure(error);
    return {
      outcome: "effect_retry",
      transitionId: reviewTransitionId(work, "dispatch-failed"),
      effectIdempotencyKey,
      effectType: REVIEW_TRIGGER_EFFECT_TYPE,
      effectVersion: REVIEW_TRIGGER_EFFECT_VERSION,
      provider: REVIEW_TRIGGER_PROVIDER,
      requestDigest: metadata.requestDigest,
      receiptStatus: failure.ambiguous ? "ambiguous" : "failed",
      diagnostic: failure.diagnostic,
      failureCategory: failure.ambiguous ? "api_transport" : "worker_execution"
    };
  }
  const providerId = handle.id?.trim();
  if (!providerId) {
    return {
      outcome: "effect_retry",
      transitionId: reviewTransitionId(work, "dispatch-invalid"),
      effectIdempotencyKey,
      effectType: REVIEW_TRIGGER_EFFECT_TYPE,
      effectVersion: REVIEW_TRIGGER_EFFECT_VERSION,
      provider: REVIEW_TRIGGER_PROVIDER,
      requestDigest: metadata.requestDigest,
      receiptStatus: "failed",
      diagnostic: "Trigger dispatch returned no run ID",
      failureCategory: "worker_execution"
    };
  }
  metrics.count("review_trigger_dispatch_total", { outcome: "accepted" });
  return {
    outcome: "waiting_external",
    operation: "provider_handoff",
    transitionId: reviewTransitionId(work, "provider-handoff"),
    effectIdempotencyKey,
    providerId,
    providerStatus: "TRIGGERED",
    nextCheckAt: reviewNextCheckAt(reviewTriggerPollMs),
    requestDigest: metadata.requestDigest,
    resultDigest: createHash("sha256").update(providerId, "utf8").digest("hex")
  };
}

async function beginReviewTriggerEffect(
  work: ClaimedWork<"run-review">,
  metadata: RelationalReviewTaskMetadata,
  effectIdempotencyKey: string
): Promise<TriggerReviewEffectReceipt> {
  const response = await sendReplayableWorkerMutation(
    "/internal/worker/effects/start",
    {
      ...workerFence(work),
      transitionId: reviewTransitionId(work, "effect-start"),
      effectIdempotencyKey,
      effectType: REVIEW_TRIGGER_EFFECT_TYPE,
      effectVersion: REVIEW_TRIGGER_EFFECT_VERSION,
      provider: REVIEW_TRIGGER_PROVIDER,
      requestDigest: metadata.requestDigest,
      metadata: { trigger_task_id: metadata.triggerTaskIdentifier }
    },
    contextCompletionTimeoutMs,
    work.task.id
  );
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || !isRecord(body.effectReceipt)) {
    throw new Error("effect-start response did not contain an effect receipt");
  }
  return reviewEffectReceiptFromResponse(body.effectReceipt, metadata.requestDigest);
}

async function observeRelationalReview(
  work: ClaimedWork<"run-review">,
  metadata: RelationalReviewTaskMetadata,
  client: TriggerReviewClient,
  providerId: string,
  effectIdempotencyKey: string
): Promise<WorkResult> {
  let run: TriggerReviewRun;
  try {
    assertLeaseOwned();
    run = await client.retrieve(providerId);
    assertLeaseOwned();
  } catch (error) {
    metrics.count("review_trigger_poll_total", { status: "transport_error", outcome: "rescheduled" });
    logger.warn("Trigger review poll failed; rescheduling", {
      event: "review.trigger_poll_rescheduled",
      workerId,
      taskId: work.task.id,
      workflowId: metadata.workflowId,
      failureCategory: workerFailureCategory(errorMessage(error))
    });
    return externalReviewWait(work, effectIdempotencyKey, providerId, "POLL_ERROR", reviewTriggerPollMs);
  }
  if (run.id !== providerId) throw new Error("Trigger retrieve returned a different run ID");
  const kind = triggerReviewRunStatusKind(run.status);
  metrics.count("review_trigger_poll_total", { status: run.status, outcome: kind });
  if (kind === "nonterminal") {
    return externalReviewWait(work, effectIdempotencyKey, providerId, run.status, reviewTriggerPollMs);
  }
  if (kind === "completed") {
    return { outcome: "done", result: compactCompletedReviewResult(run, metadata) };
  }

  const diagnostic = triggerRunDiagnostic(run);
  let reconciliation: Record<string, unknown>;
  try {
    reconciliation = await productInternalJson("/internal/reviews/reconcile-terminal", {
      board_workflow_id: metadata.workflowId,
      trigger_run_id: providerId,
      provider_status: run.status,
      diagnostic
    });
    const outcome = reconciliation.outcome;
    if (
      reconciliation.ok !== true ||
      (outcome !== "updated" && outcome !== "already_terminal" && outcome !== "no_row")
    ) {
      throw new Error("product reconciliation returned no durable acknowledgement");
    }
  } catch (error) {
    logger.warn("Trigger terminal review reconciliation failed; rescheduling", {
      event: "review.trigger_reconciliation_rescheduled",
      workerId,
      taskId: work.task.id,
      workflowId: metadata.workflowId,
      providerStatus: run.status,
      failureCategory: workerFailureCategory(errorMessage(error))
    });
    return externalReviewWait(
      work,
      effectIdempotencyKey,
      providerId,
      `${run.status}_RECONCILE_PENDING`,
      Math.min(300_000, reviewTriggerPollMs * 2)
    );
  }
  return {
    outcome: "failed",
    reason: `Trigger review run ${run.status}: ${diagnostic}`.slice(0, 2_000),
    failureCategory: "worker_execution"
  };
}

function externalReviewWait(
  work: ClaimedWork<"run-review">,
  effectIdempotencyKey: string,
  providerId: string,
  providerStatus: string,
  delayMs: number
): WorkResult {
  return {
    outcome: "waiting_external",
    operation: "reschedule",
    transitionId: reviewTransitionId(work, "poll-reschedule"),
    effectIdempotencyKey,
    providerId,
    providerStatus,
    nextCheckAt: reviewNextCheckAt(delayMs)
  };
}

function workerFence(work: ClaimedWork): Record<string, unknown> {
  return {
    messageId: work.message.id,
    leaseId: work.message.leaseId,
    taskId: work.task.id,
    ...(work.message.attempt === undefined ? {} : { attempt: work.message.attempt }),
    ...(work.message.writeFenceToken === undefined ? {} : { writeFenceToken: work.message.writeFenceToken })
  };
}

function reviewTransitionId(work: ClaimedWork<"run-review">, action: string): string {
  return `review:${work.message.leaseId}:${action}`;
}

function reviewNextCheckAt(delayMs: number): string {
  return new Date(Date.now() + delayMs).toISOString();
}

function reviewEffectReceiptFromResponse(
  value: Record<string, unknown>,
  requestDigest: string
): TriggerReviewEffectReceipt {
  const status = requiredString(value.status, "effect receipt status");
  if (status !== "started" && status !== "succeeded" && status !== "failed" && status !== "ambiguous") {
    throw new Error("effect receipt status is unsupported");
  }
  const receipt = {
    idempotencyKey: requiredString(value.idempotencyKey, "effect receipt idempotencyKey"),
    effectType: requiredString(value.effectType, "effect receipt effectType"),
    effectVersion: requiredPositiveInteger(value.effectVersion, "effect receipt effectVersion"),
    provider: requiredString(value.provider, "effect receipt provider"),
    status,
    requestDigest: requiredString(value.requestDigest, "effect receipt requestDigest"),
    ...(typeof value.providerId === "string" && value.providerId.trim() ? { providerId: value.providerId.trim() } : {}),
    metadata: isRecord(value.metadata) ? value.metadata : {}
  } satisfies TriggerReviewEffectReceipt;
  if (
    receipt.effectType !== REVIEW_TRIGGER_EFFECT_TYPE ||
    receipt.effectVersion !== REVIEW_TRIGGER_EFFECT_VERSION ||
    receipt.provider !== REVIEW_TRIGGER_PROVIDER ||
    receipt.requestDigest !== requestDigest
  ) {
    throw new Error("effect-start response returned a different Trigger dispatch receipt");
  }
  return receipt;
}

function triggerDispatchFailure(error: unknown): { readonly ambiguous: boolean; readonly diagnostic: string } {
  const value = isRecord(error) ? error : undefined;
  const response = isRecord(value?.response) ? value.response : undefined;
  const status =
    typeof value?.status === "number"
      ? value.status
      : typeof response?.status === "number"
        ? response.status
        : undefined;
  const definiteClientFailure =
    status !== undefined && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
  return {
    ambiguous: !definiteClientFailure,
    diagnostic: `Trigger dispatch ${definiteClientFailure ? "rejected" : "acceptance uncertain"}${
      status ? ` (${status})` : ""
    }: ${errorMessage(error)}`.slice(0, 2_000)
  };
}

async function runLegacyReview(work: ClaimedWork<"run-review">): Promise<Record<string, unknown>> {
  if ("workflowId" in work.task.metadata) {
    throw new Error("relational run-review work reached the legacy review executor");
  }
  const { repository, pullRequestNumber } = work.task.metadata;
  const [pullRequest, diff] = await Promise.all([
    githubJson(`/repos/${repository}/pulls/${pullRequestNumber}`),
    githubText(`/repos/${repository}/pulls/${pullRequestNumber}`, "application/vnd.github.v3.diff")
  ]);
  const reviewRequest: LegacyReviewRequest = {
    repository,
    pullRequestNumber,
    title: typeof pullRequest.title === "string" ? pullRequest.title : `Pull request #${pullRequestNumber}`,
    diff
  };
  const prepared = prepareLegacyReviewDiff(reviewRequest.diff);
  const model = process.env.REVIEW_MODEL?.trim() || "gpt-5.6-sol";
  const apiKey = requiredEnv("OPENAI_API_KEY");
  const baseUrl = (process.env.OPENAI_API_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: LEGACY_REVIEW_SYSTEM_PROMPT,
      input: legacyReviewPrompt(reviewRequest, prepared),
      text: {
        format: {
          type: "json_schema",
          name: "review_findings",
          schema: LEGACY_REVIEW_FINDINGS_SCHEMA,
          strict: true
        }
      },
      store: false
    }),
    signal: requestSignal(10 * 60 * 1000)
  });
  if (!response.ok) {
    throw new Error(`OpenAI review failed with ${response.status}: ${await boundedFailureDetail(response, [apiKey])}`);
  }
  const parsed = parseLegacyReviewOutput(extractOutputText((await response.json()) as Record<string, unknown>));
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
    isDurableBoardTopic(work.topic) ? contextApiTimeoutMs : workerApiTimeoutMs
  );
  if (!response.ok) {
    const message = `renewal failed with ${response.status}: ${await boundedFailureDetail(response)}`;
    if (response.status === 409) throw new LeaseLostError(message);
    throw new Error(message);
  }
  recordApiSuccess();
}

async function complete(work: ClaimedWork, result: WorkResult): Promise<void> {
  const modelCompletionOutcome =
    result.outcome === "waiting_external" || result.outcome === "effect_retry" ? "failed" : result.outcome;
  const modelUsage =
    BOARD_MODEL_TOPICS.has(work.topic) && activeModelUsage
      ? boardAgentModelUsageForCompletion({
          outcome: modelCompletionOutcome,
          observed: activeModelUsageObserved,
          usage: activeModelUsage
        })
      : undefined;
  if (result.outcome === "done" && BOARD_MODEL_TOPICS.has(work.topic) && !modelUsage) {
    throw new Error("model-backed task completed without an exact usage accumulator");
  }
  const fence = {
    messageId: work.message.id,
    leaseId: work.message.leaseId,
    taskId: work.task.id,
    ...(work.message.attempt === undefined ? {} : { attempt: work.message.attempt }),
    ...(work.message.writeFenceToken === undefined ? {} : { writeFenceToken: work.message.writeFenceToken })
  };
  const path =
    result.outcome === "waiting_external"
      ? "/internal/worker/wait-external"
      : result.outcome === "effect_retry"
        ? "/internal/worker/effects/retry"
        : "/internal/worker/complete";
  const mutationBody =
    result.outcome === "waiting_external"
      ? { ...fence, ...result, outcome: undefined }
      : result.outcome === "effect_retry"
        ? { ...fence, ...result, outcome: undefined }
        : { ...fence, ...(modelUsage ? { modelUsage } : {}), ...result };
  const timeoutMs = isDurableBoardTopic(work.topic) ? contextCompletionTimeoutMs : workerApiTimeoutMs;
  await sendReplayableWorkerMutation(path, mutationBody, timeoutMs, work.task.id);
}

async function sendReplayableWorkerMutation(
  path: string,
  body: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  taskId: string
): Promise<Response> {
  // The API replays completions idempotently via the dispatched lease receipt,
  // so an ambiguous outcome (network failure, timeout, 5xx) is retried with the
  // identical request rather than released — a release after a committed
  // completion would rerun the whole stage from scratch on another worker.
  for (let sendAttempt = 1; ; sendAttempt += 1) {
    let response: Response;
    try {
      response = await apiRequest(path, body, timeoutMs);
    } catch (error) {
      if (sendAttempt >= completionSendAttempts) throw error;
      logger.warn("worker mutation send failed; retrying", {
        event: "worker.mutation_send_retry",
        workerId,
        taskId,
        path,
        sendAttempt,
        ...errorLogFields(error)
      });
      await delay(completionRetryDelayMs * 2 ** (sendAttempt - 1));
      continue;
    }
    if (response.status === 409) {
      throw new LeaseLostError(`worker mutation rejected after lease loss: ${await boundedFailureDetail(response)}`);
    }
    if (!response.ok) {
      const detail = await boundedFailureDetail(response);
      if (response.status >= 500 && sendAttempt < completionSendAttempts) {
        logger.warn("worker mutation send failed; retrying", {
          event: "worker.mutation_send_retry",
          workerId,
          taskId,
          path,
          sendAttempt,
          status: response.status
        });
        await delay(completionRetryDelayMs * 2 ** (sendAttempt - 1));
        continue;
      }
      throw new Error(
        path === "/internal/worker/complete"
          ? `completion failed with ${response.status}: ${detail}`
          : `worker mutation ${path} failed with ${response.status}: ${detail}`
      );
    }
    recordApiSuccess();
    return response;
  }
}

function apiRequest(path: string, body: unknown, timeoutMs = workerApiTimeoutMs): Promise<Response> {
  assertLeaseOwned();
  const tenantId = activeWork?.task.metadata.tenantId;
  const requestBody =
    path.startsWith("/internal/worker/") && isRecord(body)
      ? {
          ...body,
          ...(workerRuntime ? workerRuntimeRequestBody(workerRuntime) : {}),
          ...(workerRelease ? workerReleaseRequestBody(workerRelease) : {})
        }
      : body;
  const traceparent = activeTraceparent();
  return fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(tenantId ? { "x-jina-tenant-id": tenantId } : {}),
      ...(traceparent ? { traceparent } : {})
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

function parseClaimedWork(value: unknown): ClaimedWork<SupportedWorkerTopic> {
  if (!isRecord(value) || !isRecord(value.message) || !isRecord(value.task) || !isRecord(value.task.metadata)) {
    throw new Error("claim response must include message, task, and task metadata");
  }
  const topicValue = requiredString(value.message.topic, "claim message topic");
  if (!SUPPORTED_WORKER_TOPICS.includes(topicValue as (typeof SUPPORTED_WORKER_TOPICS)[number])) {
    throw new Error(`unsupported claimed topic ${topicValue}`);
  }
  const topic = topicValue as SupportedWorkerTopic;
  const message = {
    id: requiredString(value.message.id, "claim message id"),
    leaseId: requiredString(value.message.leaseId, "claim lease id"),
    leaseExpiresAt: requiredString(value.message.leaseExpiresAt, "claim lease expiry"),
    ...(value.message.attempt === undefined
      ? {}
      : { attempt: requiredPositiveInteger(value.message.attempt, "claim attempt") }),
    ...(value.message.maxAttempts === undefined
      ? {}
      : { maxAttempts: requiredPositiveInteger(value.message.maxAttempts, "claim maximum attempts") }),
    ...(value.message.writeFenceToken === undefined
      ? {}
      : { writeFenceToken: requiredString(value.message.writeFenceToken, "claim write fence token") })
  };
  const taskId = requiredString(value.task.id, "claim task id");
  const metadata = value.task.metadata;
  if (topic === "run-review") {
    if (reviewRunTopicMode === "relational") {
      return {
        topic,
        message: { ...message, topic },
        task: { id: taskId, metadata: parseRelationalReviewTaskMetadata(metadata) }
      };
    }
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
  if (isReviewBoardTopic(topic)) {
    return {
      topic,
      message: { ...message, topic },
      task: { id: taskId, metadata: reviewBoardWorkMetadata(metadata) }
    } as ClaimedWork<SupportedWorkerTopic>;
  }
  if (isControlBoardTopic(topic)) {
    const workflowType = requiredString(metadata.workflowType, "task workflowType");
    const expectedWorkflowType =
      topic === "github-installation-backfill" ? "github_installation_backfill" : "billing_retry";
    if (workflowType !== expectedWorkflowType) {
      throw new Error(`${topic} task belongs to an unexpected workflow`);
    }
    const common = {
      tenantId: requiredString(metadata.tenantId, "task tenantId"),
      workflowId: requiredString(metadata.workflowId, "task workflowId"),
      workflowType,
      pipelineVersion: requiredString(metadata.pipelineVersion, "task pipelineVersion"),
      traceId: requiredString(metadata.traceId, "task traceId"),
      spanId: requiredString(metadata.spanId, "task spanId")
    };
    return {
      topic,
      message: { ...message, topic },
      task: {
        id: taskId,
        metadata:
          topic === "github-installation-backfill"
            ? {
                ...common,
                workflowType: "github_installation_backfill",
                payload: requiredRecord(metadata.payload, "task payload")
              }
            : { ...common, workflowType: "billing_retry" }
      }
    } as ClaimedWork<SupportedWorkerTopic>;
  }
  if (isBoardTopic(topic)) {
    const common = repositoryMetadata(metadata);
    const contextMetadata = {
      ...common,
      ...(metadata.commitSha === undefined ? {} : { commitSha: requiredGitSha(metadata.commitSha, "task commitSha") }),
      ...boardWorkMetadata(metadata, topic)
    };
    return {
      topic,
      message: { ...message, topic },
      task: { id: taskId, metadata: contextMetadata }
    } as ClaimedWork<SupportedWorkerTopic>;
  }
  throw new Error("unsupported claimed topic");
}

function reviewBoardWorkMetadata(metadata: Record<string, unknown>): ReviewBoardWorkerMetadata {
  if (!isRecord(metadata.workflowMetadata)) throw new Error("task workflowMetadata must be an object");
  const workflowMetadata = metadata.workflowMetadata;
  const reviewPayload = parseReviewPayload(workflowMetadata.review_payload);
  const reviewRunId = requiredString(metadata.review_run_id, "task review_run_id");
  if (requiredString(workflowMetadata.review_run_id, "workflow review_run_id") !== reviewRunId) {
    throw new Error("task review run does not match workflow review run");
  }
  const workflowType = requiredString(metadata.workflowType, "task workflowType");
  if (workflowType !== "pr_review") throw new Error("review task must belong to a pr_review workflow");
  return {
    tenantId: requiredString(metadata.tenantId, "task tenantId"),
    workflowId: requiredString(metadata.workflowId, "task workflowId"),
    workflowType,
    pipelineVersion: requiredString(metadata.pipelineVersion, "task pipelineVersion"),
    traceId: requiredString(metadata.traceId, "task traceId"),
    spanId: requiredString(metadata.spanId, "task spanId"),
    reviewRunId,
    repository: reviewPayload.repository.full_name!,
    pullRequestNumber: reviewPayload.pull_request.number,
    reviewPayload,
    workflowMetadata,
    dependencyResults: parseReviewBoardDependencyResults(metadata.dependencyResults)
  };
}

function parseReviewBoardDependencyResults(value: unknown): ReviewBoardDependencyResult[] {
  if (!Array.isArray(value) || value.length > REVIEW_BOARD_TOPICS.length) {
    throw new Error(`review dependencyResults must be an array with at most ${REVIEW_BOARD_TOPICS.length} entries`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`review dependencyResults[${index}] must be an object`);
    const taskType = requiredString(entry.taskType, `review dependencyResults[${index}].taskType`);
    if (!isReviewBoardTopic(taskType)) {
      throw new Error(`review dependencyResults[${index}] has an unsupported task type`);
    }
    return {
      taskId: requiredString(entry.taskId, `review dependencyResults[${index}].taskId`),
      taskType,
      status: requiredString(entry.status, `review dependencyResults[${index}].status`),
      ...(entry.resultArtifact === undefined
        ? {}
        : isRecord(entry.resultArtifact)
          ? { resultArtifact: entry.resultArtifact }
          : (() => {
              throw new Error(`review dependencyResults[${index}].resultArtifact must be an object`);
            })()),
      ...(entry.resultDigest === undefined
        ? {}
        : { resultDigest: requiredDigest(entry.resultDigest, `review dependencyResults[${index}].resultDigest`) })
    };
  });
}

function parseReviewPayload(value: unknown): ReviewPayload {
  if (!isRecord(value)) throw new Error("workflow review_payload must be an object");
  if (!isRecord(value.repository)) throw new Error("workflow review_payload.repository must be an object");
  if (!isRecord(value.pull_request)) throw new Error("workflow review_payload.pull_request must be an object");
  const sourceEvent = requiredString(value.source_event, "review payload source_event");
  if (!["pull_request", "issue_comment", "pull_request_review_comment", "manual"].includes(sourceEvent)) {
    throw new Error("review payload source_event is invalid");
  }
  const trigger = requiredString(value.trigger, "review payload trigger");
  if (!["webhook", "manual", "scheduled", "policy"].includes(trigger)) {
    throw new Error("review payload trigger is invalid");
  }
  const repository = value.repository;
  const pullRequest = value.pull_request;
  const fullName = requiredString(repository.full_name, "review payload repository.full_name");
  parseRepository(fullName);
  const optionalText = (candidate: unknown, label: string): string | undefined =>
    candidate === undefined ? undefined : requiredString(candidate, label);
  const optionalBoolean = (candidate: unknown, label: string): boolean | undefined => {
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "boolean") throw new Error(`${label} must be a boolean`);
    return candidate;
  };
  const optionalNumber = (candidate: unknown, label: string): number | undefined =>
    candidate === undefined ? undefined : requiredPositiveInteger(candidate, label);
  const reviewIdempotencyKey = optionalText(value.review_idempotency_key, "review payload review_idempotency_key");
  const owner = optionalText(repository.owner, "review payload repository.owner");
  const ownerId = optionalNumber(repository.owner_id, "review payload repository.owner_id");
  const ownerType = optionalText(repository.owner_type, "review payload repository.owner_type");
  const repositoryName = optionalText(repository.name, "review payload repository.name");
  const defaultBranch = optionalText(repository.default_branch, "review payload repository.default_branch");
  const repositoryPrivate = optionalBoolean(repository.private, "review payload repository.private");
  const title = optionalText(pullRequest.title, "review payload pull_request.title");
  const htmlUrl = optionalText(pullRequest.html_url, "review payload pull_request.html_url");
  const draft = optionalBoolean(pullRequest.draft, "review payload pull_request.draft");
  const baseSha = optionalText(pullRequest.base_sha, "review payload pull_request.base_sha");
  const headRef = optionalText(pullRequest.head_ref, "review payload pull_request.head_ref");
  const baseRef = optionalText(pullRequest.base_ref, "review payload pull_request.base_ref");
  const author = optionalText(pullRequest.author, "review payload pull_request.author");
  const manualCommandTag = optionalText(value.manual_command_tag, "review payload manual_command_tag");
  const reviewInstructions = optionalText(value.review_instructions, "review payload review_instructions");
  let requestedBy: ReviewPayload["requested_by"];
  if (value.requested_by !== undefined) {
    if (!isRecord(value.requested_by)) throw new Error("review payload requested_by must be an object");
    requestedBy = {
      login: requiredString(value.requested_by.login, "review payload requested_by.login"),
      comment_id: requiredPositiveInteger(value.requested_by.comment_id, "review payload requested_by.comment_id")
    };
  }
  return {
    delivery_id: requiredString(value.delivery_id, "review payload delivery_id"),
    ...(reviewIdempotencyKey ? { review_idempotency_key: reviewIdempotencyKey } : {}),
    source_event: sourceEvent as ReviewPayload["source_event"],
    action: requiredString(value.action, "review payload action"),
    github_installation_id: requiredPositiveInteger(
      value.github_installation_id,
      "review payload github_installation_id"
    ),
    repository: {
      github_repo_id: requiredPositiveInteger(repository.github_repo_id, "review payload repository.github_repo_id"),
      ...(owner ? { owner } : {}),
      ...(ownerId ? { owner_id: ownerId } : {}),
      ...(ownerType ? { owner_type: ownerType } : {}),
      ...(repositoryName ? { name: repositoryName } : {}),
      full_name: fullName,
      ...(defaultBranch ? { default_branch: defaultBranch } : {}),
      ...(repositoryPrivate === undefined ? {} : { private: repositoryPrivate })
    },
    pull_request: {
      number: requiredPositiveInteger(pullRequest.number, "review payload pull_request.number"),
      ...(title ? { title } : {}),
      ...(htmlUrl ? { html_url: htmlUrl } : {}),
      ...(draft === undefined ? {} : { draft }),
      head_sha: requiredString(pullRequest.head_sha, "review payload pull_request.head_sha"),
      ...(baseSha ? { base_sha: baseSha } : {}),
      ...(headRef ? { head_ref: headRef } : {}),
      ...(baseRef ? { base_ref: baseRef } : {}),
      ...(author ? { author } : {})
    },
    ...(requestedBy ? { requested_by: requestedBy } : {}),
    ...(manualCommandTag ? { manual_command_tag: manualCommandTag } : {}),
    ...(reviewInstructions ? { review_instructions: reviewInstructions } : {}),
    trigger: trigger as ReviewPayload["trigger"]
  };
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

function isBoardTopic(topic: string): topic is ContextWorkerTopic | CausalGraphWorkerTopic {
  return (
    CONTEXT_BOARD_TOPICS.includes(topic as ContextWorkerTopic) ||
    CAUSAL_GRAPH_TOPICS.includes(topic as CausalGraphWorkerTopic)
  );
}

function isReviewBoardTopic(topic: string): topic is ReviewBoardWorkerTopic {
  return REVIEW_BOARD_TOPICS.includes(topic as ReviewBoardWorkerTopic);
}

function isControlBoardTopic(topic: string): topic is ControlBoardWorkerTopic {
  return CONTROL_BOARD_TOPICS.includes(topic as ControlBoardWorkerTopic);
}

function isDurableBoardTopic(topic: string): topic is SupportedWorkerTopic {
  return (
    isBoardTopic(topic) ||
    isReviewBoardTopic(topic) ||
    isControlBoardTopic(topic) ||
    (reviewRunTopicMode === "relational" && topic === "run-review")
  );
}

function boardWorkMetadata(
  metadata: Record<string, unknown>,
  topic: ContextWorkerTopic | CausalGraphWorkerTopic
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
    case "run-causal-graph-history":
    case "run-causal-graph-derive":
    case "run-causal-graph-publication":
      return base;
    case "run-context-page-plan":
      return {
        ...base,
        inputArtifact: parseArtifactRef(metadata.inputArtifact, "task inputArtifact")
      };
    case "run-context-page-build": {
      const pageOperation = requiredString(metadata.pageOperation, "task pageOperation");
      if (pageOperation !== "add" && pageOperation !== "revise") {
        throw new Error("task pageOperation must be add or revise");
      }
      return {
        ...base,
        subjectId: requiredString(metadata.subjectId, "task subjectId"),
        documentPath: requiredString(metadata.documentPath, "task documentPath"),
        planArtifact: parseArtifactRef(metadata.planArtifact, "task planArtifact"),
        briefArtifact: parseArtifactRef(metadata.briefArtifact, "task briefArtifact"),
        pageOperation
      };
    }
    case "run-context-publication":
      return {
        ...base,
        planArtifact: parseArtifactRef(metadata.planArtifact, "task planArtifact")
      };
  }
}

function scheduleBoardBuildDeadline(work: ClaimedWork, controller: AbortController): NodeJS.Timeout | undefined {
  if (!isBoardTopic(work.topic)) return undefined;
  const deadline = (work.task.metadata as ContextBoardWorkerMetadata).derivationDeadlineAt;
  if (!deadline) return undefined;
  const remainingMs = Date.parse(deadline) - Date.now();
  const abort = () => controller.abort(new Error("Board build derivation deadline exceeded"));
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
    if (
      !isRecord(entry) ||
      !isRecord(entry.result) ||
      (entry.result.version !== 1 &&
        (entry.result.contract !== CONTEXT_WORKFLOW_CONTRACT ||
          entry.result.schemaRevision !== CONTEXT_WORKFLOW_SCHEMA_REVISION))
    ) {
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
      result: parsedContextDependencyResult(
        entry.result,
        parseArtifactRef(entry.result.outputArtifact, `task dependencyResults[${index}].result.outputArtifact`)
      )
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

function loseLease(lease: LeaseExecutionState, error: unknown, recordFailure = true): void {
  if (lease.lostReason) return;
  lease.lostReason = errorMessage(error);
  if (recordFailure) recordApiFailure(new LeaseLostError(lease.lostReason));
  else recordApiSuccess();
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
  if (!releaseId && !credential) return undefined;
  const runtime = configuredWorkerRuntimeIdentity();
  if (!releaseId || !credential || !runtime) {
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
  return { releaseId, credential, ...runtime };
}

function configuredWorkerRuntimeIdentity(): WorkerRuntimeIdentity | undefined {
  const cloudRunService = process.env.K_SERVICE?.trim();
  const revision = process.env.K_REVISION?.trim();
  if (!cloudRunService && !revision) return undefined;
  if (!cloudRunService || !revision) {
    throw new Error("K_SERVICE and K_REVISION must be configured together");
  }
  const service = (["jina-context-worker", "jina-causal-graph-worker", "jina-task-worker"] as const).find(
    (candidate) => cloudRunService === candidate || cloudRunService.startsWith(`${candidate}-`)
  );
  if (!service) throw new Error("K_SERVICE is not a Jina worker service");
  if (!revision.startsWith(`${cloudRunService}-`)) {
    throw new Error("K_REVISION does not belong to K_SERVICE");
  }
  return { service, revision };
}

function workerRuntimeRequestBody(identity: WorkerRuntimeIdentity): Record<string, string> {
  return {
    workerRuntimeService: identity.service,
    workerRuntimeRevision: identity.revision
  };
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

interface IssueHistoryPacket {
  readonly version: 1;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha: string;
  readonly complete: boolean;
  readonly commits: readonly IssueHistoryCommit[];
}

function parseIssueHistoryPacket(content: Uint8Array, metadata: RepositoryContextMetadata): IssueHistoryPacket {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8"));
  } catch {
    throw new Error("issue history artifact is not valid JSON");
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.commits) || value.commits.length === 0) {
    throw new Error("issue history artifact is incomplete");
  }
  const tenantId = requiredString(value.tenantId, "issue history tenantId");
  const repository = requiredString(value.repository, "issue history repository");
  const ref = requiredString(value.ref, "issue history ref");
  const refSequence = requiredPositiveInteger(value.refSequence, "issue history refSequence");
  const commitSha = requiredGitSha(value.commitSha, "issue history commitSha");
  if (
    tenantId !== metadata.tenantId ||
    repository !== metadata.repository ||
    ref !== metadata.ref ||
    refSequence !== metadata.refSequence ||
    commitSha !== metadata.commitSha
  ) {
    throw new Error("issue history artifact does not match the leased board build");
  }
  if (typeof value.complete !== "boolean") throw new Error("issue history complete must be a boolean");
  if (value.commits.length > 50_000) throw new Error("issue history contains too many commits");
  const commits = value.commits.map((candidate, index): IssueHistoryCommit => {
    if (!isRecord(candidate) || !Array.isArray(candidate.parentShas)) {
      throw new Error(`issue history commit ${index} is invalid`);
    }
    return {
      sha: requiredGitSha(candidate.sha, `issue history commit ${index} sha`),
      parentShas: candidate.parentShas.map((parent, parentIndex) =>
        requiredGitSha(parent, `issue history commit ${index} parent ${parentIndex}`)
      ),
      message: requiredString(candidate.message, `issue history commit ${index} message`),
      ...(candidate.committedAt === undefined
        ? {}
        : {
            committedAt: canonicalCausalGraphCommitTimestamp(
              candidate.committedAt,
              `issue history commit ${index} committedAt`
            )
          })
    };
  });
  if (commits[0]?.sha !== commitSha) throw new Error("issue history does not begin at the leased commit");
  return { version: 1, tenantId, repository, ref, refSequence, commitSha, complete: value.complete, commits };
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

async function releaseBoardLease(work: ClaimedWork, reason: string): Promise<void> {
  if (!isDurableBoardTopic(work.topic)) return;
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

function releaseBoardLeaseOnce(work: ClaimedWork, lease: LeaseExecutionState, reason: string): Promise<void> {
  lease.releasePromise ??= releaseBoardLease(work, reason);
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
      await releaseBoardLeaseOnce(work, lease, "worker shutdown").catch((error) => {
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
    await openTelemetry.shutdown();
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
