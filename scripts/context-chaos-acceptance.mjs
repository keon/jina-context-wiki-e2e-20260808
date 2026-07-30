#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const SCHEMA_VERSION = "context-chaos-acceptance-v1";

const HELP = `Usage: context-chaos-acceptance.mjs [options]

Required:
  --report PATH       Retained mode-0600 JSON report

Optional:
  --proof-mode MODE   run (default) or manifest-only
  --timeout-ms N      Per proof/process timeout. Default: 120000

Environment:
  CONTEXT_CHAOS_REPORT       Alternative to --report
  TEST_DATABASE_URL          Enables the disposable PostgreSQL proof group

The runner never contacts or mutates production. It reuses named deterministic
tests, executes bounded isolated child-process/fake-service scenarios, and exits:
  0 when every case is proven,
  1 when a proof or scenario fails, and
  2 when one or more cases remain explicitly unsupported.
`;

const PROOF_GROUPS = Object.freeze({
  board: {
    command: process.execPath,
    args: ["--test", "packages/board/dist/board.test.js"],
    tests: [
      "deployment fencing invalidates every selected live lease without consuming an attempt",
      "outbox leases are tenant-filterable and reclaimable after expiry",
      "fenced retries preserve sibling checkpoints and requeue one bounded attempt idempotently"
    ]
  },
  apiBoard: {
    command: process.execPath,
    args: ["--test", "apps/api/dist/context-board-server.test.js", "apps/api/dist/context-board-runtime.test.js"],
    tests: [
      "generic worker completion atomically expands a context board graph and retains artifact references",
      "terminal context exhaustion commits worker receipts before failing the build and replays exactly",
      "transient Board failures retry with fresh fences, preserved siblings, and no quota leak",
      "board completions expand the research, publication, and page repair graph before transition",
      "terminal page audit finalization preserves the completed audit while failing its build",
      "terminal global gate finalization preserves the completing gate and cancels remaining descendants"
    ]
  },
  apiPublication: {
    command: process.execPath,
    args: ["--test", "apps/api/dist/context-board-publication.test.js"],
    tests: [
      "certified publication is exactly-once under an idempotent replay",
      "publication rejects a certification digest that does not bind the exact page bytes",
      "publication validates the complete page set and never commits a partially valid catalog",
      "a delayed older ref sequence cannot advance the current release",
      "the ref frontier is checked inside the transaction so a newer-ref race wins"
    ]
  },
  apiTokens: {
    command: process.execPath,
    args: ["--test", "apps/api/dist/api-tokens.test.js"],
    tests: [
      "HTTP and MCP expose the same repository ACL denial without cross-tenant oracles",
      "revocation is immediate, idempotent, and blind to other tenants",
      "an issued token revoked while retrieval is in flight cannot emit its result"
    ]
  },
  apiPostgresChaos: {
    command: process.execPath,
    args: ["--test", "--test-concurrency=1", "apps/api/dist/context-chaos-postgres.integration.test.js"],
    requiresDatabase: true,
    tests: [
      "PostgreSQL token revocation during tenant-scoped retrieval is rejected before response",
      "a worker crash before artifact upload preserves PostgreSQL state and a reclaimed lease clears durable model quota",
      "a worker crash after API-to-GCS upload resumes from PostgreSQL with immutable artifact and stale-fence safety",
      "API restart after the graph-expansion commit replays exactly once with one durable receipt"
    ]
  },
  workerCompletion: {
    command: process.execPath,
    args: ["--test", "apps/worker/dist/completion.test.js", "apps/worker/dist/diagnostics.test.js"],
    tests: [
      "a worker voluntarily releases a Context lease after renewal rejects it",
      "SIGTERM drains a delayed successful claim without executing it and releases its fence exactly once",
      "only transient provider, sandbox, model, and API transport failures retry"
    ]
  },
  workerPageIndex: {
    command: process.execPath,
    args: ["--test", "apps/worker/dist/board-pageindex.test.js"],
    tests: [
      "board PageIndex execution indexes every certified page with pinned source metadata",
      "board PageIndex execution rejects an incomplete certified-document tree",
      "board PageIndex execution rejects malformed hierarchy intervals and malformed worker JSON",
      "board PageIndex execution fails closed on timeout and source-version mismatch",
      "board PageIndex artifact bytes and digests are idempotent for the same certified release"
    ]
  },
  contextEngine: {
    command: process.execPath,
    args: [
      "--test",
      "packages/context-engine/dist/context-engine.test.js",
      "packages/context-engine/dist/context/catalog.test.js",
      "packages/context-engine/dist/ports/artifact-store.test.js",
      "packages/context-engine/dist/workflow/board.test.js",
      "packages/context-engine/dist/workflow/incremental.test.js"
    ],
    tests: [
      "canonical input frontier rejects an index that races evidence erasure",
      "query revalidates repository access after evidence assembly and before returning",
      "prepared releases are hidden from current and explicit release access",
      "local artifacts use tenant-scoped GCS-compatible keys and round-trip exact bytes",
      "bounded page repair exhaustion fails the page instead of scheduling an unbounded pass",
      "bounded global repair exhaustion cancels certification and all downstream publication",
      "prior seed parser rejects a cross-tenant release artifact key"
    ]
  },
  daytonaContracts: {
    command: process.execPath,
    args: ["--test", "packages/daytona/dist/local-agent-stages.test.js"],
    tests: [
      "critic results bind their worker and require gaps for non-passing tasks",
      "source challenges preserve existing ids and add distinct evidence-backed maintenance tasks",
      "material source challenges block publication until the worker, subject, and task are promoted",
      "final publication requires an unchanged digest-bound all-supported citation audit"
    ]
  },
  quality: {
    command: process.execPath,
    args: ["--test", "scripts/context-board-quality.test.mjs"],
    tests: [
      "fails hard when the latest critic stops using a published page",
      "rejects private orchestration files linked from a public page",
      "rejects a PageIndex tree that no longer represents the certified release"
    ]
  },
  gcsAdapter: {
    command: process.execPath,
    args: ["--test", "packages/db/dist/gcs-artifact-store.test.js"],
    tests: [
      "GCS artifacts bind canonical key, URI, generation, metadata, and exact bytes",
      "GCS idempotent replay verifies existing bytes instead of trusting custom metadata"
    ]
  },
  postgres: {
    command: process.execPath,
    args: ["--test", "--test-concurrency=1", "packages/db/dist/context-board.integration.test.js"],
    requiresDatabase: true,
    tests: [
      "Board publication, PageIndex attachment, citations, and tenant quotas survive a fresh Postgres round trip",
      "a newer admitted ref fences a prepared release before PageIndex can make it public",
      "evidence erasure invalidates a prepared Board release before PageIndex can publish it",
      "Board publication rejects citations erased before its authoritative transaction"
    ]
  }
});

const CHAOS_CASES = Object.freeze([
  {
    id: "worker_crash_before_artifact",
    requirement: "worker dies before any artifact",
    proofGroups: ["board", "workerCompletion", "apiPostgresChaos"],
    scenario: "crash_before_artifact"
  },
  {
    id: "worker_crash_after_artifact",
    requirement: "worker dies after artifact upload but before Board completion",
    proofGroups: ["board", "contextEngine", "apiPostgresChaos"],
    scenario: "crash_after_artifact"
  },
  {
    id: "completion_response_lost",
    requirement: "completion response is lost after the authoritative transaction",
    proofGroups: ["apiBoard"]
  },
  {
    id: "stale_lease_write",
    requirement: "an expired stale worker tries to upload or complete",
    proofGroups: ["board", "apiBoard"]
  },
  {
    id: "duplicate_worker_delivery",
    requirement: "two worker processes race to claim the same delivery",
    proofGroups: ["board", "apiBoard"],
    scenario: "duplicate_claim"
  },
  {
    id: "older_ref_finishes_late",
    requirement: "an older ref sequence finishes after a newer build",
    proofGroups: ["apiPublication", "postgres"]
  },
  {
    id: "api_restart_during_graph_expansion",
    requirement: "the API restarts during dynamic graph expansion",
    proofGroups: ["apiBoard", "apiPostgresChaos"]
  },
  {
    id: "gcs_outage",
    requirement: "GCS upload or read is unavailable and later recovers",
    proofGroups: ["gcsAdapter", "workerCompletion"],
    scenario: "gcs_outage"
  },
  {
    id: "postgres_transaction_rollback",
    requirement: "a PostgreSQL transaction rolls back after partial PageIndex work",
    proofGroups: ["postgres"]
  },
  {
    id: "immutable_artifact_collision",
    requirement: "an invalid or colliding immutable artifact write is attempted",
    proofGroups: ["contextEngine", "gcsAdapter"],
    scenario: "crash_after_artifact"
  },
  {
    id: "model_timeout_with_sibling",
    requirement: "one page model task times out while a sibling page completes",
    proofGroups: ["apiBoard", "workerCompletion"],
    scenario: "model_timeout_sibling"
  },
  {
    id: "repair_exhaustion",
    requirement: "page repair and global repair exhaust their bounded passes",
    proofGroups: ["contextEngine", "apiBoard"]
  },
  {
    id: "source_challenge_expansion",
    requirement: "a source challenge adds material work and blocks publication",
    proofGroups: ["daytonaContracts", "apiBoard"]
  },
  {
    id: "malformed_critic_gap",
    requirement: "a critic returns a malformed gap severity or unknown gap reference",
    proofGroups: ["daytonaContracts"]
  },
  {
    id: "certification_digest_mismatch",
    requirement: "certification sees mismatched page, task, or citation-audit bytes",
    proofGroups: ["apiPublication", "daytonaContracts", "quality"]
  },
  {
    id: "pageindex_fails_after_prepare",
    requirement: "publication prepares successfully and PageIndex fails before public-pointer advancement",
    proofGroups: ["contextEngine", "workerPageIndex", "postgres"]
  },
  {
    id: "malformed_pageindex",
    requirement: "PageIndex returns a malformed or incomplete tree",
    proofGroups: ["workerPageIndex"]
  },
  {
    id: "token_revoked_mid_retrieval",
    requirement: "a token is revoked between retrieval start and response",
    proofGroups: ["apiTokens", "contextEngine", "apiPostgresChaos"]
  },
  {
    id: "cross_tenant_direct_ids",
    requirement: "cross-tenant artifact or release IDs are supplied directly",
    proofGroups: ["apiTokens", "contextEngine", "apiBoard"]
  },
  {
    id: "erasure_races_publication",
    requirement: "erasure races an in-flight Board publication or PageIndex attachment",
    proofGroups: ["contextEngine", "postgres"]
  }
]);

const SCENARIOS = Object.freeze({
  crash_before_artifact: crashBeforeArtifactScenario,
  crash_after_artifact: crashAfterArtifactScenario,
  duplicate_claim: duplicateClaimScenario,
  gcs_outage: gcsOutageScenario,
  model_timeout_sibling: modelTimeoutSiblingScenario
});

export function contextChaosManifest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    cases: CHAOS_CASES.map((entry) => ({
      id: entry.id,
      requirement: entry.requirement,
      proofGroups: [...entry.proofGroups],
      ...(entry.scenario ? { scenario: entry.scenario } : {}),
      ...(entry.unsupported ? { unsupported: entry.unsupported } : {})
    })),
    proofGroups: Object.fromEntries(
      Object.entries(PROOF_GROUPS).map(([id, group]) => [
        id,
        {
          command: [group.command, ...group.args],
          tests: [...group.tests],
          ...(group.requiresDatabase ? { requiresDatabase: true } : {})
        }
      ])
    )
  };
}

export async function runContextChaosAcceptance(options = {}, dependencies = {}) {
  const config = normalizedOptions(options);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const proofRunner = dependencies.proofRunner ?? runProofGroup;
  const scenarioRunner = dependencies.scenarioRunner ?? runBuiltInChaosScenario;
  const proofResults = {};
  const scenarioResults = {};

  if (config.proofMode === "run") {
    for (const groupId of new Set(CHAOS_CASES.flatMap((entry) => entry.proofGroups))) {
      proofResults[groupId] = await proofRunner(groupId, PROOF_GROUPS[groupId], config);
    }
    for (const scenarioId of new Set(CHAOS_CASES.flatMap((entry) => (entry.scenario ? [entry.scenario] : [])))) {
      scenarioResults[scenarioId] = await scenarioRunner(scenarioId, config);
    }
  } else {
    for (const groupId of new Set(CHAOS_CASES.flatMap((entry) => entry.proofGroups))) {
      proofResults[groupId] = {
        id: groupId,
        status: "unsupported",
        tests: PROOF_GROUPS[groupId].tests,
        reason: "proof execution disabled by manifest-only mode"
      };
    }
    for (const scenarioId of new Set(CHAOS_CASES.flatMap((entry) => (entry.scenario ? [entry.scenario] : [])))) {
      scenarioResults[scenarioId] = {
        id: scenarioId,
        status: "unsupported",
        reason: "scenario execution disabled by manifest-only mode"
      };
    }
  }

  const cases = CHAOS_CASES.map((entry) => {
    const proofs = entry.proofGroups.map((id) => proofResults[id]);
    const scenario = entry.scenario ? scenarioResults[entry.scenario] : undefined;
    const failed = proofs.some((proof) => proof?.status === "failed") || scenario?.status === "failed";
    const unsupported =
      entry.unsupported ||
      proofs.some((proof) => proof?.status === "unsupported") ||
      scenario?.status === "unsupported";
    return {
      id: entry.id,
      requirement: entry.requirement,
      status: failed ? "failed" : unsupported ? "unsupported" : "passed",
      proofGroups: entry.proofGroups,
      ...(entry.scenario ? { scenario: entry.scenario } : {}),
      ...(entry.unsupported ? { remainingGap: entry.unsupported } : {})
    };
  });
  const failed = cases.filter((entry) => entry.status === "failed").length;
  const unsupported = cases.filter((entry) => entry.status === "unsupported").length;
  const finishedAt = now().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    status: failed > 0 ? "failed" : unsupported > 0 ? "incomplete" : "passed",
    startedAt,
    finishedAt,
    candidate: await candidateIdentity(dependencies),
    configuration: {
      proofMode: config.proofMode,
      timeoutMs: config.timeoutMs,
      productionMutationAllowed: false
    },
    summary: {
      total: cases.length,
      passed: cases.length - failed - unsupported,
      failed,
      unsupported
    },
    cases,
    proofResults,
    scenarioResults
  };
}

export async function runBuiltInChaosScenario(id, config = normalizedOptions({})) {
  const scenario = SCENARIOS[id];
  if (!scenario) {
    return { id, status: "unsupported", reason: `no isolated scenario is registered for ${id}` };
  }
  const started = performance.now();
  try {
    const evidence = await withTimeout(scenario(config), config.timeoutMs, `${id} scenario`);
    return {
      id,
      status: "passed",
      kind: id === "gcs_outage" ? "fake_service" : "isolated_process",
      durationMs: Math.round(performance.now() - started),
      evidence
    };
  } catch (error) {
    return {
      id,
      status: "failed",
      kind: id === "gcs_outage" ? "fake_service" : "isolated_process",
      durationMs: Math.round(performance.now() - started),
      reason: safeError(error)
    };
  }
}

async function runProofGroup(id, group, config) {
  if (group.requiresDatabase && !process.env.TEST_DATABASE_URL?.trim()) {
    return {
      id,
      status: "unsupported",
      tests: group.tests,
      reason: "TEST_DATABASE_URL is required; skipped PostgreSQL tests are never accepted as proof"
    };
  }
  const started = performance.now();
  const result = await runProcess(group.command, group.args, {
    cwd: WORKSPACE_ROOT,
    env: process.env,
    timeoutMs: config.timeoutMs
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  const skipped = [...combined.matchAll(/(?:^|\s)skipped\s+(\d+)/gim)].reduce(
    (total, match) => total + Number(match[1] ?? 0),
    0
  );
  const missingTests = group.tests.filter((name) => !combined.includes(name));
  const status =
    result.code === 0 && missingTests.length === 0 && (!group.requiresDatabase || skipped === 0) ? "passed" : "failed";
  return {
    id,
    status,
    command: [group.command, ...group.args],
    tests: group.tests,
    exitCode: result.code,
    signal: result.signal,
    durationMs: Math.round(performance.now() - started),
    skipped,
    missingTests,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    ...(status === "failed"
      ? {
          reason:
            group.requiresDatabase && skipped > 0
              ? `${skipped} PostgreSQL tests were skipped`
              : missingTests.length > 0
                ? `${missingTests.length} named proof tests were absent from test output`
                : result.timedOut
                  ? "proof command timed out"
                  : "proof command failed"
        }
      : {})
  };
}

async function crashBeforeArtifactScenario(config) {
  const board = await loadBoard();
  const fixture = singleTaskFixture(board, "crash-before");
  let state = fixture.state;
  let claimed;
  const claimReady = deferred();
  await withWorkerServer(
    async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/claim") {
        claimed = claimTask(board, state, fixture.taskId, "crashed-worker", "2026-01-01T00:00:01.000Z");
        state = claimed.state;
        claimReady.resolve();
        return json(response, 200, publicClaim(claimed));
      }
      if (url.pathname === "/hold") return;
      json(response, 404, { error: "not_found" });
    },
    async (baseUrl) => {
      const child = spawnFakeWorker(baseUrl, "hold");
      await withTimeout(claimReady.promise, config.timeoutMs, "worker claim");
      await killChild(child);
    }
  );
  const reclaimed = board.leaseNextOutboxMessage(state, {
    topics: ["run-chaos"],
    taskIds: [fixture.taskId],
    leaseId: "replacement-lease",
    writeFenceToken: "replacement-fence",
    now: "2026-01-01T00:10:00.000Z",
    expiresAt: "2026-01-01T00:20:00.000Z"
  });
  assert.ok(reclaimed, "expired crash lease was not reclaimable");
  assert.equal(reclaimed.message.id, claimed.message.id);
  assert.notEqual(reclaimed.message.leaseId, claimed.message.leaseId);
  assert.equal(
    board.renewOutboxLease(
      reclaimed.state,
      claimed.message.id,
      claimed.message.leaseId,
      claimed.message.writeFenceToken,
      "2026-01-01T00:10:01.000Z",
      "2026-01-01T00:20:01.000Z"
    ),
    undefined
  );
  return {
    childExit: "SIGKILL",
    reclaimedMessage: reclaimed.message.id,
    oldFenceRejected: true,
    artifactWrites: 0
  };
}

async function crashAfterArtifactScenario(config) {
  const board = await loadBoard();
  const { FileContextArtifactStore } = await import("../packages/context-engine/dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "jina-context-chaos-artifact-"));
  try {
    const store = new FileContextArtifactStore(root);
    const fixture = singleTaskFixture(board, "crash-after");
    const write = {
      tenantId: "tenant-chaos",
      repository: "acme/chaos",
      buildId: fixture.rootId,
      kind: "context-page",
      name: "page.json",
      contentType: "application/json",
      content: '{"page":"durable"}'
    };
    let state = fixture.state;
    let claimed;
    let uploaded;
    const artifactReady = deferred();
    await withWorkerServer(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/claim") {
          claimed = claimTask(board, state, fixture.taskId, "artifact-worker", "2026-01-01T00:00:01.000Z");
          state = claimed.state;
          return json(response, 200, publicClaim(claimed));
        }
        if (url.pathname === "/artifact" && request.method === "POST") {
          uploaded = await store.put(write);
          artifactReady.resolve();
          return json(response, 201, { artifact: uploaded });
        }
        if (url.pathname === "/hold") return;
        json(response, 404, { error: "not_found" });
      },
      async (baseUrl) => {
        const child = spawnFakeWorker(baseUrl, "upload-hold");
        await withTimeout(artifactReady.promise, config.timeoutMs, "artifact upload");
        await killChild(child);
      }
    );
    const reclaimed = board.leaseNextOutboxMessage(state, {
      topics: ["run-chaos"],
      taskIds: [fixture.taskId],
      leaseId: "replacement-artifact-lease",
      writeFenceToken: "replacement-artifact-fence",
      now: "2026-01-01T00:10:00.000Z",
      expiresAt: "2026-01-01T00:20:00.000Z"
    });
    assert.ok(reclaimed);
    const replay = await store.put(write);
    assert.deepEqual(replay, uploaded);
    await assert.rejects(store.put({ ...write, content: '{"page":"collision"}' }), /collision/);
    assert.equal(
      board.releaseOutboxLease(
        reclaimed.state,
        claimed.message.id,
        claimed.message.leaseId,
        claimed.message.writeFenceToken,
        "2026-01-01T00:10:01.000Z"
      ),
      undefined
    );
    return {
      childExit: "SIGKILL",
      artifactSha256: uploaded.sha256,
      exactReplay: true,
      collisionRejected: true,
      oldFenceRejected: true
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function duplicateClaimScenario(config) {
  const board = await loadBoard();
  const fixture = singleTaskFixture(board, "duplicate");
  let state = fixture.state;
  let sequence = 0;
  await withWorkerServer(
    async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/claim") return json(response, 404, { error: "not_found" });
      sequence += 1;
      const claim = board.leaseNextOutboxMessage(state, {
        topics: ["run-chaos"],
        taskIds: [fixture.taskId],
        leaseId: `duplicate-lease-${sequence}`,
        writeFenceToken: `duplicate-fence-${sequence}`,
        now: "2026-01-01T00:00:01.000Z",
        expiresAt: "2026-01-01T00:10:00.000Z"
      });
      if (!claim) {
        response.writeHead(204);
        return response.end();
      }
      state = claim.state;
      json(response, 200, publicClaim(claim));
    },
    async (baseUrl) => {
      const results = await Promise.all([
        runFakeWorker(baseUrl, "claim-only", config.timeoutMs),
        runFakeWorker(baseUrl, "claim-only", config.timeoutMs)
      ]);
      assert.deepEqual(
        results.map((entry) => Number(entry.stdout.trim())).sort((left, right) => left - right),
        [200, 204]
      );
    }
  );
  assert.equal(state.outbox.filter((message) => message.status === "leased").length, 1);
  return { workerProcesses: 2, successfulClaims: 1, emptyClaims: 1, leasedMessages: 1 };
}

async function modelTimeoutSiblingScenario(config) {
  const board = await loadBoard();
  const fixture = siblingTaskFixture(board, "model-timeout");
  let state = fixture.state;
  const claims = new Map();
  const timeoutClaimed = deferred();
  await withWorkerServer(
    async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/claim") {
        const taskId = url.searchParams.get("task");
        const claim = claimTask(board, state, taskId, `lease-${taskId}`, "2026-01-01T00:00:01.000Z");
        state = claim.state;
        claims.set(taskId, claim);
        if (taskId === fixture.timeoutTaskId) timeoutClaimed.resolve();
        return json(response, 200, publicClaim(claim));
      }
      if (url.pathname === "/complete" && request.method === "POST") {
        const taskId = url.searchParams.get("task");
        const claim = claims.get(taskId);
        state = board.transitionBoardTask(state, taskId, "done", "2026-01-01T00:00:02.000Z");
        state = board.markOutboxDispatched(state, claim.message.id, "2026-01-01T00:00:02.000Z");
        state = board.reduceBoard(state, "2026-01-01T00:00:02.000Z");
        return json(response, 200, { completed: true });
      }
      if (url.pathname === "/hold") return;
      json(response, 404, { error: "not_found" });
    },
    async (baseUrl) => {
      const timeoutChild = spawnFakeWorker(baseUrl, "hold", fixture.timeoutTaskId);
      await withTimeout(timeoutClaimed.promise, config.timeoutMs, "timeout page claim");
      const sibling = await runFakeWorker(baseUrl, "complete", config.timeoutMs, fixture.siblingTaskId);
      assert.equal(sibling.code, 0);
      await killChild(timeoutChild);
    }
  );
  const timedClaim = claims.get(fixture.timeoutTaskId);
  const retried = board.retryLeasedOutboxTask(state, {
    messageId: timedClaim.message.id,
    taskId: fixture.timeoutTaskId,
    leaseId: timedClaim.message.leaseId,
    writeFenceToken: timedClaim.message.writeFenceToken,
    attempt: 1,
    maxAttempts: 4,
    now: "2026-01-01T00:00:03.000Z",
    diagnostic: { category: "model", reason: "fake model deadline exceeded" }
  });
  assert.ok(retried);
  assert.equal(board.findTask(retried.state, fixture.siblingTaskId)?.status, "done");
  assert.equal(board.findTask(retried.state, fixture.timeoutTaskId)?.status, "queued");
  assert.equal(board.findTask(retried.state, fixture.timeoutTaskId)?.attempt, 2);
  return {
    timedWorkerExit: "SIGKILL",
    siblingStatus: "done",
    timedTaskStatus: "queued",
    nextAttempt: 2
  };
}

async function gcsOutageScenario() {
  const { GcsContextArtifactStore } = await import("../packages/db/dist/index.js");
  const objects = new Map();
  let mode = "write-outage";
  let generation = 0;
  const storage = {
    bucket() {
      return {
        file(key, options = {}) {
          const object = () => {
            const stored = objects.get(key);
            if (!stored || (options.generation && options.generation !== stored.metadata.generation)) {
              throw Object.assign(new Error("not found"), { code: 404 });
            }
            return stored;
          };
          return {
            async save(content, saveOptions) {
              if (mode === "write-outage") throw Object.assign(new Error("GCS unavailable"), { code: 503 });
              if (objects.has(key)) throw Object.assign(new Error("precondition"), { code: 412 });
              generation += 1;
              objects.set(key, {
                content: Buffer.from(content),
                metadata: {
                  generation: String(generation),
                  size: String(content.byteLength),
                  contentType: saveOptions.metadata.contentType,
                  customTime: saveOptions.metadata.customTime,
                  metadata: { ...saveOptions.metadata.metadata }
                }
              });
            },
            async getMetadata() {
              if (mode === "read-outage") throw Object.assign(new Error("GCS unavailable"), { code: 503 });
              return [{ ...object().metadata, metadata: { ...object().metadata.metadata } }];
            },
            async download() {
              if (mode === "read-outage") throw Object.assign(new Error("GCS unavailable"), { code: 503 });
              return [Buffer.from(object().content)];
            }
          };
        }
      };
    }
  };
  const store = new GcsContextArtifactStore("context-chaos-artifacts", { storage });
  const write = {
    tenantId: "tenant-chaos",
    repository: "acme/chaos",
    buildId: "task_chaos",
    kind: "context-page",
    name: "page.json",
    contentType: "application/json",
    content: '{"page":"gcs"}'
  };
  await assert.rejects(store.put(write), /GCS unavailable/);
  assert.equal(objects.size, 0);
  mode = "healthy";
  const ref = await store.put(write);
  mode = "read-outage";
  await assert.rejects(store.get(ref), /GCS unavailable/);
  mode = "healthy";
  assert.equal(Buffer.from(await store.get(ref)).toString("utf8"), write.content);
  return {
    writeOutageLeftObjects: 0,
    recoveredWriteSha256: ref.sha256,
    readOutageRejected: true,
    recoveredReadExact: true
  };
}

async function loadBoard() {
  return import("../packages/board/dist/index.js");
}

function singleTaskFixture(board, suffix) {
  const rootId = `task_chaos_root_${suffix}`;
  const taskId = `task_chaos_work_${suffix}`;
  let state = board.createEmptyBoardState();
  state = createTask(board, state, {
    id: rootId,
    type: "chaos-root",
    kind: "aggregate",
    title: "Chaos root",
    assigneeRole: "system",
    dedupeKey: `chaos:${suffix}:root`
  });
  state = createTask(board, state, {
    id: taskId,
    type: "chaos-work",
    kind: "dispatchable",
    title: "Chaos work",
    assigneeRole: "chaos-worker",
    dedupeKey: `chaos:${suffix}:work`,
    dispatchTopic: "run-chaos",
    parentTaskId: rootId
  });
  return {
    rootId,
    taskId,
    state: board.reduceBoard(state, "2026-01-01T00:00:00.000Z")
  };
}

function siblingTaskFixture(board, suffix) {
  const base = singleTaskFixture(board, suffix);
  const siblingTaskId = `task_chaos_sibling_${suffix}`;
  const state = board.reduceBoard(
    createTask(board, base.state, {
      id: siblingTaskId,
      type: "chaos-work",
      kind: "dispatchable",
      title: "Chaos sibling",
      assigneeRole: "chaos-worker",
      dedupeKey: `chaos:${suffix}:sibling`,
      dispatchTopic: "run-chaos",
      parentTaskId: base.rootId
    }),
    "2026-01-01T00:00:00.000Z"
  );
  return { state, rootId: base.rootId, timeoutTaskId: base.taskId, siblingTaskId };
}

function createTask(board, state, task) {
  return board.applyCommand(
    state,
    { command: "CreateTask", task },
    { actor: { type: "system", id: "context-chaos-acceptance" }, now: "2026-01-01T00:00:00.000Z" }
  ).state;
}

function claimTask(board, state, taskId, leaseId, now) {
  const claim = board.leaseNextOutboxMessage(state, {
    topics: ["run-chaos"],
    taskIds: [taskId],
    leaseId,
    writeFenceToken: `${leaseId}-fence`,
    now,
    expiresAt: "2026-01-01T00:05:00.000Z"
  });
  assert.ok(claim, `task ${taskId} was not claimable`);
  return {
    ...claim,
    state: board.transitionBoardTask(claim.state, taskId, "in_progress", now)
  };
}

function publicClaim(claim) {
  return {
    message: {
      id: claim.message.id,
      leaseId: claim.message.leaseId,
      writeFenceToken: claim.message.writeFenceToken,
      attempt: claim.message.payload.attempt
    },
    task: { id: claim.message.taskId }
  };
}

async function withWorkerServer(handler, operation) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) json(response, 500, { error: safeError(error) });
      else response.destroy(error);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await operation(baseUrl);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
}

const FAKE_WORKER_SOURCE = `
const [baseUrl, mode, task = ""] = process.argv.slice(1);
const taskQuery = task ? "?task=" + encodeURIComponent(task) : "";
const claim = await fetch(baseUrl + "/claim" + taskQuery, { method: "POST" });
if (mode === "claim-only") {
  process.stdout.write(String(claim.status));
  process.exit(0);
}
if (claim.status !== 200) throw new Error("claim failed: " + claim.status);
if (mode === "upload-hold") {
  const uploaded = await fetch(baseUrl + "/artifact", { method: "POST" });
  if (uploaded.status !== 201) throw new Error("artifact failed: " + uploaded.status);
}
if (mode === "complete") {
  const completed = await fetch(baseUrl + "/complete" + taskQuery, { method: "POST" });
  if (completed.status !== 200) throw new Error("completion failed: " + completed.status);
  process.exit(0);
}
await fetch(baseUrl + "/hold");
`;

function spawnFakeWorker(baseUrl, mode, task = "") {
  return spawn(process.execPath, ["--input-type=module", "--eval", FAKE_WORKER_SOURCE, baseUrl, mode, task], {
    cwd: WORKSPACE_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runFakeWorker(baseUrl, mode, timeoutMs, task = "") {
  const child = spawnFakeWorker(baseUrl, mode, task);
  return collectChild(child, timeoutMs);
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) =>
    child.once("exit", (code, signal) => resolvePromise({ code, signal }))
  );
  child.kill("SIGKILL");
  const result = await exited;
  assert.equal(result.signal, "SIGKILL");
}

function collectChild(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("fake worker timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function json(response, status, body) {
  const content = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(content) });
  response.end(content);
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function normalizedOptions(options) {
  const proofMode = options.proofMode ?? "run";
  if (!["run", "manifest-only"].includes(proofMode)) {
    throw new Error("proofMode must be run or manifest-only");
  }
  const timeoutMs = Number(options.timeoutMs ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new Error("timeoutMs must be an integer between 1000 and 900000");
  }
  return {
    proofMode,
    timeoutMs,
    reportPath: options.reportPath
  };
}

async function candidateIdentity(dependencies) {
  if (dependencies.candidateIdentity) return dependencies.candidateIdentity();
  const head = await runProcess("git", ["rev-parse", "HEAD"], {
    cwd: WORKSPACE_ROOT,
    env: process.env,
    timeoutMs: 10_000
  });
  const status = await runProcess("git", ["status", "--short"], {
    cwd: WORKSPACE_ROOT,
    env: process.env,
    timeoutMs: 10_000
  });
  return {
    head: head.code === 0 ? head.stdout.trim() : "unknown",
    dirty: status.code !== 0 || Boolean(status.stdout.trim()),
    statusSha256: sha256(status.stdout)
  };
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => (current + String(chunk)).slice(-MAX_COMMAND_OUTPUT_BYTES);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, signal, stdout, stderr, timedOut });
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:Bearer|token|secret|password|authorization)\s*[:=]?\s*\S+/gi, "[redacted]")
    .slice(0, 2_000);
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values[key] = value;
    index += 1;
  }
  return {
    reportPath: values.report ?? process.env.CONTEXT_CHAOS_REPORT,
    proofMode: values["proof-mode"] ?? "run",
    timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"])
  };
}

async function writeReport(path, report) {
  if (!path?.trim()) throw new Error("--report or CONTEXT_CHAOS_REPORT is required");
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(destination, 0o600);
  return destination;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    const report = await runContextChaosAcceptance(options);
    const destination = await writeReport(options.reportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`Retained Context chaos report: ${destination}\n`);
    if (report.status === "failed") process.exitCode = 1;
    else if (report.status === "incomplete") process.exitCode = 2;
  } catch (error) {
    const failed = {
      schemaVersion: SCHEMA_VERSION,
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: safeError(error)
    };
    if (options?.reportPath) await writeReport(options.reportPath, failed);
    process.stderr.write(`Context chaos acceptance failed: ${failed.error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
