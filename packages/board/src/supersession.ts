import type { IsoTimestamp } from "@jina/shared-kernel";
import { appendEvent, findTask, markOutboxDispatched, transitionBoardTask, type BoardState } from "./reducer.js";
import { isTerminalTaskStatus } from "./task-status.js";
import type { BoardTask } from "./tasks.js";

/**
 * Transitions every non-terminal task belonging to an epoch before `currentEpoch` to superseded,
 * and retires their undispatched outbox messages. `superseded` is not a failure, so the
 * terminal-aggregate reconciliation never sweeps these messages; left pending, a worker would
 * claim the superseded task, be unable to complete it, release, and re-claim indefinitely.
 */
export function supersedeEpochTasks(
  state: BoardState,
  currentEpoch: number,
  now: IsoTimestamp,
  belongsToSubject: (task: BoardTask) => boolean
): BoardState {
  let next = state;
  const supersededTaskIds = new Set<string>();

  for (const task of state.tasks) {
    if (
      taskOrAncestorMatches(state, task, belongsToSubject) &&
      task.epoch !== undefined &&
      task.epoch < currentEpoch &&
      !isTerminalTaskStatus(task.status)
    ) {
      next = transitionBoardTask(next, task.id, "superseded", now);
      supersededTaskIds.add(task.id);
    }
  }

  if (supersededTaskIds.size === 0) return next;

  for (const message of state.outbox) {
    if (!supersededTaskIds.has(message.taskId) || message.status === "dispatched") continue;
    next = markOutboxDispatched(next, message.id, now);
    next = appendEvent(next, "task.superseded_outbox_retired", now, message.taskId, {
      messageId: message.id,
      attempt: message.payload.attempt,
      previousStatus: message.status,
      topic: message.topic
    });
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
