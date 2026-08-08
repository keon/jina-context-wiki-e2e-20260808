import assert from "node:assert/strict";
import test from "node:test";
import { applyCommand, createEmptyBoardState, type TaskId } from "@jina/board";
import { entityId } from "@jina/shared-kernel";
import {
  authorizeContextWikiDispatch,
  claimContextWikiParent,
  contextWikiClaimedRun,
  mintContextWikiExecutionGrant,
  verifyContextWikiExecutionGrant
} from "./context-wiki-authority.js";

const SECRET = "s".repeat(64);
const DIGEST = "a".repeat(64);
const NOW = "2026-08-08T12:00:00.000Z";

test("wiki dispatch authority commits before a single parent run can claim", () => {
  const taskId = entityId<"task">("task_wiki_build") as TaskId;
  const created = applyCommand(
    createEmptyBoardState(),
    {
      command: "CreateTask",
      task: {
        id: taskId,
        type: "build-wiki",
        title: "Build wiki",
        assigneeRole: "context_worker",
        dedupeKey: "wiki:build",
        kind: "dispatchable",
        dispatchTopic: "run-wiki-build",
        metadata: { requestDigest: DIGEST }
      }
    },
    { actor: { type: "system", id: "test" }, now: NOW }
  );
  assert.equal(created.accepted, true);
  const authorized = authorizeContextWikiDispatch(created.state, {
    taskId,
    requestDigest: DIGEST,
    attempt: 1,
    secret: SECRET,
    now: NOW
  });
  assert.equal(authorized.state.events.at(-1)?.type, "context.wiki_trigger_dispatch_authorized");
  assert.strictEqual(
    authorizeContextWikiDispatch(authorized.state, {
      taskId,
      requestDigest: DIGEST,
      attempt: 1,
      secret: SECRET,
      now: NOW
    }).state,
    authorized.state
  );
  const claimed = claimContextWikiParent(authorized.state, {
    taskId,
    requestDigest: DIGEST,
    attempt: 1,
    dispatchNonce: authorized.dispatchNonce,
    triggerParentRunId: "run_parent1",
    now: NOW
  });
  assert.equal(contextWikiClaimedRun(claimed, { taskId, requestDigest: DIGEST, attempt: 1 }), "run_parent1");
  assert.throws(
    () =>
      claimContextWikiParent(claimed, {
        taskId,
        requestDigest: DIGEST,
        attempt: 1,
        dispatchNonce: authorized.dispatchNonce,
        triggerParentRunId: "run_parent2",
        now: NOW
      }),
    /another Trigger run/
  );
});

test("wiki execution grants are signed, operation-scoped, and expiring", () => {
  const minted = mintContextWikiExecutionGrant({
    secret: SECRET,
    kind: "build",
    subjectId: "task_wiki_build",
    tenantId: "tenant-1",
    repository: "acme/docs",
    triggerParentRunId: "run_parent1",
    authorityDigest: DIGEST,
    locale: "en",
    operations: ["artifact:put", "stage:snapshot"],
    now: NOW,
    ttlSeconds: 300
  });
  assert.equal(
    verifyContextWikiExecutionGrant(minted.token, {
      secret: SECRET,
      now: "2026-08-08T12:01:00.000Z",
      operation: "stage:snapshot"
    }).subjectId,
    "task_wiki_build"
  );
  assert.throws(
    () =>
      verifyContextWikiExecutionGrant(minted.token, {
        secret: SECRET,
        now: "2026-08-08T12:01:00.000Z",
        operation: "release:activate"
      }),
    /does not permit/
  );
  assert.throws(
    () => verifyContextWikiExecutionGrant(minted.token, { secret: SECRET, now: "2026-08-08T12:06:00.000Z" }),
    /expired/
  );
});
