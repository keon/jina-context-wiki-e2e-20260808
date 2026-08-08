import { findTask, type BoardState, type TaskId } from "@jina/board";
import {
  bindCausalGraphBoardBuildCommit,
  causalGraphBoardTaskTypes,
  parseCausalGraphBoardTaskResult,
  type CausalGraphBoardTaskResult
} from "@jina/context-engine";

export function applyCausalGraphBoardTaskResult(
  state: BoardState,
  taskId: TaskId,
  value: unknown,
  now: string
): { readonly state: BoardState; readonly result: CausalGraphBoardTaskResult } {
  const task = findTask(state, taskId);
  if (!task) throw new Error("causal graph Board task not found");
  const result = parseCausalGraphBoardTaskResult(state, taskId, value);
  if (result.taskType !== causalGraphBoardTaskTypes.snapshot) return { state, result };
  const buildTaskId = task.metadata.contextBuildId;
  if (typeof buildTaskId !== "string" || !buildTaskId.startsWith("task_") || buildTaskId.length > 240) {
    throw new Error("contextBuildId must be a task ID");
  }
  return {
    state: bindCausalGraphBoardBuildCommit(state, {
      buildTaskId: buildTaskId as TaskId,
      commitSha: result.commitSha,
      now
    }),
    result
  };
}
