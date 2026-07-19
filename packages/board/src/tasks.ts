import type { IsoTimestamp } from "@jina/shared-kernel";
import type { TaskId } from "./dependencies.js";
import type { TaskStatus } from "./task-status.js";

export type TaskType =
  | "pr_review"
  | "review_pass"
  | "context"
  | "publish"
  | "cleanup"
  | "issue_triage"
  | "human_decision";

export type TaskDispatchTopic = "run-review" | "run-research" | "run-publish" | "run-cleanup";

export type TaskAssigneeRole =
  | "system"
  | "review_agent"
  | "research_agent"
  | "publisher"
  | "cleanup_worker"
  | "human";

export type TaskKind = "aggregate" | "dispatchable" | "manual" | "waitpoint";

export function taskKind(type: TaskType): TaskKind {
  switch (type) {
    case "pr_review":
      return "aggregate";
    case "issue_triage":
      return "manual";
    case "human_decision":
      return "waitpoint";
    default:
      return "dispatchable";
  }
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
    ...(input.dispatchTopic ? { dispatchTopic: input.dispatchTopic } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {})
  };
}
