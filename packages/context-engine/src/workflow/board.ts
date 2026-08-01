import {
  addDependency,
  applyCommand,
  appendEvent,
  findTask,
  markOutboxDispatched,
  reopenFailedAggregateBranch,
  reduceBoard,
  type BoardState,
  type TaskDependencyDraft,
  type TaskId,
  type TaskTypeDefinition
} from "@jina/board";
import { entityId, type IsoTimestamp } from "@jina/shared-kernel";
import { fingerprint, isFullCommitSha, normalizeIsoTime, normalizeRepository } from "../domain/fingerprint.js";
import { isDerivationDetail, type DerivationDetail } from "../derive/verbosity.js";
import { isContextArtifactKeyInScope, type ContextArtifactRef } from "../ports/artifact-store.js";
import { parseContextPriorReleaseSeed, type ContextPriorReleaseSeed } from "../publication/board-publication.js";
import { contextPageChanges, type ContextPageChange } from "./incremental.js";

export const contextBoardTaskTypes = {
  build: "build-context",
  graph: "context-build-graph",
  snapshot: "snapshot-context-input",
  researchPlan: "plan-context-research",
  research: "research-context-subject",
  publicationPlan: "plan-context-publication",
  page: "context-page",
  pageWrite: "write-context-page",
  pageAudit: "audit-context-page",
  pageRepair: "repair-context-page",
  sourceChallenge: "challenge-context-sources",
  taskEvaluation: "evaluate-context-tasks",
  gapRepair: "repair-context-gaps",
  certification: "certify-context-release",
  publication: "publish-context-release",
  pageIndex: "index-context-release"
} as const;

export type ContextBoardTaskType = (typeof contextBoardTaskTypes)[keyof typeof contextBoardTaskTypes];

export const contextBoardTopics = {
  snapshot: "run-context-input-snapshot",
  researchPlan: "run-context-research-plan",
  research: "run-context-research",
  publicationPlan: "run-context-publication-plan",
  pageWrite: "run-context-page-write",
  pageAudit: "run-context-page-audit",
  pageRepair: "run-context-page-repair",
  sourceChallenge: "run-context-source-challenge",
  taskEvaluation: "run-context-task-evaluation",
  gapRepair: "run-context-gap-repair",
  certification: "run-context-certification",
  publication: "run-context-publication",
  pageIndex: "run-context-pageindex"
} as const;

export type ContextBoardTopic = (typeof contextBoardTopics)[keyof typeof contextBoardTopics];

export const contextBoardTaskTypeDefinitions: readonly TaskTypeDefinition[] = [
  definition(
    contextBoardTaskTypes.build,
    "aggregate",
    "system",
    "Coordinates one atomically published context release."
  ),
  definition(
    contextBoardTaskTypes.graph,
    "manual",
    "system",
    "Keeps the aggregate open until the dynamic context task graph has been materialized."
  ),
  definition(
    contextBoardTaskTypes.snapshot,
    "dispatchable",
    "context_worker",
    "Captures the immutable repository, Git, and provider input boundary.",
    contextBoardTopics.snapshot
  ),
  definition(
    contextBoardTaskTypes.researchPlan,
    "dispatchable",
    "context_agent",
    "Discovers a bounded repository-specific research graph.",
    contextBoardTopics.researchPlan
  ),
  definition(
    contextBoardTaskTypes.research,
    "dispatchable",
    "context_agent",
    "Researches one non-overlapping repository subject.",
    contextBoardTopics.research
  ),
  definition(
    contextBoardTaskTypes.publicationPlan,
    "dispatchable",
    "context_agent",
    "Synthesizes the public engineering-documentation plan.",
    contextBoardTopics.publicationPlan
  ),
  definition(contextBoardTaskTypes.page, "aggregate", "system", "Coordinates one independently verified context page."),
  definition(
    contextBoardTaskTypes.pageWrite,
    "dispatchable",
    "context_agent",
    "Writes or revises one planned context page.",
    contextBoardTopics.pageWrite
  ),
  definition(
    contextBoardTaskTypes.pageAudit,
    "dispatchable",
    "context_auditor",
    "Audits core evidence bindings and substantive-section grounding in one page.",
    contextBoardTopics.pageAudit
  ),
  definition(
    contextBoardTaskTypes.pageRepair,
    "dispatchable",
    "context_agent",
    "Repairs one page from deterministic or citation-audit findings.",
    contextBoardTopics.pageRepair
  ),
  definition(
    contextBoardTaskTypes.sourceChallenge,
    "dispatchable",
    "context_auditor",
    "Challenges public coverage against the immutable source boundary.",
    contextBoardTopics.sourceChallenge
  ),
  definition(
    contextBoardTaskTypes.taskEvaluation,
    "dispatchable",
    "context_critic",
    "Attempts repository-specific maintenance tasks using public context only.",
    contextBoardTopics.taskEvaluation
  ),
  definition(
    contextBoardTaskTypes.gapRepair,
    "dispatchable",
    "context_agent",
    "Repairs the complete public context snapshot from source-challenge and context-only evaluation findings.",
    contextBoardTopics.gapRepair
  ),
  definition(
    contextBoardTaskTypes.certification,
    "dispatchable",
    "context_auditor",
    "Certifies the unchanged complete context snapshot.",
    contextBoardTopics.certification
  ),
  definition(
    contextBoardTaskTypes.publication,
    "dispatchable",
    "context_worker",
    "Atomically publishes a certified release behind a ref-sequence fence.",
    contextBoardTopics.publication
  ),
  definition(
    contextBoardTaskTypes.pageIndex,
    "dispatchable",
    "context_worker",
    "Builds the self-hosted PageIndex tree for one published release.",
    contextBoardTopics.pageIndex
  )
];

const SYSTEM_ACTOR = { type: "system", id: "context-board" } as const;
const MAX_CONTEXT_METADATA_BYTES = 32 * 1024;
const MAX_RESEARCH_TASKS = 24;
const MAX_PAGE_TASKS = 96;
// Three automatic page repairs cover the observed progression from structural
// cleanup, through compound-claim correction, to one final focused evidence
// adjustment without turning citation churn into an unbounded build. Further
// recovery is an explicit operator-remediation decision over checkpoints.
export const MAX_CONTEXT_REPAIR_PASS = 3;
export const MAX_CONTEXT_GATE_REPAIR_PASS = 3;
export const MAX_CONTEXT_OPERATOR_REMEDIATION_PASS = 12;

export function contextGateRepairMustChangeSnapshot(pass: number): boolean {
  if (!Number.isSafeInteger(pass) || pass <= 0 || pass > MAX_CONTEXT_OPERATOR_REMEDIATION_PASS) {
    throw new Error("context gate repair pass is outside the supported range");
  }
  return pass <= MAX_CONTEXT_GATE_REPAIR_PASS;
}
const MAX_CONTEXT_RESULT_BYTES = 256 * 1024;

export interface ContextBuildScope {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly requestKey: string;
  readonly commitSha?: string;
  readonly githubInstallationId?: number;
  readonly derivationDetail?: DerivationDetail;
  readonly derivationBudgetSeconds?: number;
  readonly derivationTokenBudget?: number;
  readonly trigger?: "push" | "pull_request" | "issue" | "manual";
  readonly priorRelease?: ContextPriorReleaseSeed;
}

export interface ContextBoardBuild {
  readonly state: BoardState;
  readonly buildTaskId: TaskId;
  readonly graphTaskId: TaskId;
  readonly snapshotTaskId: TaskId;
}

export interface ContextResearchWork {
  readonly key: string;
  readonly title: string;
  readonly input: ContextArtifactRef;
}

export interface ContextPageWork {
  readonly key: string;
  readonly path: string;
  readonly title: string;
  readonly input: ContextArtifactRef;
  readonly change?: ContextPageChange;
}

export interface ContextPublicationGraph {
  readonly state: BoardState;
  readonly pageTaskIds: readonly TaskId[];
  readonly sourceChallengeTaskId: TaskId;
  readonly taskEvaluationTaskId: TaskId;
  readonly certificationTaskId: TaskId;
  readonly publicationTaskId: TaskId;
  readonly pageIndexTaskId: TaskId;
}

export interface ContextGateRepairGraph {
  readonly state: BoardState;
  readonly repairTaskId: TaskId;
  readonly sourceChallengeTaskId: TaskId;
  readonly taskEvaluationTaskId: TaskId;
}

export type ContextBoardTaskResult =
  | {
      readonly version: 1;
      readonly taskType: typeof contextBoardTaskTypes.snapshot;
      readonly outputArtifact: ContextArtifactRef;
      readonly commitSha: string;
    }
  | {
      readonly version: 1;
      readonly taskType: typeof contextBoardTaskTypes.research;
      readonly outputArtifact: ContextArtifactRef;
    }
  | {
      readonly version: 1;
      readonly taskType:
        | typeof contextBoardTaskTypes.pageWrite
        | typeof contextBoardTaskTypes.pageRepair
        | typeof contextBoardTaskTypes.gapRepair;
      readonly outputArtifact: ContextArtifactRef;
      readonly publicSnapshotDigest: string;
    }
  | {
      readonly version: 1;
      readonly taskType: typeof contextBoardTaskTypes.researchPlan;
      readonly outputArtifact: ContextArtifactRef;
      readonly work: readonly ContextResearchWork[];
    }
  | {
      readonly version: 1;
      readonly taskType: typeof contextBoardTaskTypes.publicationPlan;
      readonly outputArtifact: ContextArtifactRef;
      readonly pages: readonly ContextPageWork[];
    }
  | {
      readonly version: 1;
      readonly taskType: typeof contextBoardTaskTypes.pageAudit;
      readonly outputArtifact: ContextArtifactRef;
      readonly verdict: "supported" | "unsupported";
      readonly publicSnapshotDigest: string;
      readonly unsupportedCitationCount: number;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly version: 1;
      readonly taskType: typeof contextBoardTaskTypes.sourceChallenge | typeof contextBoardTaskTypes.taskEvaluation;
      readonly outputArtifact: ContextArtifactRef;
      readonly verdict: "pass" | "repair_required";
      readonly publicSnapshotDigest: string;
      readonly blockingGapCount: number;
    }
  | {
      readonly version: 1;
      readonly taskType: typeof contextBoardTaskTypes.certification;
      readonly outputArtifact: ContextArtifactRef;
      readonly verdict: "certified" | "rejected";
      readonly publicSnapshotDigest: string;
    }
  | {
      readonly version: 1;
      readonly taskType: typeof contextBoardTaskTypes.publication | typeof contextBoardTaskTypes.pageIndex;
      readonly outputArtifact: ContextArtifactRef;
      readonly releaseId: string;
    };

/**
 * Validates the small result envelope that may be retained with a board event.
 * Page bodies, plans, reports, and evidence remain in artifact storage.
 */
export function parseContextBoardTaskResult(state: BoardState, taskId: TaskId, value: unknown): ContextBoardTaskResult {
  const task = findTask(state, taskId);
  if (!task || !isContextBoardTaskType(task.type) || task.kind !== "dispatchable") {
    throw new Error("dispatchable context board task not found");
  }
  const result = requiredRecord(value, "context task result");
  assertJsonValue(result, "$");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_CONTEXT_RESULT_BYTES) {
    throw new Error(`context task result exceeds ${MAX_CONTEXT_RESULT_BYTES} bytes`);
  }
  for (const forbidden of ["body", "content", "prompt", "transcript", "evidence", "report"]) {
    if (containsKey(result, forbidden)) {
      throw new Error(`context task result must reference ${forbidden} as an artifact`);
    }
  }
  if (result.version !== 1) throw new Error("context task result version must be 1");
  const build = requireContextBuild(state, requiredTaskId(task.metadata.contextBuildId, "contextBuildId"));
  const outputArtifact = parsedArtifact(result.outputArtifact, "outputArtifact");
  assertScopedArtifact(build, outputArtifact);
  const base = { version: 1 as const, taskType: task.type, outputArtifact };

  switch (task.type) {
    case contextBoardTaskTypes.research:
      return { ...base, taskType: task.type };
    case contextBoardTaskTypes.snapshot: {
      const commitSha = requiredBoundedString(result.commitSha, "commitSha", 40).toLowerCase();
      if (!isFullCommitSha(commitSha)) throw new Error("snapshot commitSha must be a full Git commit SHA");
      return { ...base, taskType: task.type, commitSha };
    }
    case contextBoardTaskTypes.pageWrite:
    case contextBoardTaskTypes.pageRepair:
    case contextBoardTaskTypes.gapRepair:
      return {
        ...base,
        taskType: task.type,
        publicSnapshotDigest: requiredDigest(result.publicSnapshotDigest, "publicSnapshotDigest")
      };
    case contextBoardTaskTypes.researchPlan: {
      if (!Array.isArray(result.work) || result.work.length > MAX_RESEARCH_TASKS) {
        throw new Error(`research work must contain at most ${MAX_RESEARCH_TASKS} items`);
      }
      const work = result.work.map((item, index) => {
        const candidate = requiredRecord(item, `work[${index}]`);
        const inputArtifact = parsedArtifact(candidate.inputArtifact, `work[${index}].inputArtifact`);
        assertScopedArtifact(build, inputArtifact);
        return {
          key: requiredKey(candidate.key, `work[${index}].key`),
          title: requiredBoundedString(candidate.title, `work[${index}].title`, 240),
          input: inputArtifact
        };
      });
      uniqueKeys(work, "research");
      return { ...base, taskType: task.type, work };
    }
    case contextBoardTaskTypes.publicationPlan: {
      if (!Array.isArray(result.pages) || result.pages.length === 0 || result.pages.length > MAX_PAGE_TASKS) {
        throw new Error(`publication pages must contain between 1 and ${MAX_PAGE_TASKS} items`);
      }
      const pages = result.pages.map((item, index) => {
        const candidate = requiredRecord(item, `pages[${index}]`);
        const inputArtifact = parsedArtifact(candidate.inputArtifact, `pages[${index}].inputArtifact`);
        assertScopedArtifact(build, inputArtifact);
        return {
          key: requiredKey(candidate.key, `pages[${index}].key`),
          path: normalizedPagePath(requiredBoundedString(candidate.path, `pages[${index}].path`, 512)),
          title: requiredBoundedString(candidate.title, `pages[${index}].title`, 240),
          input: inputArtifact,
          change:
            candidate.change === undefined && build.metadata.priorRelease === undefined
              ? "add"
              : requiredEnum(candidate.change, `pages[${index}].change`, contextPageChanges)
        };
      });
      uniqueKeys(pages, "page");
      if (new Set(pages.map((page) => page.path)).size !== pages.length) {
        throw new Error("publication pages contain duplicate paths");
      }
      return { ...base, taskType: task.type, pages };
    }
    case contextBoardTaskTypes.pageAudit: {
      const verdict = requiredEnum(result.verdict, "verdict", ["supported", "unsupported"]);
      const unsupportedCitationCount = requiredCount(result.unsupportedCitationCount, "unsupportedCitationCount");
      if (
        (verdict === "supported" && unsupportedCitationCount !== 0) ||
        (verdict === "unsupported" && unsupportedCitationCount === 0)
      ) {
        throw new Error("page audit verdict and unsupportedCitationCount disagree");
      }
      return {
        ...base,
        taskType: task.type,
        verdict,
        publicSnapshotDigest: requiredDigest(result.publicSnapshotDigest, "publicSnapshotDigest"),
        unsupportedCitationCount,
        diagnostics:
          result.diagnostics === undefined ? [] : requiredBoundedStrings(result.diagnostics, "diagnostics", 32, 500)
      };
    }
    case contextBoardTaskTypes.sourceChallenge:
    case contextBoardTaskTypes.taskEvaluation: {
      const verdict = requiredEnum(result.verdict, "verdict", ["pass", "repair_required"]);
      const blockingGapCount = requiredCount(result.blockingGapCount, "blockingGapCount");
      if ((verdict === "pass" && blockingGapCount !== 0) || (verdict === "repair_required" && blockingGapCount === 0)) {
        throw new Error("context gate verdict and blockingGapCount disagree");
      }
      return {
        ...base,
        taskType: task.type,
        verdict,
        publicSnapshotDigest: requiredDigest(result.publicSnapshotDigest, "publicSnapshotDigest"),
        blockingGapCount
      };
    }
    case contextBoardTaskTypes.certification:
      return {
        ...base,
        taskType: task.type,
        verdict: requiredEnum(result.verdict, "verdict", ["certified", "rejected"]),
        publicSnapshotDigest: requiredDigest(result.publicSnapshotDigest, "publicSnapshotDigest")
      };
    case contextBoardTaskTypes.publication:
    case contextBoardTaskTypes.pageIndex:
      return {
        ...base,
        taskType: task.type,
        releaseId: requiredBoundedString(result.releaseId, "releaseId", 240)
      };
    default:
      throw new Error(`context task type ${task.type} does not produce a worker result`);
  }
}

export function isContextBoardTaskType(value: string): value is ContextBoardTaskType {
  return Object.values(contextBoardTaskTypes).some((type) => type === value);
}

/**
 * Binds an issue/current-ref build to the immutable commit resolved by its
 * snapshot worker before any agent work is expanded.
 */
export function bindContextBoardBuildCommit(
  state: BoardState,
  input: {
    readonly buildTaskId: TaskId;
    readonly commitSha: string;
    readonly now: string;
  }
): BoardState {
  const build = requireContextBuild(state, input.buildTaskId);
  const commitSha = input.commitSha.toLowerCase();
  if (!isFullCommitSha(commitSha)) throw new Error("context build commit must be a full Git SHA");
  if (build.metadata.commitSha !== undefined) {
    if (build.metadata.commitSha !== commitSha) {
      throw new Error("context snapshot commit does not match the admitted build commit");
    }
    return state;
  }
  const now = normalizeIsoTime(input.now);
  const tasks = state.tasks.map((task) =>
    task.id === build.id || task.metadata.contextBuildId === build.id
      ? { ...task, metadata: { ...task.metadata, commitSha }, updatedAt: now }
      : task
  );
  return appendEvent({ ...state, tasks }, "context.commit_bound", now, build.id, { commitSha });
}

/**
 * Creates the only eagerly known part of a build. Later graph expansion is
 * driven by validated, artifact-backed agent results.
 */
export function createContextBoardBuild(
  state: BoardState,
  input: ContextBuildScope & { readonly now: string }
): ContextBoardBuild {
  const scope = normalizeScope(input);
  const now = normalizeIsoTime(input.now);
  const buildTaskId = taskId("context-build", {
    tenantId: scope.tenantId,
    requestKey: scope.requestKey
  });
  const graphTaskId = taskId("context-build-graph", { buildTaskId });
  const snapshotTaskId = taskId("context-input", { buildTaskId });
  const scoped = scopeMetadata(scope, buildTaskId);
  const existing = findTask(state, buildTaskId);
  if (existing) {
    if (
      existing.type !== contextBoardTaskTypes.build ||
      existing.metadata.tenantId !== scope.tenantId ||
      existing.metadata.repository !== scope.repository ||
      existing.metadata.ref !== scope.ref ||
      existing.metadata.requestKey !== scope.requestKey ||
      existing.metadata.refSequence !== scope.refSequence ||
      existing.metadata.commitSha !== scope.commitSha ||
      existing.metadata.githubInstallationId !== scope.githubInstallationId ||
      existing.metadata.derivationDetail !== scope.derivationDetail ||
      existing.metadata.derivationBudgetSeconds !== scope.derivationBudgetSeconds ||
      existing.metadata.derivationTokenBudget !== scope.derivationTokenBudget ||
      existing.metadata.trigger !== scope.trigger ||
      fingerprint(existing.metadata.priorRelease ?? null) !== fingerprint(scope.priorRelease ?? null)
    ) {
      throw new Error("context build request key is already bound to a different scope");
    }
  }

  let next = createTask(state, {
    id: buildTaskId,
    type: contextBoardTaskTypes.build,
    title: `Build context for ${scope.repository}@${scope.ref}`,
    role: "system",
    dedupeKey: `context:${scope.tenantId}:${scope.requestKey}`,
    kind: "aggregate",
    now,
    metadata: scoped,
    blocksParentCompletion: false
  });
  next = createTask(next, {
    id: graphTaskId,
    type: contextBoardTaskTypes.graph,
    title: `Materialize context task graph for ${scope.repository}@${scope.ref}`,
    role: "system",
    dedupeKey: `context:${buildTaskId}:graph`,
    kind: "manual",
    parentTaskId: buildTaskId,
    now,
    metadata: scoped
  });
  next = createTask(next, {
    id: snapshotTaskId,
    type: contextBoardTaskTypes.snapshot,
    title: `Snapshot context input for ${scope.repository}@${scope.ref}`,
    role: "context_worker",
    dedupeKey: `context:${buildTaskId}:input`,
    kind: "dispatchable",
    topic: contextBoardTopics.snapshot,
    parentTaskId: buildTaskId,
    now,
    metadata: scoped
  });
  return { state: reduceBoard(next, now), buildTaskId, graphTaskId, snapshotTaskId };
}

export function nextContextBoardRefSequence(
  state: BoardState,
  input: { readonly tenantId: string; readonly repository: string; readonly ref: string }
): number {
  const repository = normalizeRepository(input.repository);
  const sequences = state.tasks
    .filter(
      (task) =>
        task.type === contextBoardTaskTypes.build &&
        task.metadata.tenantId === input.tenantId &&
        task.metadata.repository === repository &&
        task.metadata.ref === input.ref
    )
    .map((task) => task.metadata.refSequence)
    .filter((value): value is number => Number.isSafeInteger(value) && Number(value) > 0);
  const next = Math.max(0, ...sequences) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("context board ref sequence exceeds the supported range");
  return next;
}

/** Adds the research lead after an immutable snapshot has been accepted. */
export function addContextResearchPlan(
  state: BoardState,
  input: {
    readonly buildTaskId: TaskId;
    readonly snapshotTaskId: TaskId;
    readonly snapshot: ContextArtifactRef;
    readonly now: string;
  }
): { readonly state: BoardState; readonly taskId: TaskId } {
  const task = requireContextBuild(state, input.buildTaskId);
  requireContextChild(state, input.snapshotTaskId, contextBoardTaskTypes.snapshot, task.id);
  assertScopedArtifact(task, input.snapshot);
  const now = normalizeIsoTime(input.now);
  const id = taskId("context-research-plan", { buildTaskId: task.id, snapshot: input.snapshot.sha256 });
  const next = createTask(state, {
    id,
    type: contextBoardTaskTypes.researchPlan,
    title: `Plan context research for ${String(task.metadata.repository)}`,
    role: "context_agent",
    dedupeKey: `context:${task.id}:research-plan:${input.snapshot.sha256}`,
    kind: "dispatchable",
    topic: contextBoardTopics.researchPlan,
    parentTaskId: task.id,
    dependencies: [blocks(id, input.snapshotTaskId)],
    now,
    metadata: childMetadata(task, { inputArtifact: input.snapshot })
  });
  return { state: reduceBoard(next, now), taskId: id };
}

/**
 * Materializes the agent-selected research fan-out and its join. The full plan
 * and worker packets remain in artifact storage.
 */
export function addContextResearchWork(
  state: BoardState,
  input: {
    readonly buildTaskId: TaskId;
    readonly researchPlanTaskId: TaskId;
    readonly plan: ContextArtifactRef;
    readonly work: readonly ContextResearchWork[];
    readonly now: string;
  }
): {
  readonly state: BoardState;
  readonly researchTaskIds: readonly TaskId[];
  readonly publicationPlanTaskId: TaskId;
} {
  if (input.work.length > MAX_RESEARCH_TASKS) {
    throw new Error(`context research plan exceeds ${MAX_RESEARCH_TASKS} tasks`);
  }
  uniqueKeys(input.work, "research");
  const build = requireContextBuild(state, input.buildTaskId);
  requireContextChild(state, input.researchPlanTaskId, contextBoardTaskTypes.researchPlan, build.id);
  assertScopedArtifact(build, input.plan);
  input.work.forEach((work) => assertScopedArtifact(build, work.input));
  const now = normalizeIsoTime(input.now);
  let next = state;
  const researchTaskIds = input.work.map((work) => {
    const id = taskId("context-research", { buildTaskId: build.id, key: work.key, plan: input.plan.sha256 });
    next = createTask(next, {
      id,
      type: contextBoardTaskTypes.research,
      title: work.title,
      role: "context_agent",
      dedupeKey: `context:${build.id}:research:${work.key}:${input.plan.sha256}`,
      kind: "dispatchable",
      topic: contextBoardTopics.research,
      parentTaskId: build.id,
      dependencies: [blocks(id, input.researchPlanTaskId)],
      now,
      metadata: childMetadata(build, {
        workKey: work.key,
        planArtifact: input.plan,
        inputArtifact: work.input
      })
    });
    return id;
  });
  const publicationPlanTaskId = taskId("context-publication-plan", {
    buildTaskId: build.id,
    plan: input.plan.sha256
  });
  next = createTask(next, {
    id: publicationPlanTaskId,
    type: contextBoardTaskTypes.publicationPlan,
    title: `Plan context publication for ${String(build.metadata.repository)}`,
    role: "context_agent",
    dedupeKey: `context:${build.id}:publication-plan:${input.plan.sha256}`,
    kind: "dispatchable",
    topic: contextBoardTopics.publicationPlan,
    parentTaskId: build.id,
    dependencies: [
      blocks(publicationPlanTaskId, input.researchPlanTaskId),
      ...researchTaskIds.map((id) => blocks(publicationPlanTaskId, id))
    ],
    now,
    metadata: childMetadata(build, { planArtifact: input.plan })
  });
  return { state: reduceBoard(next, now), researchTaskIds, publicationPlanTaskId };
}

/**
 * Creates a durable aggregate per page plus the final release gates. Audit
 * workers are independent of writers and receive only artifact references.
 */
export function addContextPublicationWork(
  state: BoardState,
  input: {
    readonly buildTaskId: TaskId;
    readonly graphTaskId: TaskId;
    readonly publicationPlanTaskId: TaskId;
    readonly plan: ContextArtifactRef;
    readonly pages: readonly ContextPageWork[];
    readonly now: string;
  }
): ContextPublicationGraph {
  if (input.pages.length === 0) throw new Error("context publication plan must contain at least one page");
  if (input.pages.length > MAX_PAGE_TASKS) throw new Error(`context publication plan exceeds ${MAX_PAGE_TASKS} pages`);
  uniqueKeys(input.pages, "page");
  const paths = new Set<string>();
  for (const page of input.pages) {
    const path = normalizedPagePath(page.path);
    if (paths.has(path)) throw new Error(`duplicate context page path: ${path}`);
    paths.add(path);
  }

  const build = requireContextBuild(state, input.buildTaskId);
  requireContextChild(state, input.graphTaskId, contextBoardTaskTypes.graph, build.id);
  requireContextChild(state, input.publicationPlanTaskId, contextBoardTaskTypes.publicationPlan, build.id);
  assertScopedArtifact(build, input.plan);
  input.pages.forEach((page) => assertScopedArtifact(build, page.input));
  const now = normalizeIsoTime(input.now);
  let next = state;
  const pageTaskIds = input.pages.map((page) => {
    const pageTaskId = taskId("context-page", { buildTaskId: build.id, key: page.key, plan: input.plan.sha256 });
    next = createTask(next, {
      id: pageTaskId,
      type: contextBoardTaskTypes.page,
      title: page.title,
      role: "system",
      dedupeKey: `context:${build.id}:page:${page.key}:${input.plan.sha256}`,
      kind: "aggregate",
      parentTaskId: build.id,
      dependencies: [blocks(pageTaskId, input.publicationPlanTaskId)],
      now,
      metadata: childMetadata(build, {
        pageKey: page.key,
        documentPath: normalizedPagePath(page.path),
        planArtifact: input.plan,
        pageChange: page.change ?? "add"
      })
    });
    const writeTaskId = taskId("context-page-write", { pageTaskId, pass: 0 });
    next = createTask(next, {
      id: writeTaskId,
      type: contextBoardTaskTypes.pageWrite,
      title: `Write ${page.path}`,
      role: "context_agent",
      dedupeKey: `context:${pageTaskId}:write:0`,
      kind: "dispatchable",
      topic: contextBoardTopics.pageWrite,
      parentTaskId: pageTaskId,
      dependencies: [blocks(writeTaskId, input.publicationPlanTaskId)],
      now,
      metadata: childMetadata(build, {
        pageTaskId,
        pageKey: page.key,
        documentPath: normalizedPagePath(page.path),
        planArtifact: input.plan,
        inputArtifact: page.input,
        pageChange: page.change ?? "add",
        pass: 0
      })
    });
    const auditTaskId = taskId("context-page-audit", { pageTaskId, pass: 0 });
    next = createTask(next, {
      id: auditTaskId,
      type: contextBoardTaskTypes.pageAudit,
      title: `Audit ${page.path}`,
      role: "context_auditor",
      dedupeKey: `context:${pageTaskId}:audit:0`,
      kind: "dispatchable",
      topic: contextBoardTopics.pageAudit,
      parentTaskId: pageTaskId,
      dependencies: [blocks(auditTaskId, writeTaskId)],
      now,
      metadata: childMetadata(build, {
        pageTaskId,
        pageKey: page.key,
        documentPath: normalizedPagePath(page.path),
        pass: 0
      })
    });
    return pageTaskId;
  });

  const sourceChallengeTaskId = gatedTaskId(build.id, "source-challenge", input.plan.sha256);
  next = createGate(next, build, {
    id: sourceChallengeTaskId,
    type: contextBoardTaskTypes.sourceChallenge,
    title: "Challenge context coverage against source",
    role: "context_auditor",
    topic: contextBoardTopics.sourceChallenge,
    key: `source-challenge:${input.plan.sha256}`,
    dependencies: pageTaskIds,
    now,
    metadata: { planArtifact: input.plan, pass: 0 }
  });
  const taskEvaluationTaskId = gatedTaskId(build.id, "task-evaluation", input.plan.sha256);
  next = createGate(next, build, {
    id: taskEvaluationTaskId,
    type: contextBoardTaskTypes.taskEvaluation,
    title: "Evaluate maintenance tasks from public context",
    role: "context_critic",
    topic: contextBoardTopics.taskEvaluation,
    key: `task-evaluation:${input.plan.sha256}`,
    dependencies: pageTaskIds,
    now,
    metadata: { planArtifact: input.plan, pass: 0 }
  });
  const certificationTaskId = gatedTaskId(build.id, "certification", input.plan.sha256);
  next = createGate(next, build, {
    id: certificationTaskId,
    type: contextBoardTaskTypes.certification,
    title: "Certify unchanged context snapshot",
    role: "context_auditor",
    topic: contextBoardTopics.certification,
    key: `certification:${input.plan.sha256}`,
    dependencies: [sourceChallengeTaskId, taskEvaluationTaskId],
    now,
    metadata: { planArtifact: input.plan }
  });
  const publicationTaskId = gatedTaskId(build.id, "publication", input.plan.sha256);
  next = createGate(next, build, {
    id: publicationTaskId,
    type: contextBoardTaskTypes.publication,
    title: "Publish certified context release",
    role: "context_worker",
    topic: contextBoardTopics.publication,
    key: `publication:${input.plan.sha256}`,
    dependencies: [certificationTaskId],
    now,
    metadata: { planArtifact: input.plan }
  });
  const pageIndexTaskId = gatedTaskId(build.id, "pageindex", input.plan.sha256);
  next = createGate(next, build, {
    id: pageIndexTaskId,
    type: contextBoardTaskTypes.pageIndex,
    title: "Build PageIndex context tree",
    role: "context_worker",
    topic: contextBoardTopics.pageIndex,
    key: `pageindex:${input.plan.sha256}`,
    dependencies: [publicationTaskId],
    now,
    metadata: { planArtifact: input.plan }
  });

  const sealed = applyCommand(
    next,
    { command: "TransitionTask", taskId: input.graphTaskId, toStatus: "done" },
    { actor: SYSTEM_ACTOR, now }
  );
  if (!sealed.accepted) {
    throw new Error(`context build graph could not be sealed: ${sealed.rejection?.reason ?? "unknown"}`);
  }

  return {
    state: reduceBoard(sealed.state, now),
    pageTaskIds,
    sourceChallengeTaskId,
    taskEvaluationTaskId,
    certificationTaskId,
    publicationTaskId,
    pageIndexTaskId
  };
}

/**
 * Adds a bounded repair/audit pair before the caller completes the prior audit
 * and reduces the board. This atomic ordering prevents the page aggregate from
 * completing in the gap between an unsupported verdict and its repair.
 */
export function addContextPageRepairCycle(
  state: BoardState,
  input: {
    readonly pageTaskId: TaskId;
    readonly priorAuditTaskId: TaskId;
    readonly findings: ContextArtifactRef;
    readonly pass: number;
    readonly now: string;
  }
): { readonly state: BoardState; readonly repairTaskId: TaskId; readonly auditTaskId: TaskId } {
  if (!Number.isInteger(input.pass) || input.pass < 1 || input.pass > MAX_CONTEXT_OPERATOR_REMEDIATION_PASS) {
    throw new Error(`context page repair pass must be between 1 and ${MAX_CONTEXT_OPERATOR_REMEDIATION_PASS}`);
  }
  const page = findTask(state, input.pageTaskId);
  if (!page || page.type !== contextBoardTaskTypes.page || !page.parentTaskId) {
    throw new Error("context page task not found");
  }
  const build = requireContextBuild(state, page.parentTaskId);
  const priorAudit = requireContextChild(state, input.priorAuditTaskId, contextBoardTaskTypes.pageAudit, page.id);
  if (priorAudit.metadata.pass !== input.pass - 1) {
    throw new Error("context page repair input does not belong to the preceding pass");
  }
  assertScopedArtifact(build, input.findings);
  const documentPath = String(page.metadata.documentPath);
  const now = normalizeIsoTime(input.now);
  const repairTaskId = taskId("context-page-repair", { pageTaskId: page.id, pass: input.pass });
  let next = createTask(state, {
    id: repairTaskId,
    type: contextBoardTaskTypes.pageRepair,
    title: `Repair ${documentPath} (pass ${input.pass})`,
    role: "context_agent",
    dedupeKey: `context:${page.id}:repair:${input.pass}`,
    kind: "dispatchable",
    topic: contextBoardTopics.pageRepair,
    parentTaskId: page.id,
    dependencies: [blocks(repairTaskId, input.priorAuditTaskId)],
    now,
    metadata: childMetadata(build, {
      pageTaskId: page.id,
      pageKey: page.metadata.pageKey,
      documentPath,
      findingsArtifact: input.findings,
      pass: input.pass
    })
  });
  const auditTaskId = taskId("context-page-audit", { pageTaskId: page.id, pass: input.pass });
  next = createTask(next, {
    id: auditTaskId,
    type: contextBoardTaskTypes.pageAudit,
    title: `Audit ${documentPath} (pass ${input.pass})`,
    role: "context_auditor",
    dedupeKey: `context:${page.id}:audit:${input.pass}`,
    kind: "dispatchable",
    topic: contextBoardTopics.pageAudit,
    parentTaskId: page.id,
    dependencies: [blocks(auditTaskId, repairTaskId)],
    now,
    metadata: childMetadata(build, {
      pageTaskId: page.id,
      pageKey: page.metadata.pageKey,
      documentPath,
      pass: input.pass
    })
  });
  return { state: next, repairTaskId, auditTaskId };
}

/**
 * Materializes one durable global repair pass. The repair waits for both
 * parallel gates, and certification is atomically linked to the successor
 * gates before the failing gate can complete. This keeps the complete
 * challenge/repair/rechallenge loop visible and resumable on the board.
 */
export function addContextGateRepairRound(
  state: BoardState,
  input: {
    readonly buildTaskId: TaskId;
    readonly sourceChallengeTaskId: TaskId;
    readonly taskEvaluationTaskId: TaskId;
    readonly pass: number;
    readonly now: string;
  }
): ContextGateRepairGraph {
  if (!Number.isInteger(input.pass) || input.pass < 1 || input.pass > MAX_CONTEXT_OPERATOR_REMEDIATION_PASS) {
    throw new Error(`context gate repair pass must be between 1 and ${MAX_CONTEXT_OPERATOR_REMEDIATION_PASS}`);
  }
  const build = requireContextBuild(state, input.buildTaskId);
  const priorChallenge = requireContextChild(
    state,
    input.sourceChallengeTaskId,
    contextBoardTaskTypes.sourceChallenge,
    build.id
  );
  const priorEvaluation = requireContextChild(
    state,
    input.taskEvaluationTaskId,
    contextBoardTaskTypes.taskEvaluation,
    build.id
  );
  const priorPass = input.pass - 1;
  if (priorChallenge.metadata.pass !== priorPass || priorEvaluation.metadata.pass !== priorPass) {
    throw new Error("context gate repair inputs do not belong to the preceding pass");
  }
  const plan = parsedArtifact(priorChallenge.metadata.planArtifact, "source challenge planArtifact");
  const evaluationPlan = parsedArtifact(priorEvaluation.metadata.planArtifact, "task evaluation planArtifact");
  assertScopedArtifact(build, plan);
  assertScopedArtifact(build, evaluationPlan);
  if (plan.key !== evaluationPlan.key || plan.sha256 !== evaluationPlan.sha256) {
    throw new Error("context gate repair inputs reference different publication plans");
  }
  const certification = state.tasks.find(
    (task) => task.parentTaskId === build.id && task.type === contextBoardTaskTypes.certification
  );
  if (!certification) throw new Error("context certification task not found");
  const now = normalizeIsoTime(input.now);
  const repairTaskId = gatedTaskId(build.id, "gap-repair", `${plan.sha256}:${input.pass}`);
  let next = createGate(state, build, {
    id: repairTaskId,
    type: contextBoardTaskTypes.gapRepair,
    title: `Repair context gaps (pass ${input.pass})`,
    role: "context_agent",
    topic: contextBoardTopics.gapRepair,
    key: `gap-repair:${plan.sha256}:${input.pass}`,
    dependencies: [priorChallenge.id, priorEvaluation.id],
    now,
    metadata: { planArtifact: plan, pass: input.pass }
  });
  const sourceChallengeTaskId = gatedTaskId(build.id, "source-challenge", `${plan.sha256}:${input.pass}`);
  next = createGate(next, build, {
    id: sourceChallengeTaskId,
    type: contextBoardTaskTypes.sourceChallenge,
    title: `Challenge repaired context against source (pass ${input.pass})`,
    role: "context_auditor",
    topic: contextBoardTopics.sourceChallenge,
    key: `source-challenge:${plan.sha256}:${input.pass}`,
    dependencies: [repairTaskId],
    now,
    metadata: { planArtifact: plan, pass: input.pass }
  });
  const taskEvaluationTaskId = gatedTaskId(build.id, "task-evaluation", `${plan.sha256}:${input.pass}`);
  next = createGate(next, build, {
    id: taskEvaluationTaskId,
    type: contextBoardTaskTypes.taskEvaluation,
    title: `Evaluate repaired context tasks (pass ${input.pass})`,
    role: "context_critic",
    topic: contextBoardTopics.taskEvaluation,
    key: `task-evaluation:${plan.sha256}:${input.pass}`,
    dependencies: [repairTaskId],
    now,
    metadata: { planArtifact: plan, pass: input.pass }
  });
  next = linkRequiredTask(next, certification.id, sourceChallengeTaskId, now);
  next = linkRequiredTask(next, certification.id, taskEvaluationTaskId, now);
  return {
    state: reduceBoard(next, now),
    repairTaskId,
    sourceChallengeTaskId,
    taskEvaluationTaskId
  };
}

export function failContextPageRepairExhausted(
  state: BoardState,
  input: {
    readonly pageTaskId: TaskId;
    readonly priorAuditTaskId: TaskId;
    readonly pass: number;
    readonly now: string;
  }
): BoardState {
  if (
    !Number.isInteger(input.pass) ||
    input.pass < MAX_CONTEXT_REPAIR_PASS ||
    input.pass > MAX_CONTEXT_OPERATOR_REMEDIATION_PASS
  ) {
    throw new Error(
      `context page exhaustion requires a pass between ${MAX_CONTEXT_REPAIR_PASS} and ${MAX_CONTEXT_OPERATOR_REMEDIATION_PASS}`
    );
  }
  const page = findTask(state, input.pageTaskId);
  if (!page || page.type !== contextBoardTaskTypes.page || !page.parentTaskId) {
    throw new Error("context page task not found");
  }
  const audit = requireContextChild(state, input.priorAuditTaskId, contextBoardTaskTypes.pageAudit, page.id);
  if (audit.metadata.pass !== input.pass) {
    throw new Error("context exhausted page audit does not belong to the terminal pass");
  }
  const now = normalizeIsoTime(input.now);
  let next = applyCommand(
    state,
    {
      command: "CommentTask",
      taskId: page.id,
      eventType: "context.page_repair_exhausted",
      payload: {
        pass: input.pass,
        reason: "citation support remained incomplete after the bounded repair policy"
      }
    },
    { actor: SYSTEM_ACTOR, now }
  ).state;
  const failed = applyCommand(
    next,
    { command: "TransitionTask", taskId: page.id, toStatus: "failed" },
    { actor: SYSTEM_ACTOR, now }
  );
  if (!failed.accepted) {
    throw new Error(`context page exhaustion transition rejected: ${failed.rejection?.reason ?? "unknown"}`);
  }
  next = failed.state;
  return next;
}

export interface ResumeContextPageExhaustionInput {
  readonly buildTaskId: TaskId;
  readonly pageTaskId: TaskId;
  readonly requestKey: string;
  readonly actorId: string;
  readonly reason: string;
  readonly now: string;
}

export interface ResumeContextPageExhaustionResult {
  readonly state: BoardState;
  readonly replay: boolean;
  readonly pass: number;
  readonly repairTaskId: TaskId;
  readonly auditTaskId: TaskId;
  readonly reopenedTaskIds: readonly TaskId[];
}

/**
 * Resumes one bounded page-quality exhaustion from its immutable page and audit
 * checkpoints. This is an explicit operator action, not an extension of the
 * automatic loop: each request adds exactly one targeted repair/audit pair and
 * remains capped independently of ordinary model retries. Dispatchable
 * siblings canceled by the failed build wait for that audit before they resume,
 * so repeated remediation does not restart unrelated expensive agent work.
 */
export function resumeContextPageExhaustion(
  state: BoardState,
  input: ResumeContextPageExhaustionInput
): ResumeContextPageExhaustionResult {
  const now = normalizeIsoTime(input.now);
  const priorReceipt = state.events.find(
    (event) =>
      event.type === "context.page_operator_remediation_scheduled" && event.payload?.requestKey === input.requestKey
  );
  if (priorReceipt) {
    if (priorReceipt.taskId !== input.pageTaskId || priorReceipt.payload?.buildTaskId !== input.buildTaskId) {
      throw new Error("context page remediation requestKey was already used for another page");
    }
    const pass = requiredInteger(priorReceipt.payload?.pass, "context page remediation pass");
    const repairTaskId = requiredTaskId(priorReceipt.payload?.repairTaskId, "context page remediation repairTaskId");
    const auditTaskId = requiredTaskId(priorReceipt.payload?.auditTaskId, "context page remediation auditTaskId");
    return {
      state,
      replay: true,
      pass,
      repairTaskId,
      auditTaskId,
      reopenedTaskIds: arrayTaskIds(priorReceipt.payload?.reopenedTaskIds)
    };
  }

  const build = requireContextBuild(state, input.buildTaskId);
  const page = requireContextChild(state, input.pageTaskId, contextBoardTaskTypes.page, build.id);
  if (build.status !== "failed" || page.status !== "failed") {
    throw new Error("context page remediation requires a failed build and failed page");
  }
  const exhaustion = [...state.events]
    .reverse()
    .find((event) => event.taskId === page.id && event.type === "context.page_repair_exhausted");
  if (!exhaustion) throw new Error("context page did not fail from bounded repair exhaustion");

  const priorAudit = state.tasks
    .filter(
      (task) =>
        task.parentTaskId === page.id &&
        task.type === contextBoardTaskTypes.pageAudit &&
        task.status === "done" &&
        Number.isSafeInteger(task.metadata.pass)
    )
    .sort((left, right) => Number(right.metadata.pass) - Number(left.metadata.pass))[0];
  if (!priorAudit) throw new Error("context page remediation requires a completed prior audit");
  const priorPass = Number(priorAudit.metadata.pass);
  const pass = priorPass + 1;
  if (pass > MAX_CONTEXT_OPERATOR_REMEDIATION_PASS) {
    throw new Error(`context page remediation cannot exceed pass ${MAX_CONTEXT_OPERATOR_REMEDIATION_PASS}`);
  }
  const findings = completedOutputArtifact(state, priorAudit.id);

  const reopened = reopenFailedAggregateBranch(state, {
    buildTaskId: build.id,
    aggregateTaskId: page.id,
    requestKey: input.requestKey,
    actorId: input.actorId,
    reason: input.reason,
    now
  });
  if (reopened.replay) {
    throw new Error("aggregate recovery replay is missing its context remediation receipt");
  }
  const expanded = addContextPageRepairCycle(reopened.state, {
    pageTaskId: page.id,
    priorAuditTaskId: priorAudit.id,
    findings,
    pass,
    now
  });
  const reopenedTaskIds = reopened.reopenedTaskIds;
  let gatedState = expanded.state;
  for (const taskId of reopenedTaskIds) {
    const prior = findTask(state, taskId);
    const current = findTask(gatedState, taskId);
    if (prior?.status !== "canceled" || current?.kind !== "dispatchable") continue;
    gatedState = addDependency(gatedState, blocks(current.id, expanded.auditTaskId), now);
  }
  const withReceipt = appendEvent(gatedState, "context.page_operator_remediation_scheduled", now, page.id, {
    actor: input.actorId,
    buildTaskId: build.id,
    requestKey: input.requestKey,
    reason: input.reason,
    pass,
    priorAuditTaskId: priorAudit.id,
    repairTaskId: expanded.repairTaskId,
    auditTaskId: expanded.auditTaskId,
    reopenedTaskIds
  });
  return {
    state: reduceBoard(withReceipt, now),
    replay: false,
    pass,
    repairTaskId: expanded.repairTaskId,
    auditTaskId: expanded.auditTaskId,
    reopenedTaskIds
  };
}

export interface ResumeContextGateExhaustionInput {
  readonly buildTaskId: TaskId;
  readonly requestKey: string;
  readonly actorId: string;
  readonly reason: string;
  readonly now: string;
}

export interface ResumeContextGateExhaustionResult {
  readonly state: BoardState;
  readonly replay: boolean;
  readonly pass: number;
  readonly repairTaskId: TaskId;
  readonly sourceChallengeTaskId: TaskId;
  readonly taskEvaluationTaskId: TaskId;
  readonly reopenedTaskIds: readonly TaskId[];
}

/**
 * Continues a source/task gate exhaustion from the latest immutable draft and
 * gate checkpoints. Automatic convergence remains capped separately; each
 * explicit operator request adds exactly one repair/challenge/evaluation round.
 */
export function resumeContextGateExhaustion(
  state: BoardState,
  input: ResumeContextGateExhaustionInput
): ResumeContextGateExhaustionResult {
  const now = normalizeIsoTime(input.now);
  const priorReceipt = state.events.find(
    (event) =>
      event.type === "context.gate_operator_remediation_scheduled" && event.payload?.requestKey === input.requestKey
  );
  if (priorReceipt) {
    if (priorReceipt.taskId !== input.buildTaskId) {
      throw new Error("context gate remediation requestKey was already used for another build");
    }
    return {
      state,
      replay: true,
      pass: requiredInteger(priorReceipt.payload?.pass, "context gate remediation pass"),
      repairTaskId: requiredTaskId(priorReceipt.payload?.repairTaskId, "context gate remediation repairTaskId"),
      sourceChallengeTaskId: requiredTaskId(
        priorReceipt.payload?.sourceChallengeTaskId,
        "context gate remediation sourceChallengeTaskId"
      ),
      taskEvaluationTaskId: requiredTaskId(
        priorReceipt.payload?.taskEvaluationTaskId,
        "context gate remediation taskEvaluationTaskId"
      ),
      reopenedTaskIds: arrayTaskIds(priorReceipt.payload?.reopenedTaskIds)
    };
  }

  const build = requireContextBuild(state, input.buildTaskId);
  if (build.status !== "failed") {
    throw new Error("context gate remediation requires a failed build");
  }
  const certification = state.tasks.find(
    (task) => task.parentTaskId === build.id && task.type === contextBoardTaskTypes.certification
  );
  if (!certification || certification.status !== "canceled") {
    throw new Error("context gate remediation requires canceled certification");
  }
  const exhaustion = [...state.events]
    .reverse()
    .find((event) => event.taskId === certification.id && event.type === "context.gate_repair_exhausted");
  if (!exhaustion) throw new Error("context certification did not fail from bounded gate exhaustion");
  const priorPass = requiredInteger(exhaustion.payload?.pass, "context gate exhaustion pass");
  const pass = priorPass + 1;
  if (pass > MAX_CONTEXT_OPERATOR_REMEDIATION_PASS) {
    throw new Error(`context gate remediation cannot exceed pass ${MAX_CONTEXT_OPERATOR_REMEDIATION_PASS}`);
  }
  const priorChallenge = latestContextGate(state, build.id, contextBoardTaskTypes.sourceChallenge, priorPass);
  const priorEvaluation = latestContextGate(state, build.id, contextBoardTaskTypes.taskEvaluation, priorPass);

  const recoverableTypes = new Set<ContextBoardTaskType>([
    contextBoardTaskTypes.certification,
    contextBoardTaskTypes.publication,
    contextBoardTaskTypes.pageIndex,
    contextBoardTaskTypes.sourceChallenge,
    contextBoardTaskTypes.taskEvaluation
  ]);
  const buildTasks = state.tasks.filter((task) => task.id === build.id || task.metadata.contextBuildId === build.id);
  if (
    buildTasks.some(
      (task) =>
        task.status === "superseded" ||
        (task.status === "failed" && task.id !== build.id) ||
        (task.status === "canceled" &&
          (!recoverableTypes.has(task.type as ContextBoardTaskType) ||
            (task.type === contextBoardTaskTypes.sourceChallenge && task.id !== priorChallenge.id) ||
            (task.type === contextBoardTaskTypes.taskEvaluation && task.id !== priorEvaluation.id)))
    )
  ) {
    throw new Error("context gate remediation found terminal work outside the exhausted gate branch");
  }
  const reopenable = buildTasks.filter(
    (task) => task.id === build.id || task.id === certification.id || task.status === "canceled"
  );
  const reopenableIds = new Set(reopenable.map((task) => task.id));
  let next = state;
  for (const message of state.outbox) {
    if (reopenableIds.has(message.taskId) && message.status !== "dispatched") {
      next = markOutboxDispatched(next, message.id, now);
    }
  }
  for (const task of reopenable) {
    next = appendEvent(
      {
        ...next,
        tasks: next.tasks.map((candidate) =>
          candidate.id === task.id ? { ...candidate, status: "triage", updatedAt: now } : candidate
        )
      },
      "task.operator_reopened",
      now,
      task.id,
      {
        actor: input.actorId,
        requestKey: input.requestKey,
        fromStatus: task.status,
        reason: input.reason,
        buildTaskId: build.id
      }
    );
  }
  const expanded = addContextGateRepairRound(next, {
    buildTaskId: build.id,
    sourceChallengeTaskId: priorChallenge.id,
    taskEvaluationTaskId: priorEvaluation.id,
    pass,
    now
  });
  const withReceipt = appendEvent(expanded.state, "context.gate_operator_remediation_scheduled", now, build.id, {
    actor: input.actorId,
    requestKey: input.requestKey,
    reason: input.reason,
    pass,
    repairTaskId: expanded.repairTaskId,
    sourceChallengeTaskId: expanded.sourceChallengeTaskId,
    taskEvaluationTaskId: expanded.taskEvaluationTaskId,
    reopenedTaskIds: reopenable.map((task) => task.id)
  });
  return {
    state: reduceBoard(withReceipt, now),
    replay: false,
    pass,
    repairTaskId: expanded.repairTaskId,
    sourceChallengeTaskId: expanded.sourceChallengeTaskId,
    taskEvaluationTaskId: expanded.taskEvaluationTaskId,
    reopenedTaskIds: reopenable.map((task) => task.id)
  };
}

export function failContextGateRepairExhausted(
  state: BoardState,
  input: {
    readonly buildTaskId: TaskId;
    readonly sourceChallengeTaskId: TaskId;
    readonly taskEvaluationTaskId: TaskId;
    readonly pass: number;
    readonly now: string;
  }
): BoardState {
  if (input.pass !== MAX_CONTEXT_GATE_REPAIR_PASS) {
    throw new Error(`context gate exhaustion requires pass ${MAX_CONTEXT_GATE_REPAIR_PASS}`);
  }
  const build = requireContextBuild(state, input.buildTaskId);
  const challenge = requireContextChild(
    state,
    input.sourceChallengeTaskId,
    contextBoardTaskTypes.sourceChallenge,
    build.id
  );
  const evaluation = requireContextChild(
    state,
    input.taskEvaluationTaskId,
    contextBoardTaskTypes.taskEvaluation,
    build.id
  );
  if (challenge.metadata.pass !== input.pass || evaluation.metadata.pass !== input.pass) {
    throw new Error("context exhausted gates do not belong to the terminal pass");
  }
  const certification = state.tasks.find(
    (task) => task.parentTaskId === build.id && task.type === contextBoardTaskTypes.certification
  );
  if (!certification) throw new Error("context certification task not found");
  const now = normalizeIsoTime(input.now);
  let next = applyCommand(
    state,
    {
      command: "CommentTask",
      taskId: certification.id,
      eventType: "context.gate_repair_exhausted",
      payload: {
        pass: input.pass,
        reason: "source or maintenance-task gaps remained after the bounded repair policy"
      }
    },
    { actor: SYSTEM_ACTOR, now }
  ).state;
  const canceled = applyCommand(
    next,
    { command: "TransitionTask", taskId: certification.id, toStatus: "canceled" },
    { actor: SYSTEM_ACTOR, now }
  );
  if (!canceled.accepted) {
    throw new Error(`context certification exhaustion transition rejected: ${canceled.rejection?.reason ?? "unknown"}`);
  }
  next = canceled.state;
  return reduceBoard(next, now);
}

export function assertContextBoardMetadata(metadata: Record<string, unknown>): void {
  assertJsonValue(metadata, "$");
  const bytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
  if (bytes > MAX_CONTEXT_METADATA_BYTES) {
    throw new Error(`context task metadata exceeds ${MAX_CONTEXT_METADATA_BYTES} bytes`);
  }
  for (const forbidden of ["body", "content", "prompt", "transcript", "evidence", "report"]) {
    if (containsKey(metadata, forbidden)) {
      throw new Error(`context task metadata must reference ${forbidden} as an artifact`);
    }
  }
}

function definition(
  type: ContextBoardTaskType,
  kind: TaskTypeDefinition["kind"],
  defaultAssigneeRole: string,
  description: string,
  dispatchTopic?: ContextBoardTopic
): TaskTypeDefinition {
  return { type, kind, defaultAssigneeRole, description, ...(dispatchTopic ? { dispatchTopic } : {}) };
}

function createGate(
  state: BoardState,
  build: NonNullable<ReturnType<typeof findTask>>,
  input: {
    readonly id: TaskId;
    readonly type: ContextBoardTaskType;
    readonly title: string;
    readonly role: string;
    readonly topic: ContextBoardTopic;
    readonly key: string;
    readonly dependencies: readonly TaskId[];
    readonly now: IsoTimestamp;
    readonly metadata: Record<string, unknown>;
  }
): BoardState {
  return createTask(state, {
    id: input.id,
    type: input.type,
    title: input.title,
    role: input.role,
    dedupeKey: `context:${build.id}:${input.key}`,
    kind: "dispatchable",
    topic: input.topic,
    parentTaskId: build.id,
    dependencies: input.dependencies.map((dependency) => blocks(input.id, dependency)),
    now: input.now,
    metadata: childMetadata(build, input.metadata)
  });
}

function createTask(
  state: BoardState,
  input: {
    readonly id: TaskId;
    readonly type: ContextBoardTaskType;
    readonly title: string;
    readonly role: string;
    readonly dedupeKey: string;
    readonly kind: "aggregate" | "dispatchable" | "manual";
    readonly topic?: ContextBoardTopic;
    readonly parentTaskId?: TaskId;
    readonly dependencies?: readonly TaskDependencyDraft[];
    readonly now: IsoTimestamp;
    readonly metadata: Record<string, unknown>;
    readonly blocksParentCompletion?: boolean;
  }
): BoardState {
  assertContextBoardMetadata(input.metadata);
  const result = applyCommand(
    state,
    {
      command: "CreateTask",
      task: {
        id: input.id,
        type: input.type,
        title: input.title,
        assigneeRole: input.role,
        dedupeKey: input.dedupeKey,
        kind: input.kind,
        ...(input.topic ? { dispatchTopic: input.topic } : {}),
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
        metadata: input.metadata
      },
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      ...(input.blocksParentCompletion === false ? { blocksParentCompletion: false } : {})
    },
    { actor: SYSTEM_ACTOR, now: input.now }
  );
  if (!result.accepted) throw new Error(`context board task rejected: ${result.rejection?.reason ?? "unknown"}`);
  if (!input.parentTaskId) return result.state;
  const parent = findTask(result.state, input.parentTaskId);
  if (parent?.kind !== "aggregate") return result.state;
  const linked = applyCommand(
    result.state,
    { command: "LinkTask", dependency: blocks(parent.id, input.id) },
    { actor: SYSTEM_ACTOR, now: input.now }
  );
  if (!linked.accepted) {
    throw new Error(`context parent dependency rejected: ${linked.rejection?.reason ?? "unknown"}`);
  }
  return linked.state;
}

function linkRequiredTask(state: BoardState, taskId: TaskId, dependsOnTaskId: TaskId, now: IsoTimestamp): BoardState {
  const linked = applyCommand(
    state,
    { command: "LinkTask", dependency: blocks(taskId, dependsOnTaskId) },
    { actor: SYSTEM_ACTOR, now }
  );
  if (!linked.accepted) {
    throw new Error(`context task dependency rejected: ${linked.rejection?.reason ?? "unknown"}`);
  }
  return linked.state;
}

function requireContextBuild(state: BoardState, id: TaskId) {
  const task = findTask(state, id);
  if (!task || task.type !== contextBoardTaskTypes.build || task.kind !== "aggregate") {
    throw new Error("context build task not found");
  }
  return task;
}

function latestContextGate(
  state: BoardState,
  buildTaskId: TaskId,
  type: typeof contextBoardTaskTypes.sourceChallenge | typeof contextBoardTaskTypes.taskEvaluation,
  pass: number
) {
  const task = state.tasks.find(
    (candidate) => candidate.parentTaskId === buildTaskId && candidate.type === type && candidate.metadata.pass === pass
  );
  if (!task) throw new Error(`context gate ${type} pass ${pass} not found`);
  return task;
}

function requireContextChild(state: BoardState, id: TaskId, type: ContextBoardTaskType, parentTaskId: TaskId) {
  const task = findTask(state, id);
  if (!task || task.type !== type || task.parentTaskId !== parentTaskId) {
    throw new Error(`context ${type} task not found in the expected build`);
  }
  return task;
}

function assertScopedArtifact(build: NonNullable<ReturnType<typeof findTask>>, artifact: ContextArtifactRef): void {
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error("context artifact digest is invalid");
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new Error("context artifact size is invalid");
  if (!artifact.contentType.trim() || !artifact.uri.trim()) throw new Error("context artifact metadata is incomplete");
  if (
    !isContextArtifactKeyInScope(artifact.key, {
      tenantId: String(build.metadata.tenantId),
      repository: String(build.metadata.repository),
      buildId: build.id
    })
  ) {
    throw new Error("context artifact does not belong to the task's tenant, repository, and build");
  }
}

function normalizeScope(input: ContextBuildScope): ContextBuildScope {
  const tenantId = input.tenantId.trim();
  const ref = input.ref.trim();
  const requestKey = input.requestKey.trim();
  if (!tenantId) throw new Error("tenantId is required");
  if (!ref) throw new Error("ref is required");
  if (!requestKey) throw new Error("requestKey is required");
  if (!Number.isSafeInteger(input.refSequence) || input.refSequence < 1) {
    throw new Error("refSequence must be a positive integer");
  }
  if (input.commitSha && !isFullCommitSha(input.commitSha)) throw new Error("commitSha must be a full Git SHA");
  if (input.derivationDetail !== undefined && !isDerivationDetail(input.derivationDetail)) {
    throw new Error("derivationDetail is invalid");
  }
  if (
    input.githubInstallationId !== undefined &&
    (!Number.isSafeInteger(input.githubInstallationId) || input.githubInstallationId < 1)
  ) {
    throw new Error("githubInstallationId must be a positive integer");
  }
  if (
    input.derivationBudgetSeconds !== undefined &&
    (!Number.isSafeInteger(input.derivationBudgetSeconds) || input.derivationBudgetSeconds < 1)
  ) {
    throw new Error("derivationBudgetSeconds must be a positive integer");
  }
  if (
    input.derivationTokenBudget !== undefined &&
    (!Number.isSafeInteger(input.derivationTokenBudget) || input.derivationTokenBudget < 1)
  ) {
    throw new Error("derivationTokenBudget must be a positive integer");
  }
  const repository = normalizeRepository(input.repository);
  const priorRelease = input.priorRelease === undefined ? undefined : parseContextPriorReleaseSeed(input.priorRelease);
  if (
    priorRelease &&
    (priorRelease.tenantId !== tenantId ||
      priorRelease.repository !== repository ||
      priorRelease.ref !== ref ||
      priorRelease.refSequence >= input.refSequence)
  ) {
    throw new Error("prior Context release does not precede the exact build scope");
  }
  return {
    tenantId,
    repository,
    ref,
    refSequence: input.refSequence,
    requestKey,
    ...(input.commitSha ? { commitSha: input.commitSha.toLowerCase() } : {}),
    ...(input.githubInstallationId ? { githubInstallationId: input.githubInstallationId } : {}),
    ...(input.derivationDetail ? { derivationDetail: input.derivationDetail } : {}),
    ...(input.derivationBudgetSeconds ? { derivationBudgetSeconds: input.derivationBudgetSeconds } : {}),
    ...(input.derivationTokenBudget ? { derivationTokenBudget: input.derivationTokenBudget } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(priorRelease ? { priorRelease } : {})
  };
}

function scopeMetadata(scope: ContextBuildScope, buildTaskId: TaskId): Record<string, unknown> {
  return {
    workflowVersion: 1,
    contextBuildId: buildTaskId,
    tenantId: scope.tenantId,
    repository: scope.repository,
    ref: scope.ref,
    refSequence: scope.refSequence,
    requestKey: scope.requestKey,
    ...(scope.commitSha ? { commitSha: scope.commitSha } : {}),
    ...(scope.githubInstallationId ? { githubInstallationId: scope.githubInstallationId } : {}),
    ...(scope.derivationDetail ? { derivationDetail: scope.derivationDetail } : {}),
    ...(scope.derivationBudgetSeconds ? { derivationBudgetSeconds: scope.derivationBudgetSeconds } : {}),
    ...(scope.derivationTokenBudget ? { derivationTokenBudget: scope.derivationTokenBudget } : {}),
    ...(scope.trigger ? { trigger: scope.trigger } : {}),
    ...(scope.priorRelease ? { priorRelease: scope.priorRelease } : {})
  };
}

function childMetadata(
  build: NonNullable<ReturnType<typeof findTask>>,
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return {
    workflowVersion: 1,
    contextBuildId: build.id,
    tenantId: build.metadata.tenantId,
    repository: build.metadata.repository,
    ref: build.metadata.ref,
    refSequence: build.metadata.refSequence,
    requestKey: build.metadata.requestKey,
    ...(build.metadata.commitSha ? { commitSha: build.metadata.commitSha } : {}),
    ...(build.metadata.githubInstallationId ? { githubInstallationId: build.metadata.githubInstallationId } : {}),
    ...(build.metadata.derivationDetail ? { derivationDetail: build.metadata.derivationDetail } : {}),
    ...(build.metadata.derivationBudgetSeconds
      ? { derivationBudgetSeconds: build.metadata.derivationBudgetSeconds }
      : {}),
    ...(build.metadata.derivationTokenBudget ? { derivationTokenBudget: build.metadata.derivationTokenBudget } : {}),
    ...(build.metadata.priorRelease ? { priorRelease: build.metadata.priorRelease } : {}),
    ...metadata
  };
}

function taskId(kind: string, identity: unknown): TaskId {
  return entityId<"task">(`task_${fingerprint({ kind, identity }).slice(0, 32)}`);
}

function gatedTaskId(buildTaskId: TaskId, kind: string, planDigest: string): TaskId {
  return taskId(`context-${kind}`, { buildTaskId, planDigest });
}

function blocks(taskId: TaskId, dependsOnTaskId: TaskId): TaskDependencyDraft {
  return {
    taskId,
    dependsOnTaskId,
    relationship: "blocks",
    required: true,
    blocksParentCompletion: true
  };
}

function normalizedPagePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized.endsWith(".md") ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`invalid context page path: ${value}`);
  }
  return normalized;
}

function uniqueKeys(items: readonly { readonly key: string }[], kind: string): void {
  const keys = new Set<string>();
  for (const item of items) {
    const key = item.key.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(key)) throw new Error(`invalid ${kind} key: ${item.key}`);
    if (keys.has(key)) throw new Error(`duplicate ${kind} key: ${key}`);
    keys.add(key);
  }
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredTaskId(value: unknown, name: string): TaskId {
  const normalized = requiredBoundedString(value, name, 240);
  if (!normalized.startsWith("task_")) throw new Error(`${name} must be a task ID`);
  return entityId<"task">(normalized);
}

function arrayTaskIds(value: unknown): readonly TaskId[] {
  if (!Array.isArray(value)) throw new Error("context remediation reopenedTaskIds must be an array");
  return value.map((item, index) => requiredTaskId(item, `context remediation reopenedTaskIds[${index}]`));
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function completedOutputArtifact(state: BoardState, taskId: TaskId): ContextArtifactRef {
  const event = [...state.events]
    .reverse()
    .find(
      (candidate) =>
        candidate.taskId === taskId &&
        candidate.type.endsWith(".completed") &&
        candidate.payload?.outputArtifact !== undefined
    );
  if (!event?.payload) throw new Error("context remediation prior audit has no completed output artifact");
  return parsedArtifact(event.payload.outputArtifact, "context remediation findings artifact");
}

function requiredBoundedString(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maximumLength} characters`);
  }
  return value.trim();
}

function requiredBoundedStrings(
  value: unknown,
  name: string,
  maximumItems: number,
  maximumLength: number
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${name} must contain at most ${maximumItems} items`);
  }
  return value.map((item, index) => requiredBoundedString(item, `${name}[${index}]`, maximumLength));
}

function requiredKey(value: unknown, name: string): string {
  const key = requiredBoundedString(value, name, 96);
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(key)) throw new Error(`${name} is invalid`);
  return key;
}

function requiredDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a SHA-256 digest`);
  }
  return value;
}

function requiredCount(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

function requiredEnum<const T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function parsedArtifact(value: unknown, name: string): ContextArtifactRef {
  const artifact = requiredRecord(value, name);
  return {
    uri: requiredBoundedString(artifact.uri, `${name}.uri`, 2_048),
    key: requiredBoundedString(artifact.key, `${name}.key`, 2_048),
    contentType: requiredBoundedString(artifact.contentType, `${name}.contentType`, 240),
    bytes: requiredCount(artifact.bytes, `${name}.bytes`),
    sha256: requiredDigest(artifact.sha256, `${name}.sha256`),
    ...(artifact.objectGeneration === undefined
      ? {}
      : {
          objectGeneration: requiredBoundedString(artifact.objectGeneration, `${name}.objectGeneration`, 240)
        })
  };
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`context task metadata is not JSON at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") throw new Error(`context task metadata is not JSON at ${path}`);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) throw new Error(`context task metadata contains undefined at ${path}.${key}`);
    assertJsonValue(item, `${path}.${key}`);
  }
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([candidate, item]) => candidate.toLowerCase() === key || containsKey(item, key)
  );
}
