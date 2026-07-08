import type { EntityId } from "@jina/shared-kernel";
import type { TaskDependencyRelationship, TaskId } from "./dependencies.js";
import type { TaskStatus } from "./task-status.js";

export type ActorId = EntityId<"actor">;

export type BoardVerb =
  | "CreateTask"
  | "UpdateTask"
  | "TransitionTask"
  | "CommentTask"
  | "LinkTask"
  | "AssignTask"
  | "AttachArtifact";

export interface TransitionTaskIntent {
  readonly verb: "TransitionTask";
  readonly taskId: TaskId;
  readonly toStatus: TaskStatus;
}

export interface LinkTaskIntent {
  readonly verb: "LinkTask";
  readonly taskId: TaskId;
  readonly relationship: TaskDependencyRelationship;
  readonly otherTaskId: TaskId;
}

export function transitionTask(taskId: TaskId, toStatus: TaskStatus): TransitionTaskIntent {
  return { verb: "TransitionTask", taskId, toStatus };
}

export function linkTask(taskId: TaskId, relationship: TaskDependencyRelationship, otherTaskId: TaskId): LinkTaskIntent {
  return { verb: "LinkTask", taskId, relationship, otherTaskId };
}

