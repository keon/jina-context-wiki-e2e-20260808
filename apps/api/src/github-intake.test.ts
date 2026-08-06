import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCommand, isTerminalTaskStatus, type BoardState } from "@jina/board";
import type { ParsedGitHubWebhook } from "@jina/github";
import { compactTerminalEpochHistory } from "./context-board-compaction.js";
import { createGitHubIntakeState, ingestGitHubWebhook } from "./github-intake.js";

const WEBHOOK: ParsedGitHubWebhook = {
  event: {
    type: "pull_request.opened",
    pullRequestNumber: 7,
    headSha: "a".repeat(40)
  },
  repository: "acme/app",
  repositoryId: 42,
  installationId: 99,
  repositoryOwner: { id: 1, login: "acme", accountType: "Organization" }
};

function terminalize(board: BoardState, now: string): BoardState {
  // Failing the aggregate root settles the whole epoch: terminal-aggregate
  // reconciliation cancels the children and retires their outbox messages.
  let next = board;
  for (const task of board.tasks) {
    if (task.kind !== "aggregate" || isTerminalTaskStatus(task.status)) continue;
    const result = applyCommand(
      next,
      { command: "TransitionTask", taskId: task.id, toStatus: "failed" },
      { actor: { type: "system", id: "test" }, now }
    );
    assert.equal(result.accepted, true);
    next = result.state;
  }
  return next;
}

test("a replayed delivery for a compacted settled epoch does not dispatch a duplicate review", () => {
  const ingestedAt = "2026-07-01T00:00:00.000Z";
  const first = ingestGitHubWebhook(createGitHubIntakeState(), WEBHOOK, {
    deliveryId: "delivery-1",
    now: ingestedAt,
    tenantId: "tenant-a"
  });
  assert.equal(first.outcome, "created");
  assert.ok(first.state.board.outbox.some((message) => message.topic === "run-review"));

  // The epoch settles: every task reaches a terminal status and the outbox
  // messages are retired by terminal-aggregate reconciliation.
  const board = terminalize(first.state.board, "2026-07-01T01:00:00.000Z");
  assert.ok(board.tasks.every((task) => isTerminalTaskStatus(task.status)));
  assert.ok(board.outbox.every((message) => message.status === "dispatched"));

  // Age past the retention window and compact: children are pruned, the root
  // stays behind as an idempotency tombstone.
  const compacted = compactTerminalEpochHistory(board, "2026-07-31T00:00:00.000Z");
  assert.equal(compacted.prunedBuilds, 1);
  assert.ok(compacted.state.tasks.some((task) => task.type === "pr_review"));
  assert.equal(
    compacted.state.tasks.some((task) => task.type === "review_pass"),
    false
  );

  // GitHub redelivers the same event (same head, same epoch) with a new
  // delivery id. The settled epoch must not be resurrected.
  const replayed = ingestGitHubWebhook({ board: compacted.state, pullRequests: first.state.pullRequests }, WEBHOOK, {
    deliveryId: "delivery-2",
    now: "2026-07-31T00:05:00.000Z",
    tenantId: "tenant-a"
  });
  assert.equal(replayed.outcome, "duplicate");
  assert.equal(replayed.createdTaskIds.length, 0);
  assert.equal(
    replayed.state.board.tasks.some((task) => task.type === "review_pass"),
    false,
    "the pruned review child must not be recreated"
  );
  assert.equal(
    replayed.state.board.outbox.some((message) => message.status === "pending" || message.status === "leased"),
    false,
    "no claimable run-review message may be dispatched for a settled epoch"
  );

  // A genuinely new head still opens a new epoch and dispatches work.
  const newHead = ingestGitHubWebhook(
    replayed.state,
    {
      ...WEBHOOK,
      event: { type: "pull_request.synchronize", pullRequestNumber: 7, headSha: "b".repeat(40) }
    },
    { deliveryId: "delivery-3", now: "2026-07-31T00:10:00.000Z", tenantId: "tenant-a" }
  );
  assert.equal(newHead.outcome, "created");
  assert.ok(
    newHead.state.board.outbox.some((message) => message.topic === "run-review" && message.status === "pending")
  );
});

test("a new commit after tracking expiry is reviewed despite retained epoch tombstones", () => {
  const first = ingestGitHubWebhook(createGitHubIntakeState(), WEBHOOK, {
    deliveryId: "delivery-1",
    now: "2026-07-01T00:00:00.000Z",
    tenantId: "tenant-a"
  });
  const board = terminalize(first.state.board, "2026-07-01T01:00:00.000Z");
  const compacted = compactTerminalEpochHistory(board, "2026-07-31T00:00:00.000Z");

  // The tracked pull-request entry has been compacted away (30-day idle
  // prune), so the returning pull request restarts at epoch 1 while the
  // terminal epoch-1 root tombstone is still on the board.
  const returned = ingestGitHubWebhook(
    { board: compacted.state, pullRequests: [] },
    {
      ...WEBHOOK,
      event: { type: "pull_request.synchronize", pullRequestNumber: 7, headSha: "c".repeat(40) }
    },
    { deliveryId: "delivery-9", now: "2026-08-15T00:00:00.000Z", tenantId: "tenant-a" }
  );
  assert.equal(returned.outcome, "created");
  assert.ok(
    returned.state.board.outbox.some((message) => message.topic === "run-review" && message.status === "pending"),
    "the returning pull request's new head must dispatch a review"
  );
  // The epoch advanced past the retained tombstone instead of colliding with it.
  assert.ok(returned.state.board.tasks.some((task) => task.epoch === 2 && task.type === "pr_review"));
  assert.equal(returned.state.pullRequests[0]?.epoch, 2);

  // A replay of the settled OLD head with tracking still expired stays
  // suppressed: it plans epoch 1, whose tombstone matches that head exactly.
  // (With live tracking, a differing head keeps its pre-existing new-head
  // semantics and opens a fresh epoch — reverts must still be reviewed.)
  const oldHeadReplay = ingestGitHubWebhook({ board: returned.state.board, pullRequests: [] }, WEBHOOK, {
    deliveryId: "delivery-10",
    now: "2026-08-15T00:05:00.000Z",
    tenantId: "tenant-a"
  });
  assert.equal(oldHeadReplay.outcome, "duplicate");
});
