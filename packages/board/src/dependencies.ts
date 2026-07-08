import type { EntityId } from "@jina/shared-kernel";

export type TaskId = EntityId<"task">;

export type TaskDependencyRelationship =
  | "blocks"
  | "relates_to"
  | "context_for"
  | "verifies"
  | "fixes"
  | "publishes"
  | "supersedes";

export interface TaskDependencyDraft {
  readonly taskId: TaskId;
  readonly dependsOnTaskId: TaskId;
  readonly relationship: TaskDependencyRelationship;
  readonly required: boolean;
  readonly blocksParentCompletion: boolean;
}

export function createContextForDependency(taskId: TaskId, contextTaskId: TaskId): TaskDependencyDraft {
  return {
    taskId,
    dependsOnTaskId: contextTaskId,
    relationship: "context_for",
    required: true,
    blocksParentCompletion: true,
  };
}

