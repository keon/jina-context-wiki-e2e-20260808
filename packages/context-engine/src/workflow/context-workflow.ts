import {
  applyCommand,
  appendEvent,
  findTask,
  reduceBoard,
  type BoardState,
  type TaskId,
  type TaskTypeDefinition
} from "@jina/board";
import { entityId, type IsoTimestamp } from "@jina/shared-kernel";
import { fingerprint, isFullCommitSha, normalizeIsoTime, normalizeRepository } from "../domain/fingerprint.js";
import type { DerivationDetail } from "../derive/verbosity.js";
import {
  isContextArtifactKeyInScope,
  type ContextArtifactKind,
  type ContextArtifactRef
} from "../ports/artifact-store.js";

export const CONTEXT_WORKFLOW_CONTRACT = "page-oriented" as const;
export const CONTEXT_WORKFLOW_SCHEMA_REVISION = 1 as const;

export const contextWorkflowBoardTaskTypes = {
  build: "build-context",
  graph: "context-build-graph",
  snapshot: "snapshot-context-input",
  planner: "plan-context-pages",
  page: "build-context-page",
  publication: "publish-context-release"
} as const;

export type ContextWorkflowBoardTaskType =
  (typeof contextWorkflowBoardTaskTypes)[keyof typeof contextWorkflowBoardTaskTypes];

export const contextWorkflowBoardTopics = {
  snapshot: "run-context-input-snapshot",
  planner: "run-context-page-plan",
  page: "run-context-page-build",
  publication: "run-context-publication"
} as const;

export type ContextWorkflowBoardTopic = (typeof contextWorkflowBoardTopics)[keyof typeof contextWorkflowBoardTopics];

export const contextWorkflowBoardTaskTypeDefinitions: readonly TaskTypeDefinition[] = [
  definition(contextWorkflowBoardTaskTypes.build, "aggregate", "system", "Coordinates one Context release."),
  definition(
    contextWorkflowBoardTaskTypes.graph,
    "manual",
    "system",
    "Keeps the build open until the Context planner materializes page work."
  ),
  definition(
    contextWorkflowBoardTaskTypes.snapshot,
    "dispatchable",
    "context_worker",
    "Captures the immutable repository, Git, provider, and prior-release boundary.",
    contextWorkflowBoardTopics.snapshot
  ),
  definition(
    contextWorkflowBoardTaskTypes.planner,
    "dispatchable",
    "context_agent",
    "Plans the complete Context subject catalog and affected pages.",
    contextWorkflowBoardTopics.planner
  ),
  definition(
    contextWorkflowBoardTaskTypes.page,
    "dispatchable",
    "context_agent",
    "Builds, validates, audits, optionally repairs, and dispositions one Context page.",
    contextWorkflowBoardTopics.page
  ),
  definition(
    contextWorkflowBoardTaskTypes.publication,
    "dispatchable",
    "context_worker",
    "Assembles safely dispositioned pages, builds PageIndex, and publishes one immutable release.",
    contextWorkflowBoardTopics.publication
  )
];

export const contextWorkflowPageOperations = ["add", "retain", "revise", "retire"] as const;
export type ContextWorkflowPageOperation = (typeof contextWorkflowPageOperations)[number];

export const contextWorkflowPageDispositionReasonCodes = [
  "provider_authentication_failed",
  "provider_credits_exhausted",
  "provider_rate_limited",
  "model_timeout",
  "daytona_recoverable_failure",
  "deterministic_validation_failed",
  "unsupported_core_claims"
] as const;
export type ContextWorkflowPageDispositionReasonCode = (typeof contextWorkflowPageDispositionReasonCodes)[number];

export interface ContextWorkflowMetadata {
  readonly contextWorkflowContract: typeof CONTEXT_WORKFLOW_CONTRACT;
  readonly contextWorkflowSchemaRevision: typeof CONTEXT_WORKFLOW_SCHEMA_REVISION;
  readonly promptContractVersion: string;
  readonly validatorVersion: string;
  readonly pageIndexVersion: string;
  readonly executionProfileDigest: string;
}

export interface ContextWorkflowPriorReleaseSeed {
  readonly contract: typeof CONTEXT_WORKFLOW_CONTRACT;
  readonly schemaRevision: typeof CONTEXT_WORKFLOW_SCHEMA_REVISION;
  readonly version: 1;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly releaseId: string;
  readonly commitSha: string;
  readonly publicSnapshotDigest: string;
  readonly releaseArtifact: ContextArtifactRef;
}

export interface ContextWorkflowBuildScope extends ContextWorkflowMetadata {
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
  readonly priorRelease?: ContextWorkflowPriorReleaseSeed;
}

export interface ContextWorkflowBoardBuild {
  readonly state: BoardState;
  readonly buildTaskId: TaskId;
  readonly graphTaskId: TaskId;
  readonly snapshotTaskId: TaskId;
}

export interface ContextWorkflowPagePlanEntry {
  readonly subjectId: string;
  readonly path: string;
  readonly title: string;
  readonly operation: ContextWorkflowPageOperation;
  readonly briefArtifact?: ContextArtifactRef;
  readonly reason?: string;
  readonly replacementPath?: string;
}

export interface ContextWorkflowPublicationGraph {
  readonly state: BoardState;
  readonly pageTaskIds: readonly TaskId[];
  readonly publicationTaskId: TaskId;
}

export type ContextWorkflowPageDisposition =
  | {
      readonly status: "accepted";
      readonly pageArtifact: ContextArtifactRef;
      readonly evidenceFingerprint: string;
      readonly generationFingerprint: string;
    }
  | {
      readonly status: "retained_stale";
      readonly pageArtifact: ContextArtifactRef;
      readonly reasonCode: ContextWorkflowPageDispositionReasonCode;
    }
  | {
      readonly status: "omitted";
      readonly reasonCode: ContextWorkflowPageDispositionReasonCode;
    };

export type ContextWorkflowBoardTaskResult =
  | {
      readonly contract: typeof CONTEXT_WORKFLOW_CONTRACT;
      readonly schemaRevision: typeof CONTEXT_WORKFLOW_SCHEMA_REVISION;
      readonly taskType: typeof contextWorkflowBoardTaskTypes.snapshot;
      readonly outputArtifact: ContextArtifactRef;
      readonly commitSha: string;
    }
  | {
      readonly contract: typeof CONTEXT_WORKFLOW_CONTRACT;
      readonly schemaRevision: typeof CONTEXT_WORKFLOW_SCHEMA_REVISION;
      readonly taskType: typeof contextWorkflowBoardTaskTypes.planner;
      readonly outputArtifact: ContextArtifactRef;
      readonly pages: readonly ContextWorkflowPagePlanEntry[];
    }
  | {
      readonly contract: typeof CONTEXT_WORKFLOW_CONTRACT;
      readonly schemaRevision: typeof CONTEXT_WORKFLOW_SCHEMA_REVISION;
      readonly taskType: typeof contextWorkflowBoardTaskTypes.page;
      readonly outputArtifact: ContextArtifactRef;
      readonly disposition: ContextWorkflowPageDisposition;
      readonly phaseReceiptIds: readonly string[];
    }
  | {
      readonly contract: typeof CONTEXT_WORKFLOW_CONTRACT;
      readonly schemaRevision: typeof CONTEXT_WORKFLOW_SCHEMA_REVISION;
      readonly taskType: typeof contextWorkflowBoardTaskTypes.publication;
      readonly outputArtifact: ContextArtifactRef;
      readonly releaseId: string;
    };

const SYSTEM_ACTOR = { type: "system", id: "context-board" } as const;
const MAX_CONTEXT_WORKFLOW_METADATA_BYTES = 32 * 1024;
const MAX_CONTEXT_WORKFLOW_RESULT_BYTES = 256 * 1024;
const MAX_CONTEXT_WORKFLOW_PAGES = 96;
const MAX_CONTEXT_WORKFLOW_RECEIPTS = 16;

export function contextWorkflowBoardArtifactKind(taskType: string): ContextArtifactKind {
  switch (taskType) {
    case contextWorkflowBoardTaskTypes.snapshot:
      return "evidence-snapshot";
    case contextWorkflowBoardTaskTypes.planner:
      return "publication-plan";
    case contextWorkflowBoardTaskTypes.page:
      return "context-page";
    case contextWorkflowBoardTaskTypes.publication:
      return "context-release";
    default:
      throw new Error(`Context Board task ${taskType} does not produce an artifact`);
  }
}

export function contextWorkflowBoardArtifactKindForTopic(topic: ContextWorkflowBoardTopic): ContextArtifactKind {
  const taskType = contextWorkflowBoardTaskTypeDefinitions.find((candidate) => candidate.dispatchTopic === topic)?.type;
  if (!taskType) throw new Error(`Context Board topic ${topic} does not produce an artifact`);
  return contextWorkflowBoardArtifactKind(taskType);
}

export function createContextWorkflowBoardBuild(
  state: BoardState,
  input: ContextWorkflowBuildScope & { readonly now: string }
): ContextWorkflowBoardBuild {
  const scope = normalizeScope(input);
  const now = normalizeIsoTime(input.now);
  const buildTaskId = workflowTaskId("context-build", { tenantId: scope.tenantId, requestKey: scope.requestKey });
  const graphTaskId = workflowTaskId("context-build-graph", { buildTaskId });
  const snapshotTaskId = workflowTaskId("context-input", { buildTaskId });
  const metadata = scopeMetadata(scope, buildTaskId);
  const existing = findTask(state, buildTaskId);
  if (existing) assertExistingBuildScope(existing, scope, buildTaskId);

  let next = createTask(state, {
    id: buildTaskId,
    type: contextWorkflowBoardTaskTypes.build,
    title: `Build Context for ${scope.repository}@${scope.ref}`,
    role: "system",
    dedupeKey: `context:${scope.tenantId}:${scope.requestKey}`,
    kind: "aggregate",
    now,
    metadata,
    blocksParentCompletion: false
  });
  next = createTask(next, {
    id: graphTaskId,
    type: contextWorkflowBoardTaskTypes.graph,
    title: `Materialize Context graph for ${scope.repository}@${scope.ref}`,
    role: "system",
    dedupeKey: `context:${buildTaskId}:graph`,
    kind: "manual",
    parentTaskId: buildTaskId,
    now,
    metadata
  });
  next = createTask(next, {
    id: snapshotTaskId,
    type: contextWorkflowBoardTaskTypes.snapshot,
    title: `Snapshot Context input for ${scope.repository}@${scope.ref}`,
    role: "context_worker",
    dedupeKey: `context:${buildTaskId}:snapshot`,
    kind: "dispatchable",
    topic: contextWorkflowBoardTopics.snapshot,
    parentTaskId: buildTaskId,
    now,
    metadata
  });
  return { state: reduceBoard(next, now), buildTaskId, graphTaskId, snapshotTaskId };
}

export function bindContextWorkflowBoardBuildCommit(
  state: BoardState,
  input: { readonly buildTaskId: TaskId; readonly commitSha: string; readonly now: string }
): BoardState {
  const build = requireBuild(state, input.buildTaskId);
  const commitSha = input.commitSha.toLowerCase();
  if (!isFullCommitSha(commitSha)) throw new Error("Context build commit must be a full Git SHA");
  if (build.metadata.commitSha !== undefined) {
    if (build.metadata.commitSha !== commitSha) {
      throw new Error("Context snapshot commit does not match the admitted build commit");
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

export function addContextWorkflowPagePlanner(
  state: BoardState,
  input: {
    readonly buildTaskId: TaskId;
    readonly snapshotTaskId: TaskId;
    readonly snapshot: ContextArtifactRef;
    readonly now: string;
  }
): { readonly state: BoardState; readonly plannerTaskId: TaskId } {
  const build = requireBuild(state, input.buildTaskId);
  requireChild(state, input.snapshotTaskId, contextWorkflowBoardTaskTypes.snapshot, build.id);
  assertScopedArtifact(build, input.snapshot);
  const now = normalizeIsoTime(input.now);
  const plannerTaskId = workflowTaskId("context-page-plan", { buildTaskId: build.id, snapshot: input.snapshot.sha256 });
  const next = createTask(state, {
    id: plannerTaskId,
    type: contextWorkflowBoardTaskTypes.planner,
    title: `Plan Context pages for ${String(build.metadata.repository)}`,
    role: "context_agent",
    dedupeKey: `context:${build.id}:plan:${input.snapshot.sha256}`,
    kind: "dispatchable",
    topic: contextWorkflowBoardTopics.planner,
    parentTaskId: build.id,
    dependencies: [blocks(plannerTaskId, input.snapshotTaskId)],
    now,
    metadata: childMetadata(build, { inputArtifact: input.snapshot })
  });
  return { state: reduceBoard(next, now), plannerTaskId };
}

export function addContextWorkflowPublicationWork(
  state: BoardState,
  input: {
    readonly buildTaskId: TaskId;
    readonly graphTaskId: TaskId;
    readonly plannerTaskId: TaskId;
    readonly plan: ContextArtifactRef;
    readonly pages: readonly ContextWorkflowPagePlanEntry[];
    readonly now: string;
  }
): ContextWorkflowPublicationGraph {
  validatePagePlan(input.pages);
  const build = requireBuild(state, input.buildTaskId);
  requireChild(state, input.graphTaskId, contextWorkflowBoardTaskTypes.graph, build.id);
  requireChild(state, input.plannerTaskId, contextWorkflowBoardTaskTypes.planner, build.id);
  assertScopedArtifact(build, input.plan);
  const now = normalizeIsoTime(input.now);
  let next = state;
  const affectedPages = input.pages.filter((page) => page.operation === "add" || page.operation === "revise");
  const pageTaskIds = affectedPages.map((page) => {
    if (!page.briefArtifact) throw new Error(`Context ${page.operation} page ${page.path} requires a brief artifact`);
    assertScopedArtifact(build, page.briefArtifact);
    const pageTaskId = workflowTaskId("context-page", {
      buildTaskId: build.id,
      subjectId: page.subjectId,
      plan: input.plan.sha256
    });
    next = createTask(next, {
      id: pageTaskId,
      type: contextWorkflowBoardTaskTypes.page,
      title: page.title,
      role: "context_agent",
      dedupeKey: `context:${build.id}:page:${page.subjectId}:${input.plan.sha256}`,
      kind: "dispatchable",
      topic: contextWorkflowBoardTopics.page,
      parentTaskId: build.id,
      dependencies: [blocks(pageTaskId, input.plannerTaskId)],
      now,
      metadata: childMetadata(build, {
        subjectId: page.subjectId,
        documentPath: page.path,
        pageOperation: page.operation,
        planArtifact: input.plan,
        briefArtifact: page.briefArtifact
      })
    });
    return pageTaskId;
  });

  const publicationTaskId = workflowTaskId("context-publication", { buildTaskId: build.id, plan: input.plan.sha256 });
  next = createTask(next, {
    id: publicationTaskId,
    type: contextWorkflowBoardTaskTypes.publication,
    title: "Assemble and publish Context release",
    role: "context_worker",
    dedupeKey: `context:${build.id}:publication:${input.plan.sha256}`,
    kind: "dispatchable",
    topic: contextWorkflowBoardTopics.publication,
    parentTaskId: build.id,
    dependencies: [
      blocks(publicationTaskId, input.plannerTaskId),
      ...pageTaskIds.map((pageTaskId) => blocks(publicationTaskId, pageTaskId))
    ],
    now,
    metadata: childMetadata(build, { planArtifact: input.plan })
  });

  const sealed = applyCommand(
    next,
    { command: "TransitionTask", taskId: input.graphTaskId, toStatus: "done" },
    { actor: SYSTEM_ACTOR, now }
  );
  if (!sealed.accepted) throw new Error(`Context graph could not be sealed: ${sealed.rejection?.reason ?? "unknown"}`);
  return { state: reduceBoard(sealed.state, now), pageTaskIds, publicationTaskId };
}

export function parseContextWorkflowBoardTaskResult(
  state: BoardState,
  taskId: TaskId,
  value: unknown
): ContextWorkflowBoardTaskResult {
  const task = findTask(state, taskId);
  if (!task || !isContextWorkflowBoardTaskType(task.type) || task.kind !== "dispatchable") {
    throw new Error("Context dispatchable Board task not found");
  }
  if (
    task.metadata.contextWorkflowContract !== CONTEXT_WORKFLOW_CONTRACT ||
    task.metadata.contextWorkflowSchemaRevision !== CONTEXT_WORKFLOW_SCHEMA_REVISION
  ) {
    throw new Error("Context task workflow contract is missing or mismatched");
  }
  const result = requiredRecord(value, "Context task result");
  assertJsonValue(result, "$");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_CONTEXT_WORKFLOW_RESULT_BYTES) {
    throw new Error(`Context task result exceeds ${MAX_CONTEXT_WORKFLOW_RESULT_BYTES} bytes`);
  }
  for (const forbidden of ["body", "content", "prompt", "transcript", "evidence", "report"]) {
    if (containsKey(result, forbidden))
      throw new Error(`Context task result must reference ${forbidden} as an artifact`);
  }
  if (result.contract !== CONTEXT_WORKFLOW_CONTRACT || result.schemaRevision !== CONTEXT_WORKFLOW_SCHEMA_REVISION) {
    throw new Error("Context task result contract is missing or mismatched");
  }
  const build = requireBuild(state, requiredTaskId(task.metadata.contextBuildId, "contextBuildId"));
  assertTaskBoundToBuild(task, build);
  const outputArtifact = parsedArtifact(result.outputArtifact, "outputArtifact");
  assertScopedArtifact(build, outputArtifact);
  const base = {
    contract: CONTEXT_WORKFLOW_CONTRACT,
    schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    taskType: task.type,
    outputArtifact
  };

  switch (task.type) {
    case contextWorkflowBoardTaskTypes.snapshot: {
      exactKeys(result, ["contract", "schemaRevision", "outputArtifact", "commitSha"], "snapshot result");
      const commitSha = requiredString(result.commitSha, "commitSha", 40).toLowerCase();
      if (!isFullCommitSha(commitSha)) throw new Error(" snapshot commitSha must be a full Git commit SHA");
      return { ...base, taskType: task.type, commitSha };
    }
    case contextWorkflowBoardTaskTypes.planner: {
      exactKeys(result, ["contract", "schemaRevision", "outputArtifact", "pages"], "planner result");
      if (!Array.isArray(result.pages)) throw new Error(" planner pages must be an array");
      const pages = result.pages.map((entry, index) => parsePagePlanEntry(build, entry, index));
      validatePagePlan(pages);
      return { ...base, taskType: task.type, pages };
    }
    case contextWorkflowBoardTaskTypes.page: {
      exactKeys(
        result,
        ["contract", "schemaRevision", "outputArtifact", "disposition", "phaseReceiptIds"],
        "page result"
      );
      const disposition = parseDisposition(build, result.disposition);
      const phaseReceiptIds = boundedUniqueStrings(
        result.phaseReceiptIds,
        "phaseReceiptIds",
        MAX_CONTEXT_WORKFLOW_RECEIPTS,
        240
      );
      return { ...base, taskType: task.type, disposition, phaseReceiptIds };
    }
    case contextWorkflowBoardTaskTypes.publication:
      exactKeys(result, ["contract", "schemaRevision", "outputArtifact", "releaseId"], "publication result");
      return {
        ...base,
        taskType: task.type,
        releaseId: requiredString(result.releaseId, "releaseId", 240)
      };
    default:
      throw new Error(`Context task type ${task.type} does not produce a worker result`);
  }
}

export function isContextWorkflowBoardTaskType(value: string): value is ContextWorkflowBoardTaskType {
  return Object.values(contextWorkflowBoardTaskTypes).some((type) => type === value);
}

function parsePagePlanEntry(
  build: NonNullable<ReturnType<typeof findTask>>,
  value: unknown,
  index: number
): ContextWorkflowPagePlanEntry {
  const name = `pages[${index}]`;
  const entry = requiredRecord(value, name);
  exactKeys(
    entry,
    ["subjectId", "path", "title", "operation", "briefArtifact", "reason", "replacementPath"],
    name,
    true
  );
  const operation = requiredEnum(entry.operation, `${name}.operation`, contextWorkflowPageOperations);
  const briefArtifact =
    entry.briefArtifact === undefined ? undefined : parsedArtifact(entry.briefArtifact, `${name}.briefArtifact`);
  if (briefArtifact) assertScopedArtifact(build, briefArtifact);
  const reason = entry.reason === undefined ? undefined : requiredString(entry.reason, `${name}.reason`, 500);
  const replacementPath =
    entry.replacementPath === undefined
      ? undefined
      : normalizedPagePath(requiredString(entry.replacementPath, `${name}.replacementPath`, 512));
  if ((operation === "add" || operation === "revise") !== Boolean(briefArtifact)) {
    throw new Error(`Context ${operation} page ${name} has an invalid brief artifact`);
  }
  if (operation === "retire" && !reason) throw new Error(`Context retired page ${name} requires a reason`);
  if (operation !== "retire" && (reason || replacementPath)) {
    throw new Error(`Context ${operation} page ${name} cannot declare retirement metadata`);
  }
  return {
    subjectId: requiredKey(entry.subjectId, `${name}.subjectId`),
    path: normalizedPagePath(requiredString(entry.path, `${name}.path`, 512)),
    title: requiredString(entry.title, `${name}.title`, 240),
    operation,
    ...(briefArtifact ? { briefArtifact } : {}),
    ...(reason ? { reason } : {}),
    ...(replacementPath ? { replacementPath } : {})
  };
}

function parseDisposition(
  build: NonNullable<ReturnType<typeof findTask>>,
  value: unknown
): ContextWorkflowPageDisposition {
  const disposition = requiredRecord(value, "disposition");
  const status = requiredEnum(disposition.status, "disposition.status", [
    "accepted",
    "retained_stale",
    "omitted"
  ] as const);
  switch (status) {
    case "accepted": {
      exactKeys(
        disposition,
        ["status", "pageArtifact", "evidenceFingerprint", "generationFingerprint"],
        "accepted disposition"
      );
      const pageArtifact = parsedArtifact(disposition.pageArtifact, "disposition.pageArtifact");
      assertScopedArtifact(build, pageArtifact);
      return {
        status,
        pageArtifact,
        evidenceFingerprint: requiredDigest(disposition.evidenceFingerprint, "disposition.evidenceFingerprint"),
        generationFingerprint: requiredDigest(disposition.generationFingerprint, "disposition.generationFingerprint")
      };
    }
    case "retained_stale": {
      exactKeys(disposition, ["status", "pageArtifact", "reasonCode"], "retained-stale disposition");
      const pageArtifact = parsedArtifact(disposition.pageArtifact, "disposition.pageArtifact");
      assertScopedArtifact(build, pageArtifact);
      return {
        status,
        pageArtifact,
        reasonCode: requiredEnum(
          disposition.reasonCode,
          "disposition.reasonCode",
          contextWorkflowPageDispositionReasonCodes
        )
      };
    }
    case "omitted":
      exactKeys(disposition, ["status", "reasonCode"], "omitted disposition");
      return {
        status,
        reasonCode: requiredEnum(
          disposition.reasonCode,
          "disposition.reasonCode",
          contextWorkflowPageDispositionReasonCodes
        )
      };
  }
}

function validatePagePlan(pages: readonly ContextWorkflowPagePlanEntry[]): void {
  if (pages.length === 0 || pages.length > MAX_CONTEXT_WORKFLOW_PAGES) {
    throw new Error(`Context plan must contain between 1 and ${MAX_CONTEXT_WORKFLOW_PAGES} pages`);
  }
  const subjects = new Set<string>();
  const paths = new Set<string>();
  for (const page of pages) {
    if (subjects.has(page.subjectId)) throw new Error(`Context plan duplicates subject ${page.subjectId}`);
    if (paths.has(page.path)) throw new Error(`Context plan duplicates path ${page.path}`);
    subjects.add(page.subjectId);
    paths.add(page.path);
    if ((page.operation === "add" || page.operation === "revise") && !page.briefArtifact) {
      throw new Error(`Context ${page.operation} page ${page.path} requires a brief artifact`);
    }
    if ((page.operation === "retain" || page.operation === "retire") && page.briefArtifact) {
      throw new Error(`Context ${page.operation} page ${page.path} cannot schedule model work`);
    }
  }
}

function normalizeScope(input: ContextWorkflowBuildScope): ContextWorkflowBuildScope {
  if (
    input.contextWorkflowContract !== CONTEXT_WORKFLOW_CONTRACT ||
    input.contextWorkflowSchemaRevision !== CONTEXT_WORKFLOW_SCHEMA_REVISION
  ) {
    throw new Error("Context workflow contract is missing or mismatched");
  }
  const tenantId = requiredString(input.tenantId, "tenantId", 240);
  const repository = normalizeRepository(input.repository);
  const ref = requiredString(input.ref, "ref", 512);
  const requestKey = requiredString(input.requestKey, "requestKey", 512);
  if (!Number.isSafeInteger(input.refSequence) || input.refSequence < 1) {
    throw new Error("Context refSequence must be a positive integer");
  }
  if (input.commitSha && !isFullCommitSha(input.commitSha)) throw new Error("Context commitSha must be a full Git SHA");
  if (
    input.githubInstallationId !== undefined &&
    (!Number.isSafeInteger(input.githubInstallationId) || input.githubInstallationId < 1)
  ) {
    throw new Error("Context githubInstallationId must be a positive integer");
  }
  if (
    input.derivationBudgetSeconds !== undefined &&
    (!Number.isSafeInteger(input.derivationBudgetSeconds) || input.derivationBudgetSeconds < 1)
  ) {
    throw new Error("Context derivationBudgetSeconds must be a positive integer");
  }
  if (
    input.derivationTokenBudget !== undefined &&
    (!Number.isSafeInteger(input.derivationTokenBudget) || input.derivationTokenBudget < 1)
  ) {
    throw new Error("Context derivationTokenBudget must be a positive integer");
  }
  const workflow = {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: requiredString(input.promptContractVersion, "promptContractVersion", 120),
    validatorVersion: requiredString(input.validatorVersion, "validatorVersion", 120),
    pageIndexVersion: requiredString(input.pageIndexVersion, "pageIndexVersion", 120),
    executionProfileDigest: requiredDigest(input.executionProfileDigest, "executionProfileDigest")
  } as const;
  const priorRelease = input.priorRelease
    ? normalizePriorRelease(input.priorRelease, { tenantId, repository, ref, refSequence: input.refSequence })
    : undefined;
  return {
    ...workflow,
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

function normalizePriorRelease(
  input: ContextWorkflowPriorReleaseSeed,
  scope: { readonly tenantId: string; readonly repository: string; readonly ref: string; readonly refSequence: number }
): ContextWorkflowPriorReleaseSeed {
  if (input.contract !== CONTEXT_WORKFLOW_CONTRACT || input.schemaRevision !== CONTEXT_WORKFLOW_SCHEMA_REVISION) {
    throw new Error("prior Context release contract is missing or mismatched");
  }
  if (input.version !== 1) throw new Error("prior Context release version must be 1");
  const releaseArtifact = parsedArtifact(input.releaseArtifact, "priorRelease.releaseArtifact");
  if (
    input.tenantId !== scope.tenantId ||
    normalizeRepository(input.repository) !== scope.repository ||
    input.ref !== scope.ref ||
    !Number.isSafeInteger(input.refSequence) ||
    input.refSequence < 1 ||
    input.refSequence >= scope.refSequence
  ) {
    throw new Error("prior Context release does not precede the exact build scope");
  }
  if (!isFullCommitSha(input.commitSha)) throw new Error("prior Context release commit must be a full Git SHA");
  if (
    !isContextArtifactKeyInScope(releaseArtifact.key, {
      tenantId: scope.tenantId,
      repository: scope.repository,
      buildId: priorBuildIdFromArtifact(releaseArtifact)
    })
  ) {
    throw new Error("prior Context manifest artifact is outside the repository scope");
  }
  return {
    ...input,
    repository: scope.repository,
    commitSha: input.commitSha.toLowerCase(),
    releaseId: requiredString(input.releaseId, "priorRelease.releaseId", 240),
    publicSnapshotDigest: requiredDigest(input.publicSnapshotDigest, "priorRelease.publicSnapshotDigest"),
    releaseArtifact
  };
}

function priorBuildIdFromArtifact(artifact: ContextArtifactRef): string {
  const segments = artifact.key.split("/");
  const buildsIndex = segments.indexOf("builds");
  const encodedBuildId = segments[buildsIndex + 1];
  if (buildsIndex < 0 || !encodedBuildId) throw new Error("prior Context manifest artifact key is invalid");
  return decodeURIComponent(encodedBuildId);
}

function scopeMetadata(scope: ContextWorkflowBuildScope, buildTaskId: TaskId): Record<string, unknown> {
  return {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: scope.promptContractVersion,
    validatorVersion: scope.validatorVersion,
    pageIndexVersion: scope.pageIndexVersion,
    executionProfileDigest: scope.executionProfileDigest,
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
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...build.metadata,
    contextBuildId: build.id,
    ...extra
  };
}

function assertExistingBuildScope(
  existing: NonNullable<ReturnType<typeof findTask>>,
  scope: ContextWorkflowBuildScope,
  buildTaskId: TaskId
): void {
  const expected = scopeMetadata(scope, buildTaskId);
  const immutableKeys = [
    "contextWorkflowContract",
    "contextWorkflowSchemaRevision",
    "promptContractVersion",
    "validatorVersion",
    "pageIndexVersion",
    "executionProfileDigest",
    "contextBuildId",
    "tenantId",
    "repository",
    "ref",
    "refSequence",
    "requestKey",
    "githubInstallationId",
    "derivationDetail",
    "derivationBudgetSeconds",
    "derivationTokenBudget",
    "trigger"
  ] as const;
  const mismatch =
    existing.type !== contextWorkflowBoardTaskTypes.build ||
    immutableKeys.some((key) => existing.metadata[key] !== expected[key]) ||
    (scope.commitSha !== undefined && existing.metadata.commitSha !== scope.commitSha) ||
    fingerprint(existing.metadata.priorRelease ?? null) !== fingerprint(expected.priorRelease ?? null);
  if (mismatch) throw new Error("Context build request key is already bound to a different scope");
}

function createTask(
  state: BoardState,
  input: {
    readonly id: TaskId;
    readonly type: ContextWorkflowBoardTaskType;
    readonly title: string;
    readonly role: string;
    readonly dedupeKey: string;
    readonly kind: "aggregate" | "dispatchable" | "manual";
    readonly topic?: ContextWorkflowBoardTopic;
    readonly parentTaskId?: TaskId;
    readonly dependencies?: readonly ReturnType<typeof blocks>[];
    readonly now: IsoTimestamp;
    readonly metadata: Record<string, unknown>;
    readonly blocksParentCompletion?: boolean;
  }
): BoardState {
  assertMetadata(input.metadata);
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
  if (!result.accepted) throw new Error(`Context Board task rejected: ${result.rejection?.reason ?? "unknown"}`);
  return result.state;
}

function requireBuild(state: BoardState, id: TaskId) {
  const task = findTask(state, id);
  if (!task || task.type !== contextWorkflowBoardTaskTypes.build || task.kind !== "aggregate") {
    throw new Error("Context build task not found");
  }
  if (
    task.metadata.contextWorkflowContract !== CONTEXT_WORKFLOW_CONTRACT ||
    task.metadata.contextWorkflowSchemaRevision !== CONTEXT_WORKFLOW_SCHEMA_REVISION
  ) {
    throw new Error("Context build workflow contract is missing or mismatched");
  }
  return task;
}

function requireChild(state: BoardState, id: TaskId, type: ContextWorkflowBoardTaskType, parentTaskId: TaskId) {
  const task = findTask(state, id);
  if (!task || task.type !== type || task.parentTaskId !== parentTaskId) {
    throw new Error(`Context ${type} task not found in the expected build`);
  }
  return task;
}

function assertTaskBoundToBuild(
  task: NonNullable<ReturnType<typeof findTask>>,
  build: NonNullable<ReturnType<typeof findTask>>
): void {
  const identityKeys = [
    "contextWorkflowContract",
    "contextWorkflowSchemaRevision",
    "promptContractVersion",
    "validatorVersion",
    "pageIndexVersion",
    "executionProfileDigest",
    "contextBuildId",
    "tenantId",
    "repository",
    "ref",
    "refSequence",
    "requestKey",
    "commitSha"
  ] as const;
  if (identityKeys.some((key) => task.metadata[key] !== build.metadata[key])) {
    throw new Error("Context task identity does not match its build");
  }
}

function assertScopedArtifact(build: NonNullable<ReturnType<typeof findTask>>, artifact: ContextArtifactRef): void {
  parsedArtifact(artifact, "artifact");
  if (
    !isContextArtifactKeyInScope(artifact.key, {
      tenantId: String(build.metadata.tenantId),
      repository: String(build.metadata.repository),
      buildId: build.id
    })
  ) {
    throw new Error("Context artifact does not belong to the task tenant, repository, and build");
  }
}

function assertMetadata(metadata: Record<string, unknown>): void {
  assertJsonValue(metadata, "$");
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_CONTEXT_WORKFLOW_METADATA_BYTES) {
    throw new Error(`Context task metadata exceeds ${MAX_CONTEXT_WORKFLOW_METADATA_BYTES} bytes`);
  }
  if (
    metadata.contextWorkflowContract !== CONTEXT_WORKFLOW_CONTRACT ||
    metadata.contextWorkflowSchemaRevision !== CONTEXT_WORKFLOW_SCHEMA_REVISION
  ) {
    throw new Error("Context task metadata must declare the page-oriented workflow contract");
  }
}

function definition(
  type: ContextWorkflowBoardTaskType,
  kind: TaskTypeDefinition["kind"],
  defaultAssigneeRole: string,
  description: string,
  dispatchTopic?: ContextWorkflowBoardTopic
): TaskTypeDefinition {
  return { type, kind, defaultAssigneeRole, description, ...(dispatchTopic ? { dispatchTopic } : {}) };
}

function blocks(taskId: TaskId, dependsOnTaskId: TaskId) {
  return { taskId, dependsOnTaskId, relationship: "blocks" as const, required: true, blocksParentCompletion: true };
}

function workflowTaskId(kind: string, identity: unknown): TaskId {
  return entityId<"task">(
    `task_${fingerprint({
      workflowContract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      kind,
      identity
    }).slice(0, 32)}`
  );
}

function normalizedPagePath(value: string): string {
  const path = value.trim().replace(/^\/+/, "");
  if (
    !path ||
    path.length > 512 ||
    path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Context page path is invalid");
  }
  return path.endsWith(".md") ? path : `${path}.md`;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function requiredKey(value: unknown, name: string): string {
  const key = requiredString(value, name, 160);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(key)) throw new Error(`${name} is invalid`);
  return key;
}

function requiredDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
  return value;
}

function requiredTaskId(value: unknown, name: string): TaskId {
  if (typeof value !== "string" || !value.startsWith("task_") || value.length > 240)
    throw new Error(`${name} must be a task ID`);
  return value as TaskId;
}

function requiredEnum<const T extends readonly string[]>(value: unknown, name: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} is invalid`);
  return value;
}

function boundedUniqueStrings(value: unknown, name: string, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new Error(`${name} must contain at most ${maxItems} items`);
  const items = value.map((item, index) => requiredString(item, `${name}[${index}]`, maxLength));
  if (new Set(items).size !== items.length) throw new Error(`${name} must not contain duplicates`);
  return items;
}

function parsedArtifact(value: unknown, name: string): ContextArtifactRef {
  const artifact = requiredRecord(value, name);
  exactKeys(artifact, ["uri", "key", "contentType", "bytes", "sha256", "objectGeneration"], name, true);
  const bytes = artifact.bytes;
  if (!Number.isSafeInteger(bytes) || Number(bytes) < 0) throw new Error(`${name}.bytes is invalid`);
  return {
    uri: requiredString(artifact.uri, `${name}.uri`, 4_096),
    key: requiredString(artifact.key, `${name}.key`, 4_096),
    contentType: requiredString(artifact.contentType, `${name}.contentType`, 240),
    bytes: Number(bytes),
    sha256: requiredDigest(artifact.sha256, `${name}.sha256`),
    ...(artifact.objectGeneration === undefined
      ? {}
      : { objectGeneration: requiredString(artifact.objectGeneration, `${name}.objectGeneration`, 240) })
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string, optional = false): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${name} contains unknown properties: ${unknown.join(", ")}`);
  if (!optional) {
    const missing = keys.filter((key) => !(key in value));
    if (missing.length > 0) throw new Error(`${name} is missing properties: ${missing.join(", ")}`);
  }
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(record, key) || Object.values(record).some((entry) => containsKey(entry, key))
  );
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`${path} is not JSON-compatible`);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) assertJsonValue(entry, `${path}.${key}`);
}
