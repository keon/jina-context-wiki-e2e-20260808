import { markOutboxDispatched, nextPendingOutboxMessage, type BoardOutboxMessage } from "@jina/board";
import type { IsoTimestamp } from "@jina/shared-kernel";
import type { WorkflowState } from "../state.js";
import { runPublishTask } from "../tasks/run-publish.js";
import { runResearchTask } from "../tasks/run-research.js";
import { runReviewTask } from "../tasks/run-review.js";

export type WorkflowClock = () => IsoTimestamp;

export interface RelayResult {
  readonly state: WorkflowState;
  readonly dispatched: readonly BoardOutboxMessage[];
}

export function drainOutbox(state: WorkflowState, clock: WorkflowClock): RelayResult {
  let next = state;
  const dispatched: BoardOutboxMessage[] = [];

  while (true) {
    const result = drainOneOutboxMessage(next, clock);
    if (!result) {
      return { state: next, dispatched };
    }

    next = result.state;
    dispatched.push(result.message);
  }
}

export function drainOneOutboxMessage(
  state: WorkflowState,
  clock: WorkflowClock
): { readonly state: WorkflowState; readonly message: BoardOutboxMessage } | undefined {
  const message = nextPendingOutboxMessage(state.board);
  if (!message) {
    return undefined;
  }

  let next: WorkflowState = {
    ...state,
    board: markOutboxDispatched(state.board, message.id, clock())
  };

  switch (message.topic) {
    case "run-review":
      next = runReviewTask(next, message.payload.taskId, clock());
      break;
    case "run-research":
      next = runResearchTask(next, message.payload.taskId, clock());
      break;
    case "run-publish":
      next = runPublishTask(next, message.payload.taskId, clock());
      break;
  }

  return { state: next, message };
}
