import {
  addDependency,
  addTask,
  createBoardTask,
  createContextForDependency,
  findTask,
  reduceBoard,
  transitionBoardTask,
  type TaskId
} from "@jina/board";
import { entityId, type IsoTimestamp } from "@jina/shared-kernel";
import type { WorkflowState } from "../state.js";

export interface ReviewTaskInput {
  readonly taskId: string;
  readonly hasEnoughContext: boolean;
}

export function runReviewTask(state: WorkflowState, taskId: TaskId, now: IsoTimestamp): WorkflowState {
  let board = transitionBoardTask(state.board, taskId, "in_progress", now);
  const task = findTask(board, taskId);

  if (!task) {
    return state;
  }

  if (task.metadata.needsExternalContext === true && !hasSatisfiedContext(state, taskId)) {
    const contextTaskId = entityId<"task">(`${taskId}:context:dependency-docs`);
    board = addTask(
      board,
      createBoardTask({
        id: contextTaskId,
        type: "context",
        title: "Collect dependency context",
        assigneeRole: "research_agent",
        dedupeKey: `${task.dedupeKey}:context:dependency-docs`,
        now,
        required: true,
        dispatchTopic: "run-research",
        metadata: {
          targetTaskId: task.id,
          sourceUrls: ["https://example.com/dependency-docs"],
          question: "Extract dependency behavior relevant to this review."
        },
        ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
        ...(task.epoch !== undefined ? { epoch: task.epoch } : {})
      })
    );
    board = addDependency(board, createContextForDependency(taskId, contextTaskId), now);
    board = transitionBoardTask(board, taskId, "blocked", now);

    return { ...state, board: reduceBoard(board, now) };
  }

  board = transitionBoardTask(board, taskId, "done", now);
  return { ...state, board: reduceBoard(board, now) };
}

function hasSatisfiedContext(state: WorkflowState, taskId: TaskId): boolean {
  const contextDependencies = state.board.dependencies.filter(
    (dependency) => dependency.taskId === taskId && dependency.relationship === "context_for"
  );

  return contextDependencies.some((dependency) => {
    const contextTask = findTask(state.board, dependency.dependsOnTaskId);
    return (
      contextTask?.status === "done" &&
      state.contextItems.some((item) => item.taskId === dependency.dependsOnTaskId)
    );
  });
}
