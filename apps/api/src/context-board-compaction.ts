import { isTerminalTaskStatus, type BoardState, type TaskId } from "@jina/board";
import { contextBoardTaskTypes } from "@jina/context-engine";

const DEFAULT_TERMINAL_CONTEXT_BUILD_HISTORY_PER_TENANT = 20;

export interface ContextBoardCompaction {
  readonly state: BoardState;
  readonly prunedBuilds: number;
  readonly prunedTasks: number;
  readonly prunedDependencies: number;
  readonly prunedOutboxMessages: number;
  readonly prunedEvents: number;
}

/**
 * Keeps active work plus a bounded per-tenant terminal execution history in the hot Board.
 * Published Context, checkpoints, artifacts, and quota ledgers live in their
 * own durable stores. Lightweight terminal roots remain as idempotency and ref
 * sequence tombstones; retaining their completed child graphs in the single
 * mutation snapshot only makes unrelated tenants contend on old history.
 */
export function compactTerminalContextBuildHistory(
  state: BoardState,
  terminalBuildsPerTenant = DEFAULT_TERMINAL_CONTEXT_BUILD_HISTORY_PER_TENANT
): ContextBoardCompaction {
  if (!Number.isSafeInteger(terminalBuildsPerTenant) || terminalBuildsPerTenant < 0) {
    throw new Error("terminalBuildsPerTenant must be a non-negative safe integer");
  }

  const terminalBuildsByTenant = new Map<string, typeof state.tasks>();
  for (const task of state.tasks) {
    if (task.type !== contextBoardTaskTypes.build || !isTerminalTaskStatus(task.status)) continue;
    const tenantId = task.metadata.tenantId;
    if (typeof tenantId !== "string" || tenantId.length === 0) continue;
    const builds = terminalBuildsByTenant.get(tenantId) ?? [];
    terminalBuildsByTenant.set(tenantId, [...builds, task]);
  }

  const prunedBuildIds = new Set<TaskId>();
  for (const builds of terminalBuildsByTenant.values()) {
    const newestFirst = [...builds].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id)
    );
    for (const build of newestFirst.slice(terminalBuildsPerTenant)) prunedBuildIds.add(build.id);
  }
  if (prunedBuildIds.size === 0) return unchanged(state);

  const prunedGraphTaskIds = new Set(
    state.tasks
      .filter((task) => {
        const contextBuildId = task.metadata.contextBuildId;
        return typeof contextBuildId === "string" && prunedBuildIds.has(contextBuildId as TaskId);
      })
      .map((task) => task.id)
  );
  const tasks = state.tasks.filter((task) => {
    const contextBuildId = task.metadata.contextBuildId;
    return (
      typeof contextBuildId !== "string" || !prunedBuildIds.has(contextBuildId as TaskId) || task.id === contextBuildId
    );
  });
  const retainedTaskIds = new Set(tasks.map((task) => task.id));
  const dependencies = state.dependencies.filter(
    (dependency) => retainedTaskIds.has(dependency.taskId) && retainedTaskIds.has(dependency.dependsOnTaskId)
  );
  const outbox = state.outbox.filter((message) => retainedTaskIds.has(message.taskId));
  const events = state.events.filter(
    (event) =>
      event.taskId === undefined || (!prunedGraphTaskIds.has(event.taskId) && retainedTaskIds.has(event.taskId))
  );

  return {
    state: { tasks, dependencies, outbox, events },
    prunedBuilds: prunedBuildIds.size,
    prunedTasks: state.tasks.length - tasks.length,
    prunedDependencies: state.dependencies.length - dependencies.length,
    prunedOutboxMessages: state.outbox.length - outbox.length,
    prunedEvents: state.events.length - events.length
  };
}

function unchanged(state: BoardState): ContextBoardCompaction {
  return {
    state,
    prunedBuilds: 0,
    prunedTasks: 0,
    prunedDependencies: 0,
    prunedOutboxMessages: 0,
    prunedEvents: 0
  };
}
