import { findTask, type BoardState, type TaskId } from "@jina/board";
import {
  addContextWorkflowPagePlanner,
  addContextWorkflowPublicationWork,
  bindContextWorkflowBoardBuildCommit,
  contextWorkflowBoardTaskTypes,
  parseContextWorkflowBoardTaskResult,
  type ContextWorkflowBoardTaskResult
} from "@jina/context-engine";

export interface AppliedContextWorkflowBoardResult {
  readonly state: BoardState;
  readonly result: ContextWorkflowBoardTaskResult;
}

/**
 * Expands the Context graph before the caller records the worker completion. The API
 * persists this state, the result receipt, and the task transition atomically.
 * Page jobs own their bounded repair internally, so no result creates a repair
 * or release-gate task.
 */
export function applyContextWorkflowBoardTaskResult(
  state: BoardState,
  taskId: TaskId,
  value: unknown,
  now: string
): AppliedContextWorkflowBoardResult {
  const task = findTask(state, taskId);
  if (!task) throw new Error("Context Board task not found");
  const result = parseContextWorkflowBoardTaskResult(state, taskId, value);
  const buildTaskId = requiredTaskId(task.metadata.contextBuildId, "contextBuildId");

  switch (result.taskType) {
    case contextWorkflowBoardTaskTypes.snapshot: {
      const bound = bindContextWorkflowBoardBuildCommit(state, {
        buildTaskId,
        commitSha: result.commitSha,
        now
      });
      const expanded = addContextWorkflowPagePlanner(bound, {
        buildTaskId,
        snapshotTaskId: taskId,
        snapshot: result.outputArtifact,
        now
      });
      return { state: expanded.state, result };
    }
    case contextWorkflowBoardTaskTypes.planner: {
      const graphTask = state.tasks.find(
        (candidate) => candidate.parentTaskId === buildTaskId && candidate.type === contextWorkflowBoardTaskTypes.graph
      );
      if (!graphTask) throw new Error("Context build graph task not found");
      const expanded = addContextWorkflowPublicationWork(state, {
        buildTaskId,
        graphTaskId: graphTask.id,
        plannerTaskId: taskId,
        plan: result.outputArtifact,
        pages: result.pages,
        now
      });
      return { state: expanded.state, result };
    }
    case contextWorkflowBoardTaskTypes.page:
    case contextWorkflowBoardTaskTypes.publication:
      return { state, result };
  }
}

function requiredTaskId(value: unknown, name: string): TaskId {
  if (typeof value !== "string" || !value.startsWith("task_") || value.length > 240) {
    throw new Error(`${name} must be a task ID`);
  }
  return value as TaskId;
}
