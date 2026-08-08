import { applyCommand, isTerminalTaskStatus, type BoardState, type TaskId } from "@jina/board";
import {
  contextWikiBoardTaskType,
  createContextWikiBoardBuild,
  fingerprint,
  normalizeRepository,
  stableId,
  type ContextWikiBoardBuild
} from "@jina/context-engine";
import {
  normalizeWikiRefIdentity,
  parseWikiTriggerRequest,
  type WikiGenerationReason,
  type WikiSourceScopeKind,
  type WikiTriggerImprovementV1,
  type WikiTriggerRequestV1
} from "@jina/shared-kernel";

export interface ContextWikiAdmissionInput {
  readonly tenantId: string;
  readonly repository: string;
  readonly scopeKind: WikiSourceScopeKind;
  readonly scopeKey: string;
  readonly commitSha: string;
  readonly baseCommitSha?: string;
  readonly githubInstallationId?: number;
  readonly requestKey: string;
  readonly generationReason: WikiGenerationReason;
  readonly parentReleaseId?: string;
  readonly sourceReleaseId?: string;
  readonly sourceLocale?: string;
  readonly releaseFamilyId?: string;
  readonly improvement?: WikiTriggerImprovementV1;
  readonly locale: string;
  readonly priorRefSequence?: number;
  readonly generatorPolicyVersion: string;
  readonly now: string;
}

export type ContextWikiAdmissionResult =
  | {
      readonly outcome: "created";
      readonly state: BoardState;
      readonly build: ContextWikiBoardBuild;
      readonly request: WikiTriggerRequestV1;
      readonly supersededBuildTaskIds: readonly TaskId[];
    }
  | {
      readonly outcome: "duplicate";
      readonly state: BoardState;
      readonly build: ContextWikiBoardBuild;
      readonly request: WikiTriggerRequestV1;
      readonly supersededBuildTaskIds: readonly [];
    };

export function admitContextWikiBuild(state: BoardState, input: ContextWikiAdmissionInput): ContextWikiAdmissionResult {
  const tenantId = normalizedTenantId(input.tenantId);
  const repository = normalizeRepository(input.repository);
  const identity = normalizeWikiRefIdentity({ scopeKind: input.scopeKind, scopeKey: input.scopeKey });
  const requestKey = requiredRequestKey(input.requestKey);
  const locale = canonicalLocale(input.locale);
  if (input.generationReason !== "translation" && input.releaseFamilyId !== undefined) {
    throw new Error("releaseFamilyId override is only valid for translation");
  }
  const boardBuildId = stableId("task_wiki", { tenantId, requestKey });
  const existing = state.tasks.find((task) => task.id === boardBuildId);
  const refSequence =
    identity.scopeKind === "commit"
      ? undefined
      : existing?.type === contextWikiBoardTaskType && typeof existing.metadata.refSequence === "number"
        ? existing.metadata.refSequence
        : nextRefSequence(state, {
            tenantId,
            repository,
            ref: identity.ref,
            locale,
            ...(input.priorRefSequence === undefined ? {} : { priorRefSequence: input.priorRefSequence })
          });
  const releaseFamilyId =
    input.generationReason === "translation"
      ? requiredReleaseFamilyId(input.releaseFamilyId)
      : stableId("wiki_family", {
          tenantId,
          repository,
          commitSha: input.commitSha.toLowerCase(),
          requestKey,
          locale
        });
  const request = parseWikiTriggerRequest({
    schemaVersion: 1,
    taskIdentifier: "generate-wiki",
    boardBuildId,
    tenantId,
    repository,
    source: {
      commitSha: input.commitSha.toLowerCase(),
      ref: identity.ref,
      scopeKind: identity.scopeKind,
      scopeKey: identity.scopeKey,
      ...(refSequence === undefined ? {} : { refSequence }),
      ...(input.baseCommitSha ? { baseCommitSha: input.baseCommitSha.toLowerCase() } : {}),
      ...(input.githubInstallationId ? { githubInstallationId: input.githubInstallationId } : {})
    },
    requestKey,
    generationReason: input.generationReason,
    releaseFamilyId,
    ...(input.parentReleaseId ? { parentReleaseId: input.parentReleaseId } : {}),
    ...(input.sourceReleaseId ? { sourceReleaseId: input.sourceReleaseId } : {}),
    ...(input.sourceLocale ? { sourceLocale: input.sourceLocale } : {}),
    ...(input.improvement ? { improvement: input.improvement } : {}),
    requestedLocale: locale,
    pipelineVersion: "context_wiki.trigger.v1",
    generatorPolicyVersion: input.generatorPolicyVersion,
    options: {
      idempotencyKey: `wiki:${boardBuildId}`,
      concurrencyKey: `wiki:${fingerprint({ tenantId, repository, ref: identity.ref, locale }).slice(0, 32)}`,
      queue: "context-wiki",
      tags: [
        `build_${fingerprint(boardBuildId).slice(0, 20)}`,
        `repo_${fingerprint(`${tenantId}/${repository}`).slice(0, 20)}`,
        `locale_${locale.replace(/[^A-Za-z0-9]/g, "_")}`
      ]
    }
  });
  const build = createContextWikiBoardBuild(state, { request, now: input.now });
  if (existing) {
    return { outcome: "duplicate", state, build: { ...build, state }, request, supersededBuildTaskIds: [] };
  }
  const superseded = supersedeOlderWikiBuilds(build.state, build.buildTaskId, request, input.now);
  return {
    outcome: "created",
    state: superseded.state,
    build: { ...build, state: superseded.state },
    request,
    supersededBuildTaskIds: superseded.taskIds
  };
}

function nextRefSequence(
  state: BoardState,
  input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly locale: string;
    readonly priorRefSequence?: number;
  }
): number {
  const sequences = state.tasks
    .filter(
      (task) =>
        task.type === contextWikiBoardTaskType &&
        task.metadata.tenantId === input.tenantId &&
        task.metadata.repository === input.repository &&
        task.metadata.ref === input.ref &&
        task.metadata.locale === input.locale
    )
    .map((task) => task.metadata.refSequence)
    .filter((value): value is number => Number.isSafeInteger(value) && Number(value) > 0);
  if (input.priorRefSequence !== undefined) {
    if (!Number.isSafeInteger(input.priorRefSequence) || input.priorRefSequence < 1) {
      throw new Error("priorRefSequence must be a positive integer");
    }
    sequences.push(input.priorRefSequence);
  }
  const next = Math.max(0, ...sequences) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("wiki ref sequence exceeds the supported range");
  return next;
}

function supersedeOlderWikiBuilds(
  state: BoardState,
  newBuildTaskId: TaskId,
  request: WikiTriggerRequestV1,
  now: string
): { readonly state: BoardState; readonly taskIds: readonly TaskId[] } {
  if (request.source.refSequence === undefined) return { state, taskIds: [] };
  const candidates = state.tasks.filter(
    (task) =>
      task.type === contextWikiBoardTaskType &&
      task.id !== newBuildTaskId &&
      task.metadata.tenantId === request.tenantId &&
      task.metadata.repository === request.repository &&
      task.metadata.ref === request.source.ref &&
      task.metadata.locale === request.requestedLocale &&
      typeof task.metadata.refSequence === "number" &&
      task.metadata.refSequence < request.source.refSequence! &&
      !isTerminalTaskStatus(task.status)
  );
  let next = state;
  for (const candidate of candidates) {
    const commented = applyCommand(
      next,
      {
        command: "CommentTask",
        taskId: candidate.id,
        eventType: "context.wiki_build_superseded",
        payload: { supersededByBuildTaskId: newBuildTaskId, reason: "newer locale-specific ref sequence admitted" }
      },
      { actor: { type: "system", id: "context-wiki-admission" }, now }
    );
    if (!commented.accepted) throw new Error("failed to record superseded wiki build");
    const canceled = applyCommand(
      commented.state,
      { command: "TransitionTask", taskId: candidate.id, toStatus: "canceled" },
      { actor: { type: "system", id: "context-wiki-admission" }, now }
    );
    if (!canceled.accepted) throw new Error("failed to cancel superseded wiki build");
    next = canceled.state;
  }
  return { state: next, taskIds: candidates.map((candidate) => candidate.id) };
}

function normalizedTenantId(value: string): string {
  const tenantId = value.trim();
  if (!tenantId || tenantId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(tenantId)) {
    throw new Error("tenantId is invalid");
  }
  return tenantId;
}

function requiredRequestKey(value: string): string {
  const requestKey = value.trim();
  if (!requestKey || requestKey.length > 512) throw new Error("requestKey is invalid");
  return requestKey;
}

function requiredReleaseFamilyId(value: string | undefined): string {
  if (!value || value !== value.trim() || value.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(value)) {
    throw new Error("translation releaseFamilyId is invalid");
  }
  return value;
}

function canonicalLocale(value: string): string {
  const locales = Intl.getCanonicalLocales(value.trim());
  if (locales.length !== 1) throw new Error("locale is invalid");
  return locales[0]!.toLowerCase();
}
