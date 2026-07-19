import { applyCommand, findTask, reduceBoard, type TaskId, type CommandActor } from "@jina/board";
import { isSourceAllowed, type ContextItemDraft } from "@jina/context";
import type { IsoTimestamp } from "@jina/shared-kernel";
import type { WorkflowState } from "../state.js";

const RUN_ACTOR: CommandActor = { type: "run", id: "run-research" };

export function runResearchTask(state: WorkflowState, taskId: TaskId, now: IsoTimestamp): WorkflowState {
  const task = findTask(state.board, taskId);
  if (!task || task.status !== "queued") {
    return state;
  }

  let board = applyCommand(state.board, { command: "TransitionTask", taskId, toStatus: "in_progress" }, { actor: RUN_ACTOR, now })
    .state;

  const targetTaskId = stringMetadata(task.metadata.targetTaskId, taskId);
  const sourceUrls = stringArrayMetadata(task.metadata.sourceUrls);
  const allowedUrls = sourceUrls.filter((url) => isSourceAllowed(state.sourcePolicy, url));

  if (sourceUrls.length > 0 && allowedUrls.length === 0) {
    board = applyCommand(
      board,
      {
        command: "CommentTask",
        taskId,
        eventType: "context.failed",
        payload: { reason: "no_allowed_sources", requested: [...sourceUrls] }
      },
      { actor: RUN_ACTOR, now }
    ).state;
    board = applyCommand(board, { command: "TransitionTask", taskId, toStatus: "failed" }, { actor: RUN_ACTOR, now }).state;

    return { ...state, board: reduceBoard(board, now) };
  }

  const items = allowedUrls.map(
    (sourceUrl): ContextItemDraft => ({
      sourceUri: sourceUrl,
      summary: "Extracted dependency behavior",
      citations: [sourceUrl]
    })
  );

  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId,
      eventType: "context.collected",
      payload: { itemCount: items.length, sources: [...allowedUrls] }
    },
    { actor: RUN_ACTOR, now }
  ).state;
  board = applyCommand(board, { command: "TransitionTask", taskId, toStatus: "done" }, { actor: RUN_ACTOR, now }).state;

  return {
    ...state,
    board: reduceBoard(board, now),
    contextItems: [
      ...state.contextItems,
      ...items.map((item) => ({
        taskId: taskId as string,
        targetTaskId,
        item
      }))
    ]
  };
}

function stringMetadata(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringArrayMetadata(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
