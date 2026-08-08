import { boardOperatorRetryEligibility, type BoardState, type BoardTask, type TaskId } from "@jina/board";
import { contextWorkflowBoardTaskTypes } from "@jina/context-engine";

export function contextBuildBoardState(state: BoardState, buildTaskId: TaskId): BoardState {
  const tasks = state.tasks.filter((task) => task.id === buildTaskId || task.metadata.contextBuildId === buildTaskId);
  const taskIds = new Set(tasks.map((task) => task.id));
  return {
    tasks,
    dependencies: state.dependencies.filter(
      (dependency) => taskIds.has(dependency.taskId) && taskIds.has(dependency.dependsOnTaskId)
    ),
    outbox: state.outbox.filter((message) => taskIds.has(message.taskId)),
    events: state.events.filter((event) => event.taskId === undefined || taskIds.has(event.taskId))
  };
}

export function contextDeadlineInterruptedTaskIds(state: BoardState, build: BoardTask): readonly TaskId[] {
  return contextLimitInterruptedTaskIds(state, build, "context.build_time_budget_exceeded.failed");
}

export function contextTokenInterruptedTaskIds(state: BoardState, build: BoardTask): readonly TaskId[] {
  return contextLimitInterruptedTaskIds(state, build, "context.build_token_budget_exceeded.failed");
}

function contextLimitInterruptedTaskIds(
  state: BoardState,
  build: BoardTask,
  failureEventType: "context.build_time_budget_exceeded.failed" | "context.build_token_budget_exceeded.failed"
): readonly TaskId[] {
  if (build.type !== contextWorkflowBoardTaskTypes.build || build.status !== "failed") return [];
  const latestReopen = [...state.events]
    .reverse()
    .find((event) => event.taskId === build.id && event.type === "task.operator_reopened");
  const limitFailure = [...state.events]
    .reverse()
    .find((event) => event.taskId === build.id && event.type === failureEventType);
  if (!limitFailure || (latestReopen && limitFailure.seq <= latestReopen.seq)) return [];
  const reconciliation = state.events.find(
    (event) =>
      event.taskId === build.id &&
      event.type === "aggregate.terminal_reconciled" &&
      event.seq > limitFailure.seq &&
      Array.isArray(event.payload?.canceledTaskIds)
  );
  if (!reconciliation) return [];
  const canceledIds = new Set(
    (reconciliation.payload?.canceledTaskIds as unknown[]).filter((value): value is string => typeof value === "string")
  );
  return state.tasks
    .filter(
      (task) =>
        canceledIds.has(task.id) &&
        task.status === "canceled" &&
        task.kind === "dispatchable" &&
        Boolean(task.dispatchTopic) &&
        task.metadata.contextBuildId === build.id
    )
    .map((task) => task.id)
    .sort((left, right) => left.localeCompare(right));
}

export function contextBuildHasOperatorRecovery(state: BoardState, build: BoardTask, now: string): boolean {
  if (build.type !== contextWorkflowBoardTaskTypes.build || build.status !== "failed") return false;
  if (
    state.events.some(
      (event) => event.taskId === build.id && event.type === "context.build_operator_recovery_abandoned"
    )
  ) {
    return false;
  }
  const buildState = contextBuildBoardState(state, build.id);
  return (
    boardOperatorRetryEligibility(buildState, { buildTaskId: build.id, now }).eligible ||
    contextDeadlineInterruptedTaskIds(buildState, build).length > 0 ||
    contextTokenInterruptedTaskIds(buildState, build).length > 0
  );
}
