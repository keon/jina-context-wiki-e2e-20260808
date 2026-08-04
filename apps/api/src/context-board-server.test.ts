import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileContextArtifactStore,
  MemoryContextEngineStore,
  addContextGateRepairRound,
  addContextPageRepairCycle,
  addContextPublicationWork,
  addContextResearchPlan,
  addContextResearchWork,
  boardContextPublicationInputDigest,
  boardContextReleaseId,
  contextArtifactKey,
  contextBoardTaskTypes,
  contextBoardTopics,
  contextPublicSnapshotDigest,
  createContextBoardBuild,
  MAX_CONTEXT_GATE_REPAIR_PASS,
  MAX_CONTEXT_REPAIR_PASS,
  serializeCertifiedContextReleaseArtifact,
  type CertifiedContextReleaseArtifactV1,
  type ContextArtifactRef
} from "@jina/context-engine";
import {
  BOARD_TASK_HARD_MAX_ATTEMPTS,
  applyCommand,
  appendEvent,
  createEmptyBoardState,
  findTask,
  leaseNextOutboxMessage,
  markOutboxDispatched,
  reduceBoard,
  transitionBoardTask,
  type BoardState,
  type TaskId
} from "@jina/board";
import { entityId } from "@jina/shared-kernel";
import { ContextQuotaService, InMemoryContextQuotaStore } from "./context-quotas.js";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const NOW = "2026-07-29T21:00:00.000Z";

test("generic worker completion atomically expands a context board graph and retains artifact references", async () => {
  const tenantId = "tenant-1";
  const repository = "omxyz/jina";
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "manual:http-runtime",
    now: NOW
  });
  const store = mutableStateStore({
    intakeState: { board: created.state, pullRequests: [] },
    devDeliverySequence: 0
  });
  const artifactRoot = await mkdtemp(join(tmpdir(), "jina-context-board-artifacts-"));
  const artifactStore = new FileContextArtifactStore(artifactRoot);
  const internalApiToken = "context-board-test-token";
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore()
  });
  await quotaService.admitBuild({
    tenantId,
    buildId: created.buildTaskId
  });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken,
    contextArtifactStore: artifactStore,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // A real repository snapshot is several megabytes. Keep this integration
    // payload large enough to guard against stack-overflowing base64
    // validation while remaining below the API's bounded request limit.
    const snapshotContent = JSON.stringify({ snapshot: "x".repeat(5 * 1024 * 1024) });
    const claimResponse = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workerId: "context-board-test",
        topics: [contextBoardTopics.snapshot]
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = (await claimResponse.json()) as {
      message: {
        id: string;
        leaseId: string;
        attempt: number;
        writeFenceToken: string;
      };
      task: { id: string };
    };
    assert.equal(claim.task.id, created.snapshotTaskId);

    const leaseBody = {
      messageId: claim.message.id,
      taskId: claim.task.id,
      leaseId: claim.message.leaseId,
      attempt: claim.message.attempt,
      writeFenceToken: claim.message.writeFenceToken
    };
    const oversizedArtifactResponse = await fetch(`${baseUrl}/internal/context/board/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...leaseBody,
        kind: "evidence-snapshot",
        name: "oversized.json",
        contentType: "application/json",
        contentBase64: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64")
      })
    });
    assert.equal(oversizedArtifactResponse.status, 413);
    assert.equal((await quotaService.snapshot(tenantId)).storage.reservedBytes, 0);

    const artifactResponse = await fetch(`${baseUrl}/internal/context/board/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...leaseBody,
        kind: "evidence-snapshot",
        name: "snapshot.json",
        contentType: "application/json",
        contentBase64: Buffer.from(snapshotContent).toString("base64")
      })
    });
    assert.equal(artifactResponse.status, 201);
    const outputArtifact = ((await artifactResponse.json()) as { artifact: ContextArtifactRef }).artifact;
    const readResponse = await fetch(`${baseUrl}/internal/context/board/artifacts/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ...leaseBody, artifact: outputArtifact })
    });
    assert.equal(readResponse.status, 200);
    const read = (await readResponse.json()) as { contentBase64: string };
    assert.equal(Buffer.from(read.contentBase64, "base64").toString("utf8"), snapshotContent);

    const wrongContentTypeRead = await fetch(`${baseUrl}/internal/context/board/artifacts/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...leaseBody,
        artifact: { ...outputArtifact, contentType: "text/plain" }
      })
    });
    assert.equal(wrongContentTypeRead.status, 400);

    const foreignBuildArtifact = await artifactStore.put({
      tenantId,
      repository,
      buildId: "task_foreign_build",
      kind: "evidence-snapshot",
      name: "snapshot.json",
      contentType: "application/json",
      content: snapshotContent
    });
    const currentBuildPrefix = outputArtifact.key.slice(0, outputArtifact.key.indexOf("/evidence-snapshot/"));
    const dotSegmentEscape = {
      ...foreignBuildArtifact,
      key: `${currentBuildPrefix}/../task_foreign_build/evidence-snapshot/snapshot.json`
    };
    const escapedRead = await fetch(`${baseUrl}/internal/context/board/artifacts/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ...leaseBody, artifact: dotSegmentEscape })
    });
    assert.equal(escapedRead.status, 400);

    const wrongTaskArtifact = await artifactStore.put({
      tenantId,
      repository,
      buildId: created.buildTaskId,
      kind: "evidence-snapshot",
      name: "another-task.json",
      contentType: "application/json",
      content: snapshotContent
    });
    const wrongTaskCompletion = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...leaseBody,
        outcome: "done",
        result: { version: 1, outputArtifact: wrongTaskArtifact, commitSha: "9".repeat(40) }
      })
    });
    assert.equal(wrongTaskCompletion.status, 400);

    const replayArtifactResponse = await fetch(`${baseUrl}/internal/context/board/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...leaseBody,
        kind: "evidence-snapshot",
        name: "snapshot-replay.json",
        contentType: "application/json",
        contentBase64: Buffer.from(snapshotContent).toString("base64")
      })
    });
    assert.equal(replayArtifactResponse.status, 201);
    const replayArtifact = ((await replayArtifactResponse.json()) as { artifact: ContextArtifactRef }).artifact;

    const nonModelUsageResponse = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...leaseBody,
        outcome: "done",
        modelUsage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
        result: { version: 1, outputArtifact, commitSha: "9".repeat(40) }
      })
    });
    assert.equal(nonModelUsageResponse.status, 400);
    const completionResponse = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...leaseBody,
        outcome: "done",
        result: { version: 1, outputArtifact, commitSha: "9".repeat(40) }
      })
    });
    assert.equal(completionResponse.status, 200, await completionResponse.text());
    const changedReplayResponse = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...leaseBody,
        outcome: "done",
        result: { version: 1, outputArtifact: replayArtifact, commitSha: "9".repeat(40) }
      })
    });
    assert.equal(changedReplayResponse.status, 409);
    const staleReadResponse = await fetch(`${baseUrl}/internal/context/board/artifacts/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ...leaseBody, artifact: outputArtifact })
    });
    assert.equal(staleReadResponse.status, 409);

    const persisted = store.current();
    const snapshotTask = persisted.intakeState.board.tasks.find((task) => task.id === created.snapshotTaskId);
    const researchPlan = persisted.intakeState.board.tasks.find(
      (task) => task.type === contextBoardTaskTypes.researchPlan
    );
    assert.equal(snapshotTask?.status, "done");
    assert.equal(researchPlan?.status, "queued");
    const completionEvent = persisted.intakeState.board.events.find(
      (event) => event.taskId === created.snapshotTaskId && event.type === `${contextBoardTopics.snapshot}.completed`
    );
    assert.deepEqual(completionEvent?.payload?.outputArtifact, outputArtifact);

    const plannerClaimResponse = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workerId: "context-board-test",
        topics: [contextBoardTopics.researchPlan]
      })
    });
    assert.equal(plannerClaimResponse.status, 200);
    const plannerClaim = (await plannerClaimResponse.json()) as {
      message: {
        id: string;
        leaseId: string;
        attempt: number;
        writeFenceToken: string;
      };
      task: {
        id: string;
        metadata: {
          dependencyResults: readonly {
            taskId: string;
            result: { outputArtifact: ContextArtifactRef };
          }[];
        };
      };
    };
    assert.equal(plannerClaim.task.metadata.dependencyResults[0]?.taskId, created.snapshotTaskId);
    assert.deepEqual(plannerClaim.task.metadata.dependencyResults[0]?.result.outputArtifact, outputArtifact);
    const plannerLease = {
      messageId: plannerClaim.message.id,
      taskId: plannerClaim.task.id,
      leaseId: plannerClaim.message.leaseId,
      attempt: plannerClaim.message.attempt,
      writeFenceToken: plannerClaim.message.writeFenceToken
    };
    const plannerCandidateResponse = await fetch(`${baseUrl}/internal/context/board/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...plannerLease,
        kind: "research-plan",
        name: "research-plan.candidate.json",
        contentType: "application/json",
        contentBase64: Buffer.from('{"candidate":true}').toString("base64")
      })
    });
    const plannerCandidateText = await plannerCandidateResponse.text();
    assert.equal(plannerCandidateResponse.status, 201, plannerCandidateText);
    const plannerCandidate = (JSON.parse(plannerCandidateText) as { artifact: ContextArtifactRef }).artifact;
    const phaseCheckpointBody = {
      ...plannerLease,
      phase: "research-plan.candidate",
      checkpointKey: "c".repeat(64),
      artifact: plannerCandidate
    };
    for (const [expectedStatus, created] of [
      [201, true],
      [200, false]
    ] as const) {
      const checkpointResponse = await fetch(`${baseUrl}/internal/context/board/phase-checkpoints`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${internalApiToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(phaseCheckpointBody)
      });
      const checkpointText = await checkpointResponse.text();
      assert.equal(checkpointResponse.status, expectedStatus, checkpointText);
      const checkpoint = JSON.parse(checkpointText) as {
        created: boolean;
        checkpoint: { attempt: number; artifact: ContextArtifactRef };
      };
      assert.equal(checkpoint.created, created);
      assert.equal(checkpoint.checkpoint.attempt, plannerLease.attempt);
      assert.deepEqual(checkpoint.checkpoint.artifact, plannerCandidate);
    }
    const phaseProgressResponse = await fetch(`${baseUrl}/context/builds/${created.buildTaskId}/progress`, {
      headers: { authorization: `Bearer ${internalApiToken}` }
    });
    const phaseProgressText = await phaseProgressResponse.text();
    assert.equal(phaseProgressResponse.status, 200, phaseProgressText);
    const phaseProgress = JSON.parse(phaseProgressText) as {
      stages: readonly {
        id: string;
        phaseCheckpoints?: readonly { phase: string; attempt: number; recordedAt: string }[];
      }[];
    };
    assert.deepEqual(
      phaseProgress.stages
        .find((stage) => stage.id === plannerClaim.task.id)
        ?.phaseCheckpoints?.map((checkpoint) => ({
          phase: checkpoint.phase,
          attempt: checkpoint.attempt
        })),
      [{ phase: "research-plan.candidate", attempt: plannerLease.attempt }]
    );
    assert.equal(
      (await store.load())?.intakeState.board.events.some((event) => event.type === "task.phase_checkpoint_recorded"),
      false
    );
    const releaseResponse = await fetch(`${baseUrl}/internal/worker/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ...plannerLease, reason: "bounded test interruption" })
    });
    assert.equal(releaseResponse.status, 200, await releaseResponse.text());
    const staleReleaseResponse = await fetch(`${baseUrl}/internal/worker/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(plannerLease)
    });
    assert.equal(staleReleaseResponse.status, 409);
    const reclaimedResponse = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workerId: "context-board-test-retry",
        topics: [contextBoardTopics.researchPlan]
      })
    });
    assert.equal(reclaimedResponse.status, 200);
    const reclaimed = (await reclaimedResponse.json()) as {
      message: {
        id: string;
        leaseId: string;
        attempt: number;
        writeFenceToken: string;
      };
      task: { id: string };
    };
    assert.equal(reclaimed.task.id, plannerClaim.task.id);
    assert.notEqual(reclaimed.message.leaseId, plannerClaim.message.leaseId);
    assert.notEqual(reclaimed.message.writeFenceToken, plannerClaim.message.writeFenceToken);
    const reclaimedLease = {
      messageId: reclaimed.message.id,
      taskId: reclaimed.task.id,
      leaseId: reclaimed.message.leaseId,
      attempt: reclaimed.message.attempt,
      writeFenceToken: reclaimed.message.writeFenceToken
    };
    const resumedCheckpointResponse = await fetch(`${baseUrl}/internal/context/board/phase-checkpoints/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...reclaimedLease,
        phase: "research-plan.candidate",
        checkpointKey: "c".repeat(64)
      })
    });
    const resumedCheckpointText = await resumedCheckpointResponse.text();
    assert.equal(resumedCheckpointResponse.status, 200, resumedCheckpointText);
    const resumedCheckpoint = JSON.parse(resumedCheckpointText) as {
      checkpoint: { attempt: number; artifact: ContextArtifactRef };
    };
    assert.equal(resumedCheckpoint.checkpoint.attempt, plannerLease.attempt);
    assert.deepEqual(resumedCheckpoint.checkpoint.artifact, plannerCandidate);
    const staleCheckpointRead = await fetch(`${baseUrl}/internal/context/board/phase-checkpoints/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...plannerLease,
        phase: "research-plan.candidate",
        checkpointKey: "c".repeat(64)
      })
    });
    assert.equal(staleCheckpointRead.status, 409);
    const plannerArtifactResponse = await fetch(`${baseUrl}/internal/context/board/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...reclaimedLease,
        kind: "research-plan",
        name: "research-plan.json",
        contentType: "application/json",
        contentBase64: Buffer.from('{"version":1}').toString("base64")
      })
    });
    assert.equal(plannerArtifactResponse.status, 201);
    const plannerArtifact = ((await plannerArtifactResponse.json()) as { artifact: ContextArtifactRef }).artifact;
    const plannerResult = {
      version: 1,
      outputArtifact: plannerArtifact,
      work: [
        {
          key: "runtime",
          title: "Research runtime",
          inputArtifact: plannerArtifact
        }
      ]
    };
    const missingUsageResponse = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...reclaimedLease,
        outcome: "done",
        result: plannerResult
      })
    });
    assert.equal(missingUsageResponse.status, 400);
    const malformedUsageResponse = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...reclaimedLease,
        outcome: "done",
        modelUsage: { inputTokens: 10, cachedInputTokens: 11, outputTokens: 2 },
        result: plannerResult
      })
    });
    assert.equal(malformedUsageResponse.status, 400);
    assert.equal((await quotaService.snapshot(tenantId)).active.modelTasks, 1);
    const exactUsage = { inputTokens: 123, cachedInputTokens: 80, outputTokens: 27 };
    const plannerCompletionBody = {
      ...reclaimedLease,
      outcome: "done",
      modelUsage: exactUsage,
      result: plannerResult
    };
    const plannerCompletionResponse = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(plannerCompletionBody)
    });
    assert.equal(plannerCompletionResponse.status, 200, await plannerCompletionResponse.text());
    const exactSnapshot = await quotaService.snapshot(tenantId);
    assert.equal(exactSnapshot.active.modelTasks, 0);
    assert.equal(exactSnapshot.monthlyModel.inputTokens, exactUsage.inputTokens);
    assert.equal(exactSnapshot.monthlyModel.cachedInputTokens, exactUsage.cachedInputTokens);
    assert.equal(exactSnapshot.monthlyModel.outputTokens, exactUsage.outputTokens);
    const completionReplayResponse = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(plannerCompletionBody)
    });
    assert.equal(completionReplayResponse.status, 200);
    const conflictingReplayResponse = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...plannerCompletionBody,
        modelUsage: { ...exactUsage, outputTokens: exactUsage.outputTokens + 1 }
      })
    });
    assert.equal(conflictingReplayResponse.status, 409);
    const replaySnapshot = await quotaService.finishModelTask({
      tenantId,
      taskId: `${reclaimed.task.id}:attempt:${reclaimed.message.attempt}`,
      ...exactUsage
    });
    assert.equal(replaySnapshot.monthlyModel.inputTokens, exactUsage.inputTokens);
    assert.equal(replaySnapshot.monthlyModel.outputTokens, exactUsage.outputTokens);

    const researchClaimResponse = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalApiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workerId: "context-board-test-research",
        topics: [contextBoardTopics.research]
      })
    });
    assert.equal(researchClaimResponse.status, 200);
    const researchClaim = (await researchClaimResponse.json()) as {
      message: {
        id: string;
        leaseId: string;
        attempt: number;
        writeFenceToken: string;
      };
      task: { id: string };
    };
    assert.equal((await quotaService.snapshot(tenantId)).active.modelTasks, 1);
    const failedResearchBody = {
      messageId: researchClaim.message.id,
      taskId: researchClaim.task.id,
      leaseId: researchClaim.message.leaseId,
      attempt: researchClaim.message.attempt,
      writeFenceToken: researchClaim.message.writeFenceToken,
      outcome: "failed",
      reason: "model request failed"
    };
    const failedResearchResponse = await workerComplete(baseUrl, internalApiToken, failedResearchBody);
    assert.equal(failedResearchResponse.status, 200, await failedResearchResponse.text());
    const cancelledSnapshot = await quotaService.snapshot(tenantId);
    assert.equal(cancelledSnapshot.active.modelTasks, 0);
    assert.equal(cancelledSnapshot.monthlyModel.inputTokens, exactUsage.inputTokens);
    assert.equal(cancelledSnapshot.monthlyModel.outputTokens, exactUsage.outputTokens);
    const failedResearchReplay = await workerComplete(baseUrl, internalApiToken, failedResearchBody);
    assert.equal(failedResearchReplay.status, 200, await failedResearchReplay.text());
    const failedResearchReplayWithUsage = await workerComplete(baseUrl, internalApiToken, {
      ...failedResearchBody,
      modelUsage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }
    });
    assert.equal(failedResearchReplayWithUsage.status, 409);

    const boardResponse = await fetch(`${baseUrl}/board`);
    assert.equal(boardResponse.status, 200);
    const publicBoard = (await boardResponse.json()) as {
      outbox: readonly Record<string, unknown>[];
      tasks: readonly { readonly metadata?: Readonly<Record<string, unknown>> }[];
    };
    assert.equal(
      publicBoard.outbox.some((message) => "writeFenceToken" in message || "leaseId" in message),
      false
    );
    assert.equal(
      publicBoard.tasks.some((task) =>
        ["inputArtifact", "planArtifact", "dependencyResults", "findingsArtifact"].some(
          (key) => key in (task.metadata ?? {})
        )
      ),
      false
    );
    assert.equal(JSON.stringify(publicBoard).includes("file://"), false);
    assert.equal(JSON.stringify(publicBoard).includes("gs://"), false);
    const eventsResponse = await fetch(`${baseUrl}/events`);
    assert.equal(eventsResponse.status, 200);
    const publicEvents = (await eventsResponse.json()) as readonly {
      readonly payload?: Readonly<Record<string, unknown>>;
    }[];
    assert.equal(
      publicEvents.some((event) =>
        ["outputArtifact", "inputArtifact", "planArtifact", "dependencyResults"].some(
          (key) => key in (event.payload ?? {})
        )
      ),
      false
    );
    assert.equal(JSON.stringify(publicEvents).includes("file://"), false);
    assert.equal(JSON.stringify(publicEvents).includes("gs://"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("Context builds enforce wall-clock and token ceilings and support idempotent operator cancellation", async () => {
  const tenantId = "tenant-budget";
  const repository = "omxyz/budget-fixture";
  const principalId = "user:budget-admin@example.com";
  const internalApiToken = "context-budget-test-token";
  const current = new Date().toISOString();
  const expired = createContextBoardBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "budget:expired",
    derivationBudgetSeconds: 300,
    derivationTokenBudget: 12_000_000,
    now: "2020-01-01T00:00:00.000Z"
  });
  const expiredMessage = expired.state.outbox.find((message) => message.taskId === expired.snapshotTaskId);
  assert.ok(expiredMessage);
  const expiredLeaseId = "expired-execution-lease";
  const expiredExecution = appendEvent(
    expired.state,
    "context.build_execution_lease_started",
    new Date(Date.now() - 301_000).toISOString(),
    expired.buildTaskId,
    {
      messageId: expiredMessage.id,
      taskId: expired.snapshotTaskId,
      attempt: expiredMessage.payload.attempt,
      leaseId: expiredLeaseId,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  );
  const tokenLimited = createContextBoardBuild(expiredExecution, {
    tenantId,
    repository,
    ref: "main",
    refSequence: 2,
    requestKey: "budget:tokens",
    derivationBudgetSeconds: 10_800,
    derivationTokenBudget: 250_000,
    now: current
  });
  let board = transitionBoardTask(tokenLimited.state, tokenLimited.snapshotTaskId, "in_progress", current);
  const tokenSnapshotMessage = board.outbox.find((message) => message.taskId === tokenLimited.snapshotTaskId);
  assert.ok(tokenSnapshotMessage);
  board = markOutboxDispatched(board, tokenSnapshotMessage.id, current);
  board = transitionBoardTask(board, tokenLimited.snapshotTaskId, "done", current);
  const snapshotContent = Buffer.from("{}", "utf8");
  const snapshotArtifact: ContextArtifactRef = {
    uri: "memory://budget-snapshot",
    key: contextArtifactKey({
      tenantId,
      repository,
      buildId: tokenLimited.buildTaskId,
      kind: "evidence-snapshot",
      name: "snapshot.json",
      contentType: "application/json",
      content: snapshotContent
    }),
    contentType: "application/json",
    bytes: snapshotContent.byteLength,
    sha256: createHash("sha256").update(snapshotContent).digest("hex")
  };
  const researchPlan = addContextResearchPlan(board, {
    buildTaskId: tokenLimited.buildTaskId,
    snapshotTaskId: tokenLimited.snapshotTaskId,
    snapshot: snapshotArtifact,
    now: current
  });
  const cancelable = createContextBoardBuild(researchPlan.state, {
    tenantId,
    repository,
    ref: "feature",
    refSequence: 1,
    requestKey: "budget:cancel",
    derivationBudgetSeconds: 10_800,
    derivationTokenBudget: 12_000_000,
    now: current
  });
  const stateStore = mutableStateStore({
    intakeState: { board: cancelable.state, pullRequests: [] },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: {
      queryRequestsPerWindow: 1_000,
      buildRequestsPerWindow: 1_000,
      maxActiveBuilds: 10,
      maxActiveModelTasks: 10
    }
  });
  for (const buildId of [expired.buildTaskId, tokenLimited.buildTaskId, cancelable.buildTaskId]) {
    await quotaService.admitBuild({ tenantId, buildId });
  }
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextStore,
    internalApiToken,
    contextQuotaService: quotaService,
    tenantAdminPrincipalIds: [principalId]
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const adminHeaders = {
    ...devHeaders(tenantId, principalId),
    authorization: `Bearer ${internalApiToken}`
  };

  try {
    const expiredClaim = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ workerId: "budget-test", topics: [contextBoardTopics.snapshot] })
    });
    assert.equal(expiredClaim.status, 200);
    const firstSnapshotClaim = (await expiredClaim.json()) as TestClaim;
    assert.equal(firstSnapshotClaim.task.id, cancelable.snapshotTaskId);
    const releaseCancelableSnapshot = await fetch(`${baseUrl}/internal/worker/release`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ ...leaseFromClaim(firstSnapshotClaim), reason: "budget test ordering" })
    });
    assert.equal(releaseCancelableSnapshot.status, 200);

    const expiredProgress = await fetch(
      `${baseUrl}/context/builds/${encodeURIComponent(expired.buildTaskId)}/progress`,
      { headers: devHeaders(tenantId, principalId) }
    );
    assert.equal(expiredProgress.status, 200);
    const expiredBody = (await expiredProgress.json()) as Record<string, unknown>;
    assert.equal(expiredBody.status, "failed");
    assert.equal(expiredBody.failureCode, "build_time_budget_exceeded");

    const modelClaim = await claimContextTask(baseUrl, internalApiToken, contextBoardTopics.researchPlan);
    assert.equal(modelClaim.task.id, researchPlan.taskId);
    assert.equal(typeof (modelClaim.task.metadata as Record<string, unknown>)?.derivationDeadlineAt, "string");
    const overBudgetCompletion = await workerComplete(baseUrl, internalApiToken, {
      ...leaseFromClaim(modelClaim),
      outcome: "retry",
      reason: "model provider unavailable",
      failureCategory: "model",
      modelUsage: {
        inputTokens: 300_000,
        cachedInputTokens: 100_000,
        outputTokens: 1
      }
    });
    assert.equal(overBudgetCompletion.status, 200, await overBudgetCompletion.text());

    const tokenProgress = await fetch(
      `${baseUrl}/context/builds/${encodeURIComponent(tokenLimited.buildTaskId)}/progress`,
      { headers: devHeaders(tenantId, principalId) }
    );
    assert.equal(tokenProgress.status, 200);
    const tokenBody = (await tokenProgress.json()) as Record<string, unknown>;
    assert.equal(tokenBody.status, "failed");
    assert.equal(tokenBody.failureCode, "build_token_budget_exceeded");
    assert.equal(tokenBody.consumedModelTokens, 300_001);

    const tokenExtensionUrl = `${baseUrl}/context/builds/${encodeURIComponent(tokenLimited.buildTaskId)}/token-budget`;
    const unacknowledged = await fetch(tokenExtensionUrl, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        acknowledged: false,
        additionalTokens: 1_000_000,
        expectedDerivationTokenBudget: 250_000,
        requestKey: "operator:token-budget-unacknowledged",
        reason: "continue the checkpointed build"
      })
    });
    assert.equal(unacknowledged.status, 400);

    const tokenExtensionBody = {
      acknowledged: true,
      additionalTokens: 1_000_000,
      expectedDerivationTokenBudget: 250_000,
      requestKey: "operator:token-budget-extension",
      reason: "continue the checkpointed build"
    };
    for (const [expectedStatus, duplicate] of [
      [202, false],
      [200, true]
    ] as const) {
      const extended = await fetch(tokenExtensionUrl, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify(tokenExtensionBody)
      });
      const extendedBody = (await extended.json()) as Record<string, unknown>;
      assert.equal(extended.status, expectedStatus, JSON.stringify(extendedBody));
      assert.equal(extendedBody.duplicate, duplicate);
      assert.equal(extendedBody.acknowledged, true);
      assert.equal(extendedBody.previousDerivationTokenBudget, 250_000);
      assert.equal(extendedBody.derivationTokenBudget, 1_250_000);
      assert.equal(extendedBody.resumed, true);
      assert.equal(extendedBody.resumedTaskId, researchPlan.taskId);
    }
    const recoveredBoard = stateStore.current().intakeState.board;
    assert.equal(findTask(recoveredBoard, tokenLimited.buildTaskId)?.metadata.derivationTokenBudget, 1_250_000);
    assert.equal(findTask(recoveredBoard, researchPlan.taskId)?.status, "queued");
    assert.equal(
      recoveredBoard.events.filter((event) => event.type === "context.build_token_budget_extended").length,
      1
    );

    for (const changed of [true, false]) {
      const cancellation = await fetch(
        `${baseUrl}/internal/context/builds/${encodeURIComponent(cancelable.buildTaskId)}/cancel`,
        {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ reason: "acceptance timeout" })
        }
      );
      assert.equal(cancellation.status, 200);
      assert.deepEqual(await cancellation.json(), {
        accepted: true,
        buildId: cancelable.buildTaskId,
        status: "canceled",
        canceled: true,
        changed
      });
    }
    const canceledProgress = await fetch(
      `${baseUrl}/context/builds/${encodeURIComponent(cancelable.buildTaskId)}/progress`,
      { headers: devHeaders(tenantId, principalId) }
    );
    assert.equal(canceledProgress.status, 200);
    assert.equal((await canceledProgress.json()).failureCode, "build_canceled");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("Context execution budgets ignore queue time and merge parallel lease windows", async () => {
  const tenantId = "tenant-active-time-budget";
  const repository = "omxyz/active-time-budget";
  const principalId = "user:active-time@example.com";
  const internalApiToken = "context-active-time-test-token";
  const createdAtMs = Date.now() - 600_000;
  const createdAt = new Date(createdAtMs).toISOString();
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "budget:active-time",
    derivationBudgetSeconds: 300,
    derivationTokenBudget: 12_000_000,
    now: createdAt
  });
  const base = Date.now();
  const firstMessage = created.state.outbox.find((message) => message.taskId === created.snapshotTaskId);
  assert.ok(firstMessage);
  const executionEvent = (
    state: BoardState,
    phase: "started" | "ended",
    messageId: string,
    leaseId: string,
    at: number,
    expiresAt: number
  ) =>
    appendEvent(state, `context.build_execution_lease_${phase}`, new Date(at).toISOString(), created.buildTaskId, {
      messageId,
      taskId: created.snapshotTaskId,
      attempt: 1,
      leaseId,
      leaseExpiresAt: new Date(expiresAt).toISOString()
    });
  let board = executionEvent(
    created.state,
    "started",
    firstMessage.id,
    "execution-one",
    base - 240_000,
    base - 210_000
  );
  board = executionEvent(board, "ended", firstMessage.id, "execution-one", base - 180_000, base - 150_000);
  board = executionEvent(
    board,
    "started",
    `${firstMessage.id}-parallel`,
    "execution-two",
    base - 190_000,
    base - 90_000
  );
  board = executionEvent(board, "ended", `${firstMessage.id}-parallel`, "execution-two", base - 120_000, base - 90_000);
  const stateStore = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextStore,
    internalApiToken
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/context/builds/${created.buildTaskId}/progress`, {
      headers: devHeaders(tenantId, principalId)
    });
    assert.equal(response.status, 200);
    const progress = (await response.json()) as Record<string, unknown>;
    assert.equal(progress.status, "active");
    assert.equal(progress.consumedExecutionSeconds, 120);
    assert.equal(progress.remainingExecutionSeconds, 180);
    const deadlineMs = Date.parse(String(progress.derivationDeadlineAt));
    assert.ok(deadlineMs >= Date.now() + 179_000 && deadlineMs <= Date.now() + 181_000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("tenant administrators can extend and resume only the task canceled by a build deadline", async () => {
  const tenantId = "tenant-deadline-recovery";
  const repository = "omxyz/deadline-recovery";
  const principalId = "user:deadline-admin@example.com";
  const internalApiToken = "context-deadline-recovery-token";
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "deadline:expired",
    derivationBudgetSeconds: 300,
    derivationTokenBudget: 12_000_000,
    now: new Date(Date.now() - 301_000).toISOString()
  });
  const snapshotMessage = created.state.outbox.find((message) => message.taskId === created.snapshotTaskId);
  assert.ok(snapshotMessage);
  const board = appendEvent(
    created.state,
    "context.build_execution_lease_started",
    new Date(Date.now() - 301_000).toISOString(),
    created.buildTaskId,
    {
      messageId: snapshotMessage.id,
      taskId: created.snapshotTaskId,
      attempt: snapshotMessage.payload.attempt,
      leaseId: "deadline-expired-lease",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  );
  const stateStore = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quotaService.admitBuild({ tenantId, buildId: created.buildTaskId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextStore,
    internalApiToken,
    contextQuotaService: quotaService,
    tenantAdminPrincipalIds: [principalId]
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const expiredClaim = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ workerId: "deadline-recovery-test", topics: [contextBoardTopics.snapshot] })
    });
    assert.equal(expiredClaim.status, 204);
    const expired = await fetch(`${baseUrl}/context/builds/${created.buildTaskId}/progress`, {
      headers: devHeaders(tenantId, principalId)
    });
    assert.equal(expired.status, 200);
    assert.equal((await expired.json()).failureCode, "build_time_budget_exceeded");

    const retryUrl = `${baseUrl}/context/builds/${created.buildTaskId}/tasks/${created.snapshotTaskId}/retry`;
    const retryBody = {
      requestKey: "operator:deadline-recovery",
      reason: "the provider outage consumed the original build envelope",
      extendDeadlineBySeconds: 3_600
    };
    for (const [expectedStatus, duplicate] of [
      [202, false],
      [200, true]
    ] as const) {
      const retried = await fetch(retryUrl, {
        method: "POST",
        headers: devHeaders(tenantId, principalId),
        body: JSON.stringify(retryBody)
      });
      const body = (await retried.json()) as Record<string, unknown>;
      assert.equal(retried.status, expectedStatus, JSON.stringify(body));
      assert.equal(body.duplicate, duplicate);
      assert.equal(body.taskId, created.snapshotTaskId);
      assert.equal(typeof body.extendedDeadlineAt, "string");
    }

    const recovered = stateStore.current().intakeState.board;
    const recoveredBuild = findTask(recovered, created.buildTaskId);
    assert.equal(recoveredBuild?.metadata.derivationBudgetSeconds, 3_900);
    assert.equal(findTask(recovered, created.snapshotTaskId)?.status, "queued");
    assert.equal(recovered.events.filter((event) => event.type === "context.build_time_budget_extended").length, 1);
    assert.equal(
      recovered.events.filter((event) => event.type === "context.deadline_interrupted_task_reclassified").length,
      1
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("tenant administrators can extend a provider-failed task after its build deadline", async () => {
  const tenantId = "tenant-provider-deadline-recovery";
  const repository = "omxyz/provider-deadline-recovery";
  const failed = failedPublicationPlannerFixture(tenantId, repository, "provider-deadline");
  const expiredAt = new Date(Date.now() - 301_000).toISOString();
  let board: BoardState = {
    ...failed.state,
    tasks: failed.state.tasks.map((task) =>
      task.id === failed.buildId
        ? {
            ...task,
            createdAt: expiredAt,
            updatedAt: expiredAt,
            metadata: { ...task.metadata, derivationBudgetSeconds: 300 }
          }
        : task
    )
  };
  board = appendEvent(board, "context.build_execution_lease_started", expiredAt, failed.buildId, {
    messageId: failed.oldLease.messageId,
    taskId: failed.plannerId,
    attempt: failed.oldLease.attempt,
    leaseId: failed.oldLease.leaseId,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const stateStore = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quotaService.admitBuild({ tenantId, buildId: failed.buildId });
  await quotaService.completeBuild({ tenantId, buildId: failed.buildId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/context/builds/${failed.buildId}/tasks/${failed.plannerId}/retry`, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify({
        requestKey: "operator:provider-deadline-recovery",
        reason: "the provider retries consumed the remaining build envelope",
        extendDeadlineBySeconds: 3_600
      })
    });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(body.taskId, failed.plannerId);
    assert.equal(typeof body.extendedDeadlineAt, "string");

    const recovered = stateStore.current().intakeState.board;
    assert.equal(findTask(recovered, failed.buildId)?.metadata.derivationBudgetSeconds, 3_900);
    assert.equal(findTask(recovered, failed.plannerId)?.status, "queued");
    assert.equal(
      recovered.events.filter((event) => event.type === "context.deadline_constrained_task_retry_prepared").length,
      1
    );
    assert.equal(
      recovered.events.filter((event) => event.type === "context.deadline_interrupted_task_reclassified").length,
      0
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("Context claims recover a settled build quota and defer excess parallel reservations", async () => {
  const tenantId = "tenant-reservation-headroom";
  const repository = "omxyz/reservation-fixture";
  const principalId = "user:reservation@example.com";
  const internalApiToken = "context-reservation-test-token";
  const now = new Date().toISOString();
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "reservation:parallel",
    derivationBudgetSeconds: 10_800,
    derivationTokenBudget: 2_500_000,
    now
  });
  const artifact = (name: string): ContextArtifactRef => {
    const content = Buffer.from(name, "utf8");
    const kind = name === "snapshot" ? "evidence-snapshot" : name === "plan" ? "research-plan" : "research-report";
    return {
      uri: `memory://${name}`,
      key: contextArtifactKey({
        tenantId,
        repository,
        buildId: created.buildTaskId,
        kind,
        name: `${name}.json`,
        contentType: "application/json",
        content
      }),
      contentType: "application/json",
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex")
    };
  };
  let board = transitionBoardTask(created.state, created.snapshotTaskId, "in_progress", now);
  const snapshotMessage = board.outbox.find((message) => message.taskId === created.snapshotTaskId);
  assert.ok(snapshotMessage);
  board = markOutboxDispatched(board, snapshotMessage.id, now);
  board = transitionBoardTask(board, created.snapshotTaskId, "done", now);
  const plan = addContextResearchPlan(board, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: artifact("snapshot"),
    now
  });
  board = transitionBoardTask(plan.state, plan.taskId, "in_progress", now);
  const planMessage = board.outbox.find((message) => message.taskId === plan.taskId);
  assert.ok(planMessage);
  board = markOutboxDispatched(board, planMessage.id, now);
  board = transitionBoardTask(board, plan.taskId, "done", now);
  const research = addContextResearchWork(board, {
    buildTaskId: created.buildTaskId,
    researchPlanTaskId: plan.taskId,
    plan: artifact("plan"),
    work: ["one", "two", "three"].map((key) => ({
      key,
      title: `Research ${key}`,
      input: artifact(`input-${key}`)
    })),
    now
  });
  const stateStore = mutableStateStore({
    intakeState: { board: research.state, pullRequests: [] },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: { maxActiveBuilds: 10, maxActiveModelTasks: 10 }
  });
  await quotaService.admitBuild({ tenantId, buildId: created.buildTaskId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextStore,
    internalApiToken,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // Simulate a stale terminal observation settling quota while the durable
    // Board still has active work. The next claim must reactivate it.
    await quotaService.completeBuild({ tenantId, buildId: created.buildTaskId });
    const first = await claimContextTask(baseUrl, internalApiToken, contextBoardTopics.research);
    await claimContextTask(baseUrl, internalApiToken, contextBoardTopics.research);
    const deferred = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ workerId: "reservation-third", topics: [contextBoardTopics.research] })
    });
    assert.equal(deferred.status, 204);

    const progress = await fetch(`${baseUrl}/context/builds/${encodeURIComponent(created.buildTaskId)}/progress`, {
      headers: devHeaders(tenantId, principalId)
    });
    assert.equal(progress.status, 200);
    const progressBody = (await progress.json()) as Record<string, unknown>;
    assert.equal(progressBody.status, "active");
    assert.equal(progressBody.activeModelReservedTokens, 2_000_000);

    const released = await fetch(`${baseUrl}/internal/worker/release`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ ...leaseFromClaim(first), reason: "test reservation release" })
    });
    assert.equal(released.status, 200, await released.text());
    const resumed = await claimContextTask(baseUrl, internalApiToken, contextBoardTopics.research);
    assert.equal(research.researchTaskIds.includes(entityId<"task">(resumed.task.id)), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("new build admission reconciles terminal and orphaned quota reservations against the Board", async () => {
  const tenantId = "tenant-terminal-quota-repair";
  const repository = "omxyz/quota-repair";
  const principalId = "user:quota-repair@example.com";
  const internalApiToken = "terminal-quota-repair-token";
  const stale = createContextBoardBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "stale-terminal-build",
    now: NOW
  });
  const stateStore = mutableStateStore({
    intakeState: {
      board: setTaskStatus(stale.state, stale.buildTaskId, "failed"),
      pullRequests: []
    },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: { maxActiveBuilds: 1, buildRequestsPerWindow: 10 }
  });
  await quotaService.admitBuild({ tenantId, buildId: stale.buildTaskId });
  await quotaService.completeBuild({ tenantId, buildId: stale.buildTaskId });
  await quotaService.admitBuild({ tenantId, buildId: "orphaned-build-reservation" });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextStore,
    contextQuotaService: quotaService,
    internalApiToken,
    tenantAdminPrincipalIds: [principalId]
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/context/build`, {
      method: "POST",
      headers: {
        ...devHeaders(tenantId, principalId),
        authorization: `Bearer ${internalApiToken}`
      },
      body: JSON.stringify({
        repository,
        ref: "main",
        commitSha: "d".repeat(40),
        requestKey: "replacement-build"
      })
    });
    const body = await response.text();
    assert.equal(response.status, 202, body);
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);
    assert.equal(
      stateStore.current().intakeState.board.tasks.find((task) => task.id === stale.buildTaskId)?.status,
      "failed"
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a newer PR delivery queues behind leased work without settling or canceling its predecessor", async () => {
  const tenantId = "tenant-supersession-settlement-retry";
  const repository = "omxyz/supersession-settlement-retry";
  const webhookSecret = "supersession-settlement-retry-secret";
  const firstHead = "1".repeat(40);
  const secondHead = "2".repeat(40);
  const old = createContextBoardBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "pull/88/head",
    refSequence: 1,
    requestKey: "github:pull:omxyz/supersession-settlement-retry:88:first",
    commitSha: firstHead,
    trigger: "pull_request",
    now: NOW
  });
  const modelTaskId = entityId<"task">("supersession-settlement-model-task");
  let board = addContextTask(old.state, {
    id: modelTaskId,
    type: contextBoardTaskTypes.researchPlan,
    kind: "dispatchable",
    title: "Leased model work from the superseded build",
    assigneeRole: "context-agent",
    dedupeKey: "supersession-settlement:model-task",
    dispatchTopic: contextBoardTopics.researchPlan,
    parentTaskId: old.buildTaskId,
    metadata: contextMetadata(tenantId, repository, old.buildTaskId)
  });
  board = reduceBoard(board, NOW);
  const leased = leaseNextOutboxMessage(board, {
    topics: [contextBoardTopics.researchPlan],
    taskIds: [modelTaskId],
    leaseId: "supersession-settlement-lease",
    writeFenceToken: "supersession-settlement-fence",
    now: NOW,
    expiresAt: "2026-07-29T22:00:00.000Z"
  });
  assert.ok(leased);
  board = transitionBoardTask(leased.state, modelTaskId, "in_progress", NOW);
  const quotaTaskId = `${modelTaskId}:attempt:${leased.message.payload.attempt}`;
  const quotaService = new FailOnceModelSettlementQuotaService(quotaTaskId);
  await quotaService.admitBuild({ tenantId, buildId: old.buildTaskId });
  await quotaService.startModelTask({ tenantId, taskId: quotaTaskId });
  const stateStore = deliveryTrackingStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const server = createApiServer({
    tenantId,
    stateStore,
    githubWebhookSecret: webhookSecret,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const deliveryId = "supersession-settlement-retry-delivery";
  const rawBody = JSON.stringify({
    action: "synchronize",
    repository: { full_name: repository, default_branch: "main" },
    pull_request: { number: 88, head: { sha: secondHead } }
  });
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const deliver = () =>
    fetch(`${baseUrl}/context/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signature
      },
      body: rawBody
    });

  try {
    const first = await deliver();
    assert.equal(first.status, 202, await first.text());
    const committed = stateStore.current().intakeState.board;
    assert.notEqual(committed.tasks.find((task) => task.id === old.buildTaskId)?.status, "canceled");
    assert.equal(
      committed.tasks.some(
        (task) => task.type === contextBoardTaskTypes.build && task.metadata.commitSha === secondHead
      ),
      false
    );
    assert.ok(
      committed.events.some(
        (event) =>
          event.type === "context.build_followup_requested" &&
          (event.payload?.followup as { commitSha?: string } | undefined)?.commitSha === secondHead
      )
    );
    assert.equal((await quotaService.snapshot(tenantId)).active.modelTasks, 1);
    assert.equal(quotaService.failedSettlementAttempts, 0);

    const duplicate = await deliver();
    const duplicateBody = (await duplicate.json()) as { duplicate?: boolean };
    assert.equal(duplicate.status, 200);
    assert.equal(duplicateBody.duplicate, true);
    assert.equal((await quotaService.snapshot(tenantId)).active.modelTasks, 1);
    assert.equal(quotaService.successfulSettlementAttempts, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a quota-denied model task does not block later same-tenant non-model work", async () => {
  const tenantId = "tenant-claim-bypass";
  const modelTaskId = entityId<"task">("claim-bypass-model");
  const snapshotTaskId = entityId<"task">("claim-bypass-snapshot");
  const initialBoard = quotaClaimBoard([
    {
      tenantId,
      taskId: modelTaskId,
      type: contextBoardTaskTypes.researchPlan,
      topic: contextBoardTopics.researchPlan
    },
    {
      tenantId,
      taskId: snapshotTaskId,
      type: contextBoardTaskTypes.snapshot,
      topic: contextBoardTopics.snapshot
    }
  ]);
  const store = mutableStateStore({
    intakeState: { board: initialBoard, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: { maxActiveModelTasks: 1 }
  });
  await quotaService.startModelTask({ tenantId, taskId: "claim-bypass-capacity-holder" });
  const internalApiToken = "claim-bypass-internal-token";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        workerId: "claim-bypass-worker",
        topics: [contextBoardTopics.researchPlan, contextBoardTopics.snapshot]
      })
    });
    const body = (await response.json()) as TestClaim;
    assert.equal(response.status, 200);
    assert.equal(body.task.id, snapshotTaskId);

    const persisted = store.current().intakeState.board;
    assert.deepEqual(
      persisted.tasks.find((task) => task.id === modelTaskId),
      initialBoard.tasks.find((task) => task.id === modelTaskId)
    );
    assert.deepEqual(
      persisted.outbox.find((message) => message.taskId === modelTaskId),
      initialBoard.outbox.find((message) => message.taskId === modelTaskId)
    );
    assert.equal(persisted.tasks.find((task) => task.id === snapshotTaskId)?.status, "in_progress");
    assert.equal(persisted.outbox.find((message) => message.taskId === snapshotTaskId)?.status, "leased");

    let quota = await quotaService.snapshot(tenantId);
    assert.equal(quota.active.modelTasks, 1);
    assert.equal(quota.monthlyModel.requests, 1);
    assert.equal(quota.monthlyModel.reservedTokens, quota.limits.defaultModelTaskReservationTokens);
    assert.equal(quota.denials.active_model_tasks?.count, 1);

    const beforeEmptyClaim = store.current().intakeState.board;
    const updatesBeforeEmptyClaim = store.updateCount();
    const empty = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        workerId: "claim-bypass-worker",
        topics: [contextBoardTopics.certification]
      })
    });
    assert.equal(empty.status, 204);
    assert.deepEqual(store.current().intakeState.board, beforeEmptyClaim);
    assert.equal(store.updateCount(), updatesBeforeEmptyClaim);
    assert.equal((await quotaService.snapshot(tenantId)).denials.active_model_tasks?.count, 1);

    const beforeDeniedClaim = store.current().intakeState.board;
    const denied = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        workerId: "claim-bypass-worker",
        topics: [contextBoardTopics.researchPlan, contextBoardTopics.snapshot]
      })
    });
    const deniedBody = await denied.text();
    assert.equal(denied.status, 429, deniedBody);
    assert.equal((JSON.parse(deniedBody) as { code: string }).code, "context_quota_exceeded");
    assert.deepEqual(store.current().intakeState.board, beforeDeniedClaim);
    quota = await quotaService.snapshot(tenantId);
    assert.equal(quota.active.modelTasks, 1);
    assert.equal(quota.monthlyModel.requests, 1);
    assert.equal(quota.denials.active_model_tasks?.count, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a context worker can prefer release-acceptance repository work without excluding normal work", async () => {
  const tenantId = "tenant-preferred-repository";
  const ordinaryTaskId = entityId<"task">("ordinary-repository-task");
  const acceptanceTaskId = entityId<"task">("acceptance-repository-task");
  const initialBoard = quotaClaimBoard([
    {
      tenantId,
      taskId: ordinaryTaskId,
      type: contextBoardTaskTypes.snapshot,
      topic: contextBoardTopics.snapshot,
      repository: "acme/ordinary"
    },
    {
      tenantId,
      taskId: acceptanceTaskId,
      type: contextBoardTaskTypes.snapshot,
      topic: contextBoardTopics.snapshot,
      repository: "acme/release-fixture"
    }
  ]);
  const store = mutableStateStore({
    intakeState: { board: initialBoard, pullRequests: [] },
    devDeliverySequence: 0
  });
  const internalApiToken = "preferred-repository-token";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const preferred = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        workerId: "preferred-repository-worker",
        topics: [contextBoardTopics.snapshot],
        preferredRepository: "acme/release-fixture"
      })
    });
    assert.equal(preferred.status, 200);
    assert.equal(((await preferred.json()) as TestClaim).task.id, acceptanceTaskId);

    const fallback = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        workerId: "preferred-repository-worker",
        topics: [contextBoardTopics.snapshot],
        preferredRepository: "acme/release-fixture"
      })
    });
    assert.equal(fallback.status, 200);
    assert.equal(((await fallback.json()) as TestClaim).task.id, ordinaryTaskId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("snapshot claims serialize checkout work per repository without blocking other repositories", async () => {
  const tenantId = "tenant-snapshot-repository-fairness";
  const firstRepositoryTaskId = entityId<"task">("snapshot-fairness-first");
  const queuedSameRepositoryTaskId = entityId<"task">("snapshot-fairness-same-repository");
  const otherRepositoryTaskId = entityId<"task">("snapshot-fairness-other-repository");
  const initialBoard = quotaClaimBoard([
    {
      tenantId,
      taskId: firstRepositoryTaskId,
      type: contextBoardTaskTypes.snapshot,
      topic: contextBoardTopics.snapshot,
      repository: "acme/large-repository"
    },
    {
      tenantId,
      taskId: queuedSameRepositoryTaskId,
      type: contextBoardTaskTypes.snapshot,
      topic: contextBoardTopics.snapshot,
      repository: "acme/large-repository"
    },
    {
      tenantId,
      taskId: otherRepositoryTaskId,
      type: contextBoardTaskTypes.snapshot,
      topic: contextBoardTopics.snapshot,
      repository: "acme/other-repository"
    }
  ]);
  const store = mutableStateStore({
    intakeState: { board: initialBoard, pullRequests: [] },
    devDeliverySequence: 0
  });
  const internalApiToken = "snapshot-fairness-token";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const claim = async (workerId: string): Promise<TestClaim> => {
    const response = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ workerId, topics: [contextBoardTopics.snapshot] })
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text) as TestClaim;
  };

  try {
    assert.equal((await claim("snapshot-fairness-worker-1")).task.id, firstRepositoryTaskId);
    assert.equal((await claim("snapshot-fairness-worker-2")).task.id, otherRepositoryTaskId);
    const persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === queuedSameRepositoryTaskId)?.status, "queued");
    assert.equal(persisted.outbox.find((message) => message.taskId === queuedSameRepositoryTaskId)?.status, "pending");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a denied candidate does not block an exact pre-admitted model-task reclaim", async () => {
  const tenantId = "tenant-claim-replay";
  const deniedTaskId = entityId<"task">("claim-replay-new-model");
  const preAdmittedTaskId = entityId<"task">("claim-replay-pre-admitted-model");
  const pendingBoard = quotaClaimBoard([
    {
      tenantId,
      taskId: deniedTaskId,
      type: contextBoardTaskTypes.researchPlan,
      topic: contextBoardTopics.researchPlan
    },
    {
      tenantId,
      taskId: preAdmittedTaskId,
      type: contextBoardTaskTypes.researchPlan,
      topic: contextBoardTopics.researchPlan
    }
  ]);
  const preAdmittedMessage = pendingBoard.outbox.find((message) => message.taskId === preAdmittedTaskId);
  assert.ok(preAdmittedMessage);
  const expiredLease = leaseNextOutboxMessage(pendingBoard, {
    topics: [contextBoardTopics.researchPlan],
    messageIds: [preAdmittedMessage.id],
    leaseId: "claim-replay-expired-lease",
    writeFenceToken: "claim-replay-expired-fence",
    now: NOW,
    expiresAt: "2026-07-29T22:00:00.000Z"
  });
  assert.ok(expiredLease);
  const initialBoard = transitionBoardTask(expiredLease.state, preAdmittedTaskId, "in_progress", NOW);
  const store = mutableStateStore({
    intakeState: { board: initialBoard, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: { maxActiveModelTasks: 1 }
  });
  await quotaService.startModelTask({
    tenantId,
    taskId: `${preAdmittedTaskId}:attempt:1`
  });
  const internalApiToken = "claim-replay-internal-token";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        workerId: "claim-replay-worker",
        topics: [contextBoardTopics.researchPlan]
      })
    });
    const body = (await response.json()) as TestClaim;
    assert.equal(response.status, 200);
    assert.equal(body.task.id, preAdmittedTaskId);
    assert.notEqual(body.message.leaseId, expiredLease.message.leaseId);
    assert.notEqual(body.message.writeFenceToken, expiredLease.message.writeFenceToken);

    const persisted = store.current().intakeState.board;
    assert.deepEqual(
      persisted.tasks.find((task) => task.id === deniedTaskId),
      initialBoard.tasks.find((task) => task.id === deniedTaskId)
    );
    assert.deepEqual(
      persisted.outbox.find((message) => message.taskId === deniedTaskId),
      initialBoard.outbox.find((message) => message.taskId === deniedTaskId)
    );
    assert.equal(persisted.tasks.find((task) => task.id === preAdmittedTaskId)?.status, "in_progress");
    assert.equal(persisted.outbox.find((message) => message.taskId === preAdmittedTaskId)?.status, "leased");

    const quota = await quotaService.snapshot(tenantId);
    assert.equal(quota.active.modelTasks, 1);
    assert.equal(quota.monthlyModel.requests, 1);
    assert.equal(quota.monthlyModel.reservedTokens, quota.limits.defaultModelTaskReservationTokens);
    assert.equal(quota.denials.active_model_tasks?.count, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("shared workers record one denied-tenant mutation and admit another tenant's model task", async () => {
  const deniedTenantId = "tenant-claim-denied";
  const admittedTenantId = "tenant-claim-admitted";
  const deniedTaskIds = [
    entityId<"task">("claim-fairness-denied-one"),
    entityId<"task">("claim-fairness-denied-two")
  ] as const;
  const admittedTaskId = entityId<"task">("claim-fairness-admitted");
  const initialBoard = quotaClaimBoard([
    ...deniedTaskIds.map((taskId) => ({
      tenantId: deniedTenantId,
      taskId,
      type: contextBoardTaskTypes.researchPlan,
      topic: contextBoardTopics.researchPlan
    })),
    {
      tenantId: admittedTenantId,
      taskId: admittedTaskId,
      type: contextBoardTaskTypes.researchPlan,
      topic: contextBoardTopics.researchPlan
    }
  ]);
  const store = mutableStateStore({
    intakeState: { board: initialBoard, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: { maxActiveModelTasks: 1 }
  });
  await quotaService.startModelTask({
    tenantId: deniedTenantId,
    taskId: "claim-fairness-capacity-holder"
  });
  const internalApiToken = "claim-fairness-internal-token";
  const server = createApiServer({
    stateStore: store,
    internalApiToken,
    contextQuotaService: quotaService,
    sharedIdentityResolver: {
      async resolveRepository() {
        return undefined;
      },
      async listTenantIds() {
        return [deniedTenantId, admittedTenantId];
      },
      async ping() {},
      async close() {}
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        workerId: "claim-fairness-worker",
        topics: [contextBoardTopics.researchPlan]
      })
    });
    const body = (await response.json()) as TestClaim;
    assert.equal(response.status, 200);
    assert.equal(body.task.id, admittedTaskId);

    const persisted = store.current().intakeState.board;
    for (const taskId of deniedTaskIds) {
      assert.deepEqual(
        persisted.tasks.find((task) => task.id === taskId),
        initialBoard.tasks.find((task) => task.id === taskId)
      );
      assert.deepEqual(
        persisted.outbox.find((message) => message.taskId === taskId),
        initialBoard.outbox.find((message) => message.taskId === taskId)
      );
    }
    assert.equal(persisted.tasks.find((task) => task.id === admittedTaskId)?.status, "in_progress");
    assert.equal(persisted.outbox.find((message) => message.taskId === admittedTaskId)?.status, "leased");

    const deniedQuota = await quotaService.snapshot(deniedTenantId);
    assert.equal(deniedQuota.active.modelTasks, 1);
    assert.equal(deniedQuota.monthlyModel.requests, 1);
    assert.equal(deniedQuota.denials.active_model_tasks?.count, 1);
    const admittedQuota = await quotaService.snapshot(admittedTenantId);
    assert.equal(admittedQuota.active.modelTasks, 1);
    assert.equal(admittedQuota.monthlyModel.requests, 1);
    assert.equal(admittedQuota.monthlyModel.reservedTokens, admittedQuota.limits.defaultModelTaskReservationTokens);
    assert.deepEqual(admittedQuota.denials, {});
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("terminal context exhaustion commits worker receipts before failing the build and replays exactly", async () => {
  const tenantId = "tenant-terminal";
  const repository = "omxyz/jina";
  const page = terminalExhaustionGraph(tenantId, repository, "page");
  const gate = terminalExhaustionGraph(tenantId, repository, "gate", page.state);
  let board = setTaskStatus(gate.state, page.pageRepairTaskId, "done");
  const retainedPageArtifact: ContextArtifactRef = {
    uri: "gs://context-test/retained-page.json",
    key: `context/tenants/${tenantId}/repositories/${repository}/builds/${page.buildId}/retained-page.json`,
    contentType: "application/json",
    bytes: 1,
    sha256: "a".repeat(64)
  };
  board = appendEvent(board, "context.page_repair.completed", NOW, page.pageRepairTaskId, {
    version: 1,
    outputArtifact: retainedPageArtifact
  });
  board = setTaskStatus(board, gate.gapRepairTaskId, "done");
  board = reduceBoard(board, NOW);
  const store = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const artifactRoot = await mkdtemp(join(tmpdir(), "jina-context-terminal-artifacts-"));
  const internalApiToken = "context-terminal-test-token";
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quotaService.admitBuild({ tenantId, buildId: page.buildId });
  await quotaService.admitBuild({ tenantId, buildId: gate.buildId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken,
    contextArtifactStore: new FileContextArtifactStore(artifactRoot),
    contextQuotaService: quotaService,
    tenantAdminPrincipalIds: ["user:context-admin@example.com"]
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const pageClaim = await claimContextTask(baseUrl, internalApiToken, contextBoardTopics.pageAudit);
    assert.equal(pageClaim.task.id, page.auditTaskId);
    const pageDependency = pageClaim.task.metadata?.dependencyResults?.find(
      (dependency) => dependency.taskType === contextBoardTaskTypes.pageRepair
    );
    assert.equal(pageDependency?.pageTaskId, page.pageTaskId);
    assert.equal(pageDependency?.documentPath, "architecture.md");
    const pageArtifact = await uploadWorkerArtifact(
      baseUrl,
      internalApiToken,
      pageClaim,
      "citation-audit",
      "terminal-page-audit.json"
    );
    const pageCompletion = {
      ...leaseFromClaim(pageClaim),
      outcome: "done",
      modelUsage: { inputTokens: 90, cachedInputTokens: 20, outputTokens: 15 },
      result: {
        version: 1,
        outputArtifact: pageArtifact,
        verdict: "unsupported",
        publicSnapshotDigest: "d".repeat(64),
        unsupportedCitationCount: 1,
        diagnostics: ["repository citation range exceeds 120 lines: src/server.ts"]
      }
    };
    const pageResponse = await workerComplete(baseUrl, internalApiToken, pageCompletion);
    assert.equal(pageResponse.status, 200, await pageResponse.text());

    const pageProgressResponse = await fetch(`${baseUrl}/context/builds/${page.buildId}/progress`, {
      headers: devHeaders(tenantId, "user:context-admin@example.com")
    });
    const pageProgressText = await pageProgressResponse.text();
    assert.equal(pageProgressResponse.status, 200, pageProgressText);
    const pageProgress = JSON.parse(pageProgressText) as {
      readonly pages: readonly { readonly diagnostics: readonly string[] }[];
    };
    assert.deepEqual(pageProgress.pages[0]?.diagnostics, [
      "repository citation range exceeds 120 lines: src/server.ts"
    ]);

    let persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === page.auditTaskId)?.status, "done");
    assert.equal(persisted.tasks.find((task) => task.id === page.pageTaskId)?.status, "failed");
    assert.equal(persisted.tasks.find((task) => task.id === page.buildId)?.status, "failed");
    assert.equal(persisted.tasks.find((task) => task.id === page.certificationTaskId)?.status, "canceled");
    assert.equal(persisted.tasks.find((task) => task.id === page.publicationTaskId)?.status, "canceled");
    assert.equal(persisted.tasks.find((task) => task.id === page.pageIndexTaskId)?.status, "canceled");
    assert.equal(
      persisted.events.filter(
        (event) => event.taskId === page.auditTaskId && event.type === "task.worker_completion_recorded"
      ).length,
      1
    );
    const beforePageReplay = structuredClone(persisted);
    const pageReplay = await workerComplete(baseUrl, internalApiToken, pageCompletion);
    assert.equal(pageReplay.status, 200, await pageReplay.text());
    assert.deepEqual(store.current().intakeState.board, beforePageReplay);

    const gateClaim = await claimContextTask(baseUrl, internalApiToken, contextBoardTopics.sourceChallenge);
    assert.equal(gateClaim.task.id, gate.sourceChallengeTaskId);
    const gateArtifact = await uploadWorkerArtifact(
      baseUrl,
      internalApiToken,
      gateClaim,
      "gate-evaluation",
      "terminal-source-challenge.json"
    );
    const gateCompletion = {
      ...leaseFromClaim(gateClaim),
      outcome: "done",
      modelUsage: { inputTokens: 110, cachedInputTokens: 40, outputTokens: 18 },
      result: {
        version: 1,
        outputArtifact: gateArtifact,
        verdict: "repair_required",
        publicSnapshotDigest: "e".repeat(64),
        blockingGapCount: 1
      }
    };
    const gateResponse = await workerComplete(baseUrl, internalApiToken, gateCompletion);
    assert.equal(gateResponse.status, 200, await gateResponse.text());

    persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === gate.sourceChallengeTaskId)?.status, "done");
    assert.equal(persisted.tasks.find((task) => task.id === gate.taskEvaluationTaskId)?.status, "canceled");
    assert.equal(persisted.tasks.find((task) => task.id === gate.buildId)?.status, "failed");
    assert.equal(persisted.tasks.find((task) => task.id === gate.certificationTaskId)?.status, "canceled");
    assert.equal(persisted.tasks.find((task) => task.id === gate.publicationTaskId)?.status, "canceled");
    assert.equal(persisted.tasks.find((task) => task.id === gate.pageIndexTaskId)?.status, "canceled");
    assert.equal(
      persisted.events.filter(
        (event) => event.taskId === gate.sourceChallengeTaskId && event.type === "task.worker_completion_recorded"
      ).length,
      1
    );
    const beforeGateReplay = structuredClone(persisted);
    const gateReplay = await workerComplete(baseUrl, internalApiToken, gateCompletion);
    assert.equal(gateReplay.status, 200, await gateReplay.text());
    assert.deepEqual(store.current().intakeState.board, beforeGateReplay);

    const quota = await quotaService.snapshot(tenantId);
    assert.equal(quota.active.modelTasks, 0);
    assert.equal(quota.active.builds, 0);
    assert.equal(quota.monthlyModel.requests, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a leased incremental build can read only its exact admission-bound prior release", async () => {
  const tenantId = "tenant-incremental-read";
  const repository = "omxyz/jina";
  const ref = "main";
  const commitSha = "8".repeat(40);
  const priorBuildId = "task_prior_release";
  const artifactRoot = await mkdtemp(join(tmpdir(), "jina-context-prior-release-"));
  const artifactStore = new FileContextArtifactStore(artifactRoot);
  const certificationArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: priorBuildId,
    kind: "certification",
    name: "certification.json",
    contentType: "application/json",
    content: '{"version":1}'
  });
  const publicationPlanArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: priorBuildId,
    kind: "publication-plan",
    name: "plan.json",
    contentType: "application/json",
    content: '{"version":1}'
  });
  const bodyMarkdown = "# Architecture\n\nThe API routes requests through the runtime.\n";
  const pages = [
    {
      documentPath: "architecture.md",
      title: "Architecture",
      bodyMarkdown,
      bodySha256: createHash("sha256").update(bodyMarkdown).digest("hex"),
      revisionId: "kr_prior_architecture",
      citations: []
    }
  ];
  const priorScope = {
    tenantId,
    repository,
    ref,
    refSequence: 1,
    commitSha,
    buildId: priorBuildId
  };
  const publicSnapshotDigest = contextPublicSnapshotDigest(pages);
  const publicationInputDigest = boardContextPublicationInputDigest({
    scope: priorScope,
    certificationArtifact,
    publicationPlanArtifact,
    checkpointId: "checkpoint-prior",
    publicSnapshotDigest,
    pages: pages.map((page) => ({
      documentPath: page.documentPath,
      bodySha256: page.bodySha256,
      revisionId: page.revisionId,
      citationIds: []
    }))
  });
  const releaseId = boardContextReleaseId(publicationInputDigest);
  const release: CertifiedContextReleaseArtifactV1 = {
    version: 1,
    release: {
      releaseId,
      ...priorScope,
      checkpointId: "checkpoint-prior",
      publishedAt: NOW
    },
    certificationArtifact,
    publicationPlanArtifact,
    publicSnapshotDigest,
    publicationInputDigest,
    pages
  };
  const releaseContent = serializeCertifiedContextReleaseArtifact(release);
  const releaseArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: priorBuildId,
    kind: "context-release",
    name: `${releaseId}.json`,
    contentType: "application/json",
    content: releaseContent
  });
  const priorRelease = {
    version: 1 as const,
    tenantId,
    repository,
    ref,
    refSequence: 1,
    commitSha,
    releaseId,
    publicSnapshotDigest,
    releaseArtifact
  };
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref,
    refSequence: 2,
    commitSha,
    requestKey: "manual:incremental-read",
    priorRelease,
    now: NOW
  });
  const store = mutableStateStore({
    intakeState: { board: created.state, pullRequests: [] },
    devDeliverySequence: 0
  });
  const internalApiToken = "context-prior-release-token";
  const server = createApiServer({
    tenantId,
    stateStore: store,
    internalApiToken,
    contextArtifactStore: artifactStore
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const claimResponse = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ workerId: "prior-reader", topics: [contextBoardTopics.snapshot] })
    });
    const claimText = await claimResponse.text();
    assert.equal(claimResponse.status, 200, claimText);
    const claim = JSON.parse(claimText) as {
      message: { id: string; leaseId: string; attempt: number; writeFenceToken: string };
      task: { id: string; metadata: { priorRelease: unknown } };
    };
    assert.deepEqual(claim.task.metadata.priorRelease, priorRelease);
    const lease = {
      messageId: claim.message.id,
      taskId: claim.task.id,
      leaseId: claim.message.leaseId,
      attempt: claim.message.attempt,
      writeFenceToken: claim.message.writeFenceToken
    };
    const priorRead = await fetch(`${baseUrl}/internal/context/board/artifacts/read`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ ...lease, artifact: releaseArtifact })
    });
    const priorReadText = await priorRead.text();
    assert.equal(priorRead.status, 200, priorReadText);
    const priorBody = JSON.parse(priorReadText) as { contentBase64: string };
    assert.equal(Buffer.from(priorBody.contentBase64, "base64").toString("utf8"), releaseContent);

    const unboundArtifact = await artifactStore.put({
      tenantId,
      repository,
      buildId: priorBuildId,
      kind: "context-release",
      name: "cr_unbound.json",
      contentType: "application/json",
      content: releaseContent
    });
    const unboundRead = await fetch(`${baseUrl}/internal/context/board/artifacts/read`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ ...lease, artifact: unboundArtifact })
    });
    assert.equal(unboundRead.status, 400, await unboundRead.text());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("transient Board failures retry with fresh fences, preserved siblings, and no quota leak", async () => {
  const tenantId = "tenant-retry";
  const repository = "omxyz/jina";
  const transientRootId = entityId<"task">("retry-http-root");
  const transientTaskId = entityId<"task">("retry-http-model-task");
  const siblingTaskId = entityId<"task">("retry-http-completed-sibling");
  const semanticRootId = entityId<"task">("retry-http-semantic-root");
  const semanticTaskId = entityId<"task">("retry-http-semantic-task");
  let board = createEmptyBoardState();
  board = addContextTask(board, {
    id: transientRootId,
    type: contextBoardTaskTypes.build,
    kind: "aggregate",
    title: "Transient retry build",
    assigneeRole: "system",
    dedupeKey: "retry-http:root",
    metadata: contextMetadata(tenantId, repository, transientRootId)
  });
  board = addContextTask(board, {
    id: transientTaskId,
    type: contextBoardTaskTypes.research,
    kind: "dispatchable",
    title: "Transient model task",
    assigneeRole: "context-researcher",
    dedupeKey: "retry-http:model",
    dispatchTopic: contextBoardTopics.research,
    parentTaskId: transientRootId,
    metadata: contextMetadata(tenantId, repository, transientRootId)
  });
  board = addContextTask(board, {
    id: siblingTaskId,
    type: contextBoardTaskTypes.research,
    kind: "dispatchable",
    title: "Completed sibling checkpoint",
    assigneeRole: "context-researcher",
    dedupeKey: "retry-http:sibling",
    dispatchTopic: contextBoardTopics.research,
    parentTaskId: transientRootId,
    metadata: contextMetadata(tenantId, repository, transientRootId)
  });
  board = transitionBoardTask(board, siblingTaskId, "done", NOW);
  board = addContextTask(board, {
    id: semanticRootId,
    type: contextBoardTaskTypes.build,
    kind: "aggregate",
    title: "Semantic failure build",
    assigneeRole: "system",
    dedupeKey: "retry-http:semantic-root",
    metadata: contextMetadata(tenantId, repository, semanticRootId)
  });
  board = addContextTask(board, {
    id: semanticTaskId,
    type: contextBoardTaskTypes.pageAudit,
    kind: "dispatchable",
    title: "Deterministic validation failure",
    assigneeRole: "context-auditor",
    dedupeKey: "retry-http:semantic-task",
    dispatchTopic: contextBoardTopics.pageAudit,
    parentTaskId: semanticRootId,
    metadata: contextMetadata(tenantId, repository, semanticRootId)
  });
  board = reduceBoard(board, NOW);

  const store = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const artifactRoot = await mkdtemp(join(tmpdir(), "jina-context-board-retry-artifacts-"));
  const internalApiToken = "context-board-retry-token";
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore()
  });
  await quotaService.admitBuild({ tenantId, buildId: transientRootId });
  await quotaService.admitBuild({ tenantId, buildId: semanticRootId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken,
    contextArtifactStore: new FileContextArtifactStore(artifactRoot),
    contextQuotaService: quotaService,
    contextBoardMaxAttempts: 2,
    tenantAdminPrincipalIds: ["user:failure-admin@example.com"]
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const firstClaim = await claimContextTask(baseUrl, internalApiToken, contextBoardTopics.research);
    assert.equal(firstClaim.task.id, transientTaskId);
    assert.equal(firstClaim.message.attempt, 1);
    assert.equal((await quotaService.snapshot(tenantId)).active.modelTasks, 1);
    const firstLease = leaseFromClaim(firstClaim);
    const transientUsage = { inputTokens: 240, cachedInputTokens: 160, outputTokens: 35 };
    const retryBody = {
      ...firstLease,
      outcome: "retry",
      reason: `provider unavailable ${"x".repeat(3_000)}`,
      failureCategory: "model",
      modelUsage: transientUsage
    };
    const firstRetry = await workerComplete(baseUrl, internalApiToken, retryBody);
    assert.equal(firstRetry.status, 200, await firstRetry.text());

    let persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === transientTaskId)?.status, "queued");
    assert.equal(persisted.tasks.find((task) => task.id === transientTaskId)?.attempt, 2);
    assert.equal(persisted.tasks.find((task) => task.id === transientRootId)?.status, "triage");
    assert.equal(persisted.tasks.find((task) => task.id === siblingTaskId)?.status, "done");
    const retryReason = persisted.events.find(
      (event) => event.taskId === transientTaskId && event.type === "task.retry_scheduled"
    )?.payload?.reason;
    assert.equal(typeof retryReason, "string");
    assert.equal((retryReason as string).length, 2_000);
    assert.match(retryReason as string, /^provider unavailable /);
    let quota = await quotaService.snapshot(tenantId);
    assert.equal(quota.active.modelTasks, 0);
    assert.equal(quota.monthlyModel.inputTokens, transientUsage.inputTokens);
    assert.equal(quota.monthlyModel.cachedInputTokens, transientUsage.cachedInputTokens);
    assert.equal(quota.monthlyModel.outputTokens, transientUsage.outputTokens);

    const staleArtifact = await fetch(`${baseUrl}/internal/context/board/artifacts`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        ...firstLease,
        kind: "research-report",
        name: "stale.json",
        contentType: "application/json",
        contentBase64: Buffer.from('{"stale":true}').toString("base64")
      })
    });
    assert.equal(staleArtifact.status, 409);
    const staleCompletion = await workerComplete(baseUrl, internalApiToken, {
      ...firstLease,
      outcome: "done",
      modelUsage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 },
      result: { version: 1, outputArtifact: artifactRef("stale") }
    });
    assert.equal(staleCompletion.status, 409);

    const beforeReplay = structuredClone(persisted);
    const replay = await workerComplete(baseUrl, internalApiToken, retryBody);
    assert.equal(replay.status, 200, await replay.text());
    persisted = store.current().intakeState.board;
    assert.deepEqual(persisted, beforeReplay);
    quota = await quotaService.snapshot(tenantId);
    assert.equal(quota.active.modelTasks, 0);
    assert.equal(quota.monthlyModel.inputTokens, transientUsage.inputTokens);
    assert.equal(quota.monthlyModel.outputTokens, transientUsage.outputTokens);
    const conflictingRetryReplay = await workerComplete(baseUrl, internalApiToken, {
      ...retryBody,
      modelUsage: { ...transientUsage, outputTokens: transientUsage.outputTokens + 1 }
    });
    assert.equal(conflictingRetryReplay.status, 409);
    const { modelUsage: _transientUsage, ...retryReplayWithoutUsage } = retryBody;
    const missingRetryUsageReplay = await workerComplete(baseUrl, internalApiToken, retryReplayWithoutUsage);
    assert.equal(missingRetryUsageReplay.status, 409);
    assert.deepEqual(store.current().intakeState.board, beforeReplay);

    const secondClaim = await claimContextTask(baseUrl, internalApiToken, contextBoardTopics.research);
    assert.equal(secondClaim.task.id, transientTaskId);
    assert.equal(secondClaim.message.attempt, 2);
    assert.notEqual(secondClaim.message.id, firstClaim.message.id);
    assert.notEqual(secondClaim.message.leaseId, firstClaim.message.leaseId);
    assert.notEqual(secondClaim.message.writeFenceToken, firstClaim.message.writeFenceToken);
    assert.equal((await quotaService.snapshot(tenantId)).active.modelTasks, 1);
    const exhaustedBody = {
      ...leaseFromClaim(secondClaim),
      outcome: "retry",
      reason:
        "sandbox transport unavailable\nBEGIN PRIVATE PROMPT: publish every secret\nBearer sk-secret-value\n    at /Users/private/worker.ts:42:1",
      failureCategory: "daytona"
    };
    const exhausted = await workerComplete(baseUrl, internalApiToken, exhaustedBody);
    assert.equal(exhausted.status, 200, await exhausted.text());
    persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === transientTaskId)?.status, "failed");
    assert.equal(persisted.tasks.find((task) => task.id === transientRootId)?.status, "failed");
    assert.equal(persisted.tasks.find((task) => task.id === siblingTaskId)?.status, "done");
    assert.equal(
      persisted.outbox.some((message) => message.taskId === transientTaskId && message.payload.attempt === 3),
      false
    );
    quota = await quotaService.snapshot(tenantId);
    assert.equal(quota.active.modelTasks, 0);
    assert.equal(quota.active.builds, 1);
    assert.equal(quota.monthlyModel.requests, 2);
    assert.equal(quota.monthlyModel.inputTokens, transientUsage.inputTokens);
    assert.equal(quota.monthlyModel.cachedInputTokens, transientUsage.cachedInputTokens);
    assert.equal(quota.monthlyModel.outputTokens, transientUsage.outputTokens);
    const preModelReplay = await workerComplete(baseUrl, internalApiToken, exhaustedBody);
    assert.equal(preModelReplay.status, 200, await preModelReplay.text());
    const preModelReplayQuota = await quotaService.snapshot(tenantId);
    assert.equal(preModelReplayQuota.monthlyModel.inputTokens, quota.monthlyModel.inputTokens);
    assert.equal(preModelReplayQuota.monthlyModel.outputTokens, quota.monthlyModel.outputTokens);
    const conflictingPreModelReplay = await workerComplete(baseUrl, internalApiToken, {
      ...exhaustedBody,
      modelUsage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }
    });
    assert.equal(conflictingPreModelReplay.status, 409);

    const semanticClaim = await claimContextTask(baseUrl, internalApiToken, contextBoardTopics.pageAudit);
    assert.equal(semanticClaim.task.id, semanticTaskId);
    const semanticUsage = { inputTokens: 175, cachedInputTokens: 75, outputTokens: 28 };
    const semanticFailureBody = {
      ...leaseFromClaim(semanticClaim),
      outcome: "retry",
      reason: "citation target is outside the repository snapshot",
      failureCategory: "context_validation",
      modelUsage: semanticUsage
    };
    const semanticFailure = await workerComplete(baseUrl, internalApiToken, semanticFailureBody);
    assert.equal(semanticFailure.status, 200, await semanticFailure.text());
    persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === semanticTaskId)?.status, "failed");
    assert.equal(persisted.tasks.find((task) => task.id === semanticRootId)?.status, "failed");
    assert.equal(
      persisted.outbox.some((message) => message.taskId === semanticTaskId && message.payload.attempt === 2),
      false
    );
    assert.equal(
      persisted.events.some((event) => event.taskId === semanticTaskId && event.type === "task.retry_scheduled"),
      false
    );
    quota = await quotaService.snapshot(tenantId);
    assert.equal(quota.active.modelTasks, 0);
    assert.equal(quota.active.builds, 0);
    assert.equal(quota.monthlyModel.reservedTokens, 0);
    assert.equal(quota.monthlyModel.requests, 3);
    assert.equal(quota.monthlyModel.inputTokens, transientUsage.inputTokens + semanticUsage.inputTokens);
    assert.equal(
      quota.monthlyModel.cachedInputTokens,
      transientUsage.cachedInputTokens + semanticUsage.cachedInputTokens
    );
    assert.equal(quota.monthlyModel.outputTokens, transientUsage.outputTokens + semanticUsage.outputTokens);

    const semanticReplay = await workerComplete(baseUrl, internalApiToken, semanticFailureBody);
    assert.equal(semanticReplay.status, 200, await semanticReplay.text());
    const semanticReplayQuota = await quotaService.snapshot(tenantId);
    assert.equal(semanticReplayQuota.monthlyModel.inputTokens, quota.monthlyModel.inputTokens);
    assert.equal(semanticReplayQuota.monthlyModel.outputTokens, quota.monthlyModel.outputTokens);
    const conflictingSemanticReplay = await workerComplete(baseUrl, internalApiToken, {
      ...semanticFailureBody,
      modelUsage: { ...semanticUsage, inputTokens: semanticUsage.inputTokens + 1 }
    });
    assert.equal(conflictingSemanticReplay.status, 409);
    const { modelUsage: _semanticUsage, ...semanticReplayWithoutUsage } = semanticFailureBody;
    const missingSemanticUsageReplay = await workerComplete(baseUrl, internalApiToken, semanticReplayWithoutUsage);
    assert.equal(missingSemanticUsageReplay.status, 409);

    const publicHeaders = devHeaders(tenantId, "user:failure-admin@example.com");
    const buildsResponse = await fetch(`${baseUrl}/context/builds`, { headers: publicHeaders });
    const buildsBody = await buildsResponse.text();
    assert.equal(buildsResponse.status, 200, buildsBody);
    const publicBuilds = JSON.parse(buildsBody) as {
      readonly builds: readonly {
        readonly id: string;
        readonly failureCode?: string;
        readonly failureReason?: string;
        readonly stages: readonly {
          readonly id: string;
          readonly failureCode?: string;
          readonly failureReason?: string;
          readonly startedAt?: string;
          readonly modelInputTokens?: number;
          readonly modelCachedInputTokens?: number;
          readonly modelOutputTokens?: number;
          readonly modelTotalTokens?: number;
          readonly lastRetryAt?: string;
          readonly lastRetryFailureCode?: string;
          readonly lastRetryFailureReason?: string;
        }[];
      }[];
    };
    const transientPublicBuild = publicBuilds.builds.find((build) => build.id === transientRootId);
    assert.equal(transientPublicBuild?.failureCode, "daytona");
    assert.equal(transientPublicBuild?.failureReason, "The isolated execution sandbox did not complete this stage.");
    const transientPublicStage = transientPublicBuild?.stages.find((stage) => stage.id === transientTaskId);
    assert.equal(transientPublicStage?.failureCode, "daytona");
    assert.ok((transientPublicStage?.failureReason?.length ?? 0) <= 240);
    assert.equal(transientPublicStage?.modelInputTokens, transientUsage.inputTokens);
    assert.equal(transientPublicStage?.modelCachedInputTokens, transientUsage.cachedInputTokens);
    assert.equal(transientPublicStage?.modelOutputTokens, transientUsage.outputTokens);
    assert.equal(transientPublicStage?.modelTotalTokens, transientUsage.inputTokens + transientUsage.outputTokens);
    assert.equal(transientPublicStage?.lastRetryFailureCode, "model");
    assert.equal(transientPublicStage?.lastRetryFailureReason, "The model provider did not complete this stage.");
    assert.equal(typeof transientPublicStage?.startedAt, "string");
    assert.equal(typeof transientPublicStage?.lastRetryAt, "string");
    assert.doesNotMatch(
      JSON.stringify(transientPublicBuild),
      /private prompt|sk-secret|Bearer|\/Users\/private|worker\.ts/i
    );
    const semanticPublicBuild = publicBuilds.builds.find((build) => build.id === semanticRootId);
    assert.equal(semanticPublicBuild?.failureCode, "context_validation");
    assert.equal(semanticPublicBuild?.failureReason, "Generated Context did not pass deterministic validation.");

    const progressResponse = await fetch(`${baseUrl}/context/builds/${encodeURIComponent(transientRootId)}/progress`, {
      headers: publicHeaders
    });
    const progressBody = await progressResponse.text();
    assert.equal(progressResponse.status, 200, progressBody);
    const progress = JSON.parse(progressBody) as {
      readonly failureCode?: string;
      readonly failureReason?: string;
      readonly stages: readonly {
        readonly id: string;
        readonly failureCode?: string;
        readonly failureReason?: string;
      }[];
    };
    assert.equal(progress.failureCode, "daytona");
    assert.equal(progress.stages.find((stage) => stage.id === transientTaskId)?.failureCode, "daytona");
    assert.doesNotMatch(JSON.stringify(progress), /private prompt|sk-secret|Bearer|\/Users\/private|worker\.ts/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("public Context model failures expose only fixed safe provider reasons", async () => {
  const tenantId = "tenant-model-failure-reasons";
  const repository = "omxyz/jina";
  const cases = [
    {
      suffix: "codex-quota",
      diagnostic: "Codex failed: 0 weighted tokens left; usage limit resets later\nBearer sk-codex-private",
      failureCode: "codex_quota_exhausted",
      failureReason: "Codex has no remaining credits or usage allowance."
    },
    {
      suffix: "provider-quota",
      diagnostic: "OpenAI request failed: insufficient_quota\naccount acct-private",
      failureCode: "model_quota_exhausted",
      failureReason: "The model provider has no remaining quota or usage allowance."
    },
    {
      suffix: "codex-named-stage-provider-quota",
      diagnostic: "board agent stage codex-integration exited with 1: OpenAI insufficient_quota",
      failureCode: "model_quota_exhausted",
      failureReason: "The model provider has no remaining quota or usage allowance."
    },
    {
      suffix: "rate-limit",
      diagnostic: "model provider returned HTTP status 429: too many requests\nrequest req-private",
      failureCode: "model_rate_limit",
      failureReason: "The model provider rate limit prevented this stage from completing."
    },
    {
      suffix: "authentication",
      diagnostic: "OpenAI: invalid API key sk-auth-private",
      failureCode: "model_authentication",
      failureReason: "Model provider authentication failed for this stage."
    },
    {
      suffix: "model-unavailable",
      diagnostic: "provider returned unknown model gpt-private",
      failureCode: "model_unavailable",
      failureReason: "The requested model is unsupported or unavailable from the provider."
    },
    {
      suffix: "generic",
      diagnostic:
        "provider returned catastrophic private upstream response\nBearer sk-raw-private\n    at /Users/private/model.ts:42:1",
      failureCode: "model",
      failureReason: "The model provider did not complete this stage."
    }
  ] as const;
  let board = createEmptyBoardState();
  const fixtures = cases.map((failureCase) => {
    const fixture = failedModelBuildFixture(board, tenantId, repository, failureCase.suffix, failureCase.diagnostic);
    board = fixture.state;
    return { ...failureCase, ...fixture };
  });
  const store = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const principalId = "user:model-failure-admin@example.com";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    tenantAdminPrincipalIds: [principalId]
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/context/builds`, {
      headers: devHeaders(tenantId, principalId)
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const result = JSON.parse(responseText) as {
      readonly builds: readonly {
        readonly id: string;
        readonly failureCode?: string;
        readonly failureReason?: string;
        readonly stages: readonly {
          readonly id: string;
          readonly failureCode?: string;
          readonly failureReason?: string;
        }[];
      }[];
    };
    for (const fixture of fixtures) {
      const build = result.builds.find((candidate) => candidate.id === fixture.buildId);
      assert.equal(build?.failureCode, fixture.failureCode);
      assert.equal(build?.failureReason, fixture.failureReason);
      const stage = build?.stages.find((candidate) => candidate.id === fixture.taskId);
      assert.equal(stage?.failureCode, fixture.failureCode);
      assert.equal(stage?.failureReason, fixture.failureReason);
    }
    assert.doesNotMatch(
      responseText,
      /sk-codex-private|acct-private|req-private|sk-auth-private|gpt-private|catastrophic|Bearer|sk-raw-private|\/Users\/private|model\.ts/i
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("tenant-admin operator retry resumes a failed publication planner from retained checkpoints", async () => {
  const tenantId = "tenant-operator";
  const repository = "omxyz/jina";
  const failed = failedPublicationPlannerFixture(tenantId, repository, "recoverable");
  const published = failedPublicationPlannerFixture(tenantId, repository, "published", true);
  const board: BoardState = {
    tasks: [...failed.state.tasks, ...published.state.tasks],
    dependencies: [...failed.state.dependencies, ...published.state.dependencies],
    outbox: [...failed.state.outbox, ...published.state.outbox],
    events: [...failed.state.events, ...published.state.events]
  };
  const store = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore()
  });
  for (const buildId of [failed.buildId, published.buildId]) {
    await quotaService.admitBuild({ tenantId, buildId });
    await quotaService.completeBuild({ tenantId, buildId });
  }
  const internalApiToken = "operator-retry-internal-token";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const retryUrl = `${baseUrl}/context/builds/${failed.buildId}/tasks/${failed.plannerId}/retry`;
  const retryBody = {
    requestKey: "operator:jina:planner-contract-v2",
    reason: "publication dependencies now use stable page ids"
  };

  try {
    const ordinaryUser = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "user:developer@example.com"),
      body: JSON.stringify(retryBody)
    });
    assert.equal(ordinaryUser.status, 403);

    const crossTenant = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders("tenant-other", "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    assert.equal(crossTenant.status, 404);

    const accepted = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    const acceptedBody = await accepted.text();
    assert.equal(accepted.status, 202, acceptedBody);
    const response = JSON.parse(acceptedBody) as {
      duplicate: boolean;
      attempt: number;
      reopenedTaskIds: string[];
    };
    assert.equal(response.duplicate, false);
    assert.equal(response.attempt, 2);
    assert.deepEqual(
      new Set(response.reopenedTaskIds),
      new Set([failed.buildId, failed.graphId, failed.plannerId, failed.dependentId])
    );

    let persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === failed.buildId)?.status, "triage");
    assert.equal(persisted.tasks.find((task) => task.id === failed.plannerId)?.status, "queued");
    assert.equal(persisted.tasks.find((task) => task.id === failed.dependentId)?.status, "triage");
    assert.equal(persisted.tasks.find((task) => task.id === failed.graphId)?.status, "triage");
    assert.equal(persisted.tasks.find((task) => task.id === failed.checkpointId)?.status, "done");
    assert.equal(
      persisted.events.filter(
        (event) => event.taskId === failed.plannerId && event.type === "task.operator_retry_scheduled"
      ).length,
      1
    );
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);

    const duplicate = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    const duplicateBody = await duplicate.text();
    assert.equal(duplicate.status, 200, duplicateBody);
    assert.equal((JSON.parse(duplicateBody) as { duplicate: boolean }).duplicate, true);
    persisted = store.current().intakeState.board;
    assert.equal(
      persisted.events.filter(
        (event) => event.taskId === failed.plannerId && event.type === "task.operator_retry_scheduled"
      ).length,
      1
    );
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);

    const staleRenew = await fetch(`${baseUrl}/internal/worker/renew`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify(failed.oldLease)
    });
    assert.equal(staleRenew.status, 409);

    const publishedRetry = await fetch(
      `${baseUrl}/context/builds/${published.buildId}/tasks/${published.plannerId}/retry`,
      {
        method: "POST",
        headers: devHeaders(tenantId, "svc:operator"),
        body: JSON.stringify({
          requestKey: "operator:jina:published",
          reason: "must not reopen an already published build"
        })
      }
    );
    assert.equal(publishedRetry.status, 409);
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("operator cancellation abandons recoverable failure and promotes its queued repository follow-up", async () => {
  const tenantId = "tenant-abandon-recovery";
  const repository = "omxyz/jina";
  const failed = failedPublicationPlannerFixture(tenantId, repository, "abandon-recovery");
  const queuedCommitSha = "b".repeat(40);
  const queued = applyCommand(
    failed.state,
    {
      command: "CommentTask",
      taskId: failed.buildId,
      eventType: "context.build_followup_requested",
      payload: {
        followup: {
          tenantId,
          repository,
          ref: "main",
          commitSha: queuedCommitSha,
          trigger: "push",
          requestKey: "push:queued-after-abandonment"
        }
      }
    },
    { actor: { type: "system", id: "context-build-admission" }, now: NOW }
  );
  assert.equal(queued.accepted, true);
  const store = mutableStateStore({
    intakeState: { board: queued.state, pullRequests: [] },
    devDeliverySequence: 0
  });
  const internalApiToken = "abandon-recovery-internal-token";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/internal/context/builds/${encodeURIComponent(failed.buildId)}/cancel`, {
      method: "POST",
      headers: {
        ...devHeaders(tenantId, "svc:operator"),
        authorization: `Bearer ${internalApiToken}`
      },
      body: JSON.stringify({ reason: "the retained plan is incompatible with the deployed contract" })
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    assert.deepEqual(JSON.parse(responseText), {
      accepted: true,
      buildId: failed.buildId,
      status: "failed",
      canceled: false,
      changed: true,
      recoveryAbandoned: true,
      followupPromoted: true
    });

    const persisted = store.current().intakeState.board;
    assert.equal(
      persisted.events.some(
        (event) => event.taskId === failed.buildId && event.type === "context.build_operator_recovery_abandoned"
      ),
      true
    );
    const promoted = persisted.tasks.find(
      (task) =>
        task.type === contextBoardTaskTypes.build &&
        task.id !== failed.buildId &&
        task.metadata.tenantId === tenantId &&
        task.metadata.repository === repository
    );
    assert.ok(promoted);
    assert.equal(promoted.status, "triage");
    assert.equal(promoted.metadata.commitSha, queuedCommitSha);
    assert.equal(promoted.metadata.refSequence, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("tenant-admin batch retry atomically resumes all failed parallel page branches", async () => {
  const tenantId = "tenant-batch-operator";
  const repository = "omxyz/jina";
  const recoverable = failedParallelPagesFixture(tenantId, repository, "recoverable");
  const incomplete = failedParallelPagesFixture(tenantId, repository, "incomplete");
  const board: BoardState = {
    tasks: [...recoverable.state.tasks, ...incomplete.state.tasks],
    dependencies: [...recoverable.state.dependencies, ...incomplete.state.dependencies],
    outbox: [...recoverable.state.outbox, ...incomplete.state.outbox],
    events: [...recoverable.state.events, ...incomplete.state.events]
  };
  const store = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  for (const buildId of [recoverable.buildId, incomplete.buildId]) {
    await quotaService.admitBuild({ tenantId, buildId });
    await quotaService.completeBuild({ tenantId, buildId });
  }
  await quotaService.startModelTask({
    tenantId,
    taskId: `${recoverable.runningSiblingId}:attempt:1`
  });
  const internalApiToken = "batch-retry-internal-token";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    contextQuotaService: quotaService,
    internalApiToken
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const retryUrl = `${baseUrl}/context/builds/${recoverable.buildId}/retry`;
  const retryBody = {
    taskIds: [recoverable.rightId, recoverable.leftId],
    requestKey: "operator:jina:parallel-pages-v1",
    reason: "retry both failed page branches from retained checkpoints"
  };

  try {
    const eligibilityResponse = await fetch(`${baseUrl}/context/builds/${recoverable.buildId}/progress`, {
      headers: devHeaders(tenantId, "svc:operator")
    });
    const eligibilityText = await eligibilityResponse.text();
    assert.equal(eligibilityResponse.status, 200, eligibilityText);
    assert.deepEqual(
      (
        JSON.parse(eligibilityText) as {
          retryEligibility: {
            eligible: boolean;
            recoverableTaskIds: readonly string[];
            blockers: readonly unknown[];
          };
        }
      ).retryEligibility,
      {
        eligible: true,
        recoverableTaskIds: [recoverable.leftId, recoverable.rightId],
        blockers: []
      }
    );

    const ordinaryUser = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "user:developer@example.com"),
      body: JSON.stringify(retryBody)
    });
    assert.equal(ordinaryUser.status, 403);

    const crossTenant = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders("tenant-other", "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    assert.equal(crossTenant.status, 404);

    const accepted = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    const acceptedText = await accepted.text();
    assert.equal(accepted.status, 202, acceptedText);
    const acceptedBody = JSON.parse(acceptedText) as {
      duplicate: boolean;
      tasks: readonly { taskId: string; attempt: number; outboxMessageId: string }[];
      reopenedTaskIds: readonly string[];
    };
    assert.equal(acceptedBody.duplicate, false);
    assert.deepEqual(
      acceptedBody.tasks.map((task) => [task.taskId, task.attempt]),
      [
        [recoverable.leftId, BOARD_TASK_HARD_MAX_ATTEMPTS + 1],
        [recoverable.rightId, BOARD_TASK_HARD_MAX_ATTEMPTS + 1]
      ]
    );
    assert.deepEqual(
      new Set(acceptedBody.reopenedTaskIds),
      new Set([
        recoverable.buildId,
        recoverable.leftId,
        recoverable.rightId,
        recoverable.downstreamId,
        recoverable.runningSiblingId
      ])
    );
    let persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === recoverable.leftId)?.status, "queued");
    assert.equal(persisted.tasks.find((task) => task.id === recoverable.rightId)?.status, "queued");
    assert.equal(persisted.tasks.find((task) => task.id === recoverable.downstreamId)?.status, "triage");
    assert.equal(persisted.tasks.find((task) => task.id === recoverable.runningSiblingId)?.status, "queued");
    assert.equal(
      persisted.outbox.find(
        (message) => message.taskId === recoverable.runningSiblingId && message.payload.attempt === 1
      )?.status,
      "dispatched"
    );
    assert.equal(
      persisted.outbox.find(
        (message) => message.taskId === recoverable.runningSiblingId && message.payload.attempt === 2
      )?.status,
      "pending"
    );
    assert.deepEqual(
      persisted.tasks.find((task) => task.id === recoverable.completedSiblingId),
      board.tasks.find((task) => task.id === recoverable.completedSiblingId)
    );
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);
    assert.equal((await quotaService.snapshot(tenantId)).active.modelTasks, 0);
    const staleRenew = await fetch(`${baseUrl}/internal/worker/renew`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify(recoverable.runningSiblingLease)
    });
    assert.equal(staleRenew.status, 409, await staleRenew.text());

    const duplicate = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify({
        ...retryBody,
        taskIds: [recoverable.leftId, recoverable.rightId]
      })
    });
    const duplicateText = await duplicate.text();
    assert.equal(duplicate.status, 200, duplicateText);
    const duplicateBody = JSON.parse(duplicateText) as typeof acceptedBody;
    assert.equal(duplicateBody.duplicate, true);
    assert.deepEqual(
      duplicateBody.tasks.map((task) => task.outboxMessageId),
      acceptedBody.tasks.map((task) => task.outboxMessageId)
    );
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);

    const beforeRejectedRetry = store.current().intakeState.board;
    const omittedBranch = await fetch(`${baseUrl}/context/builds/${incomplete.buildId}/retry`, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify({
        taskIds: [incomplete.leftId],
        requestKey: "operator:jina:omitted-page",
        reason: "unsafe partial branch request"
      })
    });
    assert.equal(omittedBranch.status, 409, await omittedBranch.text());
    persisted = store.current().intakeState.board;
    assert.deepEqual(persisted, beforeRejectedRetry);
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);

    const oversized = await fetch(`${baseUrl}/context/builds/${incomplete.buildId}/retry`, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify({
        taskIds: Array.from({ length: 26 }, (_, index) => `task-${index}`),
        requestKey: "operator:jina:too-many-pages",
        reason: "must remain bounded"
      })
    });
    assert.equal(oversized.status, 400);
    assert.deepEqual(store.current().intakeState.board, beforeRejectedRetry);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("operator retry safely replays publication side effects and rejects a stale ref sequence", async () => {
  const tenantId = "tenant-side-effects";
  const pageIndex = failedPublicationSideEffectFixture(
    tenantId,
    "omxyz/jina",
    "pageindex",
    contextBoardTaskTypes.pageIndex
  );
  const publication = failedPublicationSideEffectFixture(
    tenantId,
    "omxyz/jina",
    "publication",
    contextBoardTaskTypes.publication
  );
  const stalePublication = failedPublicationSideEffectFixture(
    tenantId,
    "omxyz/stale",
    "stale-publication",
    contextBoardTaskTypes.publication
  );
  const newerBuildId = entityId<"task">("operator-newer-build");
  const newer = addContextTask(createEmptyBoardState(), {
    id: newerBuildId,
    type: contextBoardTaskTypes.build,
    kind: "aggregate",
    title: "Newer admitted build",
    assigneeRole: "system",
    dedupeKey: "operator:newer:build",
    metadata: {
      tenantId,
      repository: "omxyz/stale",
      ref: "main",
      refSequence: 2,
      commitSha: "b".repeat(40)
    }
  });
  const board: BoardState = {
    tasks: [...pageIndex.state.tasks, ...publication.state.tasks, ...stalePublication.state.tasks, ...newer.tasks],
    dependencies: [
      ...pageIndex.state.dependencies,
      ...publication.state.dependencies,
      ...stalePublication.state.dependencies,
      ...newer.dependencies
    ],
    outbox: [...pageIndex.state.outbox, ...publication.state.outbox, ...stalePublication.state.outbox, ...newer.outbox],
    events: [...pageIndex.state.events, ...publication.state.events, ...stalePublication.state.events, ...newer.events]
  };
  const store = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  for (const buildId of [pageIndex.buildId, publication.buildId, stalePublication.buildId]) {
    await quotaService.admitBuild({ tenantId, buildId });
    await quotaService.completeBuild({ tenantId, buildId });
  }
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const retry = (fixture: typeof pageIndex, requestKey: string) =>
    fetch(`${baseUrl}/context/builds/${fixture.buildId}/tasks/${fixture.targetId}/retry`, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify({ requestKey, reason: "replay the stable idempotent transaction" })
    });

  try {
    const pageIndexResponse = await retry(pageIndex, "operator:pageindex:replay");
    assert.equal(pageIndexResponse.status, 202, await pageIndexResponse.text());
    let persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === pageIndex.targetId)?.status, "queued");
    assert.equal(persisted.tasks.find((task) => task.id === pageIndex.prerequisiteId)?.status, "done");

    const publicationResponse = await retry(publication, "operator:publication:replay");
    assert.equal(publicationResponse.status, 202, await publicationResponse.text());
    persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === publication.targetId)?.status, "queued");
    assert.equal(persisted.tasks.find((task) => task.id === publication.prerequisiteId)?.status, "done");

    const staleResponse = await retry(stalePublication, "operator:publication:stale");
    assert.equal(staleResponse.status, 409);
    persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === stalePublication.targetId)?.status, "failed");
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("worker completion attestations are internal, tenant-scoped, repository-authorized, and narrow", async () => {
  const tenantA = "00000000-0000-4000-8000-000000000001";
  const tenantB = "00000000-0000-4000-8000-000000000002";
  const repositoryA = "omxyz/jina";
  const first = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: tenantA,
    repository: repositoryA,
    ref: "main",
    refSequence: 1,
    requestKey: "attestation:tenant-a",
    now: NOW
  });
  const second = createContextBoardBuild(first.state, {
    tenantId: tenantB,
    repository: "omxyz/other",
    ref: "main",
    refSequence: 1,
    requestKey: "attestation:tenant-b",
    now: NOW
  });
  let board = applyCommand(
    second.state,
    {
      command: "CommentTask",
      taskId: first.snapshotTaskId,
      eventType: "task.worker_completion_recorded",
      payload: {
        messageId: "private-message-id",
        attempt: 1,
        outcome: "done",
        workerReleaseId: "release-1",
        workerService: "jina-context-worker",
        workerRevision: "jina-context-worker-release-1",
        resultDigest: "private-result-digest"
      }
    },
    { actor: { type: "run", id: "worker" }, now: NOW }
  ).state;
  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId: first.graphTaskId,
      eventType: "task.worker_completion_recorded",
      payload: {
        attempt: 1,
        outcome: "done",
        workerReleaseId: "must-not-leak"
      }
    },
    { actor: { type: "run", id: "worker" }, now: NOW }
  ).state;
  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId: first.snapshotTaskId,
      eventType: "context.private_diagnostic",
      payload: { secret: "must-not-leak" }
    },
    { actor: { type: "run", id: "worker" }, now: NOW }
  ).state;

  const store = mutableStateStore({
    intakeState: { board, pullRequests: [] },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  const internalApiToken = "completion-attestation-internal-token";
  const adminPrincipalId = "user:admin@example.com";
  const server = createApiServer({
    stateStore: store,
    contextStore,
    internalApiToken,
    tenantAdminPrincipalIds: [adminPrincipalId],
    sharedIdentityResolver: {
      async resolveRepository() {
        return undefined;
      },
      async listTenantIds() {
        return [tenantA, tenantB];
      },
      async ping() {},
      async close() {}
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = `/internal/context/builds/${first.buildTaskId}/worker-completions`;
  const identityHeaders = (tenantId: string, principalId = adminPrincipalId) => ({
    authorization: `Bearer ${internalApiToken}`,
    "x-jina-tenant-id": tenantId,
    "x-jina-principal-id": principalId
  });

  try {
    const unauthenticated = await fetch(`${baseUrl}${path}`, {
      headers: {
        "x-jina-tenant-id": tenantA,
        "x-jina-principal-id": adminPrincipalId
      }
    });
    assert.equal(unauthenticated.status, 401);

    const repositoryDenied = await fetch(`${baseUrl}${path}`, {
      headers: identityHeaders(tenantA, "user:reader@example.com")
    });
    assert.equal(repositoryDenied.status, 404);

    const crossTenant = await fetch(`${baseUrl}${path}`, {
      headers: identityHeaders(tenantB)
    });
    assert.equal(crossTenant.status, 404);

    const authorized = await fetch(`${baseUrl}${path}`, {
      headers: identityHeaders(tenantA)
    });
    const body = (await authorized.json()) as {
      readonly buildId: string;
      readonly repository: string;
      readonly completions: readonly Record<string, unknown>[];
    };
    assert.equal(authorized.status, 200);
    assert.equal(body.buildId, first.buildTaskId);
    assert.equal(body.repository, repositoryA);
    assert.deepEqual(body.completions, [
      {
        taskId: first.snapshotTaskId,
        taskType: contextBoardTaskTypes.snapshot,
        attempt: 1,
        outcome: "done",
        workerReleaseId: "release-1",
        workerService: "jina-context-worker",
        workerRevision: "jina-context-worker-release-1"
      }
    ]);
    assert.equal(JSON.stringify(body).includes("private-message-id"), false);
    assert.equal(JSON.stringify(body).includes("private-result-digest"), false);
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await contextStore.close();
  }
});

function terminalExhaustionGraph(
  tenantId: string,
  repository: string,
  suffix: string,
  initialState: BoardState = createEmptyBoardState()
): {
  readonly state: BoardState;
  readonly buildId: TaskId;
  readonly pageTaskId: TaskId;
  readonly pageRepairTaskId: TaskId;
  readonly auditTaskId: TaskId;
  readonly gapRepairTaskId: TaskId;
  readonly sourceChallengeTaskId: TaskId;
  readonly taskEvaluationTaskId: TaskId;
  readonly certificationTaskId: TaskId;
  readonly publicationTaskId: TaskId;
  readonly pageIndexTaskId: TaskId;
} {
  const created = createContextBoardBuild(initialState, {
    tenantId,
    repository,
    ref: "main",
    refSequence: suffix === "page" ? 10 : 11,
    requestKey: `terminal:${suffix}`,
    now: NOW
  });
  const scopedArtifact = (name: string): ContextArtifactRef => {
    const key = `context/tenants/${tenantId}/repositories/${repository}/builds/${created.buildTaskId}/${name}.json`;
    return {
      uri: `gs://context-test/${key}`,
      key,
      contentType: "application/json",
      bytes: name.length,
      sha256: "a".repeat(64)
    };
  };
  const researchPlan = addContextResearchPlan(created.state, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: scopedArtifact("snapshot"),
    now: NOW
  });
  const research = addContextResearchWork(researchPlan.state, {
    buildTaskId: created.buildTaskId,
    researchPlanTaskId: researchPlan.taskId,
    plan: scopedArtifact("research-plan"),
    work: [],
    now: NOW
  });
  const publication = addContextPublicationWork(research.state, {
    buildTaskId: created.buildTaskId,
    graphTaskId: created.graphTaskId,
    publicationPlanTaskId: research.publicationPlanTaskId,
    plan: scopedArtifact("publication-plan"),
    pages: [
      {
        key: "architecture",
        path: "architecture.md",
        title: "Architecture",
        input: scopedArtifact("page-input")
      }
    ],
    now: NOW
  });
  const pageTaskId = publication.pageTaskIds[0]!;
  let auditTaskId = publication.state.tasks.find(
    (task) =>
      task.parentTaskId === pageTaskId && task.type === contextBoardTaskTypes.pageAudit && task.metadata.pass === 0
  )?.id;
  if (!auditTaskId) throw new Error("initial page audit task not found");
  let pageRepairTaskId: TaskId | undefined;
  let state = publication.state;
  for (let pass = 1; pass <= MAX_CONTEXT_REPAIR_PASS; pass += 1) {
    const repair = addContextPageRepairCycle(state, {
      pageTaskId,
      priorAuditTaskId: auditTaskId,
      findings: scopedArtifact(`page-findings-${pass}`),
      pass,
      now: NOW
    });
    state = repair.state;
    pageRepairTaskId = repair.repairTaskId;
    auditTaskId = repair.auditTaskId;
  }
  let sourceChallengeTaskId = publication.sourceChallengeTaskId;
  let taskEvaluationTaskId = publication.taskEvaluationTaskId;
  let gapRepairTaskId: TaskId | undefined;
  for (let pass = 1; pass <= MAX_CONTEXT_GATE_REPAIR_PASS; pass += 1) {
    const repair = addContextGateRepairRound(state, {
      buildTaskId: created.buildTaskId,
      sourceChallengeTaskId,
      taskEvaluationTaskId,
      pass,
      now: NOW
    });
    state = repair.state;
    gapRepairTaskId = repair.repairTaskId;
    sourceChallengeTaskId = repair.sourceChallengeTaskId;
    taskEvaluationTaskId = repair.taskEvaluationTaskId;
  }
  if (!pageRepairTaskId || !gapRepairTaskId) throw new Error("terminal repair tasks were not created");
  return {
    state,
    buildId: created.buildTaskId,
    pageTaskId,
    pageRepairTaskId,
    auditTaskId,
    gapRepairTaskId,
    sourceChallengeTaskId,
    taskEvaluationTaskId,
    certificationTaskId: publication.certificationTaskId,
    publicationTaskId: publication.publicationTaskId,
    pageIndexTaskId: publication.pageIndexTaskId
  };
}

function setTaskStatus(
  state: BoardState,
  taskId: TaskId,
  status: "triage" | "queued" | "in_progress" | "done" | "failed" | "canceled"
): BoardState {
  return {
    ...state,
    tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status } : task))
  };
}

async function uploadWorkerArtifact(
  baseUrl: string,
  token: string,
  claim: TestClaim,
  kind: "citation-audit" | "gate-evaluation",
  name: string
): Promise<ContextArtifactRef> {
  const response = await fetch(`${baseUrl}/internal/context/board/artifacts`, {
    method: "POST",
    headers: internalHeaders(token),
    body: JSON.stringify({
      ...leaseFromClaim(claim),
      kind,
      name,
      contentType: "application/json",
      contentBase64: Buffer.from('{"version":1}').toString("base64")
    })
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return (JSON.parse(body) as { artifact: ContextArtifactRef }).artifact;
}

function mutableStateStore(initial: ApiSnapshot): ApiStateStore & { current(): ApiSnapshot; updateCount(): number } {
  let snapshot = structuredClone(initial);
  let updates = 0;
  return {
    current: () => structuredClone(snapshot),
    updateCount: () => updates,
    async load() {
      return structuredClone(snapshot);
    },
    async ping() {},
    async hasDelivery() {
      return false;
    },
    async save(next) {
      snapshot = structuredClone(next);
      return true;
    },
    async update<T>(
      operation: (current: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>
    ) {
      updates += 1;
      const updated = await operation(structuredClone(snapshot));
      snapshot = structuredClone(updated.state);
      return { committed: true, result: updated.result };
    },
    async close() {}
  };
}

function deliveryTrackingStateStore(initial: ApiSnapshot): ApiStateStore & { current(): ApiSnapshot } {
  let snapshot = structuredClone(initial);
  const deliveries = new Set<string>();
  return {
    current: () => structuredClone(snapshot),
    async load() {
      return structuredClone(snapshot);
    },
    async ping() {},
    async hasDelivery(deliveryId) {
      return deliveries.has(deliveryId);
    },
    async save(next, deliveryId) {
      snapshot = structuredClone(next);
      if (deliveryId) deliveries.add(deliveryId);
      return true;
    },
    async update<T>(
      operation: (current: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>,
      deliveryId?: string
    ) {
      const updated = await operation(structuredClone(snapshot));
      snapshot = structuredClone(updated.state);
      if (deliveryId) deliveries.add(deliveryId);
      return { committed: true, result: updated.result };
    },
    async close() {}
  };
}

class FailOnceModelSettlementQuotaService extends ContextQuotaService {
  failedSettlementAttempts = 0;
  successfulSettlementAttempts = 0;

  constructor(private readonly targetTaskId: string) {
    super({ store: new InMemoryContextQuotaStore() });
  }

  override async cancelModelTask(input: Parameters<ContextQuotaService["cancelModelTask"]>[0]) {
    if (input.taskId === this.targetTaskId && this.failedSettlementAttempts === 0) {
      this.failedSettlementAttempts += 1;
      throw new Error("injected model-quota settlement failure");
    }
    const settled = await super.cancelModelTask(input);
    if (input.taskId === this.targetTaskId) this.successfulSettlementAttempts += 1;
    return settled;
  }
}

function addContextTask(
  board: BoardState,
  task: {
    readonly id: TaskId;
    readonly type: string;
    readonly kind: "aggregate" | "dispatchable";
    readonly title: string;
    readonly assigneeRole: string;
    readonly dedupeKey: string;
    readonly metadata: Record<string, unknown>;
    readonly dispatchTopic?: string;
    readonly parentTaskId?: TaskId;
  }
): BoardState {
  return applyCommand(
    board,
    {
      command: "CreateTask",
      ...(task.kind === "aggregate" ? { blocksParentCompletion: false } : {}),
      task
    },
    { actor: { type: "system", id: "retry-http-test" }, now: NOW }
  ).state;
}

function quotaClaimBoard(
  tasks: readonly {
    readonly tenantId: string;
    readonly taskId: TaskId;
    readonly type: typeof contextBoardTaskTypes.researchPlan | typeof contextBoardTaskTypes.snapshot;
    readonly topic: typeof contextBoardTopics.researchPlan | typeof contextBoardTopics.snapshot;
    readonly repository?: string;
  }[]
): BoardState {
  let board = createEmptyBoardState();
  for (const [index, task] of tasks.entries()) {
    board = addContextTask(board, {
      id: task.taskId,
      type: task.type,
      kind: "dispatchable",
      title: `Quota claim candidate ${index + 1}`,
      assigneeRole: "context-agent",
      dedupeKey: `quota-claim:${task.tenantId}:${task.taskId}`,
      dispatchTopic: task.topic,
      metadata: contextMetadata(task.tenantId, task.repository ?? "omxyz/jina", `quota-claim-build-${task.tenantId}`)
    });
  }
  return reduceBoard(board, NOW);
}

function contextMetadata(tenantId: string, repository: string, contextBuildId: string): Record<string, unknown> {
  return {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    commitSha: "a".repeat(40),
    contextBuildId
  };
}

function failedModelBuildFixture(
  initial: BoardState,
  tenantId: string,
  repository: string,
  suffix: string,
  diagnostic: string
): { readonly state: BoardState; readonly buildId: TaskId; readonly taskId: TaskId } {
  const buildId = entityId<"task">(`model-failure-${suffix}-build`);
  const taskId = entityId<"task">(`model-failure-${suffix}-task`);
  let state = addContextTask(initial, {
    id: buildId,
    type: contextBoardTaskTypes.build,
    kind: "aggregate",
    title: `Model failure ${suffix}`,
    assigneeRole: "system",
    dedupeKey: `model-failure:${suffix}:build`,
    metadata: contextMetadata(tenantId, repository, buildId)
  });
  state = addContextTask(state, {
    id: taskId,
    type: contextBoardTaskTypes.research,
    kind: "dispatchable",
    title: `Model failure stage ${suffix}`,
    assigneeRole: "context-researcher",
    dedupeKey: `model-failure:${suffix}:stage`,
    dispatchTopic: contextBoardTopics.research,
    parentTaskId: buildId,
    metadata: contextMetadata(tenantId, repository, buildId)
  });
  state = reduceBoard(state, NOW);
  state = transitionBoardTask(state, taskId, "failed", NOW);
  state = reduceBoard(state, NOW);
  state = appendEvent(state, `${contextBoardTopics.research}.failed`, NOW, taskId, {
    failureCategory: "model",
    reason: diagnostic
  });
  return { state, buildId, taskId };
}

function failedParallelPagesFixture(
  tenantId: string,
  repository: string,
  suffix: string
): {
  readonly state: BoardState;
  readonly buildId: TaskId;
  readonly prerequisiteId: TaskId;
  readonly leftId: TaskId;
  readonly rightId: TaskId;
  readonly downstreamId: TaskId;
  readonly completedSiblingId: TaskId;
  readonly runningSiblingId: TaskId;
  readonly runningSiblingLease: {
    readonly messageId: string;
    readonly taskId: string;
    readonly leaseId: string;
    readonly attempt: number;
    readonly writeFenceToken: string;
  };
} {
  const buildId = entityId<"task">(`operator-batch-${suffix}-build`);
  const prerequisiteId = entityId<"task">(`operator-batch-${suffix}-prerequisite`);
  const leftId = entityId<"task">(`operator-batch-${suffix}-left`);
  const rightId = entityId<"task">(`operator-batch-${suffix}-right`);
  const downstreamId = entityId<"task">(`operator-batch-${suffix}-downstream`);
  const completedSiblingId = entityId<"task">(`operator-batch-${suffix}-completed-sibling`);
  const runningSiblingId = entityId<"task">(`operator-batch-${suffix}-running-sibling`);
  let board = addContextTask(createEmptyBoardState(), {
    id: buildId,
    type: contextBoardTaskTypes.build,
    kind: "aggregate",
    title: "Parallel page recovery build",
    assigneeRole: "system",
    dedupeKey: `operator-batch:${suffix}:build`,
    metadata: {
      tenantId,
      repository,
      ref: "main",
      refSequence: 1,
      commitSha: "a".repeat(40)
    }
  });
  for (const task of [
    {
      id: prerequisiteId,
      title: "Completed page plan",
      dedupeKey: `operator-batch:${suffix}:prerequisite`
    },
    {
      id: completedSiblingId,
      title: "Completed sibling page",
      dedupeKey: `operator-batch:${suffix}:completed-sibling`
    }
  ]) {
    board = addContextTask(board, {
      id: task.id,
      type: contextBoardTaskTypes.pageWrite,
      kind: "dispatchable",
      title: task.title,
      assigneeRole: "context-writer",
      dedupeKey: task.dedupeKey,
      dispatchTopic: contextBoardTopics.pageWrite,
      parentTaskId: buildId,
      metadata: contextMetadata(tenantId, repository, buildId)
    });
    board = transitionBoardTask(board, task.id, "done", NOW);
  }
  for (const task of [
    { id: leftId, title: "Failed left page", dedupeKey: `operator-batch:${suffix}:left` },
    { id: rightId, title: "Failed right page", dedupeKey: `operator-batch:${suffix}:right` }
  ]) {
    board = applyCommand(
      board,
      {
        command: "CreateTask",
        task: {
          id: task.id,
          type: contextBoardTaskTypes.pageWrite,
          kind: "dispatchable",
          title: task.title,
          assigneeRole: "context-writer",
          dedupeKey: task.dedupeKey,
          dispatchTopic: contextBoardTopics.pageWrite,
          parentTaskId: buildId,
          metadata: contextMetadata(tenantId, repository, buildId)
        },
        dependencies: [
          {
            taskId: task.id,
            dependsOnTaskId: prerequisiteId,
            relationship: "blocks",
            required: true,
            blocksParentCompletion: true
          }
        ]
      },
      { actor: { type: "system", id: "retry-http-test" }, now: NOW }
    ).state;
  }
  board = applyCommand(
    board,
    {
      command: "CreateTask",
      task: {
        id: downstreamId,
        type: contextBoardTaskTypes.certification,
        kind: "dispatchable",
        title: "Shared certification",
        assigneeRole: "context-auditor",
        dedupeKey: `operator-batch:${suffix}:downstream`,
        dispatchTopic: contextBoardTopics.certification,
        parentTaskId: buildId,
        metadata: contextMetadata(tenantId, repository, buildId)
      },
      dependencies: [leftId, rightId].map((dependsOnTaskId) => ({
        taskId: downstreamId,
        dependsOnTaskId,
        relationship: "blocks" as const,
        required: true,
        blocksParentCompletion: true
      }))
    },
    { actor: { type: "system", id: "retry-http-test" }, now: NOW }
  ).state;
  board = addContextTask(board, {
    id: runningSiblingId,
    type: contextBoardTaskTypes.pageWrite,
    kind: "dispatchable",
    title: "Leased sibling page",
    assigneeRole: "context-writer",
    dedupeKey: `operator-batch:${suffix}:running-sibling`,
    dispatchTopic: contextBoardTopics.pageWrite,
    parentTaskId: buildId,
    metadata: contextMetadata(tenantId, repository, buildId)
  });
  board = reduceBoard(board, NOW);
  const runningSiblingClaim = leaseNextOutboxMessage(board, {
    topics: [contextBoardTopics.pageWrite],
    taskIds: [runningSiblingId],
    leaseId: `operator-batch-${suffix}-running-lease`,
    writeFenceToken: `operator-batch-${suffix}-running-fence`,
    now: NOW,
    expiresAt: "2026-07-29T22:00:00.000Z"
  });
  assert.ok(runningSiblingClaim);
  board = transitionBoardTask(runningSiblingClaim.state, runningSiblingId, "in_progress", NOW);
  board = {
    ...board,
    tasks: board.tasks.map((task) => {
      if (task.id === leftId || task.id === rightId) {
        return {
          ...task,
          status: "failed" as const,
          attempt: BOARD_TASK_HARD_MAX_ATTEMPTS,
          updatedAt: NOW
        };
      }
      if (task.id === downstreamId) {
        return { ...task, status: "canceled" as const, updatedAt: NOW };
      }
      if (task.id === buildId) {
        return { ...task, status: "failed" as const, updatedAt: NOW };
      }
      return task;
    })
  };
  return {
    state: board,
    buildId,
    prerequisiteId,
    leftId,
    rightId,
    downstreamId,
    completedSiblingId,
    runningSiblingId,
    runningSiblingLease: {
      messageId: runningSiblingClaim.message.id,
      taskId: runningSiblingId,
      leaseId: `operator-batch-${suffix}-running-lease`,
      attempt: 1,
      writeFenceToken: `operator-batch-${suffix}-running-fence`
    }
  };
}

function failedPublicationPlannerFixture(
  tenantId: string,
  repository: string,
  suffix: string,
  published = false
): {
  readonly state: BoardState;
  readonly buildId: TaskId;
  readonly graphId: TaskId;
  readonly checkpointId: TaskId;
  readonly plannerId: TaskId;
  readonly dependentId: TaskId;
  readonly oldLease: {
    readonly messageId: string;
    readonly taskId: string;
    readonly leaseId: string;
    readonly attempt: number;
    readonly writeFenceToken: string;
  };
} {
  const buildId = entityId<"task">(`operator-${suffix}-build`);
  const graphId = entityId<"task">(`operator-${suffix}-graph`);
  const checkpointId = entityId<"task">(`operator-${suffix}-research`);
  const plannerId = entityId<"task">(`operator-${suffix}-publication-plan`);
  const dependentId = entityId<"task">(`operator-${suffix}-page`);
  const publicationId = entityId<"task">(`operator-${suffix}-publication`);
  let board = addContextTask(createEmptyBoardState(), {
    id: buildId,
    type: contextBoardTaskTypes.build,
    kind: "aggregate",
    title: "Context build",
    assigneeRole: "system",
    dedupeKey: `operator:${suffix}:build`,
    metadata: {
      tenantId,
      repository,
      ref: "main",
      refSequence: 1,
      commitSha: "a".repeat(40)
    }
  });
  board = applyCommand(
    board,
    {
      command: "CreateTask",
      task: {
        id: graphId,
        type: contextBoardTaskTypes.graph,
        kind: "manual",
        title: "Dynamic graph",
        assigneeRole: "system",
        dedupeKey: `operator:${suffix}:graph`,
        parentTaskId: buildId,
        metadata: contextMetadata(tenantId, repository, buildId)
      }
    },
    { actor: { type: "system", id: "retry-http-test" }, now: NOW }
  ).state;
  board = addContextTask(board, {
    id: checkpointId,
    type: contextBoardTaskTypes.research,
    kind: "dispatchable",
    title: "Completed research checkpoint",
    assigneeRole: "context-agent",
    dedupeKey: `operator:${suffix}:research`,
    dispatchTopic: contextBoardTopics.research,
    parentTaskId: buildId,
    metadata: contextMetadata(tenantId, repository, buildId)
  });
  board = transitionBoardTask(board, checkpointId, "done", NOW);
  board = applyCommand(
    board,
    {
      command: "CreateTask",
      task: {
        id: plannerId,
        type: contextBoardTaskTypes.publicationPlan,
        kind: "dispatchable",
        title: "Plan context publication",
        assigneeRole: "context-agent",
        dedupeKey: `operator:${suffix}:planner`,
        dispatchTopic: contextBoardTopics.publicationPlan,
        parentTaskId: buildId,
        metadata: contextMetadata(tenantId, repository, buildId)
      },
      dependencies: [
        {
          taskId: plannerId,
          dependsOnTaskId: checkpointId,
          relationship: "blocks",
          required: true,
          blocksParentCompletion: true
        }
      ]
    },
    { actor: { type: "system", id: "retry-http-test" }, now: NOW }
  ).state;
  board = applyCommand(
    board,
    {
      command: "CreateTask",
      task: {
        id: dependentId,
        type: contextBoardTaskTypes.pageWrite,
        kind: "dispatchable",
        title: "Write planned page",
        assigneeRole: "context-agent",
        dedupeKey: `operator:${suffix}:page`,
        dispatchTopic: contextBoardTopics.pageWrite,
        parentTaskId: buildId,
        metadata: contextMetadata(tenantId, repository, buildId)
      },
      dependencies: [
        {
          taskId: dependentId,
          dependsOnTaskId: plannerId,
          relationship: "blocks",
          required: true,
          blocksParentCompletion: true
        }
      ]
    },
    { actor: { type: "system", id: "retry-http-test" }, now: NOW }
  ).state;
  if (published) {
    board = addContextTask(board, {
      id: publicationId,
      type: contextBoardTaskTypes.publication,
      kind: "dispatchable",
      title: "Published release",
      assigneeRole: "context-worker",
      dedupeKey: `operator:${suffix}:publication`,
      dispatchTopic: contextBoardTopics.publication,
      parentTaskId: buildId,
      metadata: contextMetadata(tenantId, repository, buildId)
    });
    board = transitionBoardTask(board, publicationId, "done", NOW);
  }
  board = reduceBoard(board, NOW);
  const claim = leaseNextOutboxMessage(board, {
    topics: [contextBoardTopics.publicationPlan],
    taskIds: [plannerId],
    leaseId: `operator-${suffix}-old-lease`,
    writeFenceToken: `operator-${suffix}-old-fence`,
    now: NOW,
    expiresAt: "2026-07-29T22:00:00.000Z"
  });
  assert.ok(claim);
  board = transitionBoardTask(claim.state, plannerId, "in_progress", NOW);
  board = markOutboxDispatched(board, claim.message.id, NOW);
  board = transitionBoardTask(board, plannerId, "failed", NOW);
  board = reduceBoard(board, NOW);
  return {
    state: board,
    buildId,
    graphId,
    checkpointId,
    plannerId,
    dependentId,
    oldLease: {
      messageId: claim.message.id,
      taskId: plannerId,
      leaseId: `operator-${suffix}-old-lease`,
      attempt: 1,
      writeFenceToken: `operator-${suffix}-old-fence`
    }
  };
}

function failedPublicationSideEffectFixture(
  tenantId: string,
  repository: string,
  suffix: string,
  targetType: typeof contextBoardTaskTypes.publication | typeof contextBoardTaskTypes.pageIndex
): {
  readonly state: BoardState;
  readonly buildId: TaskId;
  readonly prerequisiteId: TaskId;
  readonly targetId: TaskId;
} {
  const buildId = entityId<"task">(`operator-${suffix}-build`);
  const prerequisiteId = entityId<"task">(`operator-${suffix}-prerequisite`);
  const targetId = entityId<"task">(`operator-${suffix}-target`);
  const prerequisiteType =
    targetType === contextBoardTaskTypes.pageIndex
      ? contextBoardTaskTypes.publication
      : contextBoardTaskTypes.certification;
  const targetTopic =
    targetType === contextBoardTaskTypes.pageIndex ? contextBoardTopics.pageIndex : contextBoardTopics.publication;
  let board = addContextTask(createEmptyBoardState(), {
    id: buildId,
    type: contextBoardTaskTypes.build,
    kind: "aggregate",
    title: "Context side-effect build",
    assigneeRole: "system",
    dedupeKey: `operator:${suffix}:build`,
    metadata: {
      tenantId,
      repository,
      ref: "main",
      refSequence: 1,
      commitSha: "a".repeat(40)
    }
  });
  board = addContextTask(board, {
    id: prerequisiteId,
    type: prerequisiteType,
    kind: "dispatchable",
    title: "Completed side-effect prerequisite",
    assigneeRole: "context-worker",
    dedupeKey: `operator:${suffix}:prerequisite`,
    dispatchTopic:
      prerequisiteType === contextBoardTaskTypes.publication
        ? contextBoardTopics.publication
        : contextBoardTopics.certification,
    parentTaskId: buildId,
    metadata: contextMetadata(tenantId, repository, buildId)
  });
  board = transitionBoardTask(board, prerequisiteId, "done", NOW);
  board = applyCommand(
    board,
    {
      command: "CreateTask",
      task: {
        id: targetId,
        type: targetType,
        kind: "dispatchable",
        title: `Failed ${targetType}`,
        assigneeRole: "context-worker",
        dedupeKey: `operator:${suffix}:target`,
        dispatchTopic: targetTopic,
        parentTaskId: buildId,
        metadata: contextMetadata(tenantId, repository, buildId)
      },
      dependencies: [
        {
          taskId: targetId,
          dependsOnTaskId: prerequisiteId,
          relationship: "blocks",
          required: true,
          blocksParentCompletion: true
        }
      ]
    },
    { actor: { type: "system", id: "retry-http-test" }, now: NOW }
  ).state;
  board = reduceBoard(board, NOW);
  const claim = leaseNextOutboxMessage(board, {
    topics: [targetTopic],
    taskIds: [targetId],
    leaseId: `operator-${suffix}-old-lease`,
    writeFenceToken: `operator-${suffix}-old-fence`,
    now: NOW,
    expiresAt: "2026-07-29T22:00:00.000Z"
  });
  assert.ok(claim);
  board = transitionBoardTask(claim.state, targetId, "in_progress", NOW);
  board = markOutboxDispatched(board, claim.message.id, NOW);
  board = transitionBoardTask(board, targetId, "failed", NOW);
  board = reduceBoard(board, NOW);
  return { state: board, buildId, prerequisiteId, targetId };
}

interface TestClaim {
  readonly message: {
    readonly id: string;
    readonly leaseId: string;
    readonly attempt: number;
    readonly writeFenceToken: string;
  };
  readonly task: {
    readonly id: string;
    readonly metadata?: {
      readonly dependencyResults?: readonly {
        readonly taskType: string;
        readonly pageTaskId?: string;
        readonly documentPath?: string;
      }[];
    };
  };
}

async function claimContextTask(baseUrl: string, token: string, topic: string): Promise<TestClaim> {
  const response = await fetch(`${baseUrl}/internal/worker/claim`, {
    method: "POST",
    headers: internalHeaders(token),
    body: JSON.stringify({
      workerId: "context-board-retry-test",
      topics: [topic]
    })
  });
  if (response.status !== 200) {
    assert.fail(`claim failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as TestClaim;
}

function leaseFromClaim(claim: TestClaim) {
  return {
    messageId: claim.message.id,
    taskId: claim.task.id,
    leaseId: claim.message.leaseId,
    attempt: claim.message.attempt,
    writeFenceToken: claim.message.writeFenceToken
  };
}

function workerComplete(baseUrl: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/internal/worker/complete`, {
    method: "POST",
    headers: internalHeaders(token),
    body: JSON.stringify(body)
  });
}

function internalHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

function devHeaders(tenantId: string, principalId: string) {
  return {
    "x-jina-tenant-id": tenantId,
    "x-jina-principal-id": principalId,
    "content-type": "application/json"
  };
}

function artifactRef(name: string): ContextArtifactRef {
  return {
    uri: `file:///tmp/${name}.json`,
    key: `context/tenants/tenant-retry/repositories/omxyz/jina/builds/retry-http-root/${name}.json`,
    contentType: "application/json",
    bytes: 1,
    sha256: "b".repeat(64),
    objectGeneration: "1"
  };
}
