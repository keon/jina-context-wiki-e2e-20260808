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

export const taskTypeDefinitions: readonly TaskTypeDefinition[] = [
  {
    type: "pr_review",
    kind: "aggregate",
    defaultAssigneeRole: "system",
    description: "Coordinates a pull-request review and completes when its required child tasks finish."
  },
  {
    type: "review_pass",
    kind: "dispatchable",
    defaultAssigneeRole: "review_agent",
    dispatchTopic: "run-review",
    description: "Runs one focused code-review pass and records findings against a pull-request revision."
  },
  {
    type: "issue_triage",
    kind: "manual",
    defaultAssigneeRole: "human",
    description: "Routes a newly opened issue for human triage."
  },
  {
    type: "human_decision",
    kind: "waitpoint",
    defaultAssigneeRole: "human",
    description: "Pauses automated work until a human records a required decision."
  }
];

function taskKind(type: TaskType): TaskKind {
  return taskTypeDefinitions.find((definition) => definition.type === type)?.kind ?? "dispatchable";
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
    kind: input.kind ?? taskKind(input.type),
    ...(input.dispatchTopic ? { dispatchTopic: input.dispatchTopic } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {})
  };
}
