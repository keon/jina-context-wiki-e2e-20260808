import { entityId, type EntityId, type IsoTimestamp } from "@jina/shared-kernel";
import type { TaskDependencyDraft, TaskId } from "./dependencies.js";
import { isTerminalFailure, isTerminalTaskStatus, type TaskStatus } from "./task-status.js";
import type { BoardTask } from "./tasks.js";
import type { CommandActor } from "./commands.js";

export type BoardOutboxMessageId = EntityId<"board_outbox_message">;

export type BoardOutboxStatus = "pending" | "leased" | "dispatched";

export const BOARD_TASK_HARD_MAX_ATTEMPTS = 4;
export const BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS = 32;

export interface BoardOutboxMessage {
  readonly id: BoardOutboxMessageId;
  readonly taskId: TaskId;
  readonly topic: NonNullable<BoardTask["dispatchTopic"]>;
  readonly idempotencyKey: string;
  readonly status: BoardOutboxStatus;
  readonly payload: {
    readonly taskId: TaskId;
    readonly attempt: number;
  };
  readonly createdAt: IsoTimestamp;
  readonly leaseId?: string;
  readonly writeFenceToken?: string;
  readonly leasedAt?: IsoTimestamp;
  readonly leaseExpiresAt?: IsoTimestamp;
  readonly dispatchedAt?: IsoTimestamp;
  /** Retained so a completion response lost after commit can be replayed safely. */
  readonly dispatchedLeaseId?: string;
}

export interface BoardEvent {
  readonly id: EntityId<"board_event">;
  readonly seq: number;
  readonly type: string;
  readonly at: IsoTimestamp;
  readonly taskId?: TaskId;
  readonly payload?: Record<string, unknown>;
}

export interface BoardState {
  readonly tasks: readonly BoardTask[];
  readonly dependencies: readonly TaskDependencyDraft[];
  readonly outbox: readonly BoardOutboxMessage[];
  readonly events: readonly BoardEvent[];
}

export function createEmptyBoardState(): BoardState {
  return {
    tasks: [],
    dependencies: [],
    outbox: [],
    events: []
  };
}

export function appendEvent(
  state: BoardState,
  type: string,
  at: IsoTimestamp,
  taskId?: TaskId,
  payload?: Record<string, unknown>
): BoardState {
  const seq = taskId
    ? state.events.filter((event) => event.taskId === taskId).length + 1
    : state.events.filter((event) => event.taskId === undefined).length + 1;

  return {
    ...state,
    events: [
      ...state.events,
      {
        id: entityId(taskId ? `event_${taskId}_${seq}` : `event_board_${seq}`),
        seq,
        type,
        at,
        ...(taskId ? { taskId } : {}),
        ...(payload ? { payload } : {})
      }
    ]
  };
}

export function addTask(state: BoardState, task: BoardTask, actor?: CommandActor): BoardState {
  if (state.tasks.some((existing) => existing.dedupeKey === task.dedupeKey)) {
    return state;
  }

  return appendEvent({ ...state, tasks: [...state.tasks, task] }, "task.created", task.updatedAt, task.id, {
    type: task.type,
    ...(actor ? { actor: actor.id, actorType: actor.type } : {})
  });
}

export function addDependency(state: BoardState, dependency: TaskDependencyDraft, now: IsoTimestamp): BoardState {
  if (
    state.dependencies.some(
      (existing) =>
        existing.taskId === dependency.taskId &&
        existing.dependsOnTaskId === dependency.dependsOnTaskId &&
        existing.relationship === dependency.relationship
    )
  ) {
    return state;
  }

  return appendEvent(
    { ...state, dependencies: [...state.dependencies, dependency] },
    "task.dependency_added",
    now,
    dependency.taskId,
    {
      dependsOnTaskId: dependency.dependsOnTaskId,
      relationship: dependency.relationship
    }
  );
}

export function transitionBoardTask(
  state: BoardState,
  taskId: TaskId,
  toStatus: TaskStatus,
  now: IsoTimestamp
): BoardState {
  const task = findTask(state, taskId);
  if (!task || task.status === toStatus || isTerminalTaskStatus(task.status)) {
    return state;
  }

  const transitioned = appendEvent(
    {
      ...state,
      tasks: state.tasks.map((existing) =>
        existing.id === taskId ? { ...existing, status: toStatus, updatedAt: now } : existing
      )
    },
    "task.transitioned",
    now,
    taskId,
    { fromStatus: task.status, toStatus }
  );
  return task.kind === "aggregate" && isTerminalFailure(toStatus)
    ? reconcileTerminalAggregate(transitioned, task.id, now)
    : transitioned;
}

export function reduceBoard(state: BoardState, now: IsoTimestamp): BoardState {
  let next = state;
  let changed = true;

  while (changed) {
    let step = blockWaitpointTasks(next, now);
    step = terminateFailedDependencyTasks(step, now);
    step = reconcileTerminalAggregates(step, now);
    step = completeReadyAggregateTasks(step, now);
    step = queueReadyDispatchableTasks(step, now);
    changed = step !== next;
    next = step;
  }

  return next;
}

export function markOutboxDispatched(
  state: BoardState,
  outboxMessageId: BoardOutboxMessageId,
  now: IsoTimestamp
): BoardState {
  return {
    ...state,
    outbox: state.outbox.map((message) => {
      if (message.id !== outboxMessageId || message.status === "dispatched") return message;
      const {
        leaseId,
        writeFenceToken: _writeFenceToken,
        leasedAt: _leasedAt,
        leaseExpiresAt: _leaseExpiresAt,
        ...unleased
      } = message;
      return {
        ...unleased,
        status: "dispatched",
        dispatchedAt: now,
        ...(leaseId ? { dispatchedLeaseId: leaseId } : {})
      };
    })
  };
}

export interface LeaseOutboxInput {
  readonly topics: readonly string[];
  readonly taskIds?: readonly TaskId[];
  readonly messageIds?: readonly BoardOutboxMessageId[];
  readonly leaseId: string;
  readonly writeFenceToken: string;
  readonly now: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface LeasedOutboxMessage {
  readonly state: BoardState;
  readonly message: BoardOutboxMessage;
}

/** Atomically shaped board update used by the durable worker claim endpoint. */
export function leaseNextOutboxMessage(state: BoardState, input: LeaseOutboxInput): LeasedOutboxMessage | undefined {
  const candidate = state.outbox.find((message) => {
    if (!input.topics.includes(message.topic) || message.status === "dispatched") return false;
    if (input.taskIds && !input.taskIds.includes(message.taskId)) return false;
    if (input.messageIds && !input.messageIds.includes(message.id)) return false;
    if (message.status === "pending") return true;
    return message.leaseExpiresAt !== undefined && message.leaseExpiresAt <= input.now;
  });
  if (!candidate) return undefined;

  const { dispatchedAt: _dispatchedAt, dispatchedLeaseId: _dispatchedLeaseId, ...claimable } = candidate;
  const leased: BoardOutboxMessage = {
    ...claimable,
    status: "leased",
    leaseId: input.leaseId,
    writeFenceToken: input.writeFenceToken,
    leasedAt: input.now,
    leaseExpiresAt: input.expiresAt
  };
  return {
    state: {
      ...state,
      outbox: state.outbox.map((message) => (message.id === candidate.id ? leased : message))
    },
    message: leased
  };
}

export function findOutboxMessage(state: BoardState, messageId: BoardOutboxMessageId): BoardOutboxMessage | undefined {
  return state.outbox.find((message) => message.id === messageId);
}

export function renewOutboxLease(
  state: BoardState,
  messageId: BoardOutboxMessageId,
  leaseId: string,
  writeFenceToken: string,
  now: IsoTimestamp,
  expiresAt: IsoTimestamp
): BoardState | undefined {
  const message = findOutboxMessage(state, messageId);
  if (
    !message ||
    message.status !== "leased" ||
    message.leaseId !== leaseId ||
    message.writeFenceToken !== writeFenceToken ||
    !message.leaseExpiresAt ||
    message.leaseExpiresAt <= now
  ) {
    return undefined;
  }
  return {
    ...state,
    outbox: state.outbox.map((candidate) =>
      candidate.id === messageId ? { ...candidate, leasedAt: now, leaseExpiresAt: expiresAt } : candidate
    )
  };
}

/**
 * Voluntarily returns an active lease to the pending queue. The full fence is
 * required so a stale worker cannot release a newer worker's claim.
 */
export function releaseOutboxLease(
  state: BoardState,
  messageId: BoardOutboxMessageId,
  leaseId: string,
  writeFenceToken: string,
  now: IsoTimestamp
): BoardState | undefined {
  const message = findOutboxMessage(state, messageId);
  if (
    !message ||
    message.status !== "leased" ||
    message.leaseId !== leaseId ||
    message.writeFenceToken !== writeFenceToken ||
    !message.leaseExpiresAt ||
    message.leaseExpiresAt <= now
  ) {
    return undefined;
  }
  return {
    ...state,
    outbox: state.outbox.map((candidate) => {
      if (candidate.id !== messageId) return candidate;
      const {
        leaseId: _leaseId,
        writeFenceToken: _writeFenceToken,
        leasedAt: _leasedAt,
        leaseExpiresAt: _leaseExpiresAt,
        ...released
      } = candidate;
      return { ...released, status: "pending" };
    })
  };
}

export interface FenceOutboxLeasesInput {
  readonly topics: readonly string[];
  readonly now: IsoTimestamp;
  readonly actorId: string;
  readonly reason: string;
}

export interface FenceOutboxLeasesResult {
  readonly state: BoardState;
  readonly releasedMessageIds: readonly BoardOutboxMessageId[];
}

/**
 * Operator-only deployment drain primitive.
 *
 * Unlike a voluntary worker release, this deliberately ignores lease expiry
 * and does not require the bearer-held fence: the platform invokes it only
 * after every worker service has been replaced by a paused revision and all
 * older revisions have been deleted. Removing the stored lease/fence makes any
 * delayed completion fail closed, while returning the delivery to `pending`
 * lets the accepted candidate generation resume the exact task and attempt.
 */
export function fenceOutboxLeases(state: BoardState, input: FenceOutboxLeasesInput): FenceOutboxLeasesResult {
  const topics = new Set(input.topics);
  const released = state.outbox.filter((message) => message.status === "leased" && topics.has(message.topic));
  if (released.length === 0) return { state, releasedMessageIds: [] };

  const releasedIds = new Set(released.map((message) => message.id));
  let next: BoardState = {
    ...state,
    outbox: state.outbox.map((message) => {
      if (!releasedIds.has(message.id)) return message;
      const {
        leaseId: _leaseId,
        writeFenceToken: _writeFenceToken,
        leasedAt: _leasedAt,
        leaseExpiresAt: _leaseExpiresAt,
        ...unleased
      } = message;
      return { ...unleased, status: "pending" };
    })
  };
  for (const message of released) {
    next = appendEvent(next, "task.worker_lease_fenced", input.now, message.taskId, {
      actor: input.actorId,
      messageId: message.id,
      topic: message.topic,
      attempt: message.payload.attempt,
      reason: input.reason.slice(0, 500)
    });
  }
  return { state: next, releasedMessageIds: released.map((message) => message.id) };
}

export interface RetryLeasedOutboxTaskInput {
  readonly messageId: BoardOutboxMessageId;
  readonly taskId: TaskId;
  readonly leaseId: string;
  readonly writeFenceToken: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly now: IsoTimestamp;
  readonly diagnostic: {
    readonly category: string;
    readonly reason: string;
  };
}

export interface RetryLeasedOutboxTaskResult {
  readonly state: BoardState;
  readonly replay: boolean;
  readonly terminal: boolean;
  readonly nextMessage?: BoardOutboxMessage;
}

export type OperatorRetryRejectionReason =
  | "request_key_conflict"
  | "unknown_build"
  | "unknown_task"
  | "task_outside_build"
  | "build_not_failed"
  | "task_not_failed"
  | "task_not_dispatchable"
  | "attempts_exhausted"
  | "unsafe_graph_state";

export class OperatorRetryRejectedError extends Error {
  readonly reason: OperatorRetryRejectionReason;

  constructor(reason: OperatorRetryRejectionReason, message: string) {
    super(message);
    this.name = "OperatorRetryRejectedError";
    this.reason = reason;
  }
}

export interface RetryFailedBoardTaskInput {
  readonly buildTaskId: TaskId;
  readonly taskId: TaskId;
  readonly requestKey: string;
  readonly actorId: string;
  readonly reason: string;
  readonly now: IsoTimestamp;
}

export interface RetryFailedBoardTaskResult {
  readonly state: BoardState;
  readonly replay: boolean;
  readonly reopenedTaskIds: readonly TaskId[];
  readonly nextMessage: BoardOutboxMessage;
}

export interface RetryFailedBoardTasksInput {
  readonly buildTaskId: TaskId;
  readonly taskIds: readonly TaskId[];
  readonly requestKey: string;
  readonly actorId: string;
  readonly reason: string;
  readonly now: IsoTimestamp;
}

export interface RetryFailedBoardTasksResult {
  readonly state: BoardState;
  readonly replay: boolean;
  readonly reopenedTaskIds: readonly TaskId[];
  readonly nextMessages: readonly BoardOutboxMessage[];
}

export interface ReopenFailedAggregateBranchInput {
  readonly buildTaskId: TaskId;
  readonly aggregateTaskId: TaskId;
  readonly requestKey: string;
  readonly actorId: string;
  readonly reason: string;
  readonly now: IsoTimestamp;
}

export interface ReopenFailedAggregateBranchResult {
  readonly state: BoardState;
  readonly replay: boolean;
  readonly reopenedTaskIds: readonly TaskId[];
}

export interface BoardOperatorRetryBlocker {
  readonly code:
    "unknown_build" | "build_not_failed" | "no_failed_dispatchable_leaf" | "attempts_exhausted" | "unsafe_graph_state";
  readonly detail: string;
  readonly taskIds?: readonly TaskId[];
}

export interface BoardOperatorRetryEligibility {
  readonly eligible: boolean;
  readonly recoverableTaskIds: readonly TaskId[];
  readonly blockers: readonly BoardOperatorRetryBlocker[];
}

/**
 * Atomically retires one fenced delivery and either schedules its next bounded
 * attempt or fails it after exhaustion. Successful sibling tasks and their
 * artifacts are never rewritten: only the leased dispatchable task and its
 * outbox messages change.
 */
export function retryLeasedOutboxTask(
  state: BoardState,
  input: RetryLeasedOutboxTaskInput
): RetryLeasedOutboxTaskResult | undefined {
  if (
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > BOARD_TASK_HARD_MAX_ATTEMPTS
  ) {
    throw new Error(`maxAttempts must be between 1 and ${BOARD_TASK_HARD_MAX_ATTEMPTS}`);
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("attempt must be a positive safe integer");
  }

  const message = findOutboxMessage(state, input.messageId);
  const task = findTask(state, input.taskId);
  if (!message || !task || message.taskId !== task.id || message.payload.attempt !== input.attempt) {
    return undefined;
  }

  const priorReceipt = retryReceipt(state, input);
  if (message.status === "dispatched" && message.dispatchedLeaseId === input.leaseId && priorReceipt) {
    const nextMessage =
      priorReceipt.type === "task.retry_scheduled"
        ? state.outbox.find(
            (candidate) => candidate.taskId === task.id && candidate.payload.attempt === input.attempt + 1
          )
        : undefined;
    return {
      state,
      replay: true,
      terminal: priorReceipt.type === "task.retry_exhausted",
      ...(nextMessage ? { nextMessage } : {})
    };
  }

  if (
    message.status !== "leased" ||
    message.leaseId !== input.leaseId ||
    message.writeFenceToken !== input.writeFenceToken ||
    !message.leaseExpiresAt ||
    message.leaseExpiresAt <= input.now ||
    task.status !== "in_progress" ||
    task.attempt !== input.attempt
  ) {
    return undefined;
  }

  const terminal = input.attempt >= input.maxAttempts;
  let next = markOutboxDispatched(state, message.id, input.now);
  next = appendEvent(next, terminal ? "task.retry_exhausted" : "task.retry_scheduled", input.now, task.id, {
    messageId: message.id,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    category: input.diagnostic.category,
    reason: input.diagnostic.reason
  });
  next = transitionBoardTask(next, task.id, terminal ? "failed" : "blocked", input.now);
  next = reduceBoard(next, input.now);
  const nextMessage = terminal
    ? undefined
    : next.outbox.find((candidate) => candidate.taskId === task.id && candidate.payload.attempt === input.attempt + 1);
  return {
    state: next,
    replay: false,
    terminal,
    ...(nextMessage ? { nextMessage } : {})
  };
}

/**
 * Reopens one failed dispatchable task and only the required dependent chain in
 * the same build. This is deliberately stricter than an ordinary transition:
 * terminal states are immutable during normal reduction, so an operator retry
 * must prove that the failed task is the sole recoverable cause, retire every
 * stale delivery fence in the reopened chain, and leave completed siblings
 * untouched.
 */
export function retryFailedBoardTask(state: BoardState, input: RetryFailedBoardTaskInput): RetryFailedBoardTaskResult {
  const result = retryFailedBoardTasks(state, {
    ...input,
    taskIds: [input.taskId]
  });
  const nextMessage = result.nextMessages[0];
  if (!nextMessage) {
    throw new OperatorRetryRejectedError(
      "unsafe_graph_state",
      "operator retry did not preserve its scheduled outbox message"
    );
  }
  return {
    ...result,
    nextMessage
  };
}

/**
 * Atomically reopens multiple explicitly failed dispatchable tasks and the
 * union of their required dependent closures. Validation completes before any
 * state is changed, and one receipt owns the complete set of resulting outbox
 * messages so a request-key replay returns the exact original recovery.
 */
export function retryFailedBoardTasks(
  state: BoardState,
  input: RetryFailedBoardTasksInput
): RetryFailedBoardTasksResult {
  // Older snapshots may predate terminal reconciliation. Normalize them inside
  // the same atomic retry mutation so a failed aggregate cannot retain a
  // sibling lease that makes its own recovery permanently unsafe.
  const reconciledState = reconcileTerminalAggregates(state, input.now);
  const requestKey = input.requestKey.trim();
  if (!requestKey) {
    throw new OperatorRetryRejectedError("unsafe_graph_state", "operator retry requestKey must not be empty");
  }
  const targetTaskIds = [...new Set(input.taskIds)].sort();
  if (targetTaskIds.length === 0) {
    throw new OperatorRetryRejectedError("unsafe_graph_state", "operator retry requires at least one task");
  }

  const priorReceipt = reconciledState.events.find(
    (event) => event.type === "task.operator_retry_scheduled" && event.payload?.requestKey === requestKey
  );
  if (priorReceipt) {
    const receiptTargetTaskIds = operatorRetryTargetTaskIds(priorReceipt);
    if (priorReceipt.payload?.buildTaskId !== input.buildTaskId || !sameTaskIds(receiptTargetTaskIds, targetTaskIds)) {
      throw new OperatorRetryRejectedError(
        "request_key_conflict",
        "operator retry requestKey was already used for another task set"
      );
    }
    const nextMessages = operatorRetryMessagesFromReceipt(reconciledState, priorReceipt, targetTaskIds);
    if (nextMessages.length !== targetTaskIds.length) {
      throw new OperatorRetryRejectedError(
        "unsafe_graph_state",
        "operator retry receipt exists without all of its scheduled outbox messages"
      );
    }
    return {
      state: reconciledState,
      replay: true,
      reopenedTaskIds: taskIdsFromEvent(priorReceipt),
      nextMessages
    };
  }

  const build = findTask(reconciledState, input.buildTaskId);
  if (!build || build.kind !== "aggregate") {
    throw new OperatorRetryRejectedError("unknown_build", "operator retry build was not found");
  }
  if (build.status !== "failed") {
    throw new OperatorRetryRejectedError("build_not_failed", "operator retry requires a failed build");
  }

  const targets: BoardTask[] = [];
  for (const taskId of targetTaskIds) {
    const target = findTask(reconciledState, taskId);
    if (!target) {
      throw new OperatorRetryRejectedError("unknown_task", `operator retry task ${taskId} was not found`);
    }
    if (!taskBelongsToBuild(reconciledState, target, build.id)) {
      throw new OperatorRetryRejectedError(
        "task_outside_build",
        `operator retry task ${taskId} is outside the requested build`
      );
    }
    if (target.status !== "failed") {
      throw new OperatorRetryRejectedError("task_not_failed", `operator retry task ${taskId} is not failed`);
    }
    if (target.kind !== "dispatchable" || !target.dispatchTopic) {
      throw new OperatorRetryRejectedError(
        "task_not_dispatchable",
        `operator retry task ${taskId} is not dispatchable`
      );
    }
    if (target.attempt >= BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS) {
      throw new OperatorRetryRejectedError(
        "attempts_exhausted",
        `operator retry task ${taskId} cannot exceed ${BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS} attempts`
      );
    }
    if (!requiredDependenciesSatisfied(reconciledState, target.id)) {
      throw new OperatorRetryRejectedError(
        "unsafe_graph_state",
        `operator retry task ${taskId} has an incomplete required dependency`
      );
    }
    targets.push(target);
  }

  const buildTasks = reconciledState.tasks.filter((task) => taskBelongsToBuild(reconciledState, task, build.id));
  const dependentTaskIds = new Set<TaskId>();
  for (const target of targets) {
    for (const taskId of requiredDependentClosure(reconciledState, target.id)) {
      dependentTaskIds.add(taskId);
    }
  }
  for (const task of buildTasks) {
    if (task.status === "canceled" && wasCanceledByTerminalAggregate(reconciledState, task.id, build.id)) {
      dependentTaskIds.add(task.id);
    }
  }
  const reopenable = buildTasks.filter(
    (task) => dependentTaskIds.has(task.id) && (task.status === "failed" || task.status === "canceled")
  );
  const reopenableIds = new Set(reopenable.map((task) => task.id));
  const targetIdSet = new Set(targetTaskIds);

  for (const task of buildTasks) {
    if (task.status === "superseded") {
      throw new OperatorRetryRejectedError("unsafe_graph_state", "superseded build tasks cannot be reopened");
    }
    if ((task.status === "failed" || task.status === "canceled") && !reopenableIds.has(task.id)) {
      throw new OperatorRetryRejectedError(
        "unsafe_graph_state",
        "build has another terminal failure outside the selected dependency chain"
      );
    }
    const hasLeasedDeliveryOutsideRecovery = reconciledState.outbox.some(
      (message) => message.taskId === task.id && message.status === "leased"
    );
    if (!dependentTaskIds.has(task.id) && hasLeasedDeliveryOutsideRecovery) {
      throw new OperatorRetryRejectedError(
        "unsafe_graph_state",
        "build has leased dispatchable work outside the selected dependency chain"
      );
    }
  }

  for (const task of reopenable) {
    if (task.kind === "dispatchable" && task.attempt >= BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS) {
      throw new OperatorRetryRejectedError(
        "attempts_exhausted",
        `reopened dependency ${task.id} cannot exceed ${BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS} attempts`
      );
    }
    if (!targetIdSet.has(task.id) && task.status === "failed" && task.kind !== "aggregate") {
      throw new OperatorRetryRejectedError(
        "unsafe_graph_state",
        "selected dependency chain contains another failed task that was not explicitly selected"
      );
    }
  }

  let next = reconciledState;
  const retiredMessageIds: BoardOutboxMessageId[] = [];
  for (const message of reconciledState.outbox) {
    if (reopenableIds.has(message.taskId) && message.status !== "dispatched") {
      next = markOutboxDispatched(next, message.id, input.now);
      retiredMessageIds.push(message.id);
    }
  }

  for (const task of reopenable) {
    next = appendEvent(
      {
        ...next,
        tasks: next.tasks.map((candidate) =>
          candidate.id === task.id ? { ...candidate, status: "triage", updatedAt: input.now } : candidate
        )
      },
      "task.operator_reopened",
      input.now,
      task.id,
      {
        actor: input.actorId,
        requestKey,
        fromStatus: task.status,
        reason: input.reason,
        targetTaskIds,
        ...(targets.length === 1 ? { targetTaskId: targets[0]!.id } : {})
      }
    );
  }

  next = reduceBoard(next, input.now);
  const nextMessages: BoardOutboxMessage[] = [];
  for (const target of targets) {
    const nextMessage = next.outbox.find(
      (message) => message.taskId === target.id && message.payload.attempt === target.attempt + 1
    );
    if (!nextMessage || nextMessage.status !== "pending") {
      throw new OperatorRetryRejectedError(
        "unsafe_graph_state",
        `operator retry did not produce a fresh pending outbox message for ${target.id}`
      );
    }
    nextMessages.push(nextMessage);
  }
  next = appendEvent(next, "task.operator_retry_scheduled", input.now, targets[0]!.id, {
    actor: input.actorId,
    buildTaskId: build.id,
    requestKey,
    reason: input.reason,
    targetTaskIds,
    previousAttempts: targets.map((target) => target.attempt),
    nextAttempts: nextMessages.map((message) => message.payload.attempt),
    outboxMessageIds: nextMessages.map((message) => message.id),
    ...(targets.length === 1
      ? {
          previousAttempt: targets[0]!.attempt,
          nextAttempt: nextMessages[0]!.payload.attempt
        }
      : {}),
    reopenedTaskIds: reopenable.map((task) => task.id),
    retiredMessageIds
  });
  return {
    state: next,
    replay: false,
    reopenedTaskIds: reopenable.map((task) => task.id),
    nextMessages
  };
}

/**
 * Reopens a failed aggregate branch so a domain coordinator can atomically add
 * fresh recovery work before reduction runs again. Unlike dispatchable task
 * retry, this function deliberately does not reduce the Board: without the new
 * child dependency, the aggregate could complete immediately. The caller must
 * add its recovery graph and reduce the returned state in the same durable
 * mutation.
 */
export function reopenFailedAggregateBranch(
  state: BoardState,
  input: ReopenFailedAggregateBranchInput
): ReopenFailedAggregateBranchResult {
  const reconciledState = reconcileTerminalAggregates(state, input.now);
  const requestKey = input.requestKey.trim();
  if (!requestKey) {
    throw new OperatorRetryRejectedError("unsafe_graph_state", "aggregate recovery requestKey must not be empty");
  }

  const priorReceipt = reconciledState.events.find(
    (event) => event.type === "task.operator_aggregate_recovery_scheduled" && event.payload?.requestKey === requestKey
  );
  if (priorReceipt) {
    if (priorReceipt.taskId !== input.aggregateTaskId || priorReceipt.payload?.buildTaskId !== input.buildTaskId) {
      throw new OperatorRetryRejectedError(
        "request_key_conflict",
        "aggregate recovery requestKey was already used for another branch"
      );
    }
    return {
      state: reconciledState,
      replay: true,
      reopenedTaskIds: taskIdsFromEvent(priorReceipt)
    };
  }

  const build = findTask(reconciledState, input.buildTaskId);
  if (!build || build.kind !== "aggregate") {
    throw new OperatorRetryRejectedError("unknown_build", "aggregate recovery build was not found");
  }
  if (build.status !== "failed") {
    throw new OperatorRetryRejectedError("build_not_failed", "aggregate recovery requires a failed build");
  }
  const target = findTask(reconciledState, input.aggregateTaskId);
  if (
    !target ||
    target.id === build.id ||
    target.kind !== "aggregate" ||
    !taskBelongsToBuild(reconciledState, target, build.id)
  ) {
    throw new OperatorRetryRejectedError(
      "unsafe_graph_state",
      "aggregate recovery target must be a failed aggregate inside the build"
    );
  }
  if (target.status !== "failed") {
    throw new OperatorRetryRejectedError("unsafe_graph_state", "aggregate recovery target is not failed");
  }

  const buildTasks = reconciledState.tasks.filter(
    (task) => task.id === build.id || taskBelongsToBuild(reconciledState, task, build.id)
  );
  for (const task of buildTasks) {
    if (task.status === "superseded") {
      throw new OperatorRetryRejectedError("unsafe_graph_state", "superseded build tasks cannot be reopened");
    }
    if (task.status === "failed" && task.id !== build.id && task.id !== target.id) {
      throw new OperatorRetryRejectedError(
        "unsafe_graph_state",
        "build has another terminal failure outside the selected aggregate branch"
      );
    }
    if (task.status === "canceled" && !wasCanceledByTerminalAggregate(reconciledState, task.id, build.id)) {
      throw new OperatorRetryRejectedError(
        "unsafe_graph_state",
        "build contains a cancellation that was not caused by terminal aggregate reconciliation"
      );
    }
  }

  const reopenable = buildTasks.filter(
    (task) =>
      task.id === build.id ||
      task.id === target.id ||
      (task.status === "canceled" && wasCanceledByTerminalAggregate(reconciledState, task.id, build.id))
  );
  const reopenableIds = new Set(reopenable.map((task) => task.id));
  let next = reconciledState;
  const retiredMessageIds: BoardOutboxMessageId[] = [];
  for (const message of reconciledState.outbox) {
    if (reopenableIds.has(message.taskId) && message.status !== "dispatched") {
      next = markOutboxDispatched(next, message.id, input.now);
      retiredMessageIds.push(message.id);
    }
  }

  for (const task of reopenable) {
    next = appendEvent(
      {
        ...next,
        tasks: next.tasks.map((candidate) =>
          candidate.id === task.id ? { ...candidate, status: "triage", updatedAt: input.now } : candidate
        )
      },
      "task.operator_reopened",
      input.now,
      task.id,
      {
        actor: input.actorId,
        requestKey,
        fromStatus: task.status,
        reason: input.reason,
        aggregateTaskId: target.id,
        buildTaskId: build.id
      }
    );
  }

  next = appendEvent(next, "task.operator_aggregate_recovery_scheduled", input.now, target.id, {
    actor: input.actorId,
    buildTaskId: build.id,
    requestKey,
    reason: input.reason,
    reopenedTaskIds: reopenable.map((task) => task.id),
    retiredMessageIds
  });
  return {
    state: next,
    replay: false,
    reopenedTaskIds: reopenable.map((task) => task.id)
  };
}

/**
 * Reports the exact generic Board leaves an operator can batch-retry. The
 * analysis first applies the same idempotent terminal reconciliation as the
 * mutation, then dry-runs the complete retry validation without persisting it.
 */
export function boardOperatorRetryEligibility(
  state: BoardState,
  input: { readonly buildTaskId: TaskId; readonly now: IsoTimestamp }
): BoardOperatorRetryEligibility {
  const reconciled = reconcileTerminalAggregates(state, input.now);
  const build = findTask(reconciled, input.buildTaskId);
  if (!build || build.kind !== "aggregate") {
    return {
      eligible: false,
      recoverableTaskIds: [],
      blockers: [{ code: "unknown_build", detail: "operator retry build was not found" }]
    };
  }
  if (build.status !== "failed") {
    return {
      eligible: false,
      recoverableTaskIds: [],
      blockers: [{ code: "build_not_failed", detail: "operator retry requires a failed build" }]
    };
  }

  const failedLeaves = reconciled.tasks
    .filter(
      (task) =>
        task.status === "failed" &&
        task.kind === "dispatchable" &&
        Boolean(task.dispatchTopic) &&
        taskBelongsToBuild(reconciled, task, build.id) &&
        requiredDependenciesSatisfied(reconciled, task.id)
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (failedLeaves.length === 0) {
    return {
      eligible: false,
      recoverableTaskIds: [],
      blockers: [
        {
          code: "no_failed_dispatchable_leaf",
          detail: "build has no failed dispatchable leaf with completed required dependencies"
        }
      ]
    };
  }

  const exhausted = failedLeaves.filter((task) => task.attempt >= BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS);
  if (exhausted.length > 0) {
    return {
      eligible: false,
      recoverableTaskIds: failedLeaves.map((task) => task.id),
      blockers: [
        {
          code: "attempts_exhausted",
          detail: `operator retry cannot exceed ${BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS} attempts`,
          taskIds: exhausted.map((task) => task.id)
        }
      ]
    };
  }

  const recoverableTaskIds = failedLeaves.map((task) => task.id);
  try {
    retryFailedBoardTasks(reconciled, {
      buildTaskId: build.id,
      taskIds: recoverableTaskIds,
      requestKey: `\u0000eligibility:${build.id}`,
      actorId: "system:eligibility",
      reason: "dry-run",
      now: input.now
    });
    return { eligible: true, recoverableTaskIds, blockers: [] };
  } catch (error) {
    return {
      eligible: false,
      recoverableTaskIds,
      blockers: [
        {
          code: "unsafe_graph_state",
          detail: error instanceof Error ? error.message : "operator retry graph is unsafe"
        }
      ]
    };
  }
}

export function nextPendingOutboxMessage(state: BoardState): BoardOutboxMessage | undefined {
  return state.outbox.find((message) => message.status === "pending");
}

export function findTask(state: BoardState, taskId: TaskId): BoardTask | undefined {
  return state.tasks.find((task) => task.id === taskId);
}

export function findTasksByType(state: BoardState, type: BoardTask["type"]): readonly BoardTask[] {
  return state.tasks.filter((task) => task.type === type);
}

function requiredDependenciesSatisfied(state: BoardState, taskId: TaskId): boolean {
  const requiredDependencies = state.dependencies.filter(
    (dependency) => dependency.taskId === taskId && dependency.required
  );

  return requiredDependencies.every((dependency) => {
    const dependencyTask = findTask(state, dependency.dependsOnTaskId);
    return dependencyTask?.status === "done";
  });
}

function queueReadyDispatchableTasks(state: BoardState, now: IsoTimestamp): BoardState {
  let next = state;

  for (const task of state.tasks) {
    if (task.kind !== "dispatchable" || !task.dispatchTopic || !isReadyForQueue(state, task)) {
      continue;
    }

    const topic = task.dispatchTopic;
    const attempt = task.attempt + 1;
    const idempotencyKey = `${task.id}:${attempt}`;

    if (state.outbox.some((message) => message.idempotencyKey === idempotencyKey)) {
      continue;
    }

    next = appendEvent(
      {
        ...next,
        tasks: next.tasks.map((existing) =>
          existing.id === task.id ? { ...existing, status: "queued", attempt, updatedAt: now } : existing
        ),
        outbox: [
          ...next.outbox,
          {
            id: entityId(`outbox_${task.id}_${attempt}`),
            taskId: task.id,
            topic,
            idempotencyKey,
            status: "pending",
            payload: { taskId: task.id, attempt },
            createdAt: now
          }
        ]
      },
      "task.queued",
      now,
      task.id,
      { attempt, topic }
    );
  }

  return next;
}

function completeReadyAggregateTasks(state: BoardState, now: IsoTimestamp): BoardState {
  let next = state;

  for (const task of state.tasks) {
    const hasDependencies = state.dependencies.some((dependency) => dependency.taskId === task.id);
    if (task.kind !== "aggregate" || !hasDependencies || !isReadyForQueue(state, task)) {
      continue;
    }

    next = transitionBoardTask(next, task.id, "done", now);
  }

  return next;
}

function blockWaitpointTasks(state: BoardState, now: IsoTimestamp): BoardState {
  let next = state;

  for (const task of state.tasks) {
    if (task.kind === "waitpoint" && task.status === "triage") {
      next = transitionBoardTask(next, task.id, "blocked", now);
    }
  }

  return next;
}

function terminateFailedDependencyTasks(state: BoardState, now: IsoTimestamp): BoardState {
  let next = state;

  for (const task of state.tasks) {
    if (isTerminalTaskStatus(task.status)) {
      continue;
    }

    const hasFailedRequiredDependency = state.dependencies.some((dependency) => {
      if (dependency.taskId !== task.id || !dependency.required) {
        return false;
      }
      const dependencyTask = findTask(state, dependency.dependsOnTaskId);
      return dependencyTask !== undefined && isTerminalFailure(dependencyTask.status);
    });

    if (!hasFailedRequiredDependency) {
      continue;
    }

    next = transitionBoardTask(next, task.id, task.kind === "aggregate" ? "failed" : "canceled", now);
  }

  return next;
}

/**
 * Repairs both newly transitioned aggregates and retained snapshots from older
 * reducers. A terminal failure is a fence for its complete parent hierarchy:
 * unfinished descendants cannot continue using a lease after their aggregate
 * has already reached a terminal state.
 */
function reconcileTerminalAggregates(state: BoardState, now: IsoTimestamp): BoardState {
  let next = state;
  for (const task of state.tasks) {
    if (task.kind === "aggregate" && isTerminalFailure(task.status)) {
      next = reconcileTerminalAggregate(next, task.id, now);
    }
  }
  return next;
}

function reconcileTerminalAggregate(state: BoardState, aggregateTaskId: TaskId, now: IsoTimestamp): BoardState {
  const aggregate = findTask(state, aggregateTaskId);
  if (!aggregate || aggregate.kind !== "aggregate" || !isTerminalFailure(aggregate.status)) {
    return state;
  }

  const descendantIds = new Set(
    state.tasks
      .filter((task) => task.id !== aggregate.id && taskBelongsToBuild(state, task, aggregate.id))
      .map((task) => task.id)
  );
  if (descendantIds.size === 0) return state;

  let next = state;
  const canceledTaskIds: TaskId[] = [];
  const retiredMessageIds: BoardOutboxMessageId[] = [];

  for (const task of state.tasks) {
    if (!descendantIds.has(task.id) || isTerminalTaskStatus(task.status)) continue;
    next = appendEvent(
      {
        ...next,
        tasks: next.tasks.map((candidate) =>
          candidate.id === task.id ? { ...candidate, status: "canceled", updatedAt: now } : candidate
        )
      },
      "task.transitioned",
      now,
      task.id,
      { fromStatus: task.status, toStatus: "canceled" }
    );
    next = appendEvent(next, "task.aggregate_terminal_canceled", now, task.id, {
      aggregateTaskId: aggregate.id,
      aggregateStatus: aggregate.status,
      fromStatus: task.status
    });
    canceledTaskIds.push(task.id);
  }

  for (const message of state.outbox) {
    if (!descendantIds.has(message.taskId) || message.status === "dispatched") continue;
    next = markOutboxDispatched(next, message.id, now);
    next = appendEvent(next, "task.aggregate_terminal_outbox_retired", now, message.taskId, {
      aggregateTaskId: aggregate.id,
      aggregateStatus: aggregate.status,
      messageId: message.id,
      attempt: message.payload.attempt,
      previousStatus: message.status,
      topic: message.topic
    });
    retiredMessageIds.push(message.id);
  }

  if (canceledTaskIds.length === 0 && retiredMessageIds.length === 0) return state;
  return appendEvent(next, "aggregate.terminal_reconciled", now, aggregate.id, {
    aggregateStatus: aggregate.status,
    canceledTaskIds,
    retiredMessageIds
  });
}

function isReadyForQueue(state: BoardState, task: BoardTask): boolean {
  if (task.status !== "triage" && task.status !== "blocked") {
    return false;
  }

  return requiredDependenciesSatisfied(state, task.id);
}

function retryReceipt(
  state: BoardState,
  input: Pick<RetryLeasedOutboxTaskInput, "messageId" | "taskId" | "attempt" | "maxAttempts">
): BoardEvent | undefined {
  return state.events.find(
    (event) =>
      event.taskId === input.taskId &&
      (event.type === "task.retry_scheduled" || event.type === "task.retry_exhausted") &&
      event.payload?.messageId === input.messageId &&
      event.payload.attempt === input.attempt &&
      event.payload.maxAttempts === input.maxAttempts
  );
}

function taskBelongsToBuild(state: BoardState, task: BoardTask, buildTaskId: TaskId): boolean {
  let current: BoardTask | undefined = task;
  const visited = new Set<TaskId>();
  while (current) {
    if (current.id === buildTaskId) return true;
    if (!current.parentTaskId || visited.has(current.id)) return false;
    visited.add(current.id);
    current = findTask(state, current.parentTaskId);
  }
  return false;
}

function wasCanceledByTerminalAggregate(state: BoardState, taskId: TaskId, buildTaskId: TaskId): boolean {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const transition = state.events[index];
    if (transition?.taskId !== taskId || transition.type !== "task.transitioned") continue;
    if (transition.payload?.toStatus !== "canceled") return false;
    const provenance = state.events[index + 1];
    if (provenance?.taskId !== taskId || provenance.type !== "task.aggregate_terminal_canceled") return false;
    const aggregateTaskId = provenance.payload?.aggregateTaskId;
    if (typeof aggregateTaskId !== "string") return false;
    const aggregate = findTask(state, entityId<"task">(aggregateTaskId));
    return aggregate !== undefined && taskBelongsToBuild(state, aggregate, buildTaskId);
  }
  return false;
}

function requiredDependentClosure(state: BoardState, taskId: TaskId): Set<TaskId> {
  const closure = new Set<TaskId>([taskId]);
  const pending = [taskId];
  while (pending.length > 0) {
    const dependencyId = pending.shift()!;
    for (const dependency of state.dependencies) {
      if (!dependency.required || dependency.dependsOnTaskId !== dependencyId || closure.has(dependency.taskId)) {
        continue;
      }
      closure.add(dependency.taskId);
      pending.push(dependency.taskId);
    }
  }
  return closure;
}

function taskIdsFromEvent(event: BoardEvent): readonly TaskId[] {
  const value = event.payload?.reopenedTaskIds;
  return Array.isArray(value) ? value.filter((item): item is TaskId => typeof item === "string") : [];
}

function operatorRetryTargetTaskIds(event: BoardEvent): readonly TaskId[] {
  const value = event.payload?.targetTaskIds;
  if (Array.isArray(value)) {
    return value.filter((item): item is TaskId => typeof item === "string").sort();
  }
  return event.taskId ? [event.taskId] : [];
}

function operatorRetryMessagesFromReceipt(
  state: BoardState,
  event: BoardEvent,
  targetTaskIds: readonly TaskId[]
): readonly BoardOutboxMessage[] {
  const messageIds = event.payload?.outboxMessageIds;
  if (Array.isArray(messageIds)) {
    const messages = messageIds
      .filter((item): item is BoardOutboxMessageId => typeof item === "string")
      .map((messageId) => findOutboxMessage(state, messageId));
    return messages.length === targetTaskIds.length &&
      messages.every((message, index): message is BoardOutboxMessage => message?.taskId === targetTaskIds[index])
      ? messages
      : [];
  }

  const nextAttempt = event.payload?.nextAttempt;
  const taskId = targetTaskIds[0];
  if (targetTaskIds.length !== 1 || !taskId || typeof nextAttempt !== "number") return [];
  const message = state.outbox.find(
    (candidate) => candidate.taskId === taskId && candidate.payload.attempt === nextAttempt
  );
  return message ? [message] : [];
}

function sameTaskIds(left: readonly TaskId[], right: readonly TaskId[]): boolean {
  return left.length === right.length && left.every((taskId, index) => taskId === right[index]);
}
