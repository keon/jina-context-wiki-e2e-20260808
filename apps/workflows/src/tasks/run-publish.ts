import { reduceBoard, transitionBoardTask, type TaskId } from "@jina/board";
import type { PublicationPlan } from "@jina/publication";
import type { IsoTimestamp } from "@jina/shared-kernel";
import type { WorkflowState } from "../state.js";

export interface PublishTaskInput {
  readonly taskId: string;
  readonly plan: PublicationPlan;
}

export function runPublishTask(state: WorkflowState, taskId: TaskId, now: IsoTimestamp): WorkflowState {
  let board = transitionBoardTask(state.board, taskId, "in_progress", now);
  board = transitionBoardTask(board, taskId, "done", now);

  return {
    ...state,
    board: reduceBoard(board, now),
    publications: [
      ...state.publications,
      {
        status: "published",
        externalId: `publication:${taskId}`
      }
    ]
  };
}
