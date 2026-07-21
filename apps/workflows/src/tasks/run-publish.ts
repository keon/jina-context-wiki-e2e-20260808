import { applyCommand, findTask, reduceBoard, type TaskId, type CommandActor } from "@jina/board";
import { buildPublicationKey, upsertPublication } from "@jina/publication";
import type { IsoTimestamp } from "@jina/shared-kernel";
import { findPullRequest, type WorkflowState } from "../state.js";

const RUN_ACTOR: CommandActor = { type: "run", id: "run-publish" };

export function runPublishTask(state: WorkflowState, taskId: TaskId, now: IsoTimestamp): WorkflowState {
  const task = findTask(state.board, taskId);
  if (!task || task.status !== "queued") {
    return state;
  }

  const repository = stringValue(task.metadata.repository);
  const prNumber = Number(task.metadata.pullRequestNumber ?? 0);
  const headSha = stringValue(task.metadata.headSha);

  const pr = findPullRequest(state, repository, prNumber);
  if (pr && task.epoch !== undefined && task.epoch !== pr.currentEpoch) {
    return state;
  }
  // The head SHA fences the publication: a stale run cannot publish for a superseded head.
  if (pr && headSha !== pr.headSha) {
    return state;
  }

  let board = applyCommand(
    state.board,
    { command: "TransitionTask", taskId, toStatus: "in_progress" },
    { actor: RUN_ACTOR, now }
  ).state;

  const key = buildPublicationKey(`${repository}#${prNumber}`, headSha, "summary");
  const upserted = upsertPublication(state.publications, { key, headSha, target: "summary" });

  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId,
      eventType: "publish.completed",
      payload: { publicationKey: key, action: upserted.action }
    },
    { actor: RUN_ACTOR, now }
  ).state;
  board = applyCommand(board, { command: "TransitionTask", taskId, toStatus: "done" }, { actor: RUN_ACTOR, now }).state;

  return {
    ...state,
    board: reduceBoard(board, now),
    publications: upserted.records
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
