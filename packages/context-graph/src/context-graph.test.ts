import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createContextGraph,
  isProblemEvidencePath,
  materializeRequiredCausalAssertions,
  materializeRequiredMoveAssertions,
  parseGeneratedContextGraph,
  requiredCausalAnchors,
  requiredMoveAnchors,
  sourceBackedModelEntityIds,
  validateContextGraphEvidence,
  validateRequiredCausalAssertions,
  validateRequiredDerivedIssues,
  validateRequiredMoveAssertions,
  validateSourceBackedModelEntities
} from "./model.js";
import { MemoryContextGraphStore } from "./store.js";
import {
  CONTEXT_GRAPH_GENERATOR_VERSION,
  CONTEXT_GRAPH_PARSER_VERSION,
  CONTEXT_GRAPH_REGISTRY_VERSION,
  assertionEvidenceFingerprint,
  assertionsFromGeneratedContextGraph,
  computeCommitChanges,
  derivedIssueNaturalKey,
  featureNaturalKey,
  movedFromSimilarityCandidates,
  selectAssertionFocusPaths
} from "./pipeline.js";
import { analyzeSourceBlob } from "./parser.js";
import { predicateDefinition, validatePredicateEndpoints, validateQualifiers } from "./registry.js";
import {
  RepositoryContextOrchestrator,
  classifyTemplates,
  extractCausalRootText,
  extractFeatureText,
  extractIssueText,
  extractRepositoryPath,
  extractSymbol,
  isCounterfactualQuestion,
  type RetrievalRequest
} from "./retrieval.js";
import {
  linkedIssueNumbers,
  normalizeGitHubSourceObservation,
  normalizeSourceObservation,
  parseIncidentDocument,
  parseIncidentDocumentObservations,
  parsePackageManifest,
  parseServiceDefinitions
} from "./normalizers.js";
import {
  buildCausalTrace,
  causalTraceItemsFromGraph,
  evaluateCounterfactual,
  type CausalTraceNode,
  type CausalTraceProjection
} from "./causal.js";
import { MemoryContextGraphPipelineCoordinator } from "./pipeline-coordinator.js";
import { CONTEXT_GRAPH_ASSERTION_OUTPUT_SCHEMA, CONTEXT_GRAPH_ASSERTION_SYSTEM_PROMPT } from "./schema.js";

test("assertion generation requires evidence-backed move continuity", () => {
  assert.match(CONTEXT_GRAPH_GENERATOR_VERSION, /codex-assertions-v22-agent-consolidation/);
  assert.equal(CONTEXT_GRAPH_ASSERTION_OUTPUT_SCHEMA.properties.nodes.maxItems, 128);
  assert.equal(CONTEXT_GRAPH_ASSERTION_OUTPUT_SCHEMA.properties.edges.maxItems, 256);
  assert.equal(CONTEXT_GRAPH_ASSERTION_OUTPUT_SCHEMA.properties.edges.items.properties.evidence.maxItems, 4);
  assert.match(
    CONTEXT_GRAPH_ASSERTION_SYSTEM_PROMPT,
    /explicitly states that a current File or Symbol moved or was renamed from a previous File or Symbol/
  );
  assert.match(CONTEXT_GRAPH_ASSERTION_SYSTEM_PROMPT, /emit current MOVED_FROM previous/);
  assert.match(CONTEXT_GRAPH_ASSERTION_SYSTEM_PROMPT, /final synthesis pass/);
  assert.match(CONTEXT_GRAPH_ASSERTION_SYSTEM_PROMPT, /exactly one edge per semantic identity/);
});

test("snapshot-first contextGraph builds require history assertions before projection", async () => {
  const coordinator = new MemoryContextGraphPipelineCoordinator();
  const createdAt = "2026-07-21T00:00:00.000Z";
  await coordinator.createBuild({
    tenantId: "tenant",
    repository: "omxyz/jina",
    ref: "main",
    requestKey: "build-1",
    snapshotFirst: true,
    createdAt
  });
  const metadata = {
    commitSha: "a".repeat(40),
    codeCheckpoint: "code",
    evidenceFingerprint: "evidence"
  };
  const claim = async (
    topic: "run-context-graph-ingest" | "run-context-graph-assert" | "run-context-graph-project",
    now: string
  ) => {
    const value = await coordinator.claim({
      tenantId: "tenant",
      workerId: "worker",
      topics: [topic],
      now,
      leaseExpiresAt: "2026-07-21T01:00:00.000Z"
    });
    assert.ok(value);
    return value;
  };
  const ingest = await claim("run-context-graph-ingest", "2026-07-21T00:01:00.000Z");
  assert.equal(ingest.task.metadata.pipelinePhase, "snapshot");
  assert.equal(
    await coordinator.complete({
      tenantId: "tenant",
      stageId: ingest.task.id,
      leaseId: ingest.message.leaseId,
      outcome: "done",
      now: "2026-07-21T00:02:00.000Z",
      nextMetadata: metadata
    }),
    true
  );
  const completedIngest = (await coordinator.list("tenant"))[0]!.stages.find(
    (stage) => stage.phase === "snapshot" && stage.stage === "ingest"
  );
  assert.deepEqual(
    {
      startedAt: completedIngest?.startedAt,
      completedAt: completedIngest?.completedAt,
      durationMs: completedIngest?.durationMs
    },
    { startedAt: "2026-07-21T00:01:00.000Z", completedAt: "2026-07-21T00:02:00.000Z", durationMs: 60_000 }
  );
  const ready = (await coordinator.list("tenant"))[0]!.stages.filter((stage) => stage.status === "queued");
  assert.deepEqual(
    ready.map((stage) => `${stage.phase}:${stage.stage}`),
    ["history:ingest"]
  );
  assert.equal(
    await coordinator.claim({
      tenantId: "tenant",
      workerId: "worker",
      topics: ["run-context-graph-project"],
      now: "2026-07-21T00:03:00.000Z",
      leaseExpiresAt: "2026-07-21T01:00:00.000Z"
    }),
    undefined
  );
  const history = await claim("run-context-graph-ingest", "2026-07-21T00:04:00.000Z");
  assert.equal(history.task.metadata.pipelinePhase, "history");
  assert.equal(
    await coordinator.complete({
      tenantId: "tenant",
      stageId: history.task.id,
      leaseId: history.message.leaseId,
      outcome: "done",
      now: "2026-07-21T00:05:00.000Z",
      nextMetadata: metadata
    }),
    true
  );
  const assertion = await claim("run-context-graph-assert", "2026-07-21T00:06:00.000Z");
  assert.equal(assertion.task.metadata.pipelinePhase, "history");
  assert.equal(assertion.task.metadata.commitSha, metadata.commitSha);
  assert.equal(
    await coordinator.complete({
      tenantId: "tenant",
      stageId: assertion.task.id,
      leaseId: assertion.message.leaseId,
      outcome: "done",
      now: "2026-07-21T00:07:00.000Z",
      nextMetadata: { commitSha: metadata.commitSha, knowledgeCheckpoint: "knowledge" }
    }),
    true
  );
  const projection = await claim("run-context-graph-project", "2026-07-21T00:08:00.000Z");
  assert.equal(projection.task.metadata.pipelinePhase, "history");
  assert.equal(projection.task.metadata.commitSha, metadata.commitSha);
  assert.equal(projection.task.metadata.knowledgeCheckpoint, "knowledge");
});

test("parser repair builds contain only a durable snapshot ingest stage", async () => {
  const coordinator = new MemoryContextGraphPipelineCoordinator();
  await coordinator.createBuild({
    tenantId: "tenant",
    repository: "omxyz/jina",
    ref: "a".repeat(40),
    requestKey: "parser-repair",
    snapshotFirst: true,
    createdAt: "2026-07-23T20:00:00.000Z",
    metadata: { repairOnly: true, githubInstallationId: 99 }
  });

  const workflow = (await coordinator.list("tenant"))[0]!;
  assert.equal(workflow.stages.length, 1);
  assert.deepEqual(
    workflow.stages.map((stage) => `${stage.phase}:${stage.stage}:${stage.status}`),
    ["snapshot:ingest:queued"]
  );
});

test("required stage failure cancels siblings that were already queued", async () => {
  const coordinator = new MemoryContextGraphPipelineCoordinator();
  await coordinator.createBuild({
    tenantId: "tenant",
    repository: "omxyz/jina",
    ref: "main",
    requestKey: "failure-reconciliation",
    snapshotFirst: true,
    createdAt: "2026-07-23T20:00:00.000Z"
  });
  const snapshotIngest = await coordinator.claim({
    tenantId: "tenant",
    workerId: "worker",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-23T20:00:01.000Z",
    leaseExpiresAt: "2026-07-23T20:10:01.000Z"
  });
  assert.ok(snapshotIngest);
  assert.equal(
    await coordinator.complete({
      tenantId: "tenant",
      stageId: snapshotIngest.task.id,
      leaseId: snapshotIngest.message.leaseId,
      outcome: "done",
      now: "2026-07-23T20:00:02.000Z"
    }),
    true
  );
  const historyIngest = await coordinator.claim({
    tenantId: "tenant",
    workerId: "worker",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-23T20:00:03.000Z",
    leaseExpiresAt: "2026-07-23T20:10:03.000Z"
  });
  assert.ok(historyIngest);
  assert.equal(historyIngest.task.metadata.pipelinePhase, "history");
  assert.equal(
    await coordinator.complete({
      tenantId: "tenant",
      stageId: historyIngest.task.id,
      leaseId: historyIngest.message.leaseId,
      outcome: "failed",
      reason: "upstream unavailable",
      now: "2026-07-23T20:00:04.000Z"
    }),
    true
  );

  const workflow = (await coordinator.list("tenant"))[0]!;
  assert.equal(workflow.build.status, "failed");
  assert.deepEqual(
    workflow.stages
      .filter((stage) => stage.phase === "history" && (stage.stage === "assert" || stage.stage === "project"))
      .map((stage) => `${stage.stage}:${stage.status}`)
      .sort(),
    ["assert:canceled", "project:canceled"]
  );
  assert.equal(
    workflow.stages.some((stage) => stage.status === "queued"),
    false
  );
});

test("new repository builds fence leases from superseded builds", async () => {
  const coordinator = new MemoryContextGraphPipelineCoordinator();
  const request = {
    tenantId: "tenant",
    repository: "omxyz/jina",
    ref: "main",
    snapshotFirst: false,
    createdAt: "2026-07-21T00:00:00.000Z"
  } as const;
  await coordinator.createBuild({ ...request, requestKey: "old" });
  const old = await coordinator.claim({
    tenantId: "tenant",
    workerId: "old-worker",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-21T00:01:00.000Z",
    leaseExpiresAt: "2026-07-21T01:00:00.000Z"
  });
  assert.ok(old);
  await coordinator.createBuild({ ...request, requestKey: "new", createdAt: "2026-07-21T00:02:00.000Z" });
  assert.equal(
    await coordinator.leasedStage({
      tenantId: "tenant",
      stageId: old.task.id,
      leaseId: old.message.leaseId,
      now: "2026-07-21T00:03:00.000Z"
    }),
    undefined
  );
  const next = await coordinator.claim({
    tenantId: "tenant",
    workerId: "new-worker",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-21T00:03:00.000Z",
    leaseExpiresAt: "2026-07-21T01:00:00.000Z"
  });
  assert.ok(next);
  assert.notEqual(next.task.id, old.task.id);
});

test("workers can release contextGraph leases for immediate task-board recovery", async () => {
  const coordinator = new MemoryContextGraphPipelineCoordinator();
  await coordinator.createBuild({
    tenantId: "tenant",
    repository: "omxyz/jina",
    ref: "main",
    requestKey: "release",
    snapshotFirst: true,
    createdAt: "2026-07-21T00:00:00.000Z"
  });
  const first = await coordinator.claim({
    tenantId: "tenant",
    workerId: "worker-1",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-21T00:01:00.000Z",
    leaseExpiresAt: "2026-07-21T01:00:00.000Z"
  });
  assert.ok(first);
  assert.equal(
    await coordinator.release({
      tenantId: "tenant",
      stageId: first.task.id,
      leaseId: first.message.leaseId,
      now: "2026-07-21T00:02:00.000Z",
      reason: "worker shutdown"
    }),
    true
  );
  const released = (await coordinator.list("tenant"))[0]!.stages.find((stage) => stage.id === first.task.id);
  assert.equal(released?.status, "queued");
  assert.deepEqual(
    { startedAt: released?.startedAt, completedAt: released?.completedAt, durationMs: released?.durationMs },
    { startedAt: undefined, completedAt: undefined, durationMs: undefined },
    "a released stage carries no stale timing while queued"
  );
  const releaseEvent = (await coordinator.listEvents("tenant", { taskIds: [first.task.id] }))
    .filter((event) => event.type === "task.transitioned" && event.payload.toStatus === "queued")
    .at(-1);
  assert.deepEqual(releaseEvent?.payload, {
    fromStatus: "in_progress",
    toStatus: "queued",
    reason: "worker shutdown",
    attempt: 1,
    startedAt: "2026-07-21T00:01:00.000Z",
    endedAt: "2026-07-21T00:02:00.000Z",
    durationMs: 60_000
  });
  const second = await coordinator.claim({
    tenantId: "tenant",
    workerId: "worker-2",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-21T00:03:00.000Z",
    leaseExpiresAt: "2026-07-21T01:03:00.000Z"
  });
  assert.ok(second);
  assert.equal(second.task.id, first.task.id);
  assert.notEqual(second.message.leaseId, first.message.leaseId);
  assert.equal(second.task.metadata.pipelinePhase, "snapshot");
});

test("expired contextGraph leases requeue without stale stage timing", async () => {
  const coordinator = new MemoryContextGraphPipelineCoordinator();
  await coordinator.createBuild({
    tenantId: "tenant",
    repository: "omxyz/jina",
    ref: "main",
    requestKey: "expiry",
    snapshotFirst: true,
    createdAt: "2026-07-21T00:00:00.000Z"
  });
  const first = await coordinator.claim({
    tenantId: "tenant",
    workerId: "worker-1",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-21T00:01:00.000Z",
    leaseExpiresAt: "2026-07-21T00:05:00.000Z"
  });
  assert.ok(first);
  // A claim for an unrelated topic after the lease deadline sweeps the expired
  // lease back to queued without immediately re-leasing the stage.
  assert.equal(
    await coordinator.claim({
      tenantId: "tenant",
      workerId: "worker-2",
      topics: ["run-context-graph-assert"],
      now: "2026-07-21T00:06:00.000Z",
      leaseExpiresAt: "2026-07-21T01:06:00.000Z"
    }),
    undefined
  );
  const requeued = (await coordinator.list("tenant"))[0]!.stages.find((stage) => stage.id === first.task.id);
  assert.equal(requeued?.status, "queued");
  assert.deepEqual(
    { startedAt: requeued?.startedAt, completedAt: requeued?.completedAt, durationMs: requeued?.durationMs },
    { startedAt: undefined, completedAt: undefined, durationMs: undefined },
    "an expiry-requeued stage carries no stale timing while queued"
  );
  // The interrupted attempt's timing is not discarded: the sweep records it
  // in a task.lease_expired board event before clearing the stage row.
  const expiryEvents = (await coordinator.listEvents("tenant", { taskIds: [first.task.id] })).filter(
    (event) => event.type === "task.lease_expired"
  );
  assert.equal(expiryEvents.length, 1);
  assert.equal(expiryEvents[0]?.at, "2026-07-21T00:06:00.000Z");
  assert.deepEqual(expiryEvents[0]?.payload, {
    fromStatus: "in_progress",
    toStatus: "queued",
    attempt: 1,
    workerId: "worker-1",
    startedAt: "2026-07-21T00:01:00.000Z",
    endedAt: "2026-07-21T00:06:00.000Z",
    durationMs: 300_000
  });
  const second = await coordinator.claim({
    tenantId: "tenant",
    workerId: "worker-2",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-21T00:07:00.000Z",
    leaseExpiresAt: "2026-07-21T01:07:00.000Z"
  });
  assert.ok(second);
  assert.equal(second.task.id, first.task.id);
});

test("expired contextGraph lease sweeps stay tenant-scoped", async () => {
  const coordinator = new MemoryContextGraphPipelineCoordinator();
  await coordinator.createBuild({
    tenantId: "tenant-a",
    repository: "omxyz/jina",
    ref: "main",
    requestKey: "expiry-a",
    snapshotFirst: true,
    createdAt: "2026-07-21T00:00:00.000Z"
  });
  const first = await coordinator.claim({
    tenantId: "tenant-a",
    workerId: "worker-a",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-21T00:01:00.000Z",
    leaseExpiresAt: "2026-07-21T00:05:00.000Z"
  });
  assert.ok(first);
  // A claim by another tenant after the lease deadline must not sweep tenant
  // A's expired lease back to queued, matching the Postgres coordinator.
  assert.equal(
    await coordinator.claim({
      tenantId: "tenant-b",
      workerId: "worker-b",
      topics: ["run-context-graph-ingest"],
      now: "2026-07-21T00:06:00.000Z",
      leaseExpiresAt: "2026-07-21T01:06:00.000Z"
    }),
    undefined
  );
  const untouched = (await coordinator.list("tenant-a"))[0]!.stages.find((stage) => stage.id === first.task.id);
  assert.equal(untouched?.status, "in_progress", "another tenant's claim leaves the expired lease untouched");
  // A same-tenant claim sweeps the expired lease and re-leases the stage.
  const second = await coordinator.claim({
    tenantId: "tenant-a",
    workerId: "worker-a2",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-21T00:07:00.000Z",
    leaseExpiresAt: "2026-07-21T01:07:00.000Z"
  });
  assert.ok(second);
  assert.equal(second.task.id, first.task.id);
  assert.notEqual(second.message.leaseId, first.message.leaseId);
});

test("shared workers claim case-variant repository stages across an explicit tenant set", async () => {
  const coordinator = new MemoryContextGraphPipelineCoordinator();
  await coordinator.createBuild({
    tenantId: "tenant-b",
    repository: "Omxyz/Jina",
    ref: "main",
    requestKey: "shared-claim",
    snapshotFirst: true,
    createdAt: "2026-07-21T00:00:00.000Z"
  });

  assert.equal(
    await coordinator.claim({
      tenantId: "tenant-a",
      tenantIds: ["tenant-a", "tenant-b"],
      repositoryScopes: [{ tenantId: "tenant-a", repository: "omxyz/jina" }],
      workerId: "shared-worker",
      topics: ["run-context-graph-ingest"],
      now: "2026-07-21T00:00:30.000Z",
      leaseExpiresAt: "2026-07-21T00:05:30.000Z"
    }),
    undefined
  );

  const claimed = await coordinator.claim({
    tenantId: "tenant-a",
    tenantIds: ["tenant-a", "tenant-b"],
    repositoryScopes: [{ tenantId: "tenant-b", repository: "omxyz/jina" }],
    workerId: "shared-worker",
    topics: ["run-context-graph-ingest"],
    now: "2026-07-21T00:01:00.000Z",
    leaseExpiresAt: "2026-07-21T00:06:00.000Z"
  });

  assert.ok(claimed);
  assert.equal(claimed.task.metadata.tenantId, "tenant-b");
});

test("pure structural parsing produces versioned symbols and imports", () => {
  const analysis = analyzeSourceBlob(
    "a".repeat(40),
    "typescript",
    'import { helper } from "./helper";\nexport function main() {}\n'
  );
  assert.equal(analysis.parserVersion, CONTEXT_GRAPH_PARSER_VERSION);
  assert.deepEqual(analysis.imports, [{ specifier: "./helper", line: 1 }]);
  assert.equal(analysis.symbols[0]?.name, "main");
  assert.equal(analysis.symbols[0]?.signatureHash.length, 64);
  assert.equal(
    analysis.edges.some((edge) => edge.kind === "imports" && edge.toMoniker === "module:./helper"),
    true
  );
});

test("computes first-parent additions, modifications, deletions, and exact renames", () => {
  const changes = computeCommitChanges(
    [
      { path: "renamed.ts", blobSha: "a", size: 1 },
      { path: "changed.ts", blobSha: "c", size: 1 },
      { path: "added.ts", blobSha: "d", size: 1 }
    ],
    [
      { path: "old.ts", blobSha: "a", size: 1 },
      { path: "changed.ts", blobSha: "b", size: 1 },
      { path: "deleted.ts", blobSha: "e", size: 1 }
    ]
  );
  assert.deepEqual(changes, [
    { path: "added.ts", change: "add", newBlobSha: "d" },
    { path: "changed.ts", change: "modify", oldBlobSha: "b", newBlobSha: "c" },
    { path: "deleted.ts", change: "delete", oldBlobSha: "e" },
    { path: "renamed.ts", change: "rename", oldPath: "old.ts", oldBlobSha: "a", newBlobSha: "a" }
  ]);
});

test("deterministic intake extracts direct packages and stable services", () => {
  const manifest = parsePackageManifest({
    tenantId: "t",
    repository: "org/repo",
    commitSha: "a".repeat(40),
    path: "package.json",
    source: JSON.stringify({ dependencies: { pg: "^8.0.0", zod: "4.0.0" }, devDependencies: { typescript: "latest" } }),
    recordedAt: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(
    manifest?.dependencies.map((dependency) => dependency.name),
    ["pg", "zod"]
  );
  const normalized = normalizeSourceObservation(manifest);
  assert.deepEqual(
    normalized.assertions.map((assertion) => [assertion.predicate, assertion.object.key]),
    [
      ["DEPENDS_ON", "package:npm:pg"],
      ["DEPENDS_ON", "package:npm:zod"]
    ]
  );
  const services = parseServiceDefinitions({
    tenantId: "t",
    repository: "org/repo",
    commitSha: "a".repeat(40),
    path: "compose.yaml",
    content: "services:\n  api:\n    image: api\n    depends_on:\n      - database\n  database:\n    image: postgres\n",
    recordedAt: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(
    services.map((service) => service.name),
    ["api", "database"]
  );
  assert.deepEqual(
    normalizeSourceObservation(services[0]!).assertions.map((assertion) => [
      assertion.predicate,
      assertion.object.displayName
    ]),
    [["DEPENDS_ON", "database"]]
  );
  const incident = parseIncidentDocument({
    tenantId: "t",
    repository: "org/repo",
    path: "docs/postmortems/INC-42.md",
    content:
      "---\nincident_id: INC-42\nservice: api\nservice_source: compose\nservice_external_id: org/repo:api\nissue: #7\n---\n# Administrator deletion outage\n",
    recordedAt: "2026-01-02T00:00:00Z"
  });
  assert.equal(incident?.title, "Administrator deletion outage");
  assert.equal(normalizeSourceObservation(incident).entities[0]?.key, "incident:github:org/repo#7");
  assert.deepEqual(
    normalizeSourceObservation(incident).assertions.map((assertion) => assertion.predicate),
    ["REFERENCES", "INCIDENT_IMPACTS"]
  );
  assert.deepEqual(normalizeSourceObservation({ ...manifest, dependencies: [], removed: true }).assertions, []);
  assert.deepEqual(normalizeSourceObservation({ ...services[0]!, removed: true }).assertions, []);
  assert.deepEqual(normalizeSourceObservation({ ...incident, removed: true }).assertions, []);
  const incidentObservations = parseIncidentDocumentObservations({
    tenantId: "t",
    repository: "org/repo",
    path: "docs/postmortems/INC-42.md",
    content: [
      "---",
      "incident_id: INC-42",
      "service: api",
      "service_source: compose",
      "service_external_id: org/repo:api",
      "issue: #7",
      "---",
      "# Administrator deletion outage",
      `Incident INC-42 was introduced by Deployment deployment:github:former/repo:101, which deployed commit ${"b".repeat(40)} to the api service.`,
      `Incident INC-42 was resolved by Deployment deployment:github:former/repo:102. That recovery deployment shipped commit ${"c".repeat(40)} to api.`
    ].join("\n"),
    recordedAt: "2026-01-02T00:00:00Z"
  });
  assert.deepEqual(
    incidentObservations.map((observation) =>
      observation.kind === "deployment"
        ? [observation.kind, observation.source, observation.externalId, observation.commitSha, observation.status]
        : [observation.kind, observation.externalId]
    ),
    [
      ["incident", "org/repo:inc-42"],
      ["deployment", "github", "former/repo:101", "b".repeat(40), "incident_source"],
      ["deployment", "github", "former/repo:102", "c".repeat(40), "incident_recovery"]
    ]
  );
  const pyproject = parsePackageManifest({
    tenantId: "t",
    repository: "org/repo",
    commitSha: "a".repeat(40),
    path: "pyproject.toml",
    source: '[project]\ndependencies = ["fastapi>=0.100", "uvicorn[standard]~=0.30"]\n',
    recordedAt: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(pyproject?.dependencies, [
    { name: "fastapi", version: ">=0.100" },
    { name: "uvicorn", version: "~=0.30" }
  ]);
  const cloudRun = parseServiceDefinitions({
    tenantId: "t",
    repository: "org/repo",
    commitSha: "a".repeat(40),
    path: "deploy/service.yaml",
    content: "apiVersion: serving.knative.dev/v1\nkind: Service\nmetadata:\n  name: api\n",
    recordedAt: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(
    cloudRun.map((service) => service.source),
    ["cloud-run"]
  );
  const dockerfile = parseServiceDefinitions({
    tenantId: "t",
    repository: "org/repo",
    commitSha: "a".repeat(40),
    path: "services/worker/Dockerfile",
    content: "FROM node:24\n",
    recordedAt: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(
    dockerfile.map((service) => [service.source, service.name]),
    [["dockerfile", "worker"]]
  );
  assert.deepEqual(
    parseServiceDefinitions({
      tenantId: "t",
      repository: "org/repo",
      commitSha: "a".repeat(40),
      path: "Dockerfile",
      content: "FROM node:24\n",
      recordedAt: "2026-01-01T00:00:00Z"
    }),
    []
  );
  const workflowService = parseServiceDefinitions({
    tenantId: "t",
    repository: "org/repo",
    commitSha: "a".repeat(40),
    path: ".github/workflows/deploy.yaml",
    content: "steps:\n  - run: gcloud run deploy atlas-api --image image\n",
    recordedAt: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(
    workflowService.map((service) => [service.source, service.name]),
    [["cloud-run", "atlas-api"]]
  );
});

test("model source-backed identities must resolve to deterministic evidence", () => {
  const evidence = [
    {
      id: "obs",
      source: "manifest",
      type: "source_snapshot",
      repository: "org/repo",
      payloadSha: "sha",
      payload: {
        kind: "package_manifest",
        repository: "org/repo",
        ecosystem: "npm",
        dependencies: [{ name: "zod" }]
      }
    },
    {
      id: "incident",
      source: "postmortem",
      type: "source_snapshot",
      repository: "org/repo",
      payloadSha: "sha2",
      payload: {
        kind: "incident",
        repository: "org/repo",
        source: "postmortem",
        externalId: "org/repo:inc-42",
        issueNumber: 7
      }
    }
  ];
  assert.deepEqual([...sourceBackedModelEntityIds(evidence)].sort(), ["incident:github:org/repo#7", "package:npm:zod"]);
  const base = {
    summary: "source-backed",
    nodes: [
      { id: "repo", kind: "Repository" as const, label: "repo", description: "repo", evidence: ["README.md:1"] },
      {
        id: "package:npm:zod",
        kind: "Package" as const,
        label: "zod",
        description: "zod",
        evidence: ["package.json:1"]
      }
    ],
    edges: []
  };
  assert.doesNotThrow(() => validateSourceBackedModelEntities(base, evidence));
  assert.throws(
    () =>
      validateSourceBackedModelEntities(
        {
          ...base,
          nodes: [
            ...base.nodes,
            {
              id: "service:model:invented",
              kind: "Service" as const,
              label: "invented",
              description: "invented",
              evidence: ["README.md:1"]
            }
          ]
        },
        evidence
      ),
    /not anchored by deterministic source evidence/
  );
});

test("rename similarity creates review candidates instead of active facts", () => {
  const oldBlob = "a".repeat(40);
  const newBlob = "b".repeat(40);
  const candidates = movedFromSimilarityCandidates(
    [
      { path: "src/old-auth.ts", change: "delete", oldBlobSha: oldBlob },
      { path: "src/authz.ts", change: "add", newBlobSha: newBlob }
    ],
    new Map([
      [
        oldBlob,
        {
          blobSha: oldBlob,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          symbols: [
            { moniker: "old", name: "authorize", kind: "function", signatureHash: "sig", startLine: 1, endLine: 3 }
          ],
          imports: [],
          edges: []
        }
      ],
      [
        newBlob,
        {
          blobSha: newBlob,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          symbols: [
            { moniker: "new", name: "authorize", kind: "function", signatureHash: "sig", startLine: 1, endLine: 3 }
          ],
          imports: [],
          edges: []
        }
      ]
    ])
  );
  assert.deepEqual(candidates, [
    { oldPath: "src/old-auth.ts", newPath: "src/authz.ts", similarity: 1, matchingSignatureHashes: ["sig"] }
  ]);
  assert.deepEqual(
    movedFromSimilarityCandidates(
      [
        { path: "src/authz.ts", oldPath: "src/old-auth.ts", change: "rename", oldBlobSha: oldBlob, newBlobSha: oldBlob }
      ],
      new Map([
        [
          oldBlob,
          {
            blobSha: oldBlob,
            parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
            symbols: [
              { moniker: "old", name: "authorize", kind: "function", signatureHash: "sig", startLine: 1, endLine: 3 }
            ],
            imports: [],
            edges: []
          }
        ]
      ])
    ),
    [{ oldPath: "src/old-auth.ts", newPath: "src/authz.ts", similarity: 1, matchingSignatureHashes: ["sig"] }]
  );
});

test("generic causal traces preserve alternative causes and evaluate interventions", () => {
  const repository = "org/repo";
  const root = {
    id: "issue",
    kind: "Issue" as const,
    label: "Administrators cannot delete resources",
    description: "Issue #123",
    evidence: ["incident.md:1"]
  };
  const graph = {
    id: "graph",
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "f".repeat(40),
    generatedAt: "2026-01-01T00:00:00Z",
    generator: { executor: "projection" as const, model: "test" },
    summary: "causal fixture",
    nodes: [
      root,
      {
        id: "c3",
        kind: "Commit" as const,
        label: "3".repeat(40),
        description: "3".repeat(40),
        evidence: ["incident.md:2"]
      },
      {
        id: "c4",
        kind: "Commit" as const,
        label: "4".repeat(40),
        description: "4".repeat(40),
        evidence: ["incident.md:3"]
      },
      {
        id: "pr3",
        kind: "PullRequest" as const,
        label: "PR #3",
        description: "github:pr:org/repo#3",
        evidence: ["incident.md:2"]
      },
      {
        id: "pr4",
        kind: "PullRequest" as const,
        label: "PR #4",
        description: "github:pr:org/repo#4",
        evidence: ["incident.md:3"]
      }
    ],
    edges: [
      {
        id: "cause3",
        source: "issue",
        target: "c3",
        predicate: "INTRODUCED_BY",
        plane: "knowledge" as const,
        why: "removed the administrator bypass",
        evidence: ["assertion:cause3", "incident.md:1-2"]
      },
      {
        id: "cause4",
        source: "issue",
        target: "c4",
        predicate: "INTRODUCED_BY",
        plane: "knowledge" as const,
        why: "also denied inherited administrators",
        evidence: ["assertion:cause4", "incident.md:1-3"]
      },
      {
        id: "include3",
        source: "pr3",
        target: "c3",
        predicate: "INCLUDES",
        plane: "knowledge" as const,
        evidence: ["observation:pr3"]
      },
      {
        id: "include4",
        source: "pr4",
        target: "c4",
        predicate: "INCLUDES",
        plane: "knowledge" as const,
        evidence: ["observation:pr4"]
      }
    ]
  };
  const trace = buildCausalTrace(graph, root);
  assert.equal(trace.causes.length, 2);
  const result = evaluateCounterfactual(trace, "If PR #3 had not merged, would the deletion issue exist?");
  assert.equal(result.removedPaths.length, 1);
  assert.equal(result.remainingPaths.length, 1);
  assert.match(result.answer, /alternative known path remains/);
  assert.equal(result.basis, "graph-derived");
});

test("resolves projected derived issues as causal roots through their canonical description", () => {
  const repository = "org/repo";
  const graph = {
    id: "graph",
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "f".repeat(40),
    generatedAt: "2026-01-01T00:00:00Z",
    generator: { executor: "projection" as const, model: "test" },
    summary: "derived issue fixture",
    nodes: [
      {
        id: "entity:node-derived",
        kind: "Issue" as const,
        label: "Audit exports are not chronological",
        description: "derived:issue:org/repo:candidate_11",
        evidence: ["assertion:issue"]
      },
      {
        id: "entity:node-pr",
        kind: "PullRequest" as const,
        label: "PR #11",
        description: "github:pr:org/repo#11",
        evidence: ["observation:pr11"]
      }
    ],
    edges: [
      {
        id: "resolution",
        source: "entity:node-derived",
        target: "entity:node-pr",
        predicate: "RESOLVED_BY",
        plane: "knowledge" as const,
        why: "PR #11 repairs the documented untracked regression.",
        evidence: ["assertion:resolution"]
      }
    ]
  };
  const items = causalTraceItemsFromGraph(graph, {
    tenantId: "t",
    allowedRepositories: [repository],
    repository,
    template: "causal_trace",
    query: "Show the derived issue for the unlinked fix"
  });
  assert.equal(items[0]?.title, "Issue: Audit exports are not chronological");
  assert.equal(items[0]?.citations.length, 2);
  assert.equal(
    (items[0]?.data.resolutions as { nodes: { kind: string; label: string }[] }[])[0]?.nodes.some(
      (node) => node.kind === "PullRequest" && node.label === "PR #11"
    ),
    true
  );
});

test("selects bounded assertion focus across newly ingested commits", () => {
  const current = new Set(["src/latest.ts", "docs/root-cause.md", "src/older.ts", "tests/regression.test.ts"]);
  assert.deepEqual(
    selectAssertionFocusPaths(
      ["src/latest.ts"],
      ["src/older.ts", "docs/root-cause.md", "tests/regression.test.ts", "src/deleted.ts"],
      current,
      3
    ),
    ["src/latest.ts", "docs/root-cause.md", "tests/regression.test.ts"]
  );
  const checkpoint = "code-checkpoint";
  assert.equal(
    assertionEvidenceFingerprint(checkpoint, [], { focusPaths: ["b.ts", "a.ts"] }),
    assertionEvidenceFingerprint(checkpoint, [], { focusPaths: ["a.ts", "b.ts"] })
  );
  assert.notEqual(
    assertionEvidenceFingerprint(checkpoint, [], { focusPaths: ["a.ts"] }),
    assertionEvidenceFingerprint(checkpoint, [], { focusPaths: ["b.ts"] })
  );
});

test("recognizes explicit problem evidence paths without matching incidental substrings", () => {
  for (const path of [
    "docs/root-cause.md",
    "incidents/2026-07-delete.md",
    "docs/bug-report-delete.md",
    "tests/delete.regression-test.ts",
    "src/delete.spec.ts"
  ])
    assert.equal(isProblemEvidencePath(path), true, path);
  for (const path of ["src/debugger.ts", "src/bugfix.ts", "metrics/regression_metrics.ts"])
    assert.equal(isProblemEvidencePath(path), false, path);
});

test("a new model contract confirms rather than overwrites an active assertion", async () => {
  const store = new MemoryContextGraphStore();
  const common = {
    tenantId: "tenant",
    repository: "omxyz/demo",
    ref: "main",
    commitSha: "a".repeat(40),
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint: "same-input",
    evidenceObservationIds: [],
    model: "fixture",
    summary: "README documents the repository",
    rawOutput: { summary: "fixture", nodes: [], edges: [] },
    assertions: [
      {
        subject: { kind: "Repository" as const, naturalKey: "github:repo:omxyz/demo", label: "demo" },
        predicate: "DOCUMENTED_BY",
        object: { kind: "Document" as const, naturalKey: "repo:omxyz/demo:path:README.md", label: "README" },
        confidence: 0.95,
        explanation: "The README explicitly documents this repository.",
        evidence: ["README.md:1"]
      }
    ]
  };
  await store.saveAssertionBatch({
    ...common,
    taskId: "v1",
    generatedAt: "2026-07-20T00:00:00Z",
    generatorVersion: "model-v1"
  });
  const [proposal] = await store.listAssertions("tenant", "omxyz/demo");
  assert.ok(proposal);
  assert.equal(proposal.status, "active");
  await store.saveAssertionBatch({
    ...common,
    taskId: "v2",
    generatedAt: "2026-07-20T00:01:00Z",
    generatorVersion: "model-v2",
    evidenceFingerprint: "updated-input"
  });
  const assertions = await store.listAssertions("tenant", "omxyz/demo");
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0]?.generator, "model:model-v1");
  assert.equal(assertions[0]?.status, "active");
});

test("memory operational metrics exclude assertions outside the requested ref", async () => {
  const store = new MemoryContextGraphStore();
  await store.saveAssertionBatch({
    tenantId: "tenant",
    repository: "omxyz/demo",
    ref: "main",
    commitSha: "a".repeat(40),
    taskId: "metrics-ref",
    generatedAt: "2026-07-20T00:00:00Z",
    generatorVersion: "model-v1",
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint: "metrics-ref-input",
    evidenceObservationIds: [],
    model: "fixture",
    summary: "README documents the repository",
    rawOutput: { summary: "fixture", nodes: [], edges: [] },
    assertions: [
      {
        subject: { kind: "Repository", naturalKey: "github:repo:omxyz/demo", label: "demo" },
        predicate: "DOCUMENTED_BY",
        object: { kind: "Document", naturalKey: "repo:omxyz/demo:path:README.md", label: "README" },
        confidence: 0.95,
        explanation: "The README explicitly documents this repository.",
        evidence: ["README.md:1"]
      }
    ]
  });

  const unscoped = await store.operationalMetrics("tenant");
  const otherRef = await store.operationalMetrics("tenant", undefined, {
    repository: "omxyz/demo",
    ref: "release"
  });
  assert.equal(unscoped.proposedAssertionCount, 0);
  assert.equal(otherRef.proposedAssertionCount, 0);
  assert.equal(otherRef.unexplainedAssertionCount, 0);
});

test("does not reuse a live model assertion across repositories in the same tenant", async () => {
  const store = new MemoryContextGraphStore();
  const batch = (repository: string, evidenceFingerprint: string) => ({
    tenantId: "shared-tenant",
    repository,
    ref: "main",
    commitSha: "a".repeat(40),
    taskId: `assert-${repository}`,
    generatedAt: "2026-07-21T00:00:00.000Z",
    generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint,
    evidenceObservationIds: [],
    model: "fixture",
    summary: "shared-looking assertion",
    rawOutput: { summary: "fixture", nodes: [], edges: [] },
    assertions: [
      {
        subject: { kind: "Issue" as const, naturalKey: "external:issue:1", label: "Issue" },
        predicate: "INTRODUCED_BY",
        object: { kind: "Commit" as const, naturalKey: `repo:shared:sha:${"a".repeat(40)}`, label: "Commit" },
        confidence: 0.9,
        explanation: "Same natural key",
        evidence: ["src/app.ts:1"],
        qualifiers: { reason: "Same natural key" }
      }
    ]
  });
  await store.saveAssertionBatch(batch("org/one", "one"));
  await store.saveAssertionBatch(batch("org/two", "two"));
  assert.equal((await store.listAssertions("shared-tenant", "org/one")).length, 1);
  assert.equal((await store.listAssertions("shared-tenant", "org/two"))[0]?.repository, "org/two");
});

test("consolidates causal prose variants into one semantic knowledge edge", async () => {
  const store = new MemoryContextGraphStore();
  const tenantId = "qualified-tenant";
  const repository = "org/qualified";
  const commitSha = "b".repeat(40);
  await store.planIngestion({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    treeSha: "c".repeat(40),
    parents: [],
    updateRef: true,
    recordedAt: "2026-07-21T00:00:00.000Z",
    taskId: "qualified-ingest",
    files: [{ path: "docs/root-cause.md", blobSha: "d".repeat(40), size: 20 }]
  });
  await store.saveAssertionBatch({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    taskId: "qualified-assert",
    generatedAt: "2026-07-21T00:01:00.000Z",
    generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint: "qualified",
    evidenceObservationIds: [],
    model: "fixture",
    summary: "Two independently qualified causal claims",
    rawOutput: { summary: "fixture", nodes: [], edges: [] },
    assertions: ["First mechanism", "Second mechanism"].map((reason, index) => ({
      subject: { kind: "Issue" as const, naturalKey: `github:issue:${repository}#1`, label: "Issue #1" },
      predicate: "INTRODUCED_BY",
      object: {
        kind: "Commit" as const,
        naturalKey: `repo:${repository}:sha:${commitSha}`,
        label: commitSha.slice(0, 12)
      },
      confidence: 0.9 + index * 0.05,
      explanation: reason,
      evidence: [`docs/root-cause.md:${index + 1}`],
      qualifiers: { reason }
    }))
  });
  const [assertion] = await store.listAssertions(tenantId, repository);
  assert.equal((await store.listAssertions(tenantId, repository)).length, 1);
  assert.ok(Math.abs((assertion?.confidence ?? 0) - 0.95) < Number.EPSILON);
  assert.deepEqual(assertion?.evidence, ["docs/root-cause.md:1", "docs/root-cause.md:2"]);
  const graph = await store.project({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    taskId: "qualified-project",
    generatedAt: "2026-07-21T00:03:00.000Z"
  });
  const causes = graph.edges.filter((edge) => edge.predicate === "INTRODUCED_BY");
  assert.equal(causes.length, 1);
});

test("memory assertion dedup never reuses another tenant's assertion", async () => {
  const store = new MemoryContextGraphStore();
  const batch = (tenantId: string) => ({
    tenantId,
    repository: "omxyz/shared-name",
    ref: "main",
    commitSha: "b".repeat(40),
    taskId: `task-${tenantId}`,
    generatedAt: "2026-07-20T00:00:00Z",
    generatorVersion: "model-v1",
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint: `evidence-${tenantId}`,
    evidenceObservationIds: [],
    model: "fixture",
    summary: "README documents the repository",
    rawOutput: { summary: "fixture", nodes: [], edges: [] },
    assertions: [
      {
        subject: { kind: "Repository" as const, naturalKey: "github:repo:omxyz/shared-name", label: "shared-name" },
        predicate: "DOCUMENTED_BY",
        object: {
          kind: "Document" as const,
          naturalKey: "repo:omxyz/shared-name:path:README.md",
          label: "README"
        },
        confidence: 0.95,
        explanation: "The README explicitly documents this repository.",
        evidence: ["README.md:1"]
      }
    ]
  });
  await store.saveAssertionBatch(batch("tenant-a"));
  await store.saveAssertionBatch(batch("tenant-b"));
  const tenantAAssertions = await store.listAssertions("tenant-a", "omxyz/shared-name");
  const tenantBAssertions = await store.listAssertions("tenant-b", "omxyz/shared-name");
  assert.equal(tenantAAssertions.length, 1);
  assert.equal(tenantBAssertions.length, 1);
  const [tenantA] = tenantAAssertions;
  const [tenantB] = tenantBAssertions;
  assert.notEqual(tenantA?.id, tenantB?.id);
});

test("registry validates endpoints and qualifier keys while causal prose remains optional", () => {
  const ownership = predicateDefinition("owned-by");
  validatePredicateEndpoints(ownership, "File", "Team");
  validateQualifiers(ownership, { pattern: "src/**" });
  assert.equal(ownership.review, "manual");
  const causality = predicateDefinition("INTRODUCED_BY");
  validateQualifiers(causality, { reason: "the null branch bypassed authorization" });
  validateQualifiers(causality);
  assert.throws(() => validateQualifiers(ownership, { branch: "main" }), /does not declare qualifier branch/);
  assert.throws(
    () => validatePredicateEndpoints(predicateDefinition("INCLUDES"), "Issue", "Commit"),
    /subject kind Issue/
  );
  validatePredicateEndpoints(predicateDefinition("DEPENDS_ON"), "Service", "Package");
  validatePredicateEndpoints(predicateDefinition("DEPLOYS"), "Deployment", "Commit");
  validatePredicateEndpoints(predicateDefinition("TARGETS"), "Deployment", "Service");
  validatePredicateEndpoints(predicateDefinition("INCIDENT_IMPACTS"), "Incident", "Feature");
  validatePredicateEndpoints(predicateDefinition("RESOLVED_BY"), "Issue", "PullRequest");
});

test("orchestrator composes only fixed cited retrieval templates", async () => {
  assert.deepEqual(classifyTemplates("What changed in this PR, what might break, and who owns it?"), [
    "change",
    "ownership"
  ]);
  assert.deepEqual(classifyTemplates("Which PR and commit resolved issue #7?"), ["issue_trace"]);
  assert.deepEqual(classifyTemplates(`Which issue did commit ${"a".repeat(40)} cause, and why?`), ["issue_trace"]);
  assert.deepEqual(classifyTemplates("Which issue did PR #42 introduce?"), ["issue_trace"]);
  assert.deepEqual(classifyTemplates("Which issue did PR #11 resolve?"), ["issue_trace"]);
  assert.deepEqual(classifyTemplates("What issue was derived for the unlinked fixing PR #11?"), ["causal_trace"]);
  assert.deepEqual(classifyTemplates('Which PR or commit caused "Administrators cannot delete resources"?'), [
    "issue_trace"
  ]);
  assert.deepEqual(classifyTemplates("When did the problem Administrators cannot delete resources first start?"), [
    "issue_trace"
  ]);
  assert.deepEqual(classifyTemplates("What changed in PR #5?"), ["change"]);
  assert.deepEqual(classifyTemplates("Which PR explains why src/auth.ts exists?"), ["intent"]);
  assert.equal(
    extractIssueText("What caused “Administrators   cannot delete resources”?"),
    "Administrators cannot delete resources"
  );
  assert.equal(
    extractIssueText("Which PR or commit caused Administrators cannot delete resources, and why?"),
    "Administrators cannot delete resources"
  );
  assert.equal(
    extractIssueText("which caused Administrators cannot delete resources issue?"),
    "Administrators cannot delete resources"
  );
  assert.equal(
    extractIssueText("When did the problem Administrators cannot delete resources first start?"),
    "Administrators cannot delete resources"
  );
  assert.equal(extractRepositoryPath("Why was src/access-policy.ts changed?"), "src/access-policy.ts");
  assert.equal(extractSymbol("Where is authorize implemented and what calls it?"), "authorize");
  const called: string[] = [];
  const issueTexts: (string | undefined)[] = [];
  const issueEntityIds: (string | undefined)[] = [];
  const symbols: (string | undefined)[] = [];
  const paths: (string | undefined)[] = [];
  const orchestrator = new RepositoryContextOrchestrator({
    async retrieve(request) {
      called.push(request.template);
      issueTexts.push(request.issueText);
      issueEntityIds.push(request.issueEntityId);
      symbols.push(request.symbol);
      paths.push(request.path);
      return {
        template: request.template,
        repository: request.repository,
        ref: request.ref ?? "main",
        truncated: false,
        totalBeforeLimit: 1,
        limit: request.limit ?? 50,
        items: [
          {
            kind: "fixture",
            title: request.template,
            data: {},
            score: 1,
            citations: [
              {
                kind: "code",
                id: `${request.template}:1`,
                repository: request.repository,
                path: "src/a.ts",
                startLine: 1,
                endLine: 1
              }
            ]
          }
        ]
      };
    }
  });
  const context = await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "what changed and who owns it?"
  });
  assert.deepEqual(called, ["change", "ownership"]);
  assert.equal(context.citations.length, 2);
  assert.match(context.answer, /cited change set/i);
  assert.equal(context.citedClaims.length, 2);

  const concise = await new RepositoryContextOrchestrator({
    async retrieve(request) {
      return {
        template: request.template,
        repository: request.repository,
        ref: "main",
        truncated: false,
        totalBeforeLimit: 3,
        limit: 50,
        items: [
          {
            kind: "change",
            title: "modify src/a.ts",
            data: { change: "modify", newBlobSha: "blob-a" },
            score: 1,
            citations: [
              { kind: "commit_change", id: "commit-1:src/a.ts", repository: request.repository, path: "src/a.ts" }
            ]
          },
          {
            kind: "change",
            title: "modify src/a.ts",
            data: { change: "modify", newBlobSha: "blob-a" },
            score: 1,
            citations: [
              { kind: "commit_change", id: "commit-2:src/a.ts", repository: request.repository, path: "src/a.ts" }
            ]
          },
          {
            kind: "change",
            title: "modify src/b.ts",
            data: { change: "modify", newBlobSha: "blob-b" },
            score: 1,
            citations: [
              { kind: "commit_change", id: "commit-1:src/b.ts", repository: request.repository, path: "src/b.ts" }
            ]
          }
        ]
      };
    }
  }).answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "What changed in PR #5?"
  });
  assert.match(concise.answer, /contains 2 results/);
  assert.equal(concise.answer.match(/modify src\/a\.ts/g)?.length, 1);
  assert.equal(concise.citedClaims.find((claim) => claim.text === "modify src/a.ts")?.citations.length, 2);

  called.length = 0;
  await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "Which PR and commit resolved issue #7?"
  });
  assert.deepEqual(called, ["issue_trace"]);

  called.length = 0;
  issueEntityIds.length = 0;
  await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "What resolved this issue?",
    issueEntityId: "entity_virtual"
  });
  assert.deepEqual(called, ["issue_trace"]);
  assert.deepEqual(issueEntityIds, ["entity_virtual"]);

  called.length = 0;
  issueTexts.length = 0;
  await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: 'Which PR or commit caused "Administrators cannot delete resources"?'
  });
  assert.deepEqual(called, ["issue_trace"]);
  assert.deepEqual(issueTexts, ["Administrators cannot delete resources"]);

  called.length = 0;
  issueTexts.length = 0;
  await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "Which PR or commit caused Administrators cannot delete resources, and why?"
  });
  assert.deepEqual(called, ["issue_trace"]);
  assert.deepEqual(issueTexts, ["Administrators cannot delete resources"]);

  called.length = 0;
  issueTexts.length = 0;
  await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "which caused Administrators cannot delete resources issue?"
  });
  assert.deepEqual(called, ["issue_trace"]);
  assert.deepEqual(issueTexts, ["Administrators cannot delete resources"]);

  called.length = 0;
  symbols.length = 0;
  await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "Where is authorize implemented and what calls it?"
  });
  assert.deepEqual(called, ["structure"]);
  assert.deepEqual(symbols, ["authorize"]);

  called.length = 0;
  paths.length = 0;
  await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "Who owns src/access-policy.ts?"
  });
  assert.deepEqual(called, ["ownership"]);
  assert.deepEqual(paths, ["src/access-policy.ts"]);
  assert.equal(extractRepositoryPath("Who owns README.md?"), "README.md");
  assert.equal(extractRepositoryPath("Why does Dockerfile exist?"), "Dockerfile");
});

test("orchestrator produces a direct cited causal answer and withholds unreviewed causality", async () => {
  const citations = [
    {
      kind: "assertion" as const,
      id: "assertion-cause",
      repository: "org/repo",
      commitSha: "3".repeat(40),
      path: "src/access-policy.ts",
      startLine: 12,
      endLine: 18
    }
  ];
  const answerWith = (introducedBy: readonly unknown[]) =>
    new RepositoryContextOrchestrator({
      async retrieve(request) {
        return {
          template: request.template,
          repository: request.repository,
          ref: "main",
          truncated: false,
          totalBeforeLimit: 1,
          limit: request.limit ?? 50,
          items: [
            {
              kind: "issue_trace",
              title: "Issue #123",
              data: {
                issue: { number: 123, title: "Administrators cannot delete resources" },
                resolutions: [
                  {
                    pullRequestNumber: 5,
                    commits: [{ sha: "5".repeat(40) }],
                    assertionIds: ["assertion-fix"],
                    observationIds: ["observation-fix"]
                  }
                ],
                introducedBy
              },
              citations,
              score: 3
            }
          ]
        };
      }
    }).answer({
      tenantId: "t",
      allowedRepositories: ["org/repo"],
      repository: "org/repo",
      question: "Which PR or commit caused Administrators cannot delete resources, and why?"
    });

  const reviewed = await answerWith([
    {
      sha: "3".repeat(40),
      committedAt: "2026-02-03T10:30:00.000Z",
      why: "the administrator bypass was removed",
      assertionIds: ["assertion-cause"],
      pullRequests: [{ number: 3 }]
    }
  ]);
  assert.match(reviewed.answer, /PR #3.*commit 333333333333.*because the administrator bypass was removed/);
  assert.match(reviewed.answer, /first introduced on 2026-02-03/);
  assert.equal(reviewed.citedClaims.length, 2);
  assert.deepEqual(reviewed.citedClaims[0]?.citations, citations);
  assert.deepEqual(reviewed.coverageGaps, []);

  const beforeReview = await answerWith([]);
  assert.match(beforeReview.answer, /No active reviewed causal assertion/);
  assert.match(beforeReview.answer, /later resolution.*PR #5/i);
  assert.equal(beforeReview.coverageGaps[0]?.capability, "issue_trace");
});

test("orchestrator refuses ambiguous issue text and selects the requested causal PR", async () => {
  const executor = {
    async retrieve(request: RetrievalRequest) {
      const issue = (number: number, title: string, introducedBy: readonly unknown[]) => ({
        kind: "issue_trace",
        title: `Issue #${number}`,
        data: { issue: { number, title }, resolutions: [], introducedBy, citations: [] },
        score: 1,
        citations: [
          { kind: "assertion" as const, id: "cause-2", repository: request.repository },
          { kind: "assertion" as const, id: "cause-3", repository: request.repository }
        ]
      });
      return {
        template: request.template,
        repository: request.repository,
        ref: request.ref ?? "main",
        truncated: false,
        totalBeforeLimit: 2,
        limit: request.limit ?? 50,
        items: [
          issue(123, "Administrators cannot delete resources", [
            { sha: "2".repeat(40), why: "older cause", assertionIds: ["cause-2"], pullRequests: [{ number: 2 }] },
            { sha: "3".repeat(40), why: "requested cause", assertionIds: ["cause-3"], pullRequests: [{ number: 3 }] }
          ]),
          issue(124, "Users cannot delete resources", [])
        ]
      };
    }
  };
  const orchestrator = new RepositoryContextOrchestrator(executor);
  const ambiguous = await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "Which commit caused cannot delete resources, and why?"
  });
  assert.match(ambiguous.answer, /Multiple issues matched/);
  assert.equal(ambiguous.citedClaims.length, 0);
  assert.equal(ambiguous.unresolvedAmbiguities.length, 1);

  const selected = await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "Did PR #3 cause issue #123, and why?"
  });
  assert.match(selected.answer, /PR #3.*333333333333.*requested cause/);
  assert.deepEqual(
    selected.citedClaims[0]?.citations.map((citation) => citation.id),
    ["cause-3"]
  );
});

test("counterfactuals use reviewed issue roles instead of generic change rows", async () => {
  assert.equal(isCounterfactualQuestion("If PR #3 had not merged, would the deletion bug exist?"), true);
  const causeSha = "3".repeat(40);
  const fixSha = "5".repeat(40);
  const orchestrator = new RepositoryContextOrchestrator({
    async retrieve(request) {
      return {
        template: request.template,
        repository: request.repository,
        ref: "main",
        truncated: false,
        totalBeforeLimit: 1,
        limit: request.limit ?? 50,
        items: [
          {
            kind: "causal_trace",
            title: "Issue #123",
            data: {
              root: {
                id: "issue",
                kind: "Issue",
                label: "Administrators cannot delete resources",
                description: "Issue #123"
              },
              causes: [
                {
                  kind: "cause",
                  nodes: [
                    {
                      id: "issue",
                      kind: "Issue",
                      label: "Administrators cannot delete resources",
                      description: "Issue #123"
                    },
                    { id: "cause-commit", kind: "Commit", label: causeSha, description: causeSha },
                    { id: "pr-3", kind: "PullRequest", label: "PR #3", description: "github:pr:org/repo#3" }
                  ],
                  edgeIds: ["cause"],
                  predicates: ["INTRODUCED_BY"],
                  why: "the administrator bypass was removed",
                  citations: [{ kind: "assertion", id: "cause", repository: request.repository }]
                }
              ],
              resolutions: [
                {
                  kind: "resolution",
                  nodes: [
                    {
                      id: "issue",
                      kind: "Issue",
                      label: "Administrators cannot delete resources",
                      description: "Issue #123"
                    },
                    { id: "pr-5", kind: "PullRequest", label: "PR #5", description: "github:pr:org/repo#5" },
                    { id: "fix-commit", kind: "Commit", label: fixSha, description: fixSha }
                  ],
                  edgeIds: ["fix"],
                  predicates: ["RESOLVED_BY"],
                  citations: [{ kind: "assertion", id: "fix", repository: request.repository }]
                }
              ],
              implementations: [],
              affectedEntities: [],
              dependencies: [],
              deployments: [],
              documentation: [],
              ownership: [],
              movedFrom: [],
              structuralPaths: [],
              citations: [
                { kind: "assertion", id: "cause", repository: request.repository },
                { kind: "assertion", id: "fix", repository: request.repository }
              ]
            },
            citations: [
              { kind: "assertion", id: "cause", repository: request.repository },
              { kind: "assertion", id: "fix", repository: request.repository }
            ],
            score: 3
          }
        ]
      };
    }
  });
  const cause = await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    operation: "counterfactual",
    question: "If PR #3 had not merged, would issue #123 exist?"
  });
  assert.equal(cause.operation, "counterfactual");
  assert.match(cause.answer, /eliminates every currently known reviewed path/);
  assert.deepEqual(
    cause.calls.map((call) => call.template),
    ["counterfactual"]
  );
  assert.deepEqual(
    cause.citedClaims[0]?.citations.map((citation) => citation.id),
    ["cause"]
  );

  const fix = await orchestrator.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "If PR #5 had not merged, would issue #123 remain?"
  });
  assert.equal(fix.operation, "counterfactual");
  assert.match(fix.answer, /eliminates every currently known reviewed path/);
  assert.doesNotMatch(fix.answer, /cited change set|intent\/history/);

  const uncited = new RepositoryContextOrchestrator({
    async retrieve(request) {
      return {
        template: request.template,
        repository: request.repository,
        ref: "main",
        truncated: false,
        totalBeforeLimit: 1,
        limit: request.limit ?? 50,
        items: [
          {
            kind: "causal_trace",
            title: "Issue #123",
            score: 1,
            citations: [],
            data: {
              root: {
                id: "issue",
                kind: "Issue",
                label: "Administrators cannot delete resources",
                description: "Issue #123"
              },
              causes: [
                {
                  kind: "cause",
                  nodes: [
                    {
                      id: "issue",
                      kind: "Issue",
                      label: "Administrators cannot delete resources",
                      description: "Issue #123"
                    },
                    { id: "pr-3", kind: "PullRequest", label: "PR #3", description: "github:pr:org/repo#3" }
                  ],
                  edgeIds: ["missing"],
                  predicates: ["INTRODUCED_BY"],
                  why: "the administrator bypass was removed",
                  citations: []
                }
              ],
              resolutions: [],
              implementations: [],
              affectedEntities: [],
              dependencies: [],
              deployments: [],
              documentation: [],
              ownership: [],
              movedFrom: [],
              structuralPaths: [],
              citations: []
            }
          }
        ]
      };
    }
  });
  const unsupported = await uncited.answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    operation: "counterfactual",
    question: "If PR #3 had not merged, would issue #123 exist?"
  });
  assert.equal(unsupported.citedClaims.length, 0);
  assert.match(unsupported.coverageGaps[0]?.message ?? "", /citation|evidence/i);
});

test("counterfactual commit interventions match truncated and short shas by prefix", () => {
  const sha = "4980ac3a3c9f27e314da47380078c19108e4edb4";
  const root: CausalTraceNode = { id: "issue", kind: "Issue", label: "Issue #123", description: "Issue #123" };
  const trace = (commit: CausalTraceNode): CausalTraceProjection => ({
    root,
    causes: [
      {
        kind: "cause",
        nodes: [root, commit],
        edgeIds: ["cause"],
        predicates: ["INTRODUCED_BY"],
        citations: [{ kind: "assertion", id: "cause", repository: "org/repo" }]
      }
    ],
    resolutions: [],
    implementations: [],
    affectedEntities: [],
    dependencies: [],
    deployments: [],
    documentation: [],
    ownership: [],
    movedFrom: [],
    structuralPaths: [],
    citations: [{ kind: "assertion", id: "cause", repository: "org/repo" }]
  });

  // Node text carries only a 12-char truncated sha; the question uses the full 40-char sha.
  // The node side is prefix-resolved, so the answer must carry the sha caveat.
  const truncated = evaluateCounterfactual(
    trace({ id: "cause-commit", kind: "Commit", label: sha.slice(0, 12), description: "introduced the regression" }),
    `If commit ${sha} were removed, would issue #123 disappear?`
  );
  assert.equal(truncated.intervention?.id, "cause-commit");
  assert.equal(truncated.removedPaths.length, 1);
  assert.equal(truncated.remainingPaths.length, 0);
  assert.deepEqual(truncated.coverageGaps, []);
  assert.match(truncated.unresolvedAmbiguities[0] ?? "", /sha prefix/);

  // Inverse: node carries the full sha (in its id), question uses a 7-char short sha.
  // A short question sha can collide outside the trace, so the caveat stays.
  const short = evaluateCounterfactual(
    trace({ id: `commit:${sha}`, kind: "Commit", label: "bad change", description: "free text" }),
    `If commit ${sha.slice(0, 7)} were removed, would issue #123 disappear?`
  );
  assert.equal(short.intervention?.id, `commit:${sha}`);
  assert.equal(short.removedPaths.length, 1);
  assert.equal(short.remainingPaths.length, 0);
  assert.match(short.unresolvedAmbiguities[0] ?? "", /sha prefix/);

  // Full 40-char sha on both sides pins the commit exactly: no caveat.
  const exact = evaluateCounterfactual(
    trace({ id: "cause-commit", kind: "Commit", label: sha.slice(0, 12), description: `repo:org/repo:sha:${sha}` }),
    `If commit ${sha} were removed, would issue #123 disappear?`
  );
  assert.equal(exact.intervention?.id, "cause-commit");
  assert.deepEqual(exact.unresolvedAmbiguities, []);

  // A different commit must not match, even with the prefix-tolerant rule.
  const mismatch = evaluateCounterfactual(
    trace({ id: "cause-commit", kind: "Commit", label: "deadbeefcafe", description: "other change" }),
    `If commit ${sha} were removed, would issue #123 disappear?`
  );
  assert.equal(mismatch.intervention, undefined);
  assert.equal(mismatch.removedPaths.length, 0);
});

test("memory projection materializes accepted human causal assertions for counterfactuals", async () => {
  const store = new MemoryContextGraphStore();
  const tenantId = "t";
  const repository = "org/repo";
  const headSha = "9".repeat(40);
  const causeSha = "4980ac3a3c9f27e314da47380078c19108e4edb4";
  const now = "2026-07-21T00:00:00.000Z";
  await store.planIngestion({
    tenantId,
    repository,
    ref: "main",
    commitSha: headSha,
    treeSha: "c".repeat(40),
    parents: [],
    isDefaultRef: true,
    recordedAt: now,
    taskId: "ingest",
    files: [{ path: "README.md", blobSha: "b".repeat(40), size: 10 }]
  });
  await store.applyGitHubObservations([
    {
      tenantId,
      repository,
      kind: "issue",
      number: 123,
      title: "Worker failed",
      state: "open",
      url: `https://github.com/${repository}/issues/123`,
      recordedAt: now
    },
    {
      tenantId,
      repository,
      kind: "pull_request",
      number: 99,
      title: "Replace transport",
      state: "merged",
      url: `https://github.com/${repository}/pull/99`,
      recordedAt: now,
      commitShas: [causeSha],
      mergeCommitSha: causeSha,
      mergedAt: now
    }
  ]);
  const assigned = await store.executeCommand(
    tenantId,
    "user:verifier",
    {
      type: "assign_relationship",
      repository,
      subject: { kind: "Issue", key: `github:issue:${repository}#123`, displayName: "Worker failed" },
      predicate: "INTRODUCED_BY",
      object: { kind: "Commit", key: `repo:${repository}:sha:${causeSha}`, displayName: causeSha },
      qualifiers: { reason: "the transport change dropped the runtime" },
      reason: "curated root cause"
    },
    now,
    true
  );
  // While the command assertion is only proposed it must not project as fact.
  const unreviewed = await store.project({
    tenantId,
    repository,
    ref: "main",
    commitSha: headSha,
    taskId: "project-unreviewed",
    generatedAt: now
  });
  assert.equal(unreviewed.edges.filter((edge) => edge.predicate === "INTRODUCED_BY").length, 0);
  await store.executeCommand(
    tenantId,
    "user:verifier",
    {
      type: "review_assertion",
      assertionId: assigned.affectedIds[0]!,
      decision: "accept",
      reason: "verified"
    },
    now,
    true
  );
  const graph = await store.project({
    tenantId,
    repository,
    ref: "main",
    commitSha: headSha,
    taskId: "project",
    generatedAt: now
  });
  assert.equal(graph.edges.filter((edge) => edge.predicate === "INTRODUCED_BY").length, 1);
  const items = causalTraceItemsFromGraph(graph, {
    tenantId,
    allowedRepositories: [repository],
    repository,
    template: "counterfactual",
    issueNumber: 123,
    commitSha: causeSha,
    query: `if commit ${causeSha} were removed, would issue #123 disappear?`
  });
  assert.equal(items.length, 1);
  const evaluation = evaluateCounterfactual(
    items[0]!.data as unknown as CausalTraceProjection,
    `If commit ${causeSha} were removed, would issue #123 disappear?`
  );
  // The projected Commit node label is the source normalizer's 12-char short sha.
  assert.equal(evaluation.intervention?.label, causeSha.slice(0, 12));
  assert.ok(evaluation.removedPaths.length >= 1);
  assert.equal(evaluation.remainingPaths.length, 0);
});

test("GitHub normalizers derive explicit work links and pattern-scoped CODEOWNERS facts", () => {
  assert.deepEqual(linkedIssueNumbers("Fixes #12 and also discusses #13"), { resolves: [12], references: [13] });
  const ownership = normalizeGitHubSourceObservation({
    tenantId: "t",
    repository: "org/repo",
    kind: "codeowners",
    commitSha: "a".repeat(40),
    path: ".github/CODEOWNERS",
    entries: [{ pattern: "src/**", owners: ["@org/platform"] }],
    recordedAt: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(ownership.assertions, [
    {
      subject: { kind: "Repository", key: "github:repo:org/repo", displayName: "org/repo" },
      predicate: "OWNED_BY",
      object: { kind: "Team", key: "github:team:org/platform", displayName: "@org/platform" },
      explanation: "The CODEOWNERS rule src/** assigns matching repository paths to @org/platform.",
      qualifiers: { pattern: "src/**" }
    }
  ]);
  const mergeSha = "b".repeat(40);
  const workItem = normalizeGitHubSourceObservation({
    tenantId: "t",
    repository: "org/repo",
    kind: "pull_request",
    number: 4,
    title: "Fix access",
    body: "Fixes #12",
    state: "closed",
    url: "https://github.com/org/repo/pull/4",
    authorId: 12345,
    authorLogin: "octocat",
    authorName: "The Octocat",
    authorAccountType: "User",
    recordedAt: "2026-01-02T00:00:00Z",
    mergedAt: "2026-01-02T00:00:00Z",
    mergeCommitSha: mergeSha,
    commitShas: [mergeSha],
    resolvesIssueNumbers: [12]
  });
  assert.deepEqual(
    workItem.assertions.map((assertion) => assertion.predicate),
    ["AUTHORED_BY", "INCLUDES", "MERGED_AS", "RESOLVES"]
  );
  assert.deepEqual(workItem.githubIdentity, {
    externalId: "12345",
    entity: { kind: "Engineer", key: "github:user:12345", displayName: "The Octocat" }
  });
  assert.equal(
    workItem.assertions.every((assertion) => assertion.explanation.length > 0),
    true
  );
});

test("source ingestion distinguishes new, updated, and confirmed GitHub observations", async () => {
  const store = new MemoryContextGraphStore();
  const issue = {
    tenantId: "t",
    repository: "org/repo",
    kind: "issue" as const,
    number: 12,
    title: "Initial title",
    state: "open",
    url: "https://github.com/org/repo/issues/12",
    occurredAt: "2026-07-20T00:00:00.000Z",
    recordedAt: "2026-07-20T00:00:01.000Z"
  };
  const first = await store.applyGitHubObservations([issue]);
  assert.deepEqual(
    [first.newObservationCount, first.updatedObservationCount, first.confirmedObservationCount],
    [1, 0, 0]
  );
  const replay = await store.applyGitHubObservations([issue]);
  assert.deepEqual(
    [replay.newObservationCount, replay.updatedObservationCount, replay.confirmedObservationCount],
    [0, 0, 1]
  );
  const updated = await store.applyGitHubObservations([
    {
      ...issue,
      title: "Updated title",
      occurredAt: "2026-07-20T00:02:00.000Z",
      recordedAt: "2026-07-20T00:02:01.000Z"
    }
  ]);
  assert.deepEqual(
    [updated.newObservationCount, updated.updatedObservationCount, updated.confirmedObservationCount],
    [0, 1, 0]
  );
  assert.equal(
    assertionEvidenceFingerprint("code-checkpoint", [issue]),
    assertionEvidenceFingerprint("code-checkpoint", [{ ...issue, recordedAt: "2026-07-20T00:10:00.000Z" }])
  );
  assert.notEqual(
    assertionEvidenceFingerprint("code-checkpoint", [issue]),
    assertionEvidenceFingerprint("code-checkpoint", [{ ...issue, title: "Changed evidence" }])
  );
});

test("memory issue traces preserve ambiguous partial title matches", async () => {
  const store = new MemoryContextGraphStore();
  const repository = "org/repo";
  const observedAt = "2026-07-20T00:00:00.000Z";
  await store.applyGitHubObservations(
    [101, 102].map((number) => ({
      tenantId: "t",
      repository,
      kind: "issue" as const,
      number,
      title: number === 101 ? "Administrators cannot delete resources" : "Guests cannot delete resources",
      state: "open",
      url: `https://github.com/${repository}/issues/${number}`,
      occurredAt: observedAt,
      recordedAt: observedAt
    }))
  );
  const trace = await store.retrieve({
    tenantId: "t",
    allowedRepositories: [repository],
    repository,
    ref: "main",
    template: "issue_trace",
    issueText: "cannot delete resources"
  });
  assert.deepEqual(
    trace.items.map((item) => (item.data as { issue?: { number?: number } }).issue?.number),
    [101, 102]
  );
});

test("memory administration applies supported commands and rejects unsupported commands", async () => {
  const store = new MemoryContextGraphStore();
  const ingested = await store.applyGitHubObservations([
    {
      tenantId: "t",
      repository: "org/repo",
      kind: "issue",
      number: 12,
      title: "Redact me",
      state: "open",
      url: "https://github.com/org/repo/issues/12",
      occurredAt: "2026-07-20T00:00:00.000Z",
      recordedAt: "2026-07-20T00:00:01.000Z"
    }
  ]);
  const observationId = ingested.observationIds[0];
  assert.ok(observationId);
  await store.executeCommand(
    "t",
    "svc:test",
    {
      type: "redact_observation",
      observationId,
      reason: "privacy request"
    },
    "2026-07-20T00:01:00.000Z"
  );
  await assert.rejects(store.loadAssertionEvidence("t", "org/repo", [observationId]), /not found/);
  const assigned = await store.executeCommand(
    "t",
    "svc:test",
    {
      type: "assign_relationship",
      repository: "org/repo",
      subject: { kind: "File", key: "repo:org/repo:path:src/app.ts" },
      predicate: "IMPLEMENTS",
      object: { kind: "Feature", key: "repo:org/repo:feature:example" },
      reason: "exercise relationship administration"
    },
    "2026-07-20T00:02:00.000Z"
  );
  assert.equal(assigned.affectedIds.length, 1);
  assert.equal(
    (await store.listAssertions("t", "org/repo", { status: "proposed", predicate: "IMPLEMENTS" })).length,
    1
  );
  await assert.rejects(
    store.executeCommand(
      "t",
      "svc:test",
      {
        type: "erase_person",
        entityId: "person-1",
        reason: "privacy request"
      },
      "2026-07-20T00:03:00.000Z"
    ),
    /requires the relational contextGraph store/
  );
});

test("memory repository roles enforce administration boundaries and tombstones block replay", async () => {
  const store = new MemoryContextGraphStore();
  const tenantId = "t";
  const repository = "org/tombstoned";
  const now = "2026-07-20T00:00:00.000Z";
  for (const [principalId, role] of [
    ["user:reader@example.com", "reader"],
    ["user:writer@example.com", "writer"],
    ["user:admin@example.com", "admin"]
  ] as const) {
    await store.executeCommand(
      tenantId,
      "svc:test",
      {
        type: "grant_repository_access",
        repository,
        principalId,
        role
      },
      now
    );
  }

  const assignment = {
    type: "assign_relationship" as const,
    repository,
    subject: { kind: "File" as const, key: `repo:${repository}:path:src/app.ts` },
    predicate: "IMPLEMENTS",
    object: { kind: "Feature" as const, key: `repo:${repository}:feature:example` },
    reason: "exercise repository role enforcement"
  };
  await assert.rejects(store.executeCommand(tenantId, "user:reader@example.com", assignment, now), /access denied/);
  await store.executeCommand(tenantId, "user:writer@example.com", assignment, now);
  await assert.rejects(
    store.executeCommand(
      tenantId,
      "user:writer@example.com",
      {
        type: "grant_repository_access",
        repository,
        principalId: "user:other@example.com",
        role: "reader"
      },
      now
    ),
    /access denied/
  );
  await store.executeCommand(
    tenantId,
    "user:admin@example.com",
    {
      type: "grant_repository_access",
      repository,
      principalId: "user:other@example.com",
      role: "reader"
    },
    now
  );
  await store.executeCommand(
    tenantId,
    "user:admin@example.com",
    {
      type: "tombstone_repository",
      repository,
      reason: "erasure request"
    },
    now
  );

  assert.deepEqual(await store.repositoriesForPrincipal(tenantId, "user:reader@example.com"), []);
  await assert.rejects(
    store.applyGitHubObservations([
      {
        tenantId,
        repository,
        kind: "issue",
        number: 1,
        title: "Must not return",
        state: "open",
        url: `https://github.com/${repository}/issues/1`,
        occurredAt: now,
        recordedAt: now
      }
    ]),
    /repository is tombstoned/
  );
  await assert.rejects(
    store.planIngestion({
      tenantId,
      repository,
      ref: "main",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      parents: [],
      recordedAt: now,
      taskId: "replay",
      files: []
    }),
    /repository is tombstoned/
  );
  await assert.rejects(
    store.executeCommand(
      tenantId,
      "svc:test",
      {
        type: "grant_repository_access",
        repository,
        principalId: "user:reader@example.com",
        role: "reader"
      },
      now
    ),
    /repository is tombstoned/
  );
  await assert.rejects(store.executeCommand(tenantId, "svc:test", assignment, now), /repository is tombstoned/);
});

test("retrieves an agent-derived issue without requiring human review", async () => {
  const store = new MemoryContextGraphStore();
  const repository = "org/repo";
  const observedAt = "2026-07-20T00:00:00.000Z";
  const source = await store.applyGitHubObservations([
    {
      tenantId: "t",
      repository,
      kind: "pull_request",
      number: 42,
      title: "Restore administrator deletion",
      body: "Administrators are incorrectly denied when deleting resources.",
      state: "closed",
      url: `https://github.com/${repository}/pull/42`,
      occurredAt: observedAt,
      recordedAt: observedAt,
      commitShas: [],
      resolvesIssueNumbers: [],
      referencesIssueNumbers: []
    }
  ]);
  const evidence = await store.loadAssertionEvidence("t", repository, source.observationIds);
  assert.equal((evidence[0]?.payload as { title?: string }).title, "Restore administrator deletion");

  const rawOutput = {
    summary: "PR 42 fixes a deletion regression",
    nodes: [
      { id: "repo", kind: "Repository" as const, label: repository, description: "repo", evidence: ["README.md:1"] },
      {
        id: "42",
        kind: "PullRequest" as const,
        label: "PR #42",
        description: "restores deletion",
        evidence: ["src/auth.ts:10"]
      },
      {
        id: "derived:pr:42",
        kind: "Issue" as const,
        label: "Administrators cannot delete resources",
        description: "Administrator deletion is incorrectly denied.",
        evidence: ["src/auth.ts:10"]
      }
    ],
    edges: [
      {
        source: "42",
        target: "derived:pr:42",
        predicate: "RESOLVES",
        plane: "knowledge" as const,
        confidence: 0.94,
        why: "The pull request fixes the administrator deletion regression represented by this issue.",
        evidence: ["src/auth.ts:10"]
      }
    ]
  };
  await store.saveAssertionBatch({
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "a".repeat(40),
    taskId: "assert-virtual",
    generatedAt: "2026-07-20T00:01:00.000Z",
    generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint: "virtual-evidence",
    evidenceObservationIds: source.observationIds,
    model: "fixture",
    summary: rawOutput.summary,
    rawOutput,
    assertions: assertionsFromGeneratedContextGraph(rawOutput, repository, { sourcePullRequestNumbers: [42] })
  });
  const assertion = (await store.listAssertions("t", repository, { status: "active", predicate: "RESOLVES" }))[0];
  assert.ok(assertion);
  await store.planIngestion({
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    parents: [],
    updateRef: true,
    recordedAt: "2026-07-20T00:02:30.000Z",
    taskId: "virtual-ingest",
    files: [
      { path: "README.md", blobSha: "c".repeat(40), size: 20 },
      { path: "src/auth.ts", blobSha: "d".repeat(40), size: 20 }
    ]
  });
  const activeGraph = await store.project({
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "a".repeat(40),
    taskId: "virtual-active-project",
    generatedAt: "2026-07-20T00:02:40.000Z"
  });
  assert.equal(
    activeGraph.nodes.some((node) => node.kind === "Issue"),
    true
  );
  assert.equal(
    activeGraph.edges.some((edge) => edge.predicate === "RESOLVES" && edge.qualifiers?.assertionStatus === "active"),
    true
  );
  await store.project({
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "a".repeat(40),
    taskId: "virtual-accepted-project",
    generatedAt: "2026-07-20T00:03:10.000Z"
  });

  const trace = await store.retrieve({
    tenantId: "t",
    allowedRepositories: [repository],
    repository,
    ref: "main",
    template: "issue_trace",
    issueText: "incorrectly denied"
  });
  assert.equal(trace.items.length, 1);
  const payload = trace.items[0]?.data as unknown as {
    issue: { origin: string; number?: number; description?: string };
    resolutions: { pullRequestNumber: number }[];
  };
  assert.equal(payload.issue.origin, "derived");
  assert.equal(payload.issue.number, undefined);
  assert.equal(payload.issue.description, "Administrator deletion is incorrectly denied.");
  assert.equal(payload.resolutions[0]?.pullRequestNumber, 42);

  await store.planIngestion({
    tenantId: "t",
    repository,
    ref: "old",
    commitSha: "e".repeat(40),
    treeSha: "f".repeat(40),
    parents: [],
    updateRef: true,
    recordedAt: "2026-07-20T00:03:00.000Z",
    taskId: "virtual-old-ingest",
    files: [{ path: "src/auth.ts", blobSha: "0".repeat(40), size: 20 }]
  });
  await store.project({
    tenantId: "t",
    repository,
    ref: "old",
    commitSha: "e".repeat(40),
    taskId: "virtual-old-project",
    generatedAt: "2026-07-20T00:03:10.000Z"
  });
  const oldTrace = await store.retrieve({
    tenantId: "t",
    allowedRepositories: [repository],
    repository,
    ref: "old",
    template: "issue_trace",
    issueText: "incorrectly denied"
  });
  assert.equal(
    oldTrace.items.length,
    0,
    "issue traces exclude assertions whose evidence is stale on the requested ref"
  );
});

test("resolves derived issue descriptions by PR anchor when titles collide", async () => {
  const store = new MemoryContextGraphStore();
  const repository = "org/repo";
  const observedAt = "2026-07-20T00:00:00.000Z";
  const source = await store.applyGitHubObservations(
    [42, 43].map((number) => ({
      tenantId: "t",
      repository,
      kind: "pull_request" as const,
      number,
      title: `Fix regression ${number}`,
      body: `Regression fixed by PR ${number}.`,
      state: "closed",
      url: `https://github.com/${repository}/pull/${number}`,
      occurredAt: observedAt,
      recordedAt: observedAt,
      commitShas: [],
      resolvesIssueNumbers: [],
      referencesIssueNumbers: []
    }))
  );
  const rawOutput = {
    summary: "Two independent authorization regressions",
    nodes: [
      { id: "repo", kind: "Repository" as const, label: repository, description: "repo", evidence: ["README.md:1"] },
      { id: "42", kind: "PullRequest" as const, label: "PR #42", description: "fix", evidence: ["src/auth.ts:10"] },
      { id: "43", kind: "PullRequest" as const, label: "PR #43", description: "fix", evidence: ["src/audit.ts:10"] },
      {
        id: "derived:pr:42",
        kind: "Issue" as const,
        label: "Administrators encounter an authorization error",
        description: "Administrator deletion is incorrectly denied.",
        evidence: ["src/auth.ts:10"]
      },
      {
        id: "derived:pr:43",
        kind: "Issue" as const,
        label: "Administrators encounter an authorization error",
        description: "Administrator audit export is incorrectly denied.",
        evidence: ["src/audit.ts:10"]
      }
    ],
    edges: [42, 43].map((number) => ({
      source: String(number),
      target: `derived:pr:${number}`,
      predicate: "RESOLVES",
      plane: "knowledge" as const,
      confidence: 0.94,
      why: `Pull request #${number} fixes the corresponding authorization regression.`,
      evidence: [number === 42 ? "src/auth.ts:10" : "src/audit.ts:10"]
    }))
  };
  await store.saveAssertionBatch({
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "b".repeat(40),
    taskId: "assert-colliding-titles",
    generatedAt: "2026-07-20T00:01:00.000Z",
    generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint: "colliding-title-evidence",
    evidenceObservationIds: source.observationIds,
    model: "fixture",
    summary: rawOutput.summary,
    rawOutput,
    assertions: assertionsFromGeneratedContextGraph(rawOutput, repository, { sourcePullRequestNumbers: [42, 43] })
  });
  const resolutions = await store.listAssertions("t", repository, { status: "active", predicate: "RESOLVES" });
  assert.equal(resolutions.length, 2);
  await store.planIngestion({
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "b".repeat(40),
    treeSha: "c".repeat(40),
    parents: [],
    updateRef: true,
    recordedAt: "2026-07-20T00:02:30.000Z",
    taskId: "colliding-ingest",
    files: [
      { path: "README.md", blobSha: "d".repeat(40), size: 20 },
      { path: "src/auth.ts", blobSha: "e".repeat(40), size: 20 },
      { path: "src/audit.ts", blobSha: "f".repeat(40), size: 20 }
    ]
  });
  await store.project({
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "b".repeat(40),
    taskId: "colliding-project",
    generatedAt: "2026-07-20T00:02:40.000Z"
  });
  const trace = await store.retrieve({
    tenantId: "t",
    allowedRepositories: [repository],
    repository,
    ref: "main",
    template: "issue_trace",
    issueText: "audit export"
  });
  const payload = trace.items[0]?.data as unknown as {
    issue: { description?: string };
    resolutions: { pullRequestNumber: number }[];
  };
  assert.equal(payload.issue.description, "Administrator audit export is incorrectly denied.");
  assert.equal(payload.resolutions[0]?.pullRequestNumber, 43);
});

test("memory source ingestion applies current deterministic assertions", async () => {
  const store = new MemoryContextGraphStore();
  await store.applyGitHubObservations([
    {
      tenantId: "t",
      repository: "org/repo",
      kind: "pull_request",
      number: 4,
      title: "Fix access",
      state: "closed",
      url: "https://github.com/org/repo/pull/4",
      recordedAt: "2026-07-20T00:00:00.000Z",
      occurredAt: "2026-07-20T00:00:00.000Z",
      commitShas: ["4".repeat(40)],
      resolvesIssueNumbers: [12]
    },
    {
      tenantId: "t",
      repository: "org/repo",
      kind: "codeowners",
      commitSha: "4".repeat(40),
      path: "CODEOWNERS",
      entries: [{ pattern: "*", owners: ["@org/platform"] }],
      recordedAt: "2026-07-20T00:00:00.000Z"
    }
  ]);
  const assertions = await store.listAssertions("t", "org/repo");
  assert.equal(
    assertions.some((assertion) => assertion.predicate === "RESOLVES" && assertion.commitSha === "source"),
    true
  );
  assert.equal(
    assertions.some((assertion) => assertion.predicate === "OWNED_BY" && assertion.commitSha === "source"),
    true
  );
  assert.equal(
    assertions.every((assertion) => Boolean(assertion.explanation)),
    true
  );
  assert.equal(
    assertions.every((assertion) => assertion.evidence.some((value) => value.startsWith("observation:"))),
    true
  );
  const ownership = await store.retrieve({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    template: "ownership",
    path: "README.md"
  });
  assert.equal(ownership.items.length, 1);
  assert.match(ownership.items[0]?.title ?? "", /platform/);
});

test("normalizes model output into distinct semantic entity identities", () => {
  const assertions = assertionsFromGeneratedContextGraph(
    {
      summary: "symbols implement separate documents",
      nodes: [
        { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
        {
          id: "symbol:src/app.ts:first",
          kind: "Symbol",
          label: "first",
          description: "first symbol",
          path: "src/app.ts",
          evidence: ["src/app.ts:1"]
        },
        {
          id: "symbol:src/app.ts:second",
          kind: "Symbol",
          label: "second",
          description: "second symbol",
          path: "src/app.ts",
          evidence: ["src/app.ts:2"]
        },
        {
          id: "doc:first",
          kind: "Document",
          label: "first docs",
          description: "docs",
          path: "README.md",
          evidence: ["README.md:2"]
        }
      ],
      edges: [
        {
          source: "symbol:src/app.ts:first",
          target: "doc:first",
          predicate: "IMPLEMENTS",
          plane: "knowledge",
          confidence: 0.91,
          why: "The first symbol implements the behavior described by the document.",
          evidence: ["src/app.ts:1"]
        },
        {
          source: "symbol:src/app.ts:second",
          target: "doc:first",
          predicate: "IMPLEMENTS",
          plane: "knowledge",
          confidence: 0.92,
          why: "The second symbol implements the behavior described by the document.",
          evidence: ["src/app.ts:2"]
        }
      ]
    },
    "omxyz/demo"
  );
  assert.deepEqual(
    assertions.map((assertion) => assertion.subject.naturalKey),
    ["repo:omxyz/demo:moniker:symbol:src/app.ts:first", "repo:omxyz/demo:moniker:symbol:src/app.ts:second"]
  );
  assert.deepEqual(
    assertions.map((assertion) => assertion.explanation),
    [
      "The first symbol implements the behavior described by the document.",
      "The second symbol implements the behavior described by the document."
    ]
  );
  assert.throws(
    () =>
      assertionsFromGeneratedContextGraph(
        {
          summary: "unexplained relationship",
          nodes: [
            { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
            {
              id: "readme",
              kind: "Document",
              label: "README",
              description: "docs",
              path: "README.md",
              evidence: ["README.md:1"]
            }
          ],
          edges: [
            {
              source: "repo",
              target: "readme",
              predicate: "DOCUMENTED_BY",
              plane: "knowledge",
              confidence: 0.9,
              why: "",
              evidence: ["README.md:1"]
            }
          ]
        },
        "omxyz/demo"
      ),
    /must explain why the evidence supports the relationship/
  );
});

test("normalizes a PR-anchored derived issue as the generalized Issue kind", () => {
  const repository = "omxyz/demo";
  const assertions = assertionsFromGeneratedContextGraph(
    {
      summary: "PR 42 fixes an authorization regression",
      nodes: [
        { id: "repo", kind: "Repository", label: repository, description: "repo", evidence: ["README.md:1"] },
        {
          id: "42",
          kind: "PullRequest",
          label: "PR #42",
          description: "restores deletion",
          evidence: ["src/auth.ts:10"]
        },
        {
          id: "derived:pr:42",
          kind: "Issue",
          label: "Administrators cannot delete resources",
          description: "Administrator deletion is incorrectly denied.",
          evidence: ["src/auth.ts:10"]
        }
      ],
      edges: [
        {
          source: "42",
          target: "derived:pr:42",
          predicate: "RESOLVES",
          plane: "knowledge",
          confidence: 0.94,
          why: "The pull request fixes the administrator deletion regression represented by this issue.",
          evidence: ["src/auth.ts:10"]
        }
      ]
    },
    repository,
    { sourcePullRequestNumbers: [42] }
  );
  const assertion = assertions.find((candidate) => candidate.predicate === "RESOLVES");
  assert.equal(assertion?.subject.naturalKey, `github:pr:${repository}#42`);
  assert.equal(assertion?.object.kind, "Issue");
  assert.equal(assertion?.object.naturalKey, derivedIssueNaturalKey(repository, 42));
  assert.equal(assertion?.object.naturalKey.startsWith("github:issue:"), false);
  assert.throws(
    () => assertionsFromGeneratedContextGraph(generatedDerivedIssue(repository, 42), repository),
    /not present in source evidence/
  );
  assert.throws(
    () =>
      assertionsFromGeneratedContextGraph(
        {
          ...generatedDerivedIssue(repository, 42),
          edges: [
            {
              source: "43",
              target: "derived:pr:42",
              predicate: "RESOLVES",
              plane: "knowledge",
              confidence: 0.9,
              evidence: ["src/auth.ts:10"]
            }
          ],
          nodes: [
            ...generatedDerivedIssue(repository, 42).nodes.filter((node) => node.id !== "42"),
            {
              id: "43",
              kind: "PullRequest",
              label: "PR #43",
              description: "wrong anchor",
              evidence: ["src/auth.ts:10"]
            }
          ]
        },
        repository,
        { sourcePullRequestNumbers: [42] }
      ),
    /must be resolved by pull request #42/
  );
  assert.throws(
    () =>
      assertionsFromGeneratedContextGraph(generatedDerivedIssue(repository, 42), repository, {
        sourcePullRequestNumbers: [42],
        resolvedPullRequestNumbers: [42]
      }),
    /already explicitly resolves an issue/
  );
});

test("ignores model duplicates of deterministic GitHub issue resolutions", () => {
  const repository = "omxyz/demo";
  const sha = "a".repeat(40);
  const assertions = assertionsFromGeneratedContextGraph(
    {
      summary: "PR 5 resolves issue 4 caused by an earlier commit",
      nodes: [
        {
          id: "5",
          kind: "PullRequest",
          label: "PR #5",
          description: "restores deletion",
          evidence: ["ROOT_CAUSE.md:2"]
        },
        {
          id: "4",
          kind: "Issue",
          label: "Issue #4",
          description: "administrators cannot delete",
          evidence: ["ROOT_CAUSE.md:2"]
        },
        {
          id: sha,
          kind: "Commit",
          label: sha.slice(0, 12),
          description: "introduced the regression",
          evidence: ["ROOT_CAUSE.md:2"]
        }
      ],
      edges: [
        {
          source: "5",
          target: "4",
          predicate: "RESOLVES",
          plane: "knowledge",
          confidence: 0.99,
          why: "The pull request resolves the reported administrator deletion regression.",
          evidence: ["ROOT_CAUSE.md:2"]
        },
        {
          source: "4",
          target: sha,
          predicate: "INTRODUCED_BY",
          plane: "knowledge",
          confidence: 0.99,
          why: "The commit bypassed the administrator authorization guard.",
          evidence: ["ROOT_CAUSE.md:2"]
        }
      ]
    },
    repository
  );

  assert.deepEqual(
    assertions.map((assertion) => assertion.predicate),
    ["INTRODUCED_BY"]
  );
  assert.equal(assertions[0]?.subject.naturalKey, `github:issue:${repository}#4`);
  assert.equal(assertions[0]?.object.naturalKey, `repo:${repository}:sha:${sha}`);
});

test("drops model duplicates of source-owned incident deployment history", () => {
  const repository = "omxyz/demo";
  const assertions = assertionsFromGeneratedContextGraph(
    {
      summary: "The rollback deployment resolved the incident",
      nodes: [
        {
          id: "incident:postmortem:INC-42",
          kind: "Incident",
          label: "Deletion outage",
          description: "incident",
          evidence: ["docs/postmortems/INC-42.md:1"]
        },
        {
          id: "deployment:github:rollback-42",
          kind: "Deployment",
          label: "rollback-42",
          description: "deployment",
          evidence: ["docs/postmortems/INC-42.md:2"]
        }
      ],
      edges: [
        {
          source: "incident:postmortem:INC-42",
          target: "deployment:github:rollback-42",
          predicate: "RESOLVED_BY",
          plane: "knowledge",
          confidence: 0.93,
          why: "The postmortem identifies rollback deployment 42 as the action that restored service.",
          evidence: ["docs/postmortems/INC-42.md:1-2"]
        }
      ]
    },
    repository
  );
  assert.deepEqual(assertions, []);
});

test("infers an evidence-backed Feature and answers without required human review", async () => {
  const tenantId = "feature-tenant";
  const repository = "omxyz/feature-fixture";
  const commitSha = "f".repeat(40);
  const store = new MemoryContextGraphStore();
  assert.equal(extractFeatureText("What implements the administrator deletion feature?"), "administrator deletion");
  assert.equal(
    extractFeatureText("What package does the Administrator resource deletion implementation depend on?"),
    "Administrator resource deletion"
  );
  assert.equal(
    extractFeatureText(
      "If package zod were excluded, which Administrator resource deletion implementation paths disappear?"
    ),
    "Administrator resource deletion"
  );
  assert.deepEqual(classifyTemplates('Which files implement "administrator deletion"?'), ["feature_trace"]);
  await store.planIngestion({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    treeSha: "e".repeat(40),
    parents: [],
    recordedAt: "2026-07-20T00:00:00.000Z",
    taskId: "feature-ingest",
    files: [
      { path: "README.md", blobSha: "a".repeat(40), size: 20 },
      { path: "src/auth.ts", blobSha: "b".repeat(40), size: 40 },
      { path: "src/audit.ts", blobSha: "c".repeat(40), size: 40 }
    ]
  });
  await store.applyBlobAnalyses({ tenantId, repository, commitSha }, [
    {
      blobSha: "b".repeat(40),
      parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
      language: "typescript",
      symbols: [],
      imports: [{ specifier: "pg", line: 1 }],
      edges: []
    }
  ]);
  await store.applyGitHubObservations([
    {
      tenantId,
      repository,
      kind: "package_manifest",
      commitSha,
      path: "package.json",
      ecosystem: "npm",
      dependencies: [{ name: "pg", version: "8" }],
      recordedAt: "2026-07-20T00:00:30.000Z"
    }
  ]);
  const rawOutput = {
    summary: "Administrator deletion is a product capability",
    nodes: [
      { id: "repo", kind: "Repository" as const, label: repository, description: "repo", evidence: ["README.md:1"] },
      {
        id: "feature:administrator-deletion",
        kind: "Feature" as const,
        label: "Administrator deletion",
        description: "Administrators can delete resources.",
        evidence: ["README.md:2"]
      },
      {
        id: "feature:administrator-audit",
        kind: "Feature" as const,
        label: "Administrator audit",
        description: "Administrators can export audit events.",
        evidence: ["README.md:3"]
      },
      {
        id: "auth-file",
        kind: "File" as const,
        label: "src/auth.ts",
        description: "authorization",
        path: "src/auth.ts",
        evidence: ["src/auth.ts:1"]
      },
      {
        id: "readme",
        kind: "Document" as const,
        label: "README",
        description: "product docs",
        path: "README.md",
        evidence: ["README.md:2"]
      },
      {
        id: "audit-file",
        kind: "File" as const,
        label: "src/audit.ts",
        description: "audit export",
        path: "src/audit.ts",
        evidence: ["src/audit.ts:1"]
      }
    ],
    edges: [
      {
        source: "auth-file",
        target: "feature:administrator-deletion",
        predicate: "IMPLEMENTS",
        plane: "knowledge" as const,
        confidence: 0.96,
        why: "The authorization file implements administrator deletion behavior.",
        evidence: ["src/auth.ts:1"]
      },
      {
        source: "feature:administrator-deletion",
        target: "readme",
        predicate: "DOCUMENTED_BY",
        plane: "knowledge" as const,
        confidence: 0.98,
        why: "The README describes administrator deletion as a product capability.",
        evidence: ["README.md:2"]
      },
      {
        source: "audit-file",
        target: "feature:administrator-audit",
        predicate: "IMPLEMENTS",
        plane: "knowledge" as const,
        confidence: 0.95,
        why: "The audit file implements administrator audit export behavior.",
        evidence: ["src/audit.ts:1"]
      }
    ]
  };
  const generatedAssertions = assertionsFromGeneratedContextGraph(rawOutput, repository);
  assert.equal(
    generatedAssertions[0]?.object.naturalKey,
    featureNaturalKey(repository, "feature:administrator-deletion")
  );
  assert.throws(() => featureNaturalKey(repository, "administrator deletion"), /Feature id must use feature/);
  await store.saveAssertionBatch({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    taskId: "feature-assert",
    generatedAt: "2026-07-20T00:01:00.000Z",
    generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint: "feature-evidence",
    evidenceObservationIds: [],
    model: "fixture",
    summary: rawOutput.summary,
    rawOutput,
    assertions: generatedAssertions
  });
  const active = await store.listAssertions(tenantId, repository, { status: "active" });
  assert.equal(active.filter((assertion) => assertion.generator.startsWith("model:")).length, 3);
  const graph = await store.project({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    taskId: "feature-project",
    generatedAt: "2026-07-20T00:03:00.000Z"
  });
  assert.equal(
    graph.nodes.some((node) => node.kind === "Feature" && node.label === "Administrator deletion"),
    true
  );
  assert.equal(
    graph.edges.some((edge) => edge.predicate === "IMPLEMENTS"),
    true
  );
  assert.equal(
    graph.edges.some(
      (edge) => edge.predicate === "IMPORTS" && graph.nodes.find((node) => node.id === edge.target)?.kind === "Package"
    ),
    true
  );
  assert.equal(
    graph.edges.find((edge) => edge.predicate === "IMPLEMENTS" && edge.source === "file:src/auth.ts")?.why,
    "The authorization file implements administrator deletion behavior."
  );

  const answer = await new RepositoryContextOrchestrator(store).answer({
    tenantId,
    allowedRepositories: [repository],
    repository,
    ref: "main",
    question: 'Which files implement "administrator deletion"?'
  });
  assert.match(answer.answer, /src\/auth\.ts implements Administrator deletion/);
  assert.equal(answer.calls[0]?.template, "feature_trace");
  assert.equal(
    answer.citedClaims[0]?.citations.some((citation) => citation.kind === "assertion"),
    true
  );
  assert.equal(
    answer.citedClaims[0]?.citations.some((citation) => citation.kind === "code" && citation.path === "src/auth.ts"),
    true
  );
  const dependency = await new RepositoryContextOrchestrator(store).answer({
    tenantId,
    allowedRepositories: [repository],
    repository,
    ref: "main",
    question: "What package does the administrator deletion implementation depend on?"
  });
  assert.equal(dependency.calls[0]?.template, "causal_trace");
  assert.match(dependency.answer, /pg/);
  const excludedPackage = await new RepositoryContextOrchestrator(store).answer({
    tenantId,
    allowedRepositories: [repository],
    repository,
    ref: "main",
    question: "If package pg were excluded, which administrator deletion implementation paths disappear?"
  });
  assert.equal(excludedPackage.calls[0]?.template, "counterfactual");
  assert.equal(excludedPackage.counterfactual?.removedPaths.length, 1);
  assert.match(excludedPackage.answer, /removes 1 currently known reviewed implementation dependency path/);
  const ambiguous = await new RepositoryContextOrchestrator(store).answer({
    tenantId,
    allowedRepositories: [repository],
    repository,
    ref: "main",
    question: 'Which files implement "administrator"?'
  });
  assert.match(ambiguous.unresolvedAmbiguities[0] ?? "", /Multiple features matched/);

  const oldCommitSha = "1".repeat(40);
  await store.planIngestion({
    tenantId,
    repository,
    ref: "old",
    commitSha: oldCommitSha,
    treeSha: "2".repeat(40),
    parents: [],
    updateRef: true,
    recordedAt: "2026-07-20T00:04:00.000Z",
    taskId: "feature-old-ingest",
    files: [
      { path: "README.md", blobSha: "3".repeat(40), size: 20 },
      { path: "src/auth.ts", blobSha: "4".repeat(40), size: 40 }
    ]
  });
  await store.project({
    tenantId,
    repository,
    ref: "old",
    commitSha: oldCommitSha,
    taskId: "feature-old-project",
    generatedAt: "2026-07-20T00:04:10.000Z"
  });
  const oldFeature = await store.retrieve({
    tenantId,
    allowedRepositories: [repository],
    repository,
    ref: "old",
    template: "feature_trace",
    featureText: "administrator deletion"
  });
  assert.equal(
    oldFeature.items.length,
    0,
    "feature retrieval excludes assertions whose evidence is stale on the requested ref"
  );
});

test("causal root resolution prefers the named incident over requested result kinds", async () => {
  const repository = "omxyz/incident-fixture";
  const incidentId = "incident:github:omxyz/incident-fixture#14";
  const serviceId = "service:compose:omxyz/incident-fixture:api";
  const featureId = "repo:omxyz/incident-fixture:feature:administrator-deletion";
  const question = "Which service and feature did incident INC-2026-42 impact?";
  assert.equal(extractCausalRootText(question), "INC-2026-42");

  const graph = createContextGraph({
    request: {
      tenantId: "tenant",
      repository,
      ref: "main",
      taskId: "incident-projection"
    },
    commitSha: "a".repeat(40),
    generatedAt: "2026-07-23T00:00:00.000Z",
    executor: "projection",
    model: "fixture",
    generated: {
      summary: "incident impact",
      nodes: [
        {
          id: "repo",
          kind: "Repository",
          label: repository,
          description: repository,
          evidence: ["README.md:1"]
        },
        {
          id: incidentId,
          kind: "Incident",
          label: "INC-2026-42 administrator deletion outage",
          description: "incident 14",
          evidence: ["docs/postmortems/INC-2026-42.md:1"]
        },
        {
          id: serviceId,
          kind: "Service",
          label: "atlas-access-api",
          description: "impacted service",
          evidence: ["compose.yaml:1"]
        },
        {
          id: featureId,
          kind: "Feature",
          label: "Administrator resource deletion",
          description: "impacted feature",
          evidence: ["src/admin-deletion.ts:1"]
        }
      ],
      edges: [
        {
          source: incidentId,
          target: serviceId,
          predicate: "INCIDENT_IMPACTS",
          plane: "knowledge",
          confidence: 1,
          why: "The postmortem names the affected service.",
          evidence: ["docs/postmortems/INC-2026-42.md:2"]
        },
        {
          source: incidentId,
          target: featureId,
          predicate: "INCIDENT_IMPACTS",
          plane: "knowledge",
          confidence: 1,
          why: "The postmortem names the affected feature.",
          evidence: ["docs/postmortems/INC-2026-42.md:3"]
        }
      ]
    }
  });
  const items = causalTraceItemsFromGraph(graph, {
    tenantId: "tenant",
    allowedRepositories: [repository],
    repository,
    template: "causal_trace",
    query: question,
    rootText: "INC-2026-42",
    featureText: "service and"
  });
  const trace = items[0]?.data as unknown as CausalTraceProjection;
  assert.equal(trace.root.id, incidentId);
  assert.deepEqual(trace.affectedEntities.map((path) => path.nodes[1]?.kind).sort(), ["Feature", "Service"]);

  const answer = await new RepositoryContextOrchestrator({
    async retrieve(request: RetrievalRequest) {
      const selected = causalTraceItemsFromGraph(graph, request);
      return {
        template: request.template,
        repository,
        ref: "main",
        items: selected,
        truncated: false,
        totalBeforeLimit: selected.length,
        limit: request.limit ?? 50
      };
    }
  }).answer({
    tenantId: "tenant",
    allowedRepositories: [repository],
    repository,
    question
  });
  const orchestratedTrace = answer.calls[0]?.items[0]?.data as unknown as CausalTraceProjection;
  assert.equal(orchestratedTrace.root.id, incidentId);
  assert.deepEqual(orchestratedTrace.affectedEntities.map((path) => path.nodes[1]?.kind).sort(), [
    "Feature",
    "Service"
  ]);
});

function generatedDerivedIssue(repository: string, pullRequestNumber: number) {
  return {
    summary: `PR ${pullRequestNumber} fixes an authorization regression`,
    nodes: [
      { id: "repo", kind: "Repository" as const, label: repository, description: "repo", evidence: ["README.md:1"] },
      {
        id: String(pullRequestNumber),
        kind: "PullRequest" as const,
        label: `PR #${pullRequestNumber}`,
        description: "restores deletion",
        evidence: ["src/auth.ts:10"]
      },
      {
        id: `derived:pr:${pullRequestNumber}`,
        kind: "Issue" as const,
        label: "Administrators cannot delete resources",
        description: "Administrator deletion is incorrectly denied.",
        evidence: ["src/auth.ts:10"]
      }
    ],
    edges: [
      {
        source: String(pullRequestNumber),
        target: `derived:pr:${pullRequestNumber}`,
        predicate: "RESOLVES",
        plane: "knowledge" as const,
        confidence: 0.94,
        why: "The pull request fixes the administrator deletion regression represented by this issue.",
        evidence: ["src/auth.ts:10"]
      }
    ]
  };
}

test("canonicalizes cited causal model assertions and rejects ambiguous entity ids", () => {
  const sha = "a".repeat(40);
  const generated = {
    summary: "explicit root cause",
    nodes: [
      { id: "repo", kind: "Repository" as const, label: "demo", description: "repo", evidence: ["ROOT_CAUSE.md:1"] },
      {
        id: "issue:7",
        kind: "Issue" as const,
        label: "Issue #7",
        description: "authorization regression",
        evidence: ["ROOT_CAUSE.md:2"]
      },
      {
        id: `commit:${sha}`,
        kind: "Commit" as const,
        label: sha.slice(0, 12),
        description: "bypassed the guard",
        evidence: ["ROOT_CAUSE.md:2"]
      }
    ],
    edges: [
      {
        source: "issue:7",
        target: `commit:${sha}`,
        predicate: "INTRODUCED_BY",
        plane: "knowledge" as const,
        confidence: 0.99,
        why: "The commit bypassed the authorization guard.",
        evidence: ["ROOT_CAUSE.md:2"]
      }
    ]
  };
  const [assertion] = assertionsFromGeneratedContextGraph(generated, "omxyz/demo");
  assert.equal(assertion?.subject.naturalKey, "github:issue:omxyz/demo#7");
  assert.equal(assertion?.object.naturalKey, `repo:omxyz/demo:sha:${sha}`);
  assert.equal(assertion?.explanation, "The commit bypassed the authorization guard.");
  assert.equal(assertion?.qualifiers, undefined);
  assert.throws(
    () =>
      assertionsFromGeneratedContextGraph(
        {
          ...generated,
          nodes: generated.nodes.map((node) => (node.kind === "Commit" ? { ...node, id: "commit:short" } : node)),
          edges: [{ ...generated.edges[0]!, target: "commit:short" }]
        },
        "omxyz/demo"
      ),
    /full Git SHA/
  );
  assert.throws(
    () =>
      assertionsFromGeneratedContextGraph(
        {
          ...generated,
          edges: [
            {
              source: "issue:7",
              target: `commit:${sha}`,
              predicate: "INTRODUCED_BY",
              plane: "knowledge" as const,
              confidence: 0.99,
              evidence: ["ROOT_CAUSE.md:2"]
            }
          ]
        },
        "omxyz/demo"
      ),
    /must explain why/
  );
});

test("requires explicit root-cause records to appear as causal assertions", () => {
  const sha = "a".repeat(40);
  const anchors = requiredCausalAnchors(
    [
      {
        path: "docs/editor-root-cause.md",
        content: `GitHub issue #8 was introduced by PR #7, merged as commit ${sha}.\nThe change removed editor access.`
      },
      {
        path: "docs/audit-root-cause.md",
        content: `The regression was introduced by PR #10, merged as commit ${"b".repeat(40)}.\nNo GitHub issue was opened.`
      }
    ],
    [11]
  );
  assert.deepEqual(anchors, [
    { issueId: "8", commitSha: sha, evidencePath: "docs/editor-root-cause.md", startLine: 1, endLine: 2 },
    {
      issueId: "derived:pr:11",
      commitSha: "b".repeat(40),
      evidencePath: "docs/audit-root-cause.md",
      startLine: 1,
      endLine: 2
    }
  ]);
  assert.deepEqual(
    requiredMoveAnchors([
      { path: "README.md", content: "`../../outside.ts` moved from `src/inside.ts`." },
      { path: "README.md", content: "src/current.ts may resemble src/old.ts." }
    ]),
    []
  );
  const generated = parseGeneratedContextGraph({
    summary: "explicit causes",
    nodes: [
      {
        id: "8",
        kind: "Issue",
        label: "Editors cannot archive",
        description: "regression",
        evidence: ["docs/editor-root-cause.md:1-2"]
      },
      {
        id: sha,
        kind: "Commit",
        label: sha.slice(0, 12),
        description: "cause",
        evidence: ["docs/editor-root-cause.md:1-2"]
      }
    ],
    edges: [
      {
        source: "8",
        target: sha,
        predicate: "INTRODUCED_BY",
        plane: "knowledge",
        confidence: 0.99,
        why: "The change removed editor access.",
        evidence: ["docs/editor-root-cause.md:1-2"]
      }
    ]
  });
  assert.throws(() => validateRequiredCausalAssertions(generated, anchors), /derived:pr:11/);
  validateRequiredCausalAssertions(generated, anchors.slice(0, 1));
  const withoutFullSpan = {
    ...generated,
    edges: generated.edges.map((edge) => ({ ...edge, evidence: ["docs/editor-root-cause.md:1"] }))
  };
  assert.throws(
    () => validateRequiredCausalAssertions(withoutFullSpan, anchors.slice(0, 1)),
    /explicit root-cause evidence/
  );
});

test("validates an untracked causal issue through its explicit no-issue statement", async () => {
  const sha = "08fdf81f84b9db0c0c35e2506dfc151d9236f7ac";
  const evidencePath = "docs/cf-audit-export-root-cause.md";
  const content = [
    "# Audit exports are not chronological",
    "",
    `The audit export regression was introduced by PR #10, merged as commit ${sha}.`,
    "",
    "That change reversed the sequence comparator and returned row 3 before row 1.",
    "",
    "This change restores the ascending comparator and its regression test. No GitHub issue was opened for this repair."
  ].join("\n");
  const anchors = requiredCausalAnchors([{ path: evidencePath, content }], [11]);
  assert.deepEqual(anchors, [
    {
      issueId: "derived:pr:11",
      commitSha: sha,
      evidencePath,
      startLine: 3,
      endLine: 7
    }
  ]);
  const generated = parseGeneratedContextGraph({
    summary: "untracked audit regression",
    nodes: [
      {
        id: "repo",
        kind: "Repository",
        label: "demo",
        description: "repository",
        evidence: ["README.md:1"]
      },
      {
        id: "derived:pr:11",
        kind: "Issue",
        label: "Chronological audit exports regression",
        description: "Audit exports were returned newest-first.",
        evidence: [`${evidencePath}:1-7`]
      },
      {
        id: sha,
        kind: "Commit",
        label: sha.slice(0, 12),
        description: "Reversed the sequence comparator.",
        evidence: [`${evidencePath}:3-5`]
      }
    ],
    edges: [
      {
        source: "derived:pr:11",
        target: sha,
        predicate: "INTRODUCED_BY",
        plane: "knowledge",
        confidence: 1,
        why: "The cited change reversed the sequence comparator.",
        evidence: [`${evidencePath}:3-7`]
      }
    ]
  });
  validateRequiredCausalAssertions(generated, anchors);
  await validateContextGraphEvidence(generated, async (path) => {
    if (path === evidencePath) return content;
    if (path === "README.md") return "demo";
    throw new Error(`unexpected evidence path: ${path}`);
  });
});

test("materializes explicit causal contracts and drops malformed optional causal edges", async () => {
  const sha = "c".repeat(40);
  const evidencePath = "docs/audit-root-cause.md";
  const content = `Issue derived:pr:11 was introduced by commit ${sha}.\nThe comparator reversed chronological order.`;
  const generated = parseGeneratedContextGraph({
    summary: "model output with an omitted contract",
    nodes: [
      {
        id: "repo",
        kind: "Repository",
        label: "demo",
        description: "repository",
        evidence: ["README.md:1"]
      },
      {
        id: "feature:audit-export",
        kind: "Feature",
        label: "Audit export",
        description: "exports audit rows",
        evidence: ["README.md:1"]
      }
    ],
    edges: [
      {
        source: "feature:audit-export",
        target: "repo",
        predicate: "INTRODUCED_BY",
        plane: "knowledge",
        why: "malformed model edge",
        evidence: ["README.md:1"]
      }
    ]
  });
  const anchors = [{ issueId: "derived:pr:11", commitSha: sha, evidencePath, startLine: 1, endLine: 2 }] as const;

  const materialized = materializeRequiredCausalAssertions(generated, anchors);

  assert.equal(materialized.edges.length, 2);
  assert.ok(
    materialized.edges.some(
      (edge) => edge.predicate === "INTRODUCED_BY" && edge.source === "derived:pr:11" && edge.target === sha
    )
  );
  assert.ok(
    materialized.edges.some(
      (edge) => edge.predicate === "RESOLVED_BY" && edge.source === "derived:pr:11" && edge.target === "11"
    )
  );
  assert.equal(materialized.nodes.find((node) => node.id === "derived:pr:11")?.kind, "Issue");
  assert.equal(materialized.nodes.find((node) => node.id === sha)?.kind, "Commit");
  assert.equal(materialized.nodes.find((node) => node.id === "11")?.kind, "PullRequest");
  validateRequiredCausalAssertions(materialized, anchors);
  validateRequiredDerivedIssues(
    materialized,
    [
      {
        id: "pr-11",
        source: "github",
        type: "pull_request",
        repository: "org/repo",
        payloadSha: "payload",
        payload: {
          kind: "pull_request",
          number: 11,
          title: "Restore chronological audit exports",
          body: "Restores the broken audit order without a tracked issue.",
          mergedAt: "2026-07-21T01:28:05Z",
          resolvesIssueNumbers: [],
          referencesIssueNumbers: []
        }
      }
    ],
    [11]
  );
  await validateContextGraphEvidence(materialized, async (path) => {
    if (path === evidencePath) return content;
    if (path === "README.md") return "demo";
    throw new Error(`unexpected evidence path: ${path}`);
  });
});

test("normalizes complete incident deployment history independently of model evidence budgets", () => {
  const evidencePath = "docs/postmortems/INC-2026-42.md";
  const content = [
    "---",
    "incident_id: INC-2026-42",
    "issue: #14",
    "---",
    "# Administrator deletion outage",
    `Incident INC-2026-42 was introduced by Deployment deployment:github:omxyz/jina-ontology-e2e:5535506368, which deployed commit ${"a".repeat(40)}.`,
    `Incident INC-2026-99 was resolved by Deployment deployment:github:omxyz/jina-ontology-e2e:999, which shipped commit ${"c".repeat(40)}.`,
    ...Array.from({ length: 80 }, (_, index) => `Detailed timeline entry ${index + 1}: investigation continued.`),
    `Incident INC-2026-42 was resolved by Deployment deployment:github:omxyz/jina-ontology-e2e:5535522601, which shipped commit ${"b".repeat(40)}.`
  ].join("\n");
  assert.ok(content.indexOf("5535522601") > 500, "recovery evidence is beyond the generic prompt prefix budget");
  const observations = parseIncidentDocumentObservations({
    tenantId: "t",
    repository: "omxyz/jina-context-graph-e2e",
    path: evidencePath,
    content,
    recordedAt: "2026-07-22T00:00:00Z"
  });
  const incident = observations.find((observation) => observation.kind === "incident");
  assert.ok(incident);
  const normalized = normalizeSourceObservation(incident);
  assert.deepEqual(
    normalized.assertions
      .filter((assertion) => assertion.object.kind === "Deployment")
      .map((assertion) => [assertion.subject.key, assertion.predicate, assertion.object.key]),
    [
      [
        "incident:github:omxyz/jina-context-graph-e2e#14",
        "INTRODUCED_BY",
        "deployment:github:omxyz/jina-ontology-e2e:5535506368"
      ],
      [
        "incident:github:omxyz/jina-context-graph-e2e#14",
        "RESOLVED_BY",
        "deployment:github:omxyz/jina-ontology-e2e:5535522601"
      ]
    ]
  );
  assert.equal(
    normalized.assertions.find((assertion) => assertion.predicate === "INTRODUCED_BY")?.qualifiers?.reason,
    undefined
  );
});

test("materializes explicit file move continuity from repository evidence", async () => {
  const evidencePath = "README.md";
  const content = "`src/admin-deletion.ts` moved from `src/legacy-admin-deletion.ts` while retaining the same feature.";
  const anchors = requiredMoveAnchors([
    { path: evidencePath, content },
    {
      path: "docs/migration.md",
      content: "The implementation moved from `src/legacy-admin-deletion.ts` to `src/admin-deletion.ts`."
    }
  ]);
  assert.deepEqual(anchors, [
    {
      currentPath: "src/admin-deletion.ts",
      previousPath: "src/legacy-admin-deletion.ts",
      evidencePath,
      startLine: 1,
      endLine: 1
    }
  ]);

  const generated = parseGeneratedContextGraph({
    summary: "model output omitted explicit move continuity",
    nodes: [
      {
        id: "repo",
        kind: "Repository",
        label: "demo",
        description: "repository",
        evidence: ["README.md:1"]
      }
    ],
    edges: []
  });
  const materialized = materializeRequiredMoveAssertions(generated, anchors);
  validateRequiredMoveAssertions(materialized, anchors);
  assert.equal(
    materialized.edges.some(
      (edge) =>
        edge.predicate === "MOVED_FROM" &&
        edge.source === "file:src/admin-deletion.ts" &&
        edge.target === "file:src/legacy-admin-deletion.ts"
    ),
    true
  );
  const assertions = assertionsFromGeneratedContextGraph(materialized, "omxyz/demo");
  assert.deepEqual(
    assertions.map((assertion) => [assertion.subject.naturalKey, assertion.predicate, assertion.object.naturalKey]),
    [["repo:omxyz/demo:path:src/admin-deletion.ts", "MOVED_FROM", "repo:omxyz/demo:path:src/legacy-admin-deletion.ts"]]
  );
  await validateContextGraphEvidence(materialized, async (path) => {
    if (path === evidencePath) return content;
    throw new Error(`unexpected evidence path: ${path}`);
  });
});

test("creates a stable graph and removes dangling edges", () => {
  const generated = parseGeneratedContextGraph({
    summary: "A small service",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      {
        id: "file:src/app.ts",
        kind: "File",
        label: "app.ts",
        description: "entry",
        path: "src/app.ts",
        evidence: ["src/app.ts:1"]
      }
    ],
    edges: [
      { source: "repo", target: "file:src/app.ts", predicate: "contains", plane: "code", evidence: ["src/app.ts:1"] },
      { source: "missing", target: "repo", predicate: "references", plane: "knowledge", evidence: ["README.md:1"] }
    ]
  });
  const graph = createContextGraph({
    request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId: "task" },
    commitSha: "abc",
    generatedAt: "2026-01-01T00:00:00.000Z",
    executor: "fixture",
    model: "fixture",
    generated
  });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.predicate, "CONTAINS");
  assert.match(graph.id, /^graph_/);
});

test("projection includes every ingested file and parsed symbol without arbitrary caps", async () => {
  const store = new MemoryContextGraphStore();
  const tenantId = "complete-projection-tenant";
  const repository = "omxyz/complete-projection";
  const commitSha = "a".repeat(40);
  const files = Array.from({ length: 90 }, (_, fileIndex) => ({
    path: `src/file-${fileIndex}.ts`,
    blobSha: fileIndex.toString(16).padStart(40, "0"),
    size: 100
  }));
  await store.planIngestion({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    treeSha: "b".repeat(40),
    parents: [],
    updateRef: true,
    recordedAt: "2026-07-24T00:00:00.000Z",
    taskId: "complete-ingest",
    files
  });
  await store.applyBlobAnalyses(
    { tenantId, repository, commitSha },
    files.map((file, fileIndex) => ({
      blobSha: file.blobSha,
      parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
      language: "typescript",
      symbols: Array.from({ length: 3 }, (_, symbolIndex) => ({
        moniker: `symbol-${fileIndex}-${symbolIndex}`,
        name: `symbol${symbolIndex}`,
        kind: "function",
        signatureHash: `${fileIndex}-${symbolIndex}`.padEnd(64, "0"),
        startLine: symbolIndex + 1,
        endLine: symbolIndex + 1
      })),
      imports: [],
      edges: []
    }))
  );
  const graph = await store.project({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    taskId: "complete-project",
    generatedAt: "2026-07-24T00:01:00.000Z"
  });
  assert.equal(graph.nodes.filter((node) => node.kind === "File").length, 90);
  assert.equal(graph.nodes.filter((node) => node.kind === "Symbol").length, 270);
});

test("keeps graph generations immutable per task", () => {
  const generated = parseGeneratedContextGraph({
    summary: "repo",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "readme", kind: "File", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  const build = (taskId: string) =>
    createContextGraph({
      request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId },
      commitSha: "abc",
      generatedAt: "2026-01-01T00:00:00.000Z",
      executor: "fixture" as const,
      model: "fixture",
      generated
    });
  assert.notEqual(build("task-1").id, build("task-2").id);
});

test("content-addresses identical projection generations across worker tasks", () => {
  const generated = parseGeneratedContextGraph({
    summary: "repo",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "readme", kind: "File", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  const build = (taskId: string) =>
    createContextGraph({
      request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId },
      commitSha: "abc",
      generatedAt: "2026-01-01T00:00:00.000Z",
      executor: "projection" as const,
      model: "current-graph-v1",
      contentAddressed: true,
      generated
    });
  assert.equal(build("task-1").id, build("task-2").id);
  const reordered = { ...generated, nodes: [...generated.nodes].reverse(), edges: [...generated.edges].reverse() };
  assert.equal(
    build("task-1").id,
    createContextGraph({
      request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId: "task-3" },
      commitSha: "abc",
      generatedAt: "2026-01-01T00:00:00.000Z",
      executor: "projection",
      model: "current-graph-v1",
      contentAddressed: true,
      generated: reordered
    }).id
  );
  assert.notEqual(
    build("task-1").id,
    createContextGraph({
      request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId: "task-4" },
      commitSha: "abc",
      generatedAt: "2026-01-01T00:00:00.000Z",
      executor: "projection",
      model: "current-graph-v1",
      contentAddressed: true,
      generated: {
        ...generated,
        nodes: generated.nodes.map((node) => (node.id === "readme" ? { ...node, label: "Changed README" } : node))
      }
    }).id
  );
});

test("does not overwrite an existing graph generation", async () => {
  const generated = parseGeneratedContextGraph({
    summary: "first",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "readme", kind: "File", label: "README", description: "docs", evidence: ["README.md:1"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  const graph = createContextGraph({
    request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId: "task" },
    commitSha: "abc",
    generatedAt: "2026-01-01T00:00:00.000Z",
    executor: "fixture",
    model: "fixture",
    generated
  });
  const store = new MemoryContextGraphStore();
  await store.save(graph);
  await store.save({ ...graph, summary: "replacement" });
  assert.equal((await store.get(graph.id, "tenant"))?.summary, "first");
});

test("validates citations against repository files", async () => {
  const generated = parseGeneratedContextGraph({
    summary: "repo",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:2"] },
      {
        id: "readme",
        kind: "File",
        label: "README",
        description: "docs",
        path: "README.md",
        evidence: ["README.md:1-2"]
      }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  await validateContextGraphEvidence(generated, async () => "line one\nline two");
  await assert.rejects(
    validateContextGraphEvidence(generated, async () => "one line"),
    /outside README\.md/
  );
  assert.throws(
    () =>
      parseGeneratedContextGraph({
        summary: "bad",
        nodes: [{ id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: [] }],
        edges: []
      }),
    /must include evidence/
  );
});

test("requires causal evidence to name the issue and offending commit", async () => {
  const sha = "3".repeat(40);
  const generated = parseGeneratedContextGraph({
    summary: "root cause",
    nodes: [
      { id: "4", kind: "Issue", label: "Issue #4", description: "regression", evidence: ["docs/root-cause.md:1"] },
      {
        id: sha,
        kind: "Commit",
        label: sha.slice(0, 12),
        description: "offending change",
        evidence: ["docs/root-cause.md:1"]
      }
    ],
    edges: [
      {
        source: "4",
        target: sha,
        predicate: "INTRODUCED_BY",
        plane: "knowledge",
        confidence: 0.99,
        why: "The commit removed the administrator bypass.",
        evidence: ["docs/root-cause.md:1-2"]
      }
    ]
  });
  await validateContextGraphEvidence(
    generated,
    async () => `Issue #4 was caused by commit ${sha}.\nThe commit removed the administrator bypass.`
  );
  await assert.rejects(
    validateContextGraphEvidence(
      generated,
      async () => "Issue #4 was caused by an earlier change.\nThe administrator bypass was removed."
    ),
    /explicitly name Issue #4 and commit/
  );
  const derived = parseGeneratedContextGraph({
    summary: "derived root cause",
    nodes: [
      {
        id: "derived:pr:42",
        kind: "Issue",
        label: "Administrators cannot delete resources",
        description: "Administrator deletion is incorrectly denied.",
        evidence: ["docs/root-cause.md:1"]
      },
      {
        id: sha,
        kind: "Commit",
        label: sha.slice(0, 12),
        description: "offending change",
        evidence: ["docs/root-cause.md:1"]
      }
    ],
    edges: [
      {
        source: "derived:pr:42",
        target: sha,
        predicate: "INTRODUCED_BY",
        plane: "knowledge",
        confidence: 0.99,
        why: "The commit removed the administrator bypass.",
        evidence: ["docs/root-cause.md:1-2"]
      }
    ]
  });
  await validateContextGraphEvidence(
    derived,
    async () =>
      `Administrators cannot delete resources was caused by commit ${sha}.\nThe commit removed the administrator bypass.`
  );
  await assert.rejects(
    validateContextGraphEvidence(
      derived,
      async () => `A deletion bug was caused by commit ${sha}.\nThe commit removed the administrator bypass.`
    ),
    /explicitly name Issue Administrators cannot delete resources and commit/
  );
  const incident = parseGeneratedContextGraph({
    summary: "deployment incident",
    nodes: [
      {
        id: "incident:github:org/repo#14",
        kind: "Incident",
        label: "INC-42 deletion outage",
        description: "incident",
        evidence: ["docs/postmortem.md:1"]
      },
      {
        id: "deployment:github:5535506368",
        kind: "Deployment",
        label: "deployment 5535506368",
        description: "production deployment",
        evidence: ["docs/postmortem.md:1"]
      }
    ],
    edges: [
      {
        source: "incident:github:org/repo#14",
        target: "deployment:github:5535506368",
        predicate: "INTRODUCED_BY",
        plane: "knowledge",
        confidence: 0.95,
        why: "The deployment shipped the administrator denial path.",
        evidence: ["docs/postmortem.md:1"]
      }
    ]
  });
  await validateContextGraphEvidence(
    incident,
    async () =>
      "Incident INC-42 deletion outage was introduced by Deployment deployment:github:5535506368 because it shipped the administrator denial path."
  );
});

test("requires a derived Issue proposal for an explicit untracked repair", () => {
  const repairSha = "a".repeat(40);
  const sourceEvidence = [
    {
      id: "observation-pr-42",
      source: "github",
      type: "pull_request",
      repository: "org/repo",
      payloadSha: "payload",
      payload: {
        kind: "pull_request",
        number: 42,
        title: "Restore administrator deletion",
        body: "Repairs a regression where administrators cannot delete resources.",
        mergedAt: "2026-07-20T00:00:00Z",
        commitShas: [repairSha],
        resolvesIssueNumbers: []
      }
    }
  ];
  const base = parseGeneratedContextGraph({
    summary: "repair",
    nodes: [
      { id: "repo", kind: "Repository", label: "repo", description: "repo", evidence: ["tests/regression.test.ts:1"] }
    ],
    edges: []
  });
  assert.throws(
    () => validateRequiredDerivedIssues(base, sourceEvidence, [42]),
    /requires derived Issue derived:pr:42/
  );
  const complete = parseGeneratedContextGraph({
    summary: "repair",
    nodes: [
      ...base.nodes,
      {
        id: "42",
        kind: "PullRequest",
        label: "PR #42",
        description: "repair",
        evidence: ["tests/regression.test.ts:1"]
      },
      {
        id: "derived:pr:42",
        kind: "Issue",
        label: "Administrators cannot delete resources",
        description: "Deletion is incorrectly denied.",
        evidence: ["tests/regression.test.ts:1"]
      }
    ],
    edges: [
      {
        source: "42",
        target: "derived:pr:42",
        predicate: "RESOLVES",
        plane: "knowledge",
        confidence: 0.98,
        why: null,
        evidence: ["tests/regression.test.ts:1"]
      }
    ]
  });
  assert.doesNotThrow(() => validateRequiredDerivedIssues(complete, sourceEvidence, [42]));
  assert.doesNotThrow(
    () => validateRequiredDerivedIssues(base, sourceEvidence, [43]),
    "problem evidence from an unrelated PR must not force a derived issue"
  );
  assert.doesNotThrow(() =>
    validateRequiredDerivedIssues(
      base,
      [
        {
          ...sourceEvidence[0]!,
          payload: { ...sourceEvidence[0]!.payload, title: "Set up baseline", body: "This is not a bug fix." }
        }
      ],
      [42]
    )
  );
});

test("reuses parsed blobs and projects canonical code facts plus active agent assertions", async () => {
  const store = new MemoryContextGraphStore();
  const snapshot = {
    tenantId: "tenant",
    repository: "omxyz/demo",
    ref: "main",
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    parents: [],
    recordedAt: "2026-07-19T00:00:00.000Z",
    taskId: "ingest-task",
    files: [
      { path: "README.md", blobSha: "c".repeat(40), size: 10 },
      { path: "src/index.ts", blobSha: "d".repeat(40), size: 20 }
    ]
  };
  const first = await store.planIngestion(snapshot);
  assert.equal(first.missingBlobs.length, 2);
  assert.deepEqual(first.changedPaths, ["README.md", "src/index.ts"]);
  await store.applyBlobAnalyses(snapshot, [
    {
      blobSha: "c".repeat(40),
      parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
      language: "markdown",
      symbols: [],
      imports: [],
      edges: []
    },
    {
      blobSha: "d".repeat(40),
      parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
      language: "typescript",
      symbols: [
        { moniker: "main", name: "main", kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 1 }
      ],
      imports: [],
      edges: []
    }
  ]);
  const replay = await store.planIngestion({ ...snapshot, taskId: "retry-task" });
  assert.equal(replay.missingBlobs.length, 0);
  assert.equal(replay.reusedBlobCount, 2);

  const assertions = await store.saveAssertionBatch({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    taskId: "assert-task",
    generatedAt: "2026-07-19T00:01:00.000Z",
    generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint: "evidence-fixture",
    evidenceObservationIds: [],
    model: "fixture",
    summary: "README documents the repository",
    rawOutput: {
      summary: "README documents the repository",
      nodes: [
        { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
        {
          id: "readme",
          kind: "Document",
          label: "README",
          description: "docs",
          path: "README.md",
          evidence: ["README.md:1"]
        }
      ],
      edges: [
        {
          source: "repo",
          target: "readme",
          predicate: "DOCUMENTED_BY",
          plane: "knowledge",
          confidence: 0.95,
          evidence: ["README.md:1"]
        }
      ]
    },
    assertions: [
      {
        subject: { kind: "Repository", naturalKey: `github:repo:${snapshot.repository}`, label: "demo" },
        predicate: "DOCUMENTED_BY",
        object: { kind: "Document", naturalKey: `repo:${snapshot.repository}:path:README.md`, label: "README" },
        confidence: 0.95,
        explanation: "The README explicitly documents this repository.",
        evidence: ["README.md:1"]
      }
    ]
  });
  assert.equal(assertions.activeCount, 1);
  assert.equal(assertions.proposedCount, 0);
  assert.equal(
    (
      await store.hasAssertionGeneration(
        snapshot.tenantId,
        snapshot.repository,
        snapshot.commitSha,
        CONTEXT_GRAPH_GENERATOR_VERSION,
        CONTEXT_GRAPH_REGISTRY_VERSION,
        "evidence-fixture"
      )
    )?.cached,
    true
  );
  assert.equal(
    await store.hasAssertionGeneration(
      snapshot.tenantId,
      snapshot.repository,
      snapshot.commitSha,
      CONTEXT_GRAPH_GENERATOR_VERSION,
      CONTEXT_GRAPH_REGISTRY_VERSION,
      "different-evidence"
    ),
    undefined
  );
  assert.equal(
    await store.hasAssertionGeneration(
      snapshot.tenantId,
      snapshot.repository,
      snapshot.commitSha,
      CONTEXT_GRAPH_GENERATOR_VERSION,
      "different-registry",
      "evidence-fixture"
    ),
    undefined
  );

  const graph = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    taskId: "project-task",
    generatedAt: "2026-07-19T00:02:00.000Z"
  });
  assert.equal(graph.generator.executor, "projection");
  assert.equal(
    graph.nodes.some((node) => node.kind === "Symbol" && node.label === "main"),
    true
  );
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.plane === "knowledge" &&
        edge.predicate === "DOCUMENTED_BY" &&
        edge.qualifiers?.assertionStatus === "active"
    ),
    true
  );
  const repeatedGraph = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    taskId: "second-project-task",
    generatedAt: "2026-07-19T00:02:30.000Z"
  });
  assert.equal(repeatedGraph.id, graph.id);
  assert.equal(
    (await store.list(snapshot.tenantId)).length,
    1,
    "identical projection content does not create a second graph generation"
  );

  const nextSnapshot = {
    ...snapshot,
    commitSha: "e".repeat(40),
    treeSha: "f".repeat(40),
    parents: [snapshot.commitSha],
    taskId: "next-ingest",
    files: [snapshot.files[0]!, { path: "src/index.ts", blobSha: "1".repeat(40), size: 21 }]
  };
  const nextPlan = await store.planIngestion(nextSnapshot);
  assert.deepEqual(
    nextPlan.missingBlobs.map((blob) => blob.path),
    ["src/index.ts"]
  );
  assert.deepEqual(nextPlan.changedPaths, ["src/index.ts"]);
  await store.applyBlobAnalyses(nextSnapshot, [
    {
      blobSha: "1".repeat(40),
      parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
      language: "typescript",
      symbols: [
        { moniker: "main", name: "main", kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 1 }
      ],
      imports: [],
      edges: []
    }
  ]);
  const carried = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: nextSnapshot.commitSha,
    taskId: "next-project",
    generatedAt: "2026-07-19T00:03:00.000Z"
  });
  assert.equal(
    carried.edges.some((edge) => edge.predicate === "DOCUMENTED_BY" && edge.qualifiers?.assertionStatus === "active"),
    true,
    "current evidence-backed model assertions remain active"
  );

  const changedReadme = {
    ...nextSnapshot,
    commitSha: "2".repeat(40),
    treeSha: "3".repeat(40),
    parents: [nextSnapshot.commitSha],
    taskId: "readme-ingest",
    files: [{ path: "README.md", blobSha: "4".repeat(40), size: 11 }, nextSnapshot.files[1]!]
  };
  await store.planIngestion(changedReadme);
  const withoutStaleAssertion = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: changedReadme.commitSha,
    taskId: "readme-project",
    generatedAt: "2026-07-19T00:04:00.000Z"
  });
  assert.equal(
    withoutStaleAssertion.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"),
    false,
    "changed cited blobs invalidate old assertions"
  );
});

test("summary listings scope by repository and ref before any result limit", async () => {
  const store = new MemoryContextGraphStore();
  const generated = parseGeneratedContextGraph({
    summary: "repo",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "readme", kind: "File", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  const build = (repository: string, ref: string, generatedAt: string, tenantId = "tenant") =>
    createContextGraph({
      request: { tenantId, repository, ref, taskId: `task-${tenantId}-${repository}-${ref}` },
      commitSha: "abc",
      generatedAt,
      executor: "fixture",
      model: "fixture",
      generated
    });
  await store.save(build("omxyz/e2e", "main", "2026-01-01T00:00:00.000Z"));
  await store.save(build("omxyz/other", "main", "2026-01-02T00:00:00.000Z"));
  await store.save(build("omxyz/e2e", "dev", "2026-01-03T00:00:00.000Z"));
  await store.save(build("external/repo", "main", "2026-01-04T00:00:00.000Z", "external-tenant"));
  await store.save(build("external/repo", "main", "2025-01-04T00:00:00.000Z", "external-tenant"));

  const scoped = await store.listSummaries("tenant", { repository: "omxyz/e2e", ref: "main" });
  assert.deepEqual(
    scoped.map((summary) => [summary.repository, summary.ref]),
    [["omxyz/e2e", "main"]]
  );
  const repositoryOnly = await store.listSummaries("tenant", { repository: "omxyz/e2e" });
  assert.deepEqual(
    repositoryOnly.map((summary) => summary.ref),
    ["dev", "main"]
  );
  assert.equal((await store.listSummaries("tenant")).length, 3);
  assert.deepEqual(
    (await store.listAllSummaries()).map((summary) => summary.tenantId),
    ["external-tenant", "tenant", "tenant", "tenant"]
  );
});

test("global workflow history paginates across tenants and preserves operational filters", async () => {
  const coordinator = new MemoryContextGraphPipelineCoordinator();
  for (const build of [
    {
      tenantId: "tenant-a",
      repository: "omxyz/a",
      requestKey: "admin-a",
      createdAt: "2026-07-23T00:00:00.000Z",
      metadata: { source: "manual" }
    },
    {
      tenantId: "tenant-b",
      repository: "external/b",
      requestKey: "push-b",
      createdAt: "2026-07-23T01:00:00.000Z",
      metadata: { source: "github push" }
    },
    {
      tenantId: "tenant-c",
      repository: "external/c",
      requestKey: "schedule-c",
      createdAt: "2026-07-23T02:00:00.000Z",
      metadata: { source: "scheduled" }
    }
  ]) {
    await coordinator.createBuild({
      ...build,
      ref: "main",
      snapshotFirst: true
    });
  }

  const first = await coordinator.listGlobal({ limit: 2 });
  assert.deepEqual(
    first.workflows.map(({ build }) => build.tenantId),
    ["tenant-c", "tenant-b"]
  );
  assert.ok(first.nextCursor);
  const second = await coordinator.listGlobal({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    second.workflows.map(({ build }) => build.tenantId),
    ["tenant-a"]
  );
  assert.equal(second.nextCursor, undefined);
  assert.deepEqual(
    (await coordinator.listGlobal({ limit: 10, trigger: "webhook" })).workflows.map(({ build }) => build.repository),
    ["external/b"]
  );
  assert.equal(await coordinator.countActive(), 3);
  assert.equal(await coordinator.countActive("tenant-b"), 1);
});
