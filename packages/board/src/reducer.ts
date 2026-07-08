import { entityId, type EntityId, type IsoTimestamp } from "@jina/shared-kernel";
import type { TaskDependencyDraft, TaskId } from "./dependencies.js";
import { isTerminalTaskStatus, type TaskStatus } from "./task-status.js";
import { isDispatchableTask, type BoardTask } from "./tasks.js";

export type BoardOutboxMessageId = EntityId<"board_outbox_message">;

export type BoardOutboxStatus = "pending" | "published";

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
  readonly publishedAt?: IsoTimestamp;
}

export interface BoardEvent {
  readonly id: EntityId<"board_event">;
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

export function addTask(state: BoardState, task: BoardTask): BoardState {
  if (state.tasks.some((existing) => existing.dedupeKey === task.dedupeKey)) {
    return state;
  }

  return {
    ...state,
    tasks: [...state.tasks, task],
    events: [...state.events, boardEvent("task.created", task.updatedAt, task.id, { type: task.type })]
  };
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

  return {
    ...state,
    dependencies: [...state.dependencies, dependency],
    events: [
      ...state.events,
      boardEvent("task.dependency_added", now, dependency.taskId, {
        dependsOnTaskId: dependency.dependsOnTaskId,
        relationship: dependency.relationship
      })
    ]
  };
}

export function transitionBoardTask(state: BoardState, taskId: TaskId, toStatus: TaskStatus, now: IsoTimestamp): BoardState {
  const task = findTask(state, taskId);
  if (!task || task.status === toStatus || isTerminalTaskStatus(task.status)) {
    return state;
  }

  return {
    ...state,
    tasks: state.tasks.map((existing) =>
      existing.id === taskId ? { ...existing, status: toStatus, updatedAt: now } : existing
    ),
    events: [...state.events, boardEvent("task.transitioned", now, taskId, { fromStatus: task.status, toStatus })]
  };
}

export function reduceBoard(state: BoardState, now: IsoTimestamp): BoardState {
  let next = state;
  let changed = true;

  while (changed) {
    const afterAggregateCompletion = completeReadyAggregateTasks(next, now);
    const afterDispatchQueueing = queueReadyDispatchableTasks(afterAggregateCompletion, now);
    changed = afterDispatchQueueing !== next;
    next = afterDispatchQueueing;
  }

  return next;
}

export function markOutboxPublished(
  state: BoardState,
  outboxMessageId: BoardOutboxMessageId,
  now: IsoTimestamp
): BoardState {
  return {
    ...state,
    outbox: state.outbox.map((message) =>
      message.id === outboxMessageId && message.status === "pending"
        ? { ...message, status: "published", publishedAt: now }
        : message
    )
  };
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
    if (!isDispatchableTask(task) || !isReadyForQueue(state, task)) {
      continue;
    }

    const topic = task.dispatchTopic;
    if (!topic) {
      continue;
    }

    const attempt = task.attempt + 1;
    const idempotencyKey = `${task.id}:${attempt}`;

    if (state.outbox.some((message) => message.idempotencyKey === idempotencyKey)) {
      continue;
    }

    next = {
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
      ],
      events: [...next.events, boardEvent("task.queued", now, task.id, { attempt, topic })]
    };
  }

  return next;
}

function completeReadyAggregateTasks(state: BoardState, now: IsoTimestamp): BoardState {
  let next = state;

  for (const task of state.tasks) {
    const hasDependencies = state.dependencies.some((dependency) => dependency.taskId === task.id);
    if (isDispatchableTask(task) || !hasDependencies || !isReadyForQueue(state, task)) {
      continue;
    }

    next = transitionBoardTask(next, task.id, "done", now);
  }

  return next;
}

function isReadyForQueue(state: BoardState, task: BoardTask): boolean {
  if (task.status !== "triage" && task.status !== "blocked") {
    return false;
  }

  return requiredDependenciesSatisfied(state, task.id);
}

function boardEvent(
  type: string,
  at: IsoTimestamp,
  taskId?: TaskId,
  payload?: Record<string, unknown>
): BoardEvent {
  return {
    id: entityId(`event_${type}_${at}_${taskId ?? "board"}`),
    type,
    at,
    ...(taskId ? { taskId } : {}),
    ...(payload ? { payload } : {})
  };
}
