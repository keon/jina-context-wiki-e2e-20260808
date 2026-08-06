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
      event.taskId === undefined ||
      (retainedTaskIds.has(event.taskId) &&
        (event.type === "context.build_followup_requested" || !prunedGraphTaskIds.has(event.taskId)))
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

const DEFAULT_TERMINAL_EPOCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Compacts terminal epoch-scoped work (legacy PR reviews) the same way
 * terminal Context builds are compacted: the root survives as an idempotency
 * tombstone while its settled child graph, dependencies, outbox messages, and
 * events leave the single-row hot snapshot. Without this, superseded and
 * completed review epochs accumulate forever and every tenant contends on the
 * ever-growing snapshot under the global mutation lock.
 */
export function compactTerminalEpochHistory(
  state: BoardState,
  now: string,
  retentionMs = DEFAULT_TERMINAL_EPOCH_RETENTION_MS
): ContextBoardCompaction {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new Error("retentionMs must be a non-negative safe integer");
  }
  const cutoff = new Date(Date.parse(now) - retentionMs).toISOString();

  const childrenByParent = new Map<TaskId, TaskId[]>();
  for (const task of state.tasks) {
    if (!task.parentTaskId) continue;
    const siblings = childrenByParent.get(task.parentTaskId) ?? [];
    siblings.push(task.id);
    childrenByParent.set(task.parentTaskId, siblings);
  }

  const prunedRootIds = new Set<TaskId>();
  const prunedTaskIds = new Set<TaskId>();
  for (const task of state.tasks) {
    if (
      task.parentTaskId !== undefined ||
      task.epoch === undefined ||
      task.type === contextBoardTaskTypes.build ||
      typeof task.metadata.contextBuildId === "string" ||
      !isTerminalTaskStatus(task.status) ||
      task.updatedAt > cutoff
    ) {
      continue;
    }
    const descendants: TaskId[] = [...(childrenByParent.get(task.id) ?? [])];
    // The whole subtree must be settled before any of it is dropped.
    let subtreeTerminal = true;
    const subtree: TaskId[] = [];
    while (descendants.length > 0) {
      const taskId = descendants.pop()!;
      subtree.push(taskId);
      const descendant = state.tasks.find((candidate) => candidate.id === taskId);
      if (!descendant || !isTerminalTaskStatus(descendant.status) || descendant.updatedAt > cutoff) {
        subtreeTerminal = false;
        break;
      }
      descendants.push(...(childrenByParent.get(taskId) ?? []));
    }
    if (!subtreeTerminal || subtree.length === 0) continue;
    prunedRootIds.add(task.id);
    for (const taskId of subtree) prunedTaskIds.add(taskId);
  }
  if (prunedRootIds.size === 0) return unchanged(state);

  const tasks = state.tasks.filter((task) => !prunedTaskIds.has(task.id));
  const retainedTaskIds = new Set(tasks.map((task) => task.id));
  const dependencies = state.dependencies.filter(
    (dependency) => retainedTaskIds.has(dependency.taskId) && retainedTaskIds.has(dependency.dependsOnTaskId)
  );
  const outbox = state.outbox.filter((message) => retainedTaskIds.has(message.taskId));
  const events = state.events.filter((event) => event.taskId === undefined || !prunedTaskIds.has(event.taskId));

  return {
    state: { tasks, dependencies, outbox, events },
    prunedBuilds: prunedRootIds.size,
    prunedTasks: state.tasks.length - tasks.length,
    prunedDependencies: state.dependencies.length - dependencies.length,
    prunedOutboxMessages: state.outbox.length - outbox.length,
    prunedEvents: state.events.length - events.length
  };
}
