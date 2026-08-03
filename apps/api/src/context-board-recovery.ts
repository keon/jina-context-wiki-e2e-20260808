import { boardOperatorRetryEligibility, type BoardState, type BoardTask, type TaskId } from "@jina/board";
import { MAX_CONTEXT_OPERATOR_REMEDIATION_PASS, contextBoardTaskTypes } from "@jina/context-engine";

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
  if (build.type !== contextBoardTaskTypes.build || build.status !== "failed") return [];
  const latestReopen = [...state.events]
    .reverse()
    .find((event) => event.taskId === build.id && event.type === "task.operator_reopened");
  const deadlineFailure = [...state.events]
    .reverse()
    .find((event) => event.taskId === build.id && event.type === "context.build_time_budget_exceeded.failed");
  if (!deadlineFailure || (latestReopen && deadlineFailure.seq <= latestReopen.seq)) return [];
  const reconciliation = state.events.find(
    (event) =>
      event.taskId === build.id &&
      event.type === "aggregate.terminal_reconciled" &&
      event.seq > deadlineFailure.seq &&
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

export function contextPageRemediationTaskIds(state: BoardState, build: BoardTask): readonly TaskId[] {
  return state.tasks
    .filter(
      (task) =>
        task.parentTaskId === build.id &&
        task.type === contextBoardTaskTypes.page &&
        task.status === "failed" &&
        hasCurrentExhaustion(state, task.id, "context.page_repair_exhausted")
    )
    .filter((page) => {
      const latestPass = state.tasks
        .filter(
          (task) =>
            task.parentTaskId === page.id &&
            task.type === contextBoardTaskTypes.pageAudit &&
            task.status === "done" &&
            Number.isSafeInteger(task.metadata.pass)
        )
        .reduce((maximum, task) => Math.max(maximum, Number(task.metadata.pass)), 0);
      return latestPass >= 1 && latestPass < MAX_CONTEXT_OPERATOR_REMEDIATION_PASS;
    })
    .map((page) => page.id)
    .sort((left, right) => left.localeCompare(right));
}

export function contextGateRemediationTaskId(state: BoardState, build: BoardTask): TaskId | undefined {
  const certification = state.tasks.find(
    (task) =>
      task.parentTaskId === build.id && task.type === contextBoardTaskTypes.certification && task.status === "canceled"
  );
  const exhaustion = certification
    ? [...state.events]
        .reverse()
        .find((event) => event.taskId === certification.id && event.type === "context.gate_repair_exhausted")
    : undefined;
  return certification &&
    isAfterLatestOperatorReopen(state, certification.id, exhaustion?.seq) &&
    Number.isSafeInteger(exhaustion?.payload?.pass) &&
    Number(exhaustion?.payload?.pass) < MAX_CONTEXT_OPERATOR_REMEDIATION_PASS
    ? certification.id
    : undefined;
}

function hasCurrentExhaustion(
  state: BoardState,
  taskId: TaskId,
  eventType: "context.page_repair_exhausted" | "context.gate_repair_exhausted"
): boolean {
  const exhaustion = [...state.events].reverse().find((event) => event.taskId === taskId && event.type === eventType);
  return isAfterLatestOperatorReopen(state, taskId, exhaustion?.seq);
}

function isAfterLatestOperatorReopen(state: BoardState, taskId: TaskId, eventSequence: number | undefined): boolean {
  if (eventSequence === undefined) return false;
  const latestReopen = [...state.events]
    .reverse()
    .find((event) => event.taskId === taskId && event.type === "task.operator_reopened");
  return !latestReopen || eventSequence > latestReopen.seq;
}

export function contextBuildHasOperatorRecovery(state: BoardState, build: BoardTask, now: string): boolean {
  if (build.type !== contextBoardTaskTypes.build || build.status !== "failed") return false;
  const buildState = contextBuildBoardState(state, build.id);
  return (
    boardOperatorRetryEligibility(buildState, { buildTaskId: build.id, now }).eligible ||
    contextDeadlineInterruptedTaskIds(buildState, build).length > 0 ||
    contextPageRemediationTaskIds(buildState, build).length > 0 ||
    contextGateRemediationTaskId(buildState, build) !== undefined
  );
}
