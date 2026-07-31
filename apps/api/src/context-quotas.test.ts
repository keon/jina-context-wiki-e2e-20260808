import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextQuotaExceededError,
  ContextQuotaInvariantError,
  ContextQuotaService,
  InMemoryContextQuotaStore,
  contextQuotaLimits,
  type ContextQuotaLimits,
  type ContextQuotaSnapshot,
  type ContextQuotaStore,
  type ContextTenantQuotaLedger
} from "./context-quotas.js";

const start = Date.parse("2026-07-01T00:00:00.000Z");

test("query and build admission are idempotent, rate limited, concurrent, and reset by time", async () => {
  const service = quotaService({
    queryRequestsPerWindow: 2,
    queryWindowMs: 1_000,
    buildRequestsPerWindow: 3,
    buildWindowMs: 10_000,
    maxActiveBuilds: 1
  });

  const first = await service.admitQuery(query("query-1", start));
  assert.equal(first.outcome, "admitted");
  const duplicate = await service.admitQuery(query("query-1", start + 1));
  assert.equal(duplicate.outcome, "already_admitted");
  assert.equal(duplicate.snapshot.rates.query.used, 1);
  await service.admitQuery(query("query-2", start + 2));
  await assert.rejects(service.admitQuery(query("query-3", start + 3)), quotaError("query_rate", 997));
  const reset = await service.admitQuery(query("query-3", start + 1_001));
  assert.equal(reset.snapshot.rates.query.used, 1);

  const build = await service.admitBuild(buildInput("build-1", start + 2_000));
  assert.equal(build.outcome, "admitted");
  assert.equal(build.snapshot.active.builds, 1);
  assert.equal((await service.admitBuild(buildInput("build-1", start + 2_001))).outcome, "already_admitted");
  await assert.rejects(service.admitBuild(buildInput("build-2", start + 2_002)), quotaError("active_builds"));
  await service.completeBuild(buildInput("build-1", start + 2_003));
  assert.equal((await service.admitBuild(buildInput("build-2", start + 2_004))).outcome, "admitted");
  await assert.rejects(service.resumeBuild(buildInput("build-1", start + 2_005)), quotaError("active_builds"));
  await service.completeBuild(buildInput("build-2", start + 2_005));
  const replay = await service.admitBuild(buildInput("build-1", start + 2_006));
  assert.equal(replay.outcome, "already_completed");
  assert.equal(replay.snapshot.rates.build.used, 2);
  const resumed = await service.resumeBuild(buildInput("build-1", start + 2_007));
  assert.equal(resumed.outcome, "admitted");
  assert.equal(resumed.snapshot.active.builds, 1);
  assert.equal(resumed.snapshot.rates.build.used, 2);
  assert.equal((await service.resumeBuild(buildInput("build-1", start + 2_008))).outcome, "already_admitted");
  await service.completeBuild(buildInput("build-1", start + 2_009));
});

test("board reconciliation atomically releases terminal and orphaned build reservations", async () => {
  const service = quotaService({ maxActiveBuilds: 2 });
  await service.admitBuild(buildInput("stale-1", start));
  await service.admitBuild(buildInput("stale-2", start + 1));

  const repaired = await service.reconcileActiveBuilds({
    tenantId: "tenant-a",
    activeBuildIds: ["stale-2", "stale-2"],
    at: iso(start + 2)
  });
  assert.equal(repaired.active.builds, 1);
  assert.equal((await service.admitBuild(buildInput("stale-1", start + 3))).outcome, "already_completed");
  assert.equal((await service.admitBuild(buildInput("new-build", start + 4))).outcome, "admitted");

  const replay = await service.reconcileActiveBuilds({
    tenantId: "tenant-a",
    activeBuildIds: ["stale-2", "new-build"],
    at: iso(start + 5)
  });
  assert.equal(replay.active.builds, 2);
});

test("atomic tenant partitions enforce rate and concurrency limits under parallel admission", async () => {
  const queryService = quotaService({
    queryRequestsPerWindow: 3,
    queryWindowMs: 60_000
  });
  const queryResults = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) => queryService.admitQuery(query(`parallel-query-${index}`, start)))
  );
  assert.equal(queryResults.filter((result) => result.status === "fulfilled").length, 3);
  assert.equal(queryResults.filter((result) => result.status === "rejected").length, 9);
  assert.equal((await queryService.snapshot("tenant-a", iso(start))).rates.query.used, 3);

  const modelService = quotaService({
    maxActiveModelTasks: 2,
    monthlyModelRequests: 100,
    monthlyModelTokens: 1_000_000,
    defaultModelTaskReservationTokens: 1
  });
  const modelResults = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      modelService.startModelTask({
        tenantId: "tenant-a",
        taskId: `model-${index}`,
        at: iso(start)
      })
    )
  );
  assert.equal(modelResults.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(modelResults.filter((result) => result.status === "rejected").length, 6);
  assert.equal((await modelService.snapshot("tenant-a", iso(start))).active.modelTasks, 2);
});

test("model task reservations enforce concurrency and monthly use while completion stays idempotent", async () => {
  const service = quotaService({
    maxActiveModelTasks: 1,
    monthlyModelRequests: 2,
    monthlyModelTokens: 100,
    defaultModelTaskReservationTokens: 40
  });
  assert.equal(
    (
      await service.startModelTask({
        tenantId: "tenant-a",
        taskId: "model-1",
        at: iso(start)
      })
    ).outcome,
    "admitted"
  );
  assert.equal(
    (
      await service.startModelTask({
        tenantId: "tenant-a",
        taskId: "model-1",
        at: iso(start + 1)
      })
    ).outcome,
    "already_admitted"
  );
  await assert.rejects(
    service.startModelTask({ tenantId: "tenant-a", taskId: "model-2", at: iso(start + 2) }),
    quotaError("active_model_tasks")
  );
  const first = await service.finishModelTask({
    tenantId: "tenant-a",
    taskId: "model-1",
    inputTokens: 20,
    outputTokens: 10,
    cachedInputTokens: 5,
    at: iso(start + 3)
  });
  assert.deepEqual(modelCounts(first), {
    requests: 1,
    inputTokens: 20,
    outputTokens: 10,
    cachedInputTokens: 5,
    totalTokens: 30,
    reservedTokens: 0
  });
  const duplicate = await service.finishModelTask({
    tenantId: "tenant-a",
    taskId: "model-1",
    inputTokens: 20,
    outputTokens: 10,
    cachedInputTokens: 5,
    at: iso(start + 4)
  });
  assert.deepEqual(modelCounts(duplicate), modelCounts(first));
  await assert.rejects(
    service.finishModelTask({
      tenantId: "tenant-a",
      taskId: "model-1",
      inputTokens: 21,
      outputTokens: 10,
      at: iso(start + 5)
    }),
    (error: unknown) => error instanceof ContextQuotaInvariantError && error.reason === "reservation_conflict"
  );

  await service.startModelTask({
    tenantId: "tenant-a",
    taskId: "model-2",
    reservedTokens: 40,
    at: iso(start + 6)
  });
  const overage = await service.finishModelTask({
    tenantId: "tenant-a",
    taskId: "model-2",
    inputTokens: 60,
    outputTokens: 30,
    at: iso(start + 7)
  });
  assert.equal(overage.monthlyModel.requests, 2);
  assert.equal(overage.monthlyModel.totalTokens, 120);
  assert.equal(overage.monthlyModel.remainingTokens, 0);
  await assert.rejects(
    service.startModelTask({ tenantId: "tenant-a", taskId: "model-3", at: iso(start + 8) }),
    quotaError("monthly_model_requests")
  );

  const tokenService = quotaService({
    maxActiveModelTasks: 3,
    monthlyModelRequests: 10,
    monthlyModelTokens: 100,
    defaultModelTaskReservationTokens: 60
  });
  await tokenService.startModelTask({
    tenantId: "tenant-a",
    taskId: "token-1",
    at: iso(start)
  });
  await assert.rejects(
    tokenService.startModelTask({
      tenantId: "tenant-a",
      taskId: "token-2",
      reservedTokens: 41,
      at: iso(start + 1)
    }),
    quotaError("monthly_model_tokens")
  );
});

test("model attempt usage is exact across charged retries and canceled pre-model failures", async () => {
  const service = quotaService({
    maxActiveModelTasks: 2,
    monthlyModelRequests: 10,
    monthlyModelTokens: 10_000,
    defaultModelTaskReservationTokens: 100
  });
  const firstAttempt = "task-semantic:attempt:1";
  const secondAttempt = "task-semantic:attempt:2";
  const preModelAttempt = "task-before-model:attempt:1";
  const firstUsage = {
    inputTokens: 500,
    cachedInputTokens: 300,
    outputTokens: 50
  };
  const secondUsage = {
    inputTokens: 200,
    cachedInputTokens: 100,
    outputTokens: 25
  };

  await service.startModelTask({
    tenantId: "tenant-a",
    taskId: firstAttempt,
    at: iso(start)
  });
  const first = await service.finishModelTask({
    tenantId: "tenant-a",
    taskId: firstAttempt,
    ...firstUsage,
    at: iso(start + 1)
  });
  assert.equal(first.monthlyModel.totalTokens, 550);

  const replay = await service.finishModelTask({
    tenantId: "tenant-a",
    taskId: firstAttempt,
    ...firstUsage,
    at: iso(start + 2)
  });
  assert.deepEqual(modelCounts(replay), modelCounts(first));
  await assert.rejects(
    service.finishModelTask({
      tenantId: "tenant-a",
      taskId: firstAttempt,
      ...firstUsage,
      outputTokens: firstUsage.outputTokens + 1,
      at: iso(start + 3)
    }),
    (error: unknown) => error instanceof ContextQuotaInvariantError && error.reason === "reservation_conflict"
  );

  const retry = await service.startModelTask({
    tenantId: "tenant-a",
    taskId: secondAttempt,
    at: iso(start + 4)
  });
  assert.equal(retry.snapshot.active.modelTasks, 1);
  const second = await service.finishModelTask({
    tenantId: "tenant-a",
    taskId: secondAttempt,
    ...secondUsage,
    at: iso(start + 5)
  });
  assert.deepEqual(modelCounts(second), {
    requests: 2,
    inputTokens: 700,
    outputTokens: 75,
    cachedInputTokens: 400,
    totalTokens: 775,
    reservedTokens: 0
  });

  await service.startModelTask({
    tenantId: "tenant-a",
    taskId: preModelAttempt,
    at: iso(start + 6)
  });
  const canceled = await service.cancelModelTask({
    tenantId: "tenant-a",
    taskId: preModelAttempt,
    at: iso(start + 7)
  });
  assert.equal(canceled.active.modelTasks, 0);
  assert.equal(canceled.monthlyModel.requests, second.monthlyModel.requests + 1);
  assert.equal(canceled.monthlyModel.inputTokens, second.monthlyModel.inputTokens);
  assert.equal(canceled.monthlyModel.outputTokens, second.monthlyModel.outputTokens);
  assert.equal(canceled.monthlyModel.cachedInputTokens, second.monthlyModel.cachedInputTokens);
  assert.equal(canceled.monthlyModel.reservedTokens, 0);
});

test("artifact reservations account immutable bytes, expiry, idempotent commits, and erasure", async () => {
  const service = quotaService({
    artifactStorageBytes: 100,
    artifactReservationTtlMs: 1_000
  });
  const reserved = await service.reserveArtifactStorage({
    tenantId: "tenant-a",
    reservationId: "upload-1",
    artifactId: "artifact-1",
    bytes: 60,
    at: iso(start)
  });
  assert.equal(reserved.snapshot.storage.reservedBytes, 60);
  assert.equal(
    (
      await service.reserveArtifactStorage({
        tenantId: "tenant-a",
        reservationId: "upload-1",
        artifactId: "artifact-1",
        bytes: 60,
        at: iso(start + 1)
      })
    ).outcome,
    "already_admitted"
  );
  await assert.rejects(
    service.reserveArtifactStorage({
      tenantId: "tenant-a",
      reservationId: "upload-1-competing-digest",
      artifactId: "artifact-1",
      bytes: 60,
      at: iso(start + 1)
    }),
    (error: unknown) => error instanceof ContextQuotaInvariantError && error.reason === "reservation_conflict"
  );
  assert.equal((await service.snapshot("tenant-a", iso(start + 1))).storage.reservedBytes, 60);
  await assert.rejects(
    service.reserveArtifactStorage({
      tenantId: "tenant-a",
      reservationId: "upload-2",
      artifactId: "artifact-2",
      bytes: 41,
      at: iso(start + 2)
    }),
    quotaError("artifact_storage")
  );
  const committed = await service.commitArtifactStorage({
    tenantId: "tenant-a",
    reservationId: "upload-1",
    artifactId: "artifact-1",
    bytes: 60,
    at: iso(start + 3)
  });
  assert.equal(committed.storage.committedBytes, 60);
  assert.equal(committed.storage.reservedBytes, 0);
  assert.equal(committed.storage.artifactCount, 1);
  const alreadyCommitted = await service.reserveArtifactStorage({
    tenantId: "tenant-a",
    reservationId: "upload-retry",
    artifactId: "artifact-1",
    bytes: 60,
    at: iso(start + 4)
  });
  assert.equal(alreadyCommitted.outcome, "already_completed");
  await assert.rejects(
    service.reserveArtifactStorage({
      tenantId: "tenant-a",
      reservationId: "upload-conflict",
      artifactId: "artifact-1",
      bytes: 61,
      at: iso(start + 5)
    }),
    (error: unknown) => error instanceof ContextQuotaInvariantError && error.reason === "reservation_conflict"
  );
  const erased = await service.deleteArtifactStorage({
    tenantId: "tenant-a",
    operationId: "erase-1",
    artifactId: "artifact-1",
    at: iso(start + 6)
  });
  assert.equal(erased.storage.committedBytes, 0);
  assert.equal(
    (
      await service.deleteArtifactStorage({
        tenantId: "tenant-a",
        operationId: "erase-1",
        artifactId: "artifact-1",
        at: iso(start + 7)
      })
    ).storage.committedBytes,
    0
  );

  await service.reserveArtifactStorage({
    tenantId: "tenant-a",
    reservationId: "expiring-upload",
    artifactId: "artifact-expiring",
    bytes: 90,
    at: iso(start + 100)
  });
  const expired = await service.snapshot("tenant-a", iso(start + 1_101));
  assert.equal(expired.storage.reservedBytes, 0);
  await assert.rejects(
    service.commitArtifactStorage({
      tenantId: "tenant-a",
      reservationId: "expiring-upload",
      artifactId: "artifact-expiring",
      bytes: 90,
      at: iso(start + 1_102)
    }),
    (error: unknown) => error instanceof ContextQuotaInvariantError && error.reason === "reservation_not_found"
  );
});

test("tenant isolation is fail closed and observable snapshots expose counts without resource IDs", async () => {
  const store = new InMemoryContextQuotaStore();
  const service = quotaService({ maxActiveBuilds: 3 }, store);
  await service.admitBuild({
    tenantId: "tenant-a",
    buildId: "private-build-a",
    at: iso(start)
  });
  await service.admitBuild({
    tenantId: "tenant-b",
    buildId: "private-build-b",
    at: iso(start)
  });
  await assert.rejects(
    service.completeBuild({
      tenantId: "tenant-a",
      buildId: "private-build-b",
      at: iso(start + 1)
    }),
    (error: unknown) => error instanceof ContextQuotaInvariantError && error.reason === "reservation_not_found"
  );
  assert.equal((await service.snapshot("tenant-a", iso(start + 2))).active.builds, 1);
  const tenantB = await service.snapshot("tenant-b", iso(start + 2));
  assert.equal(tenantB.active.builds, 1);
  const publicJson = JSON.stringify(tenantB);
  assert.equal(publicJson.includes("private-build-a"), false);
  assert.equal(publicJson.includes("private-build-b"), false);

  const maliciousStore: ContextQuotaStore = {
    async transact<T>(
      _tenantId: string,
      operation: (current: ContextTenantQuotaLedger | undefined) => {
        readonly state: ContextTenantQuotaLedger;
        readonly result: T;
      }
    ): Promise<T> {
      const foreign = await ledgerFor("foreign-tenant");
      return operation(foreign).result;
    }
  };
  const failClosed = quotaService({}, maliciousStore);
  await assert.rejects(
    failClosed.snapshot("tenant-a", iso(start)),
    (error: unknown) => error instanceof ContextQuotaInvariantError && error.reason === "tenant_isolation"
  );

  const unavailableConfig = new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    resolveTenantLimits() {
      throw new Error("configuration backend offline");
    }
  });
  await assert.rejects(
    unavailableConfig.admitQuery(query("query-1", start)),
    (error: unknown) =>
      error instanceof ContextQuotaInvariantError &&
      error.reason === "tenant_isolation" &&
      error.message.includes("configuration is unavailable")
  );
});

test("quota defaults reject unsafe configuration", () => {
  assert.throws(
    () =>
      contextQuotaLimits({
        monthlyModelTokens: 100,
        defaultModelTaskReservationTokens: 101
      }),
    (error: unknown) => error instanceof ContextQuotaInvariantError && error.reason === "invalid_input"
  );
  assert.throws(
    () => contextQuotaLimits({ maxActiveBuilds: 0 }),
    (error: unknown) => error instanceof ContextQuotaInvariantError && error.reason === "invalid_input"
  );
});

function quotaService(
  defaults: Partial<ContextQuotaLimits>,
  store: ContextQuotaStore = new InMemoryContextQuotaStore()
): ContextQuotaService {
  return new ContextQuotaService({ store, defaults });
}

function query(requestId: string, at: number) {
  return { tenantId: "tenant-a", requestId, at: iso(at) };
}

function buildInput(buildId: string, at: number) {
  return { tenantId: "tenant-a", buildId, at: iso(at) };
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function quotaError(resource: ContextQuotaExceededError["resource"], retryAfterMs?: number) {
  return (error: unknown): boolean =>
    error instanceof ContextQuotaExceededError &&
    error.resource === resource &&
    (retryAfterMs === undefined || error.retryAfterMs === retryAfterMs);
}

function modelCounts(snapshot: ContextQuotaSnapshot) {
  return {
    requests: snapshot.monthlyModel.requests,
    inputTokens: snapshot.monthlyModel.inputTokens,
    outputTokens: snapshot.monthlyModel.outputTokens,
    cachedInputTokens: snapshot.monthlyModel.cachedInputTokens,
    totalTokens: snapshot.monthlyModel.totalTokens,
    reservedTokens: snapshot.monthlyModel.reservedTokens
  };
}

async function ledgerFor(tenantId: string): Promise<ContextTenantQuotaLedger> {
  const store = new InMemoryContextQuotaStore();
  const service = quotaService({}, store);
  await service.snapshot(tenantId, iso(start));
  let captured: ContextTenantQuotaLedger | undefined;
  await store.transact(tenantId, (state) => {
    captured = state;
    return { state: state!, result: undefined };
  });
  return captured!;
}
