import type { IsoTimestamp } from "@jina/shared-kernel";
import type { TaskId } from "./dependencies.js";
import type { TaskStatus } from "./task-status.js";

/** Worker-owned identifier. The board treats task types as opaque strings. */
export type TaskType = string;

/** Runtime-owned dispatch route. New workers do not require board changes. */
export type TaskDispatchTopic = string;

/** Worker-owned role identifier. */
export type TaskAssigneeRole = string;

export type TaskKind = "aggregate" | "dispatchable" | "manual" | "waitpoint";

export interface TaskTypeDefinition {
  readonly type: TaskType;
  readonly kind: TaskKind;
  readonly defaultAssigneeRole: TaskAssigneeRole;
  readonly description: string;
  readonly dispatchTopic?: TaskDispatchTopic;
}

export interface BoardTask {
  readonly id: TaskId;
  readonly type: TaskType;
  readonly title: string;
  readonly status: TaskStatus;
  readonly assigneeRole: TaskAssigneeRole;
  readonly dedupeKey: string;
  readonly required: boolean;
  readonly attempt: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly metadata: Record<string, unknown>;
  readonly kind: TaskKind;
  readonly dispatchTopic?: TaskDispatchTopic;
  readonly parentTaskId?: TaskId;
  readonly epoch?: number;
}

export interface CreateBoardTaskInput {
  readonly id: TaskId;
  readonly type: TaskType;
  readonly title: string;
  readonly assigneeRole: TaskAssigneeRole;
  readonly dedupeKey: string;
  readonly now: IsoTimestamp;
  readonly required?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly kind?: TaskKind;
  readonly dispatchTopic?: TaskDispatchTopic;
  readonly parentTaskId?: TaskId;
  readonly epoch?: number;
}

export function createBoardTask(input: CreateBoardTaskInput): BoardTask {
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    status: "triage",
    assigneeRole: input.assigneeRole,
    dedupeKey: input.dedupeKey,
    required: input.required ?? true,
    attempt: 0,
    createdAt: input.now,
    updatedAt: input.now,
    metadata: input.metadata ?? {},
    kind: input.kind ?? "dispatchable",
    ...(input.dispatchTopic ? { dispatchTopic: input.dispatchTopic } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {})
  };
}
