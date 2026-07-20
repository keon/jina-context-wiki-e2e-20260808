import type { IsoTimestamp } from "@jina/shared-kernel";
import { findTask, transitionBoardTask, type BoardState } from "./reducer.js";
import { isTerminalTaskStatus } from "./task-status.js";
import type { BoardTask } from "./tasks.js";

/** Transitions every non-terminal task belonging to an epoch before `currentEpoch` to superseded. */
export function supersedeEpochTasks(
  state: BoardState,
  currentEpoch: number,
  now: IsoTimestamp,
  belongsToSubject: (task: BoardTask) => boolean
): BoardState {
  let next = state;

  for (const task of state.tasks) {
    if (
      taskOrAncestorMatches(state, task, belongsToSubject) &&
      task.epoch !== undefined &&
      task.epoch < currentEpoch &&
      !isTerminalTaskStatus(task.status)
    ) {
      next = transitionBoardTask(next, task.id, "superseded", now);
    }
  }

  return next;
}

/** Supersedes a complete active task tree selected by a workflow-owned predicate. */
export function supersedeTaskTree(
  state: BoardState,
  now: IsoTimestamp,
  belongsToWorkflow: (task: BoardTask) => boolean
): BoardState {
  let next = state;
  for (const task of state.tasks) {
    if (taskOrAncestorMatches(state, task, belongsToWorkflow) && !isTerminalTaskStatus(task.status)) {
      next = transitionBoardTask(next, task.id, "superseded", now);
    }
  }
  return next;
}

function taskOrAncestorMatches(
  state: BoardState,
  task: BoardTask,
  predicate: (candidate: BoardTask) => boolean
): boolean {
  let current: BoardTask | undefined = task;
  const visited = new Set<string>();

  while (current && !visited.has(current.id)) {
    if (predicate(current)) {
      return true;
    }
    visited.add(current.id);
    current = current.parentTaskId ? findTask(state, current.parentTaskId) : undefined;
  }

  return false;
}
