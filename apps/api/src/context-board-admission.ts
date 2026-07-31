import { applyCommand, isTerminalTaskStatus, reduceBoard, type BoardState, type TaskId } from "@jina/board";
import {
  contextBoardTaskTypes,
  createContextBoardBuild,
  nextContextBoardRefSequence,
  normalizeRepository,
  type ContextBoardBuild,
  type ContextBuildScope,
  type ContextPriorReleaseSeed,
  type DerivationDetail
} from "@jina/context-engine";
import { isContextTrigger, type GitHubWebhookEvent } from "@jina/github";

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

export type ContextBoardAdmissionInput = ManualContextBoardAdmission | GitHubContextBoardAdmission;

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

export type ContextBoardAdmissionResult =
  CreatedContextBoardAdmission | DuplicateContextBoardAdmission | IgnoredContextBoardAdmission;

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
  const superseded = supersedeOlderPullRequestBuilds(build.state, build.buildTaskId, scope, input);
  return {
    state: superseded.state,
    outcome: "created",
    build: { ...build, state: superseded.state },
    scope,
    supersededBuildTaskIds: superseded.buildTaskIds
  };
}

const SUPERSEDED_PULL_REQUEST_REASON = "superseded by a newer pull request commit";

function supersedeOlderPullRequestBuilds(
  state: BoardState,
  newBuildTaskId: TaskId,
  scope: ContextBuildScope,
  input: ContextBoardAdmissionInput
): { readonly state: BoardState; readonly buildTaskIds: readonly TaskId[] } {
  const event = input.source === "github" ? input.event : undefined;
  if (event?.type !== "pull_request.opened" && event?.type !== "pull_request.synchronize") {
    return { state, buildTaskIds: [] };
  }

  const candidates = state.tasks.filter(
    (task) =>
      task.type === contextBoardTaskTypes.build &&
      task.metadata.tenantId === scope.tenantId &&
      task.metadata.repository === scope.repository &&
      task.metadata.ref === scope.ref &&
      task.metadata.trigger === "pull_request" &&
      task.metadata.commitSha !== scope.commitSha &&
      typeof task.metadata.refSequence === "number" &&
      task.metadata.refSequence < scope.refSequence &&
      !isTerminalTaskStatus(task.status)
  );

  let next = state;
  for (const candidate of candidates) {
    const options = {
      actor: { type: "system" as const, id: "context-build-admission" },
      now: input.now
    };
    const commented = applyCommand(
      next,
      {
        command: "CommentTask",
        taskId: candidate.id,
        eventType: "context.build_superseded.failed",
        payload: {
          failureCategory: "build_superseded",
          reason: SUPERSEDED_PULL_REQUEST_REASON,
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
    next = reduceBoard(transitioned.state, input.now);
  }
  return { state: next, buildTaskIds: candidates.map((candidate) => candidate.id) };
}

function resolveAdmissionScope(input: ContextBoardAdmissionInput): Omit<ContextBuildScope, "refSequence"> | undefined {
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

function existingRequestBuilds(state: BoardState, tenantId: string, requestKey: string) {
  return state.tasks.filter(
    (task) =>
      task.type === contextBoardTaskTypes.build &&
      task.metadata.tenantId === tenantId &&
      task.metadata.requestKey === requestKey
  );
}

function requiredRefSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("existing context build has an invalid ref sequence");
  }
  return Number(value);
}
