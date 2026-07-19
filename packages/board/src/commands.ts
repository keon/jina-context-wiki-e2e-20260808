import type { IsoTimestamp } from "@jina/shared-kernel";
import type { TaskDependencyDraft, TaskId } from "./dependencies.js";
import {
  addDependency,
  addTask,
  appendEvent,
  findTask,
  transitionBoardTask,
  type BoardState
} from "./reducer.js";
import type { TaskStatus } from "./task-status.js";
import { createBoardTask, type BoardTask, type CreateBoardTaskInput } from "./tasks.js";
import { canTransition, type TransitionActorType } from "./transitions.js";

export type BoardCommand =
  | "CreateTask"
  | "UpdateTask"
  | "TransitionTask"
  | "CommentTask"
  | "LinkTask"
  | "AssignTask"
  | "AttachArtifact";

export interface CommandActor {
  readonly type: TransitionActorType;
  readonly id: string;
}

export interface CreateTaskCommand {
  readonly command: "CreateTask";
  readonly task: Omit<CreateBoardTaskInput, "now">;
  readonly dependencies?: readonly TaskDependencyDraft[];
  /**
   * When not false, the command layer materializes a required root -> task edge so
   * dynamically created children are never invisible to root completion.
   */
  readonly blocksParentCompletion?: boolean;
}

export interface TransitionTaskCommand {
  readonly command: "TransitionTask";
  readonly taskId: TaskId;
  readonly toStatus: TaskStatus;
}

export interface LinkTaskCommand {
  readonly command: "LinkTask";
  readonly dependency: TaskDependencyDraft;
}

export interface CommentTaskCommand {
  readonly command: "CommentTask";
  readonly taskId: TaskId;
  readonly eventType: string;
  readonly payload?: Record<string, unknown>;
}

export type BoardCommandInput = CreateTaskCommand | TransitionTaskCommand | LinkTaskCommand | CommentTaskCommand;

export type CommandRejectionReason =
  | "invalid_transition"
  | "unknown_task"
  | "unknown_dependency"
  | "budget_exhausted"
  | "policy_denied";

export interface CommandRejection {
  readonly reason: CommandRejectionReason;
  readonly detail?: string;
}

export type CommandGuard = (state: BoardState, command: BoardCommandInput) => CommandRejection | undefined;

export interface ApplyCommandOptions {
  readonly actor: CommandActor;
  readonly now: IsoTimestamp;
  readonly guards?: readonly CommandGuard[];
}

export interface CommandResult {
  readonly state: BoardState;
  readonly accepted: boolean;
  readonly rejection?: CommandRejection;
}

export function applyCommand(state: BoardState, command: BoardCommandInput, options: ApplyCommandOptions): CommandResult {
  for (const guard of options.guards ?? []) {
    const rejection = guard(state, command);
    if (rejection) {
      return reject(state, command, rejection, options);
    }
  }

  switch (command.command) {
    case "CreateTask":
      return applyCreateTask(state, command, options);
    case "TransitionTask":
      return applyTransitionTask(state, command, options);
    case "LinkTask":
      return applyLinkTask(state, command, options);
    case "CommentTask":
      return applyCommentTask(state, command, options);
  }
}

function applyCreateTask(state: BoardState, command: CreateTaskCommand, options: ApplyCommandOptions): CommandResult {
  const existing = state.tasks.find((task) => task.dedupeKey === command.task.dedupeKey);
  if (existing) {
    return { state, accepted: true };
  }

  for (const dependency of command.dependencies ?? []) {
    const dependencyTargets = [dependency.taskId, dependency.dependsOnTaskId];
    const unknown = dependencyTargets.some((id) => id !== command.task.id && !findTask(state, id));
    if (unknown) {
      return reject(state, command, { reason: "unknown_dependency" }, options);
    }
  }

  let next = addTask(state, createBoardTask({ ...command.task, now: options.now }));

  for (const dependency of command.dependencies ?? []) {
    next = addDependency(next, dependency, options.now);
  }

  if (command.blocksParentCompletion !== false) {
    const created = findTask(next, command.task.id);
    const rootId = created ? findRootTaskId(next, created) : undefined;
    if (created && rootId && rootId !== created.id) {
      next = addDependency(
        next,
        {
          taskId: rootId,
          dependsOnTaskId: created.id,
          relationship: "blocks",
          required: true,
          blocksParentCompletion: true
        },
        options.now
      );
    }
  }

  return { state: next, accepted: true };
}

function applyTransitionTask(state: BoardState, command: TransitionTaskCommand, options: ApplyCommandOptions): CommandResult {
  const task = findTask(state, command.taskId);
  if (!task) {
    return reject(state, command, { reason: "unknown_task" }, options);
  }
  if (task.status === command.toStatus) {
    return { state, accepted: true };
  }
  if (!canTransition(task.type, task.status, command.toStatus, options.actor.type)) {
    return reject(
      state,
      command,
      {
        reason: "invalid_transition",
        detail: `${task.type}: ${task.status} -> ${command.toStatus} by ${options.actor.type}`
      },
      options
    );
  }

  return { state: transitionBoardTask(state, command.taskId, command.toStatus, options.now), accepted: true };
}

function applyLinkTask(state: BoardState, command: LinkTaskCommand, options: ApplyCommandOptions): CommandResult {
  const { dependency } = command;
  if (!findTask(state, dependency.taskId) || !findTask(state, dependency.dependsOnTaskId)) {
    return reject(state, command, { reason: "unknown_task" }, options);
  }

  return { state: addDependency(state, dependency, options.now), accepted: true };
}

function applyCommentTask(state: BoardState, command: CommentTaskCommand, options: ApplyCommandOptions): CommandResult {
  if (!findTask(state, command.taskId)) {
    return reject(state, command, { reason: "unknown_task" }, options);
  }

  return {
    state: appendEvent(state, command.eventType, options.now, command.taskId, {
      actor: options.actor.id,
      ...(command.payload ?? {})
    }),
    accepted: true
  };
}

function reject(
  state: BoardState,
  command: BoardCommandInput,
  rejection: CommandRejection,
  options: ApplyCommandOptions
): CommandResult {
  const withEvent = appendEvent(state, "command.rejected", options.now, commandTaskId(command), {
    command: command.command,
    actor: options.actor.id,
    reason: rejection.reason,
    ...(rejection.detail ? { detail: rejection.detail } : {})
  });

  return { state: withEvent, accepted: false, rejection };
}

function commandTaskId(command: BoardCommandInput): TaskId | undefined {
  switch (command.command) {
    case "CreateTask":
      return command.task.parentTaskId;
    case "TransitionTask":
    case "CommentTask":
      return command.taskId;
    case "LinkTask":
      return command.dependency.taskId;
  }
}

function findRootTaskId(state: BoardState, task: BoardTask): TaskId | undefined {
  let current: BoardTask | undefined = task;
  while (current?.parentTaskId) {
    current = findTask(state, current.parentTaskId);
  }
  return current?.id;
}
