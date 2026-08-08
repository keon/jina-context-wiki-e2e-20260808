import {
  applyCommand,
  findTask,
  reduceBoard,
  type BoardState,
  type TaskDependencyDraft,
  type TaskId,
  type TaskTypeDefinition
} from "@jina/board";
import { causalGraphBoardTopics, entityId, type CausalGraphWorkerTopic, type IsoTimestamp } from "@jina/shared-kernel";
import { fingerprint, isFullCommitSha, normalizeIsoTime, normalizeRepository } from "../domain/fingerprint.js";
import {
  isContextArtifactKeyInScope,
  type ContextArtifactKind,
  type ContextArtifactRef
} from "../ports/artifact-store.js";

export const causalGraphBoardTaskTypes = {
  build: "build-causal-graph",
  snapshot: "snapshot-causal-graph-history",
  derive: "derive-causal-graph",
  publication: "publish-causal-graph"
} as const;

export type CausalGraphBoardTaskType = (typeof causalGraphBoardTaskTypes)[keyof typeof causalGraphBoardTaskTypes];
export { causalGraphBoardTopics };
export type CausalGraphBoardTopic = CausalGraphWorkerTopic;

export const causalGraphBoardTaskTypeDefinitions: readonly TaskTypeDefinition[] = [
  definition(causalGraphBoardTaskTypes.build, "aggregate", "system", "Coordinates one immutable causal graph release."),
  definition(
    causalGraphBoardTaskTypes.snapshot,
    "dispatchable",
    "causal_graph_worker",
    "Captures bounded commit history without repository file contents.",
    causalGraphBoardTopics.snapshot
  ),
  definition(
    causalGraphBoardTaskTypes.derive,
    "dispatchable",
    "causal_graph_agent",
    "Derives issues and explicit causalities in one read-only agent run.",
    causalGraphBoardTopics.derive
  ),
  definition(
    causalGraphBoardTaskTypes.publication,
    "dispatchable",
    "causal_graph_worker",
    "Publishes an immutable causal graph behind a ref-sequence fence.",
    causalGraphBoardTopics.publication
  )
];

export interface CausalGraphBuildScope {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly requestKey: string;
  readonly commitSha?: string;
  readonly githubInstallationId?: number;
  readonly derivationBudgetSeconds?: number;
  readonly derivationTokenBudget?: number;
  readonly trigger?: "push" | "pull_request" | "issue" | "manual";
}

export interface IssueGraphBoardBuild {
  readonly state: BoardState;
  readonly buildTaskId: TaskId;
  readonly snapshotTaskId: TaskId;
  readonly deriveTaskId: TaskId;
  readonly publicationTaskId: TaskId;
}

export type CausalGraphBoardTaskResult =
  | {
      readonly version: 1;
      readonly taskType: typeof causalGraphBoardTaskTypes.snapshot;
      readonly outputArtifact: ContextArtifactRef;
      readonly commitSha: string;
      readonly observedCommitCount: number;
      readonly historyComplete: boolean;
    }
  | {
      readonly version: 1;
      readonly taskType: typeof causalGraphBoardTaskTypes.derive;
      readonly outputArtifact: ContextArtifactRef;
      readonly releaseId: string;
      readonly contentDigest: string;
      readonly issueCount: number;
      readonly causalityCount: number;
      readonly historyComplete: boolean;
    }
  | {
      readonly version: 1;
      readonly taskType: typeof causalGraphBoardTaskTypes.publication;
      readonly outputArtifact: ContextArtifactRef;
      readonly releaseId: string;
    };

const SYSTEM_ACTOR = { type: "system", id: "causal-graph-board" } as const;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;

export function causalGraphBoardArtifactKind(taskType: string): ContextArtifactKind {
  switch (taskType) {
    case causalGraphBoardTaskTypes.snapshot:
      return "issue-history";
    case causalGraphBoardTaskTypes.derive:
    case causalGraphBoardTaskTypes.publication:
      return "issue-graph";
    default:
      throw new Error(`Causal graph task ${taskType} does not produce an artifact`);
  }
}

export function causalGraphBoardArtifactKindForTopic(topic: CausalGraphBoardTopic): ContextArtifactKind {
  const taskType = causalGraphBoardTaskTypeDefinitions.find((candidate) => candidate.dispatchTopic === topic)?.type;
  if (!taskType) throw new Error(`Causal graph topic ${topic} does not produce an artifact`);
  return causalGraphBoardArtifactKind(taskType);
}

export function isCausalGraphBoardTaskType(value: string): value is CausalGraphBoardTaskType {
  return Object.values(causalGraphBoardTaskTypes).some((type) => type === value);
}

export function createCausalGraphBoardBuild(
  state: BoardState,
  input: CausalGraphBuildScope & { readonly now: string }
): IssueGraphBoardBuild {
  const scope = normalizeScope(input);
  const now = normalizeIsoTime(input.now);
  const buildTaskId = taskId("causal-graph-build", { tenantId: scope.tenantId, requestKey: scope.requestKey });
  const snapshotTaskId = taskId("causal-graph-history", { buildTaskId });
  const deriveTaskId = taskId("causal-graph-derive", { buildTaskId });
  const publicationTaskId = taskId("causal-graph-publication", { buildTaskId });
  const metadata = scopeMetadata(scope, buildTaskId);
  const existing = findTask(state, buildTaskId);
  if (existing && fingerprint(existing.metadata) !== fingerprint(metadata)) {
    throw new Error("causal graph build request key is already bound to a different scope");
  }

  let next = createTask(state, {
    id: buildTaskId,
    type: causalGraphBoardTaskTypes.build,
    title: `Build causal graph for ${scope.repository}@${scope.ref}`,
    role: "system",
    dedupeKey: `causal-graph:${scope.tenantId}:${scope.requestKey}`,
    kind: "aggregate",
    now,
    metadata,
    blocksParentCompletion: false
  });
  next = createTask(next, {
    id: snapshotTaskId,
    type: causalGraphBoardTaskTypes.snapshot,
    title: `Snapshot commit history for ${scope.repository}@${scope.ref}`,
    role: "causal_graph_worker",
    dedupeKey: `causal-graph:${buildTaskId}:history`,
    kind: "dispatchable",
    topic: causalGraphBoardTopics.snapshot,
    parentTaskId: buildTaskId,
    now,
    metadata
  });
  next = createTask(next, {
    id: deriveTaskId,
    type: causalGraphBoardTaskTypes.derive,
    title: `Derive issues and causalities for ${scope.repository}@${scope.ref}`,
    role: "causal_graph_agent",
    dedupeKey: `causal-graph:${buildTaskId}:derive`,
    kind: "dispatchable",
    topic: causalGraphBoardTopics.derive,
    parentTaskId: buildTaskId,
    dependencies: [blocks(deriveTaskId, snapshotTaskId)],
    now,
    metadata
  });
  next = createTask(next, {
    id: publicationTaskId,
    type: causalGraphBoardTaskTypes.publication,
    title: `Publish causal graph for ${scope.repository}@${scope.ref}`,
    role: "causal_graph_worker",
    dedupeKey: `causal-graph:${buildTaskId}:publish`,
    kind: "dispatchable",
    topic: causalGraphBoardTopics.publication,
    parentTaskId: buildTaskId,
    dependencies: [blocks(publicationTaskId, deriveTaskId)],
    now,
    metadata
  });
  return { state: reduceBoard(next, now), buildTaskId, snapshotTaskId, deriveTaskId, publicationTaskId };
}

export function nextCausalGraphBoardRefSequence(
  state: BoardState,
  input: { readonly tenantId: string; readonly repository: string; readonly ref: string }
): number {
  const repository = normalizeRepository(input.repository);
  const sequences = state.tasks
    .filter(
      (task) =>
        task.type === causalGraphBoardTaskTypes.build &&
        task.metadata.tenantId === input.tenantId &&
        task.metadata.repository === repository &&
        task.metadata.ref === input.ref
    )
    .map((task) => task.metadata.refSequence)
    .filter((value): value is number => Number.isSafeInteger(value) && Number(value) > 0);
  const next = Math.max(0, ...sequences) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("causal graph ref sequence exceeds the supported range");
  return next;
}

export function bindCausalGraphBoardBuildCommit(
  state: BoardState,
  input: { readonly buildTaskId: TaskId; readonly commitSha: string; readonly now: string }
): BoardState {
  const build = requireBuild(state, input.buildTaskId);
  const commitSha = input.commitSha.toLowerCase();
  if (!isFullCommitSha(commitSha)) throw new Error("causal graph commit must be a full Git SHA");
  if (build.metadata.commitSha !== undefined) {
    if (build.metadata.commitSha !== commitSha)
      throw new Error("causal graph snapshot commit does not match admission");
    return state;
  }
  const now = normalizeIsoTime(input.now);
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === build.id || task.metadata.contextBuildId === build.id
        ? { ...task, metadata: { ...task.metadata, commitSha }, updatedAt: now }
        : task
    )
  };
}

export function parseCausalGraphBoardTaskResult(
  state: BoardState,
  taskId: TaskId,
  value: unknown
): CausalGraphBoardTaskResult {
  const task = findTask(state, taskId);
  if (!task || !isCausalGraphBoardTaskType(task.type) || task.kind !== "dispatchable") {
    throw new Error("causal graph dispatchable Board task not found");
  }
  const result = requiredRecord(value, "causal graph task result");
  assertJsonValue(result, "$");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
    throw new Error(`causal graph task result exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  for (const forbidden of ["body", "content", "prompt", "transcript", "evidence", "report"]) {
    if (containsKey(result, forbidden))
      throw new Error(`causal graph task result must reference ${forbidden} as an artifact`);
  }
  if (result.version !== 1) throw new Error("causal graph task result version must be 1");
  const build = requireBuild(state, requiredTaskId(task.metadata.contextBuildId, "contextBuildId"));
  const outputArtifact = parsedArtifact(result.outputArtifact, "outputArtifact");
  assertScopedArtifact(build, outputArtifact);
  const base = { version: 1 as const, taskType: task.type, outputArtifact };
  switch (task.type) {
    case causalGraphBoardTaskTypes.snapshot: {
      const commitSha = requiredString(result.commitSha, "commitSha", 40).toLowerCase();
      if (!isFullCommitSha(commitSha)) throw new Error("issue history commitSha must be a full Git commit SHA");
      return {
        ...base,
        taskType: task.type,
        commitSha,
        observedCommitCount: requiredCount(result.observedCommitCount, "observedCommitCount"),
        historyComplete: requiredBoolean(result.historyComplete, "historyComplete")
      };
    }
    case causalGraphBoardTaskTypes.derive:
      return {
        ...base,
        taskType: task.type,
        releaseId: requiredString(result.releaseId, "releaseId", 240),
        contentDigest: requiredDigest(result.contentDigest, "contentDigest"),
        issueCount: requiredCount(result.issueCount, "issueCount"),
        causalityCount: requiredCount(result.causalityCount, "causalityCount"),
        historyComplete: requiredBoolean(result.historyComplete, "historyComplete")
      };
    case causalGraphBoardTaskTypes.publication:
      return {
        ...base,
        taskType: task.type,
        releaseId: requiredString(result.releaseId, "releaseId", 240)
      };
  }
  throw new Error(`causal graph task type ${task.type} does not produce a worker result`);
}

function definition(
  type: CausalGraphBoardTaskType,
  kind: TaskTypeDefinition["kind"],
  defaultAssigneeRole: string,
  description: string,
  dispatchTopic?: CausalGraphBoardTopic
): TaskTypeDefinition {
  return { type, kind, defaultAssigneeRole, description, ...(dispatchTopic ? { dispatchTopic } : {}) };
}

function createTask(
  state: BoardState,
  input: {
    readonly id: TaskId;
    readonly type: CausalGraphBoardTaskType;
    readonly title: string;
    readonly role: string;
    readonly dedupeKey: string;
    readonly kind: "aggregate" | "dispatchable";
    readonly topic?: CausalGraphBoardTopic;
    readonly parentTaskId?: TaskId;
    readonly dependencies?: readonly TaskDependencyDraft[];
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
  if (!result.accepted) throw new Error(`causal graph Board task rejected: ${result.rejection?.reason ?? "unknown"}`);
  if (!input.parentTaskId) return result.state;
  const parent = findTask(result.state, input.parentTaskId);
  if (parent?.kind !== "aggregate") return result.state;
  const linked = applyCommand(
    result.state,
    { command: "LinkTask", dependency: blocks(parent.id, input.id) },
    { actor: SYSTEM_ACTOR, now: input.now }
  );
  if (!linked.accepted)
    throw new Error(`causal graph parent dependency rejected: ${linked.rejection?.reason ?? "unknown"}`);
  return linked.state;
}

function normalizeScope(input: CausalGraphBuildScope): CausalGraphBuildScope {
  const tenantId = input.tenantId.trim();
  const ref = input.ref.trim();
  const requestKey = input.requestKey.trim();
  if (!tenantId || !ref || !requestKey) throw new Error("causal graph tenantId, ref, and requestKey are required");
  if (!Number.isSafeInteger(input.refSequence) || input.refSequence < 1) {
    throw new Error("causal graph refSequence must be a positive integer");
  }
  if (input.commitSha && !isFullCommitSha(input.commitSha)) throw new Error("commitSha must be a full Git SHA");
  if (
    input.githubInstallationId !== undefined &&
    (!Number.isSafeInteger(input.githubInstallationId) || input.githubInstallationId < 1)
  ) {
    throw new Error("githubInstallationId must be a positive integer");
  }
  for (const [name, value] of [
    ["derivationBudgetSeconds", input.derivationBudgetSeconds],
    ["derivationTokenBudget", input.derivationTokenBudget]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error(`${name} must be a positive integer`);
  }
  return {
    tenantId,
    repository: normalizeRepository(input.repository),
    ref,
    refSequence: input.refSequence,
    requestKey,
    ...(input.commitSha ? { commitSha: input.commitSha.toLowerCase() } : {}),
    ...(input.githubInstallationId ? { githubInstallationId: input.githubInstallationId } : {}),
    ...(input.derivationBudgetSeconds ? { derivationBudgetSeconds: input.derivationBudgetSeconds } : {}),
    ...(input.derivationTokenBudget ? { derivationTokenBudget: input.derivationTokenBudget } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {})
  };
}

function scopeMetadata(scope: CausalGraphBuildScope, buildTaskId: TaskId): Record<string, unknown> {
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
    ...(scope.derivationBudgetSeconds ? { derivationBudgetSeconds: scope.derivationBudgetSeconds } : {}),
    ...(scope.derivationTokenBudget ? { derivationTokenBudget: scope.derivationTokenBudget } : {}),
    ...(scope.trigger ? { trigger: scope.trigger } : {})
  };
}

function requireBuild(state: BoardState, id: TaskId) {
  const task = findTask(state, id);
  if (!task || task.type !== causalGraphBoardTaskTypes.build || task.kind !== "aggregate") {
    throw new Error("causal graph build task not found");
  }
  return task;
}

function assertScopedArtifact(build: NonNullable<ReturnType<typeof findTask>>, artifact: ContextArtifactRef): void {
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error("causal graph artifact digest is invalid");
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)
    throw new Error("causal graph artifact size is invalid");
  if (!artifact.contentType.trim() || !artifact.uri.trim())
    throw new Error("causal graph artifact metadata is incomplete");
  if (
    !isContextArtifactKeyInScope(artifact.key, {
      tenantId: String(build.metadata.tenantId),
      repository: String(build.metadata.repository),
      buildId: build.id
    })
  ) {
    throw new Error("causal graph artifact does not belong to its tenant, repository, and build");
  }
}

function assertMetadata(metadata: Record<string, unknown>): void {
  assertJsonValue(metadata, "$");
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
    throw new Error(`causal graph task metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  for (const forbidden of ["body", "content", "prompt", "transcript", "evidence", "report"]) {
    if (containsKey(metadata, forbidden))
      throw new Error(`causal graph metadata must reference ${forbidden} as an artifact`);
  }
}

function taskId(kind: string, identity: unknown): TaskId {
  return entityId<"task">(`task_${fingerprint({ kind, identity }).slice(0, 32)}`);
}

function blocks(taskId: TaskId, dependsOnTaskId: TaskId): TaskDependencyDraft {
  return { taskId, dependsOnTaskId, relationship: "blocks", required: true, blocksParentCompletion: true };
}

function parsedArtifact(value: unknown, name: string): ContextArtifactRef {
  const input = requiredRecord(value, name);
  return {
    key: requiredString(input.key, `${name}.key`, 1_024),
    uri: requiredString(input.uri, `${name}.uri`, 4_096),
    sha256: requiredDigest(input.sha256, `${name}.sha256`),
    bytes: requiredCount(input.bytes, `${name}.bytes`),
    contentType: requiredString(input.contentType, `${name}.contentType`, 240),
    ...(input.objectGeneration === undefined
      ? {}
      : { objectGeneration: requiredString(input.objectGeneration, `${name}.objectGeneration`, 240) })
  };
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredTaskId(value: unknown, name: string): TaskId {
  const normalized = requiredString(value, name, 240);
  if (!normalized.startsWith("task_")) throw new Error(`${name} must be a task ID`);
  return entityId<"task">(normalized);
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string of at most ${maximum} characters`);
  }
  return value.trim();
}

function requiredDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
  return value;
}

function requiredCount(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return Object.hasOwn(input, key) || Object.values(input).some((item) => containsKey(item, key));
}

function assertJsonValue(value: unknown, path: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} is not JSON-compatible`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
  else for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, seen);
  seen.delete(value);
}
