import { createHash } from "node:crypto";
import { applyCommand, findTask, markOutboxDispatched, reduceBoard, type BoardState } from "@jina/board";
import { contextWikiBoardTaskType, contextWikiBoardTopic } from "@jina/context-engine";
import { entityId, type WikiTriggerCompletedOutputV1 } from "@jina/shared-kernel";

const RUN_ACTOR = { type: "run", id: "context-wiki-trigger" } as const;

/** Applies a storage-attested activation to the single high-level Board task. */
export function applyActivatedWikiCompletion(
  state: BoardState,
  result: WikiTriggerCompletedOutputV1,
  now: string,
  reconciledBy?: "terminal_failure" | "newer_admission"
): { readonly state: BoardState; readonly replay: boolean } {
  const task = findTask(state, entityId<"task">(result.boardBuildId));
  if (!task || task.type !== contextWikiBoardTaskType) throw new Error("activated wiki Board task was not found");
  const resultDigest = createHash("sha256").update(JSON.stringify(result), "utf8").digest("hex");
  const prior = state.events.find(
    (event) =>
      event.taskId === task.id &&
      event.type === "context.wiki_trigger_completion_recorded" &&
      event.payload?.requestDigest === result.requestDigest
  );
  if (prior) {
    if (
      task.status !== "done" ||
      prior.payload?.triggerParentRunId !== result.triggerParentRunId ||
      prior.payload?.resultDigest !== resultDigest ||
      prior.payload?.releaseId !== result.releaseId
    ) {
      throw new Error("activated wiki completion replay changed its result");
    }
    return { state, replay: true };
  }
  if (task.status !== "in_progress") throw new Error("activated wiki Board task is not awaiting completion");
  const message = state.outbox.find(
    (candidate) => candidate.taskId === task.id && candidate.topic === contextWikiBoardTopic
  );
  if (!message || message.status === "dispatched") {
    throw new Error("activated wiki outbox is not awaiting completion");
  }
  let board = markOutboxDispatched(state, message.id, now);
  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId: task.id,
      eventType: `${message.topic}.completed`,
      payload: {
        schemaVersion: result.schemaVersion,
        status: result.status,
        triggerParentRunId: result.triggerParentRunId,
        requestDigest: result.requestDigest,
        releaseId: result.releaseId,
        generationId: result.generationId,
        publicSnapshotDigest: result.publicSnapshotDigest,
        pageindexAttachmentId: result.pageindexAttachmentId,
        activationOperationDigest: result.activationOperationDigest,
        usage: result.usage,
        completedAt: result.completedAt
      }
    },
    { actor: RUN_ACTOR, now }
  ).state;
  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId: task.id,
      eventType: "context.wiki_trigger_completion_recorded",
      payload: {
        messageId: message.id,
        attempt: message.payload.attempt,
        triggerParentRunId: result.triggerParentRunId,
        requestDigest: result.requestDigest,
        releaseId: result.releaseId,
        resultDigest,
        ...(reconciledBy ? { reconciledBy } : {})
      }
    },
    { actor: RUN_ACTOR, now }
  ).state;
  const transitioned = applyCommand(
    board,
    { command: "TransitionTask", taskId: task.id, toStatus: "done" },
    { actor: RUN_ACTOR, now }
  );
  if (!transitioned.accepted) throw new Error("activated wiki completion transition was rejected");
  return { state: reduceBoard(transitioned.state, now), replay: false };
}
