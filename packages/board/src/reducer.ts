import { entityId, type EntityId, type IsoTimestamp } from "@jina/shared-kernel";
import type { TaskDependencyDraft, TaskId } from "./dependencies.js";
import { isTerminalFailure, isTerminalTaskStatus, type TaskStatus } from "./task-status.js";
import { createBoardTask, type BoardTask } from "./tasks.js";

export type BoardOutboxMessageId = EntityId<"board_outbox_message">;

export type BoardOutboxStatus = "pending" | "leased" | "dispatched";

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
  readonly leasedAt?: IsoTimestamp;
  readonly leaseExpiresAt?: IsoTimestamp;
  readonly dispatchedAt?: IsoTimestamp;
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

export function addTask(state: BoardState, task: BoardTask): BoardState {
  if (state.tasks.some((existing) => existing.dedupeKey === task.dedupeKey)) {
    return state;
  }

  return appendEvent({ ...state, tasks: [...state.tasks, task] }, "task.created", task.updatedAt, task.id, {
    type: task.type
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

export function transitionBoardTask(state: BoardState, taskId: TaskId, toStatus: TaskStatus, now: IsoTimestamp): BoardState {
  const task = findTask(state, taskId);
  if (!task || task.status === toStatus || isTerminalTaskStatus(task.status)) {
    return state;
  }

  return appendEvent(
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
}

export function reduceBoard(state: BoardState, now: IsoTimestamp): BoardState {
  let next = state;
  let changed = true;

  while (changed) {
    let step = blockWaitpointTasks(next, now);
    step = escalateFailedDependencies(step, now);
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
      const { leaseId: _leaseId, leasedAt: _leasedAt, leaseExpiresAt: _leaseExpiresAt, ...unleased } = message;
      return { ...unleased, status: "dispatched", dispatchedAt: now };
    })
  };
}

export interface LeaseOutboxInput {
  readonly topics: readonly string[];
  readonly taskIds?: readonly TaskId[];
  readonly leaseId: string;
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
    if (message.status === "pending") return true;
    return message.leaseExpiresAt !== undefined && message.leaseExpiresAt <= input.now;
  });
  if (!candidate) return undefined;

  const { dispatchedAt: _dispatchedAt, ...claimable } = candidate;
  const leased: BoardOutboxMessage = {
    ...claimable,
    status: "leased",
    leaseId: input.leaseId,
    leasedAt: input.now,
    leaseExpiresAt: input.expiresAt
  };
  return {
    state: {
      ...state,
      outbox: state.outbox.map((message) => message.id === candidate.id ? leased : message)
    },
    message: leased
  };
}

export function findOutboxMessage(state: BoardState, messageId: BoardOutboxMessageId): BoardOutboxMessage | undefined {
  return state.outbox.find((message) => message.id === messageId);
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

export function requiredDependenciesSatisfied(state: BoardState, taskId: TaskId): boolean {
  const requiredDependencies = state.dependencies.filter((dependency) => dependency.taskId === taskId && dependency.required);

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

function escalateFailedDependencies(state: BoardState, now: IsoTimestamp): BoardState {
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

    next = transitionBoardTask(next, task.id, "blocked", now);

    const decisionId = entityId<"task">(`${task.id}:unblock`);
    next = addTask(
      next,
      createBoardTask({
        id: decisionId,
        type: "human_decision",
        title: `Decide how to unblock: ${task.title}`,
        assigneeRole: "human",
        dedupeKey: `${task.dedupeKey}:unblock`,
        now,
        required: false,
        parentTaskId: task.id,
        ...(task.epoch !== undefined ? { epoch: task.epoch } : {})
      })
    );
    next = addDependency(
      next,
      {
        taskId: task.id,
        dependsOnTaskId: decisionId,
        relationship: "relates_to",
        required: false,
        blocksParentCompletion: false
      },
      now
    );
  }

  return next;
}

function isReadyForQueue(state: BoardState, task: BoardTask): boolean {
  if (task.status !== "triage" && task.status !== "blocked") {
    return false;
  }

  return requiredDependenciesSatisfied(state, task.id);
}
