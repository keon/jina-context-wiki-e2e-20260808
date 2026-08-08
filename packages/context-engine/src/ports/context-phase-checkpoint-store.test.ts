import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryContextPhaseCheckpointStore,
  type ContextPhaseOperationClaimInput
} from "./context-phase-checkpoint-store.js";

const claim: ContextPhaseOperationClaimInput = {
  tenantId: "tenant-1",
  repository: "acme/docs",
  buildId: "build-1",
  taskId: "build-1",
  phase: "wiki-trigger-operation",
  operationKey: "a".repeat(64),
  inputDigest: "b".repeat(64),
  ownerToken: "owner-1",
  now: "2026-08-08T12:00:00.000Z",
  leaseDurationMs: 5 * 60 * 1000
};

test("operation leases serialize exact input and safely recover after release or expiry", async () => {
  const store = new MemoryContextPhaseCheckpointStore();
  assert.equal((await store.claimOperation(claim)).outcome, "acquired");
  assert.equal(
    (
      await store.claimOperation({
        ...claim,
        ownerToken: "owner-2",
        now: "2026-08-08T12:01:00.000Z"
      })
    ).outcome,
    "held"
  );
  assert.equal(
    (
      await store.claimOperation({
        ...claim,
        inputDigest: "c".repeat(64),
        ownerToken: "owner-conflict",
        now: "2026-08-08T12:01:00.000Z"
      })
    ).outcome,
    "conflict"
  );
  assert.equal(
    await store.releaseOperation({
      tenantId: claim.tenantId,
      taskId: claim.taskId,
      phase: claim.phase,
      operationKey: claim.operationKey,
      ownerToken: claim.ownerToken
    }),
    true
  );
  assert.equal(
    (
      await store.claimOperation({
        ...claim,
        ownerToken: "owner-2",
        now: "2026-08-08T12:02:00.000Z"
      })
    ).outcome,
    "acquired"
  );
  assert.equal(
    (
      await store.claimOperation({
        ...claim,
        inputDigest: "c".repeat(64),
        ownerToken: "owner-conflict-after-release",
        now: "2026-08-08T12:02:00.000Z"
      })
    ).outcome,
    "conflict",
    "release must not erase the operation/input binding"
  );
});

test("an expired lease can be reclaimed only for the same input and stale owners cannot release it", async () => {
  const store = new MemoryContextPhaseCheckpointStore();
  assert.equal((await store.claimOperation(claim)).outcome, "acquired");
  const replacement = {
    ...claim,
    ownerToken: "owner-2",
    now: "2026-08-08T12:05:01.000Z"
  };
  assert.equal((await store.claimOperation(replacement)).outcome, "acquired");
  assert.equal(
    await store.releaseOperation({
      tenantId: claim.tenantId,
      taskId: claim.taskId,
      phase: claim.phase,
      operationKey: claim.operationKey,
      ownerToken: claim.ownerToken
    }),
    false
  );
  assert.equal(
    await store.renewOperation({
      tenantId: claim.tenantId,
      taskId: claim.taskId,
      phase: claim.phase,
      operationKey: claim.operationKey,
      ownerToken: replacement.ownerToken,
      now: "2026-08-08T12:06:01.000Z",
      leaseDurationMs: 5 * 60 * 1000
    }),
    true
  );
});
