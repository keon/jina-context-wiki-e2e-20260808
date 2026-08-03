import { applyCommand, isTerminalTaskStatus, reduceBoard, type BoardState, type TaskId } from "@jina/board";
import {
  contextBoardTaskTypes,
  createContextBoardBuild,
  isDerivationDetail,
  nextContextBoardRefSequence,
  normalizeRepository,
  type ContextBoardBuild,
  type ContextBuildScope,
  type ContextPriorReleaseSeed,
  type DerivationDetail
} from "@jina/context-engine";
import { isContextTrigger, type GitHubWebhookEvent } from "@jina/github";
import { contextBuildHasOperatorRecovery } from "./context-board-recovery.js";

interface ResolvedContextBuildScope {
  readonly tenantId: string;
  readonly repository: string;
  readonly githubInstallationId?: number;
  readonly priorRelease?: ContextPriorReleaseSeed;
  readonly derivationBudgetSeconds?: number;
  readonly derivationTokenBudget?: number;
}

interface ManualContextBoardAdmission extends ResolvedContextBuildScope {
  readonly source: "manual";
  readonly ref: string;
  readonly requestKey: string;
  readonly commitSha?: string;
  readonly derivationDetail?: DerivationDetail;
  readonly derivationBudgetSeconds?: number;
  readonly derivationTokenBudget?: number;
  readonly now: string;
}

/**
 * GitHub parsing deliberately returns `undefined` for comments, reviews,
 * labels, edits, closes, and every unsupported event/action pair. Passing that
 * result through `event` makes the admission no-op explicit and testable.
 *
 * Tenant, repository, installation, and default branch must already come from
 * authoritative repository resolution. This helper never trusts provider
 * display metadata to choose a tenant.
 */
interface GitHubContextBoardAdmission extends ResolvedContextBuildScope {
  readonly source: "github";
  readonly deliveryId: string;
  readonly event?: GitHubWebhookEvent;
  readonly defaultBranch?: string;
  readonly now: string;
}

type FollowupContextBoardAdmission = Omit<ContextBuildScope, "refSequence"> & {
  readonly source: "followup";
  readonly now: string;
};

export type ContextBoardAdmissionInput =
  ManualContextBoardAdmission | GitHubContextBoardAdmission | FollowupContextBoardAdmission;

interface CreatedContextBoardAdmission {
  readonly state: BoardState;
  readonly outcome: "created";
  readonly build: ContextBoardBuild;
  readonly scope: ContextBuildScope;
  readonly supersededBuildTaskIds: readonly TaskId[];
}

interface DuplicateContextBoardAdmission {
  readonly state: BoardState;
  readonly outcome: "duplicate";
  readonly existingBuildTaskId: TaskId;
  readonly requestKey: string;
  readonly refSequence: number;
  readonly build?: never;
}

interface IgnoredContextBoardAdmission {
  readonly state: BoardState;
  readonly outcome: "ignored";
  readonly reason: "unsupported_event";
  readonly build?: never;
}

interface DeferredContextBoardAdmission {
  readonly state: BoardState;
  readonly outcome: "deferred";
  readonly activeBuildTaskId: TaskId;
  readonly requestKey: string;
  readonly scope: Omit<ContextBuildScope, "refSequence" | "priorRelease">;
  readonly build?: never;
}

export type ContextBoardAdmissionResult =
  | CreatedContextBoardAdmission
  | DuplicateContextBoardAdmission
  | IgnoredContextBoardAdmission
  | DeferredContextBoardAdmission;

export type ContextBoardFollowup = Omit<ContextBuildScope, "refSequence" | "priorRelease">;

/**
 * Admits one board-native Context build as a pure state transition.
 *
 * The caller must invoke this inside its persisted board mutation. Sequence
 * allocation and task creation then commit atomically because both are derived
 * from, and returned with, the same BoardState value.
 */
export function admitContextBoardBuild(
  state: BoardState,
  input: ContextBoardAdmissionInput
): ContextBoardAdmissionResult {
  const resolved = resolveAdmissionScope(input);
  if (!resolved) return { state, outcome: "ignored", reason: "unsupported_event" };

  const tenantId = resolved.tenantId.trim();
  const requestKey = resolved.requestKey.trim();
  const scopeWithoutSequence: Omit<ContextBuildScope, "refSequence"> = {
    ...resolved,
    tenantId,
    repository: normalizeRepository(resolved.repository),
    ref: resolved.ref.trim(),
    requestKey,
    ...(resolved.commitSha ? { commitSha: resolved.commitSha.toLowerCase() } : {})
  };
  const existing = existingRequestBuilds(state, tenantId, requestKey);
  if (existing.length > 1) {
    throw new Error("context build request key resolves to multiple board tasks");
  }
  if (existing.length === 1) {
    const task = existing[0]!;
    const refSequence = requiredRefSequence(task.metadata.refSequence);
    // Reuse the board constructor as the single scope validator. Supplying the
    // retained sequence makes an exact replay idempotent; any repository, ref,
    // commit, installation, trigger, or tuning mismatch throws its collision
    // error. Discard the returned state so a duplicate delivery creates no
    // events, tasks, or outbox messages.
    const verified = createContextBoardBuild(state, {
      ...scopeWithoutSequence,
      refSequence,
      now: input.now
    });
    return {
      state,
      outcome: "duplicate",
      existingBuildTaskId: verified.buildTaskId,
      requestKey,
      refSequence
    };
  }

  const deferredReplay = input.source === "followup" ? undefined : existingDeferredRequest(state, tenantId, requestKey);
  if (deferredReplay) {
    const requestedScope = withoutPriorRelease(scopeWithoutSequence);
    if (JSON.stringify(deferredReplay.scope) !== JSON.stringify(requestedScope)) {
      throw new Error("context build request key collides with a different deferred scope");
    }
    return {
      state,
      outcome: "deferred",
      activeBuildTaskId: deferredReplay.buildTaskId,
      requestKey,
      scope: requestedScope
    };
  }

  if (scopeWithoutSequence.trigger !== "pull_request") {
    const active =
      newestActiveRefBuild(state, scopeWithoutSequence) ??
      newestRecoverableRefBuild(state, scopeWithoutSequence, input.now);
    if (active) {
      const scope = withoutPriorRelease(scopeWithoutSequence);
      // A follow-up is a coalescing slot, not an append-only queue. Only the
      // newest revision for this repository ref can be useful after the active
      // build finishes; retaining every intermediate push makes the durable
      // Board snapshot grow without bound.
      const coalescedState: BoardState = {
        ...state,
        events: state.events.filter(
          (event) => event.taskId !== active.id || event.type !== "context.build_followup_requested"
        )
      };
      const deferred = applyCommand(
        coalescedState,
        {
          command: "CommentTask",
          taskId: active.id,
          eventType: "context.build_followup_requested",
          payload: {
            followup: scope,
            repository: scope.repository,
            ref: scope.ref,
            ...(scope.commitSha ? { commitSha: scope.commitSha } : {}),
            trigger: scope.trigger,
            reason: "Queued behind the active build so verified checkpoints are not discarded."
          }
        },
        { actor: { type: "system", id: "context-build-admission" }, now: input.now }
      );
      if (!deferred.accepted) throw new Error("failed to defer the next Context build");
      return {
        state: deferred.state,
        outcome: "deferred",
        activeBuildTaskId: active.id,
        requestKey,
        scope
      };
    }
  }

  const refSequence = nextContextBoardRefSequence(state, {
    tenantId,
    repository: scopeWithoutSequence.repository,
    ref: scopeWithoutSequence.ref
  });
  const scope: ContextBuildScope = {
    ...scopeWithoutSequence,
    refSequence
  };
  const build = createContextBoardBuild(state, { ...scope, now: input.now });
  const superseded = supersedeOlderRefBuilds(build.state, build.buildTaskId, scope, input.now);
  return {
    state: superseded.state,
    outcome: "created",
    build: { ...build, state: superseded.state },
    scope,
    supersededBuildTaskIds: superseded.buildTaskIds
  };
}

/**
 * Returns the newest unadmitted follow-up retained on a completed build. Push,
 * issue, and manual admissions are serialized behind the active build so a
 * moving default branch cannot discard hours of verified private checkpoints.
 * Pull-request heads remain freshness-first and are superseded immediately.
 */
export function latestContextBoardFollowup(state: BoardState, buildTaskId: TaskId): ContextBoardFollowup | undefined {
  const build = state.tasks.find((task) => task.id === buildTaskId && task.type === contextBoardTaskTypes.build);
  if (!build || !isTerminalTaskStatus(build.status)) return undefined;
  const events = state.events
    .filter((event) => event.taskId === buildTaskId && event.type === "context.build_followup_requested")
    .sort((left, right) => right.at.localeCompare(left.at) || right.seq - left.seq);
  const newest = events[0];
  if (!newest) return undefined;
  const followup = parseFollowup(newest.payload?.followup);
  if (build.status === "failed" && contextBuildHasOperatorRecovery(state, build, newest.at)) {
    return undefined;
  }
  const predecessorSequence = requiredRefSequence(build.metadata.refSequence);
  const newerRefBuildExists = state.tasks.some(
    (task) =>
      task.type === contextBoardTaskTypes.build &&
      task.metadata.tenantId === followup.tenantId &&
      task.metadata.repository === followup.repository &&
      task.metadata.ref === followup.ref &&
      typeof task.metadata.refSequence === "number" &&
      task.metadata.refSequence > predecessorSequence
  );
  if (newerRefBuildExists) return undefined;
  return existingRequestBuilds(state, followup.tenantId, followup.requestKey).length ? undefined : followup;
}

const SUPERSEDED_REF_REASON = "superseded by a newer build for the same repository ref";

function supersedeOlderRefBuilds(
  state: BoardState,
  newBuildTaskId: TaskId,
  scope: ContextBuildScope,
  now: string
): { readonly state: BoardState; readonly buildTaskIds: readonly TaskId[] } {
  const candidates = state.tasks.filter(
    (task) =>
      task.type === contextBoardTaskTypes.build &&
      task.metadata.tenantId === scope.tenantId &&
      task.metadata.repository === scope.repository &&
      task.metadata.ref === scope.ref &&
      typeof task.metadata.refSequence === "number" &&
      task.metadata.refSequence < scope.refSequence &&
      !isTerminalTaskStatus(task.status)
  );

  let next = state;
  for (const candidate of candidates) {
    const options = {
      actor: { type: "system" as const, id: "context-build-admission" },
      now
    };
    const commented = applyCommand(
      next,
      {
        command: "CommentTask",
        taskId: candidate.id,
        eventType: "context.build_superseded.failed",
        payload: {
          failureCategory: "build_superseded",
          reason: SUPERSEDED_REF_REASON,
          supersededByBuildTaskId: newBuildTaskId
        }
      },
      options
    );
    if (!commented.accepted) throw new Error("failed to record superseded Context build");
    const transitioned = applyCommand(
      commented.state,
      { command: "TransitionTask", taskId: candidate.id, toStatus: "canceled" },
      options
    );
    if (!transitioned.accepted) throw new Error("failed to cancel superseded Context build");
    next = reduceBoard(transitioned.state, now);
  }
  return { state: next, buildTaskIds: candidates.map((candidate) => candidate.id) };
}

function resolveAdmissionScope(input: ContextBoardAdmissionInput): Omit<ContextBuildScope, "refSequence"> | undefined {
  if (input.source === "followup") {
    const { source: _source, now: _now, ...scope } = input;
    return scope;
  }
  if (input.source === "manual") {
    return {
      tenantId: input.tenantId,
      repository: input.repository,
      ref: input.ref,
      requestKey: input.requestKey,
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      ...(input.githubInstallationId ? { githubInstallationId: input.githubInstallationId } : {}),
      ...(input.priorRelease ? { priorRelease: input.priorRelease } : {}),
      ...(input.derivationDetail ? { derivationDetail: input.derivationDetail } : {}),
      ...(input.derivationBudgetSeconds ? { derivationBudgetSeconds: input.derivationBudgetSeconds } : {}),
      ...(input.derivationTokenBudget ? { derivationTokenBudget: input.derivationTokenBudget } : {}),
      trigger: "manual"
    };
  }

  const event = input.event;
  if (!event || !isContextTrigger(event)) return undefined;
  const repository = normalizeRepository(input.repository);
  const deliveryId = input.deliveryId.trim();
  if (!deliveryId) throw new Error("GitHub delivery id is required for a context build");
  const common = {
    tenantId: input.tenantId,
    repository,
    ...(input.githubInstallationId ? { githubInstallationId: input.githubInstallationId } : {}),
    ...(input.priorRelease ? { priorRelease: input.priorRelease } : {}),
    ...(input.derivationBudgetSeconds ? { derivationBudgetSeconds: input.derivationBudgetSeconds } : {}),
    ...(input.derivationTokenBudget ? { derivationTokenBudget: input.derivationTokenBudget } : {})
  };
  if (event.type === "push") {
    const headSha = event.headSha.toLowerCase();
    const ref = event.ref.slice("refs/heads/".length);
    const defaultBranch = input.defaultBranch?.trim();
    if (defaultBranch && ref !== defaultBranch) return undefined;
    return {
      ...common,
      ref,
      commitSha: headSha,
      requestKey: `github:push:${repository}:${ref}:${headSha}:${deliveryId}`,
      trigger: "push"
    };
  }
  if (event.type === "pull_request.opened" || event.type === "pull_request.synchronize") {
    const headSha = event.headSha.toLowerCase();
    return {
      ...common,
      ref: `pull/${event.pullRequestNumber}/head`,
      commitSha: headSha,
      requestKey: `github:pull:${repository}:${event.pullRequestNumber}:${headSha}:${deliveryId}`,
      trigger: "pull_request"
    };
  }
  const defaultBranch = input.defaultBranch?.trim();
  if (!defaultBranch) {
    throw new Error("authoritative default branch is required for an issue-triggered context build");
  }
  return {
    ...common,
    ref: defaultBranch,
    requestKey: `github:issue:${repository}:${event.issueNumber}`,
    trigger: "issue"
  };
}

function newestActiveRefBuild(state: BoardState, scope: Pick<ContextBuildScope, "tenantId" | "repository" | "ref">) {
  return state.tasks
    .filter(
      (task) =>
        task.type === contextBoardTaskTypes.build &&
        task.metadata.tenantId === scope.tenantId &&
        task.metadata.repository === scope.repository &&
        task.metadata.ref === scope.ref &&
        hasInvestedBuildWork(state, task.id, task.status) &&
        !isTerminalTaskStatus(task.status)
    )
    .sort(
      (left, right) =>
        requiredRefSequence(right.metadata.refSequence) - requiredRefSequence(left.metadata.refSequence) ||
        right.createdAt.localeCompare(left.createdAt)
    )[0];
}

function newestRecoverableRefBuild(
  state: BoardState,
  scope: Pick<ContextBuildScope, "tenantId" | "repository" | "ref">,
  now: string
) {
  return state.tasks
    .filter(
      (task) =>
        task.type === contextBoardTaskTypes.build &&
        task.status === "failed" &&
        task.metadata.tenantId === scope.tenantId &&
        task.metadata.repository === scope.repository &&
        task.metadata.ref === scope.ref &&
        contextBuildHasOperatorRecovery(state, task, now)
    )
    .sort(
      (left, right) =>
        requiredRefSequence(right.metadata.refSequence) - requiredRefSequence(left.metadata.refSequence) ||
        right.createdAt.localeCompare(left.createdAt)
    )[0];
}

function hasInvestedBuildWork(state: BoardState, buildTaskId: TaskId, status: string): boolean {
  if (status === "in_progress" || status === "in_review") return true;
  return state.tasks.some(
    (task) =>
      task.parentTaskId === buildTaskId &&
      (task.status === "in_progress" || task.status === "in_review" || task.status === "done")
  );
}

function withoutPriorRelease(
  scope: Omit<ContextBuildScope, "refSequence">
): Omit<ContextBuildScope, "refSequence" | "priorRelease"> {
  const { priorRelease: _priorRelease, ...followup } = scope;
  return followup;
}

function parseFollowup(value: unknown): ContextBoardFollowup {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("deferred Context build scope is invalid");
  }
  const input = value as Record<string, unknown>;
  const trigger = input.trigger;
  if (trigger !== "push" && trigger !== "issue" && trigger !== "manual") {
    throw new Error("deferred Context build trigger is invalid");
  }
  const tenantId = requiredText(input.tenantId, "tenantId");
  const ref = requiredText(input.ref, "ref");
  const requestKey = requiredText(input.requestKey, "requestKey");
  const commitSha =
    input.commitSha === undefined ? undefined : requiredText(input.commitSha, "commitSha").toLowerCase();
  if (commitSha && !/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("deferred Context build commitSha is invalid");
  const githubInstallationId = optionalPositiveInteger(input.githubInstallationId, "githubInstallationId");
  const derivationBudgetSeconds = optionalPositiveInteger(input.derivationBudgetSeconds, "derivationBudgetSeconds");
  const derivationTokenBudget = optionalPositiveInteger(input.derivationTokenBudget, "derivationTokenBudget");
  const derivationDetail = input.derivationDetail;
  if (derivationDetail !== undefined && !isDerivationDetail(derivationDetail)) {
    throw new Error("deferred Context build derivationDetail is invalid");
  }
  return {
    tenantId,
    repository: normalizeRepository(requiredText(input.repository, "repository")),
    ref,
    requestKey,
    ...(commitSha ? { commitSha } : {}),
    ...(githubInstallationId ? { githubInstallationId } : {}),
    ...(derivationDetail ? { derivationDetail } : {}),
    ...(derivationBudgetSeconds ? { derivationBudgetSeconds } : {}),
    ...(derivationTokenBudget ? { derivationTokenBudget } : {}),
    trigger
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`deferred Context build ${label} is invalid`);
  return value.trim();
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`deferred Context build ${label} is invalid`);
  }
  return Number(value);
}

function existingRequestBuilds(state: BoardState, tenantId: string, requestKey: string) {
  return state.tasks.filter(
    (task) =>
      task.type === contextBoardTaskTypes.build &&
      task.metadata.tenantId === tenantId &&
      task.metadata.requestKey === requestKey
  );
}

function existingDeferredRequest(
  state: BoardState,
  tenantId: string,
  requestKey: string
): { readonly buildTaskId: TaskId; readonly scope: ContextBoardFollowup } | undefined {
  for (const event of [...state.events].reverse()) {
    if (!event.taskId || event.type !== "context.build_followup_requested") continue;
    const scope = parseFollowup(event.payload?.followup);
    if (scope.tenantId === tenantId && scope.requestKey === requestKey) {
      return { buildTaskId: event.taskId, scope };
    }
  }
  return undefined;
}

function requiredRefSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("existing context build has an invalid ref sequence");
  }
  return Number(value);
}
