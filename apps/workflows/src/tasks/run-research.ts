import { findTask, reduceBoard, transitionBoardTask, type TaskId } from "@jina/board";
import type { ContextItemDraft } from "@jina/context";
import type { IsoTimestamp } from "@jina/shared-kernel";
import type { WorkflowState } from "../state.js";

export interface ResearchTaskInput {
  readonly taskId: string;
  readonly sourceUrls: readonly string[];
}

export function runResearchTask(state: WorkflowState, taskId: TaskId, now: IsoTimestamp): WorkflowState {
  let board = transitionBoardTask(state.board, taskId, "in_progress", now);
  const task = findTask(board, taskId);

  if (!task) {
    return state;
  }

  const targetTaskId = stringMetadata(task.metadata.targetTaskId, taskId);
  const sourceUrls = stringArrayMetadata(task.metadata.sourceUrls);
  const items = collectContextItems({ taskId, sourceUrls });

  board = transitionBoardTask(board, taskId, "done", now);

  return {
    ...state,
    board: reduceBoard(board, now),
    contextItems: [
      ...state.contextItems,
      ...items.map((item) => ({
        taskId,
        targetTaskId,
        item
      }))
    ]
  };
}

function collectContextItems(input: ResearchTaskInput): readonly ContextItemDraft[] {
  return input.sourceUrls.map((sourceUrl) => ({
    sourceUri: sourceUrl,
    summary: "Pending extraction",
    citations: [sourceUrl]
  }));
}

function stringMetadata(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringArrayMetadata(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
