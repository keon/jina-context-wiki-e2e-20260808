import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DeriveKnowledgeService,
  EvidenceFocusSelector,
  FallbackHierarchyIndexer,
  IndexContextService,
  IngestEvidenceService,
  KnowledgeOutputValidator,
  MemoryContextEngineStore,
  MemoryContextOutbox,
  MemoryContextPipelineCoordinator,
  PageIndexHierarchyAdapter,
  QueryContextService,
  StaticScopeAuthorizer,
  assembleEvidencePack,
  contextQueueTopics,
  contextTaskTypeDefinitions,
  contextTaskTypes,
  createKnowledgeCitation,
  createKnowledgeRevision,
  detectSourceConflicts,
  fingerprint,
  fuseRetrievalCandidates,
  parseGeneratedKnowledgeDocuments,
  planContextQuery,
  stableId,
  validateEvidenceAnchor,
  verifySynthesisCitations,
  type EvidenceAnchor,
  type HierarchyBuildInput,
  type KnowledgeDocumentGenerator,
  type KnowledgeGenerationOutput,
  type RetrievalCandidate
} from "./index.js";

const tenantId = "tenant-a";
const repository = "acme/repo";
const commitSha = "a".repeat(40);
const blobSha = "b".repeat(40);
const createdAt = "2026-07-26T12:00:00.000Z";
const source = ["# Billing", "", "export function handlePayment(total: number) {", "  return total > 0;", "}"].join(
  "\n"
);

async function ingestFixture(store: MemoryContextEngineStore, aclFingerprint = "acl-public") {
  return new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    aclFingerprint,
    observationFrontier: "github:100",
    sourceComplete: true,
    createdAt,
    files: [
      {
        path: "README.md",
        blobSha: "c".repeat(40),
        body: "# Repository\n\nThe billing module accepts payments.",
        language: "markdown"
      },
      {
        path: "src/billing.ts",
        blobSha,
        body: source,
        language: "typescript"
      }
    ],
    observations: [
      {
        sourceType: "issue",
        sourceId: "issue-42",
        title: "Issue #42",
        payload: { number: 42, state: "open", title: "Retry payments" },
        pathOrUrl: "https://example.test/acme/repo/issues/42",
        observedAt: createdAt,
        metadata: { claimSubject: "issue:42:state", claimValue: "open" }
      }
    ]
  });
}

function validOutput(): KnowledgeGenerationOutput {
  const claim = "handlePayment accepts a positive total in src/billing.ts.";
  return {
    documents: [
      {
        logicalId: "component:acme/repo:billing",
        kind: "component",
        title: "Billing component",
        summary: "Payment handling",
        bodyMarkdown: `${claim} The implementation is source-cited.`,
        structuredSummary: { entrypoint: "handlePayment" },
        scope: {
          paths: ["src/billing.ts"],
          symbols: ["handlePayment"],
          pullRequests: [],
          issues: []
        },
        confidence: 0.93,
        citations: [
          {
            claim,
            sourceType: "blob",
            sourceId: blobSha,
            pathOrUrl: "src/billing.ts",
            startLine: 3,
            endLine: 5
          }
        ]
      }
    ]
  };
}

class SequenceGenerator implements KnowledgeDocumentGenerator {
  readonly name = "fixture-generator";
  readonly version = "1";
  readonly model = "fixture-model";
  calls = 0;

  constructor(private readonly outputs: unknown[]) {}

  async generate(): Promise<unknown> {
    const output = this.outputs[Math.min(this.calls, this.outputs.length - 1)];
    this.calls += 1;
    return output;
  }
}

async function deriveFixture(store: MemoryContextEngineStore, checkpointId: string) {
  const generator = new SequenceGenerator([validOutput()]);
  const run = await new DeriveKnowledgeService(
    new EvidenceFocusSelector(store),
    generator,
    store,
    new KnowledgeOutputValidator(store)
  ).derive(checkpointId, "2026-07-26T12:01:00.000Z");
  assert.equal(run.status, "succeeded");
  return run;
}

test("evidence anchors enforce digest, commit, path, and range invariants", () => {
  const anchor: EvidenceAnchor = {
    tenantId,
    repository,
    sourceType: "blob",
    sourceId: blobSha,
    contentDigest: fingerprint(source),
    commitSha,
    pathOrUrl: "src/billing.ts",
    startLine: 1,
    endLine: 2
  };
  assert.deepEqual(validateEvidenceAnchor(anchor), anchor);
  assert.throws(() => validateEvidenceAnchor({ ...anchor, contentDigest: "short" }), /SHA-256/);
  assert.throws(() => validateEvidenceAnchor({ ...anchor, commitSha: "abc" }), /full Git SHA/);
  const { pathOrUrl: _path, ...withoutPath } = anchor;
  assert.throws(() => validateEvidenceAnchor(withoutPath), /require pathOrUrl/);
  assert.throws(() => validateEvidenceAnchor({ ...anchor, startLine: 4, endLine: 2 }), /must not precede/);
});

test("ingestion is content-addressed, idempotent, and produces deterministic structure", async () => {
  const store = new MemoryContextEngineStore();
  const service = new IngestEvidenceService(store);
  const checkpoint = await ingestFixture(store);
  const repeated = await ingestFixture(store);
  assert.equal(repeated.id, checkpoint.id);
  assert.equal((await store.listManifest(checkpoint.id)).length, 2);
  const facts = await store.listStructuralFacts(checkpoint.id);
  assert.ok(facts.some((fact) => fact.kind === "defines" && fact.to.endsWith("#handlePayment")));
  assert.equal((await store.listEvidence(checkpoint.id)).length, 3);
  await assert.rejects(
    () =>
      service.ingest({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        aclFingerprint: "acl",
        observationFrontier: "x",
        sourceComplete: false,
        createdAt,
        files: []
      }),
    /incomplete/
  );
});

test("provider JSON pointers resolve against immutable raw observations", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const resolved = await store.resolveAnchor(checkpoint.id, {
    tenantId,
    repository,
    sourceType: "issue",
    sourceId: "issue-42",
    commitSha,
    jsonPointer: "/state"
  });
  assert.ok(resolved);
  assert.equal(
    await store.resolveAnchor(checkpoint.id, {
      tenantId,
      repository,
      sourceType: "issue",
      sourceId: "issue-42",
      commitSha,
      jsonPointer: "/missing"
    }),
    undefined
  );
});

test("generated document parsing rejects relation-shaped and malformed output", () => {
  assert.deepEqual(parseGeneratedKnowledgeDocuments(validOutput()), validOutput());
  assert.throws(() => parseGeneratedKnowledgeDocuments({ documents: [], nodes: [] }), /nodes is prohibited/);
  assert.throws(() => parseGeneratedKnowledgeDocuments({ documents: [{ kind: "component" }] }), /citations|logicalId/);
});

test("derivation repairs once, validates source ranges, and caches immutable input", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const generator = new SequenceGenerator([{ documents: [{ invalid: true }] }, validOutput()]);
  const service = new DeriveKnowledgeService(
    new EvidenceFocusSelector(store),
    generator,
    store,
    new KnowledgeOutputValidator(store)
  );
  const run = await service.derive(checkpoint.id, "2026-07-26T12:01:00.000Z");
  assert.equal(run.status, "succeeded");
  assert.equal(generator.calls, 2);
  assert.equal(run.rawOutputs.length, 2);
  const cached = await service.derive(checkpoint.id, "2026-07-26T13:00:00.000Z");
  assert.equal(cached.id, run.id);
  assert.equal(generator.calls, 2);
  const revision = await store.getRevision(run.revisionIds[0]!);
  assert.ok(revision);
  assert.equal(revision.scope.commitSha, commitSha);
  assert.equal((await store.listCitations(revision.id))[0]?.anchor.contentDigest, fingerprint(source));
});

test("derivation fails closed after one repair and writes no revision", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const mutated = validOutput();
  mutated.documents[0]!.citations[0]!.endLine = 99;
  const generator = new SequenceGenerator([mutated, mutated]);
  const run = await new DeriveKnowledgeService(
    new EvidenceFocusSelector(store),
    generator,
    store,
    new KnowledgeOutputValidator(store)
  ).derive(checkpoint.id, "2026-07-26T12:01:00.000Z");
  assert.equal(run.status, "failed");
  assert.equal(generator.calls, 2);
  assert.deepEqual(await store.listRevisions(tenantId, repository), []);
});

test("unsupported material paragraphs are rejected", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const unsupported = validOutput();
  unsupported.documents[0]!.bodyMarkdown += "\n\nThis unrelated paragraph has no supporting claim.";
  await assert.rejects(
    () =>
      new KnowledgeOutputValidator(store).validate({
        output: unsupported,
        checkpointId: checkpoint.id,
        generatorName: "test",
        generatorVersion: "1",
        model: "test",
        promptVersion: "1",
        createdAt
      }),
    /unsupported paragraph/
  );
});

test("high-risk knowledge is excluded until an append-only review event exists", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const record = (await store.listEvidence(checkpoint.id)).find((value) => value.anchor.sourceId === blobSha)!;
  const revision = createKnowledgeRevision({
    logicalId: "ownership:acme/repo:billing",
    tenantId,
    repository,
    kind: "ownership",
    title: "Billing ownership",
    bodyMarkdown: "Team Payments owns billing.",
    summary: "Billing ownership",
    structuredSummary: {},
    scope: { ref: "main", commitSha, paths: ["src/billing.ts"], symbols: [], pullRequests: [], issues: [] },
    evidenceFingerprint: fingerprint(record.anchor),
    generatorName: "test",
    generatorVersion: "1",
    model: "test",
    promptVersion: "1",
    confidence: 1,
    createdAt
  });
  const citation = createKnowledgeCitation(revision.id, 0, "Team Payments owns billing.", record.anchor);
  await store.commitKnowledge({
    run: {
      id: "run-own",
      tenantId,
      repository,
      checkpointId: checkpoint.id,
      cacheKey: "own",
      focusFingerprint: "focus",
      generatorName: "test",
      generatorVersion: "1",
      model: "test",
      promptVersion: "1",
      schemaVersion: "1",
      rawOutputs: [],
      status: "succeeded",
      diagnostics: [],
      revisionIds: [revision.id],
      createdAt
    },
    revisions: [revision],
    citations: [citation]
  });
  assert.deepEqual(await store.listCurrentEligibleRevisions(tenantId, repository), []);
  await store.appendRevisionEvent({
    id: "review-1",
    revisionId: revision.id,
    sequence: 1,
    type: "reviewed",
    actorId: "reviewer",
    reason: "verified against CODEOWNERS",
    createdAt
  });
  assert.deepEqual(
    (await store.listCurrentEligibleRevisions(tenantId, repository)).map((value) => value.id),
    [revision.id]
  );
  await assert.rejects(
    () =>
      store.appendRevisionEvent({
        id: "review-3",
        revisionId: revision.id,
        sequence: 3,
        type: "retained",
        actorId: "reviewer",
        reason: "keep",
        createdAt
      }),
    /Expected event sequence 2/
  );
});

test("baseline and enriched indexes publish atomically and rebuild idempotently", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const service = new IndexContextService(store);
  const baseline = await service.index(checkpoint.id, "2026-07-26T12:01:00.000Z");
  assert.equal(baseline.capabilities.derivedKnowledge, "unavailable");
  assert.equal(baseline.projectorStatuses.lexical, "ready");
  assert.equal(baseline.projectorStatuses.dense, "disabled");
  await deriveFixture(store, checkpoint.id);
  const enriched = await service.index(checkpoint.id, "2026-07-26T12:02:00.000Z");
  assert.notEqual(enriched.id, baseline.id);
  assert.equal(enriched.capabilities.derivedKnowledge, "available");
  const repeated = await service.index(checkpoint.id, "2026-07-26T13:00:00.000Z");
  assert.equal(repeated.id, enriched.id);
  assert.equal(repeated.fingerprint, enriched.fingerprint);
  const projection = await store.getGeneration(enriched.id);
  assert.ok(projection?.documents.some((document) => document.sourceKind === "knowledge"));
  assert.ok(projection?.fragments.length);
  assert.ok(projection?.exactIndex.some((entry) => entry.term === "handlepayment"));
  assert.ok(projection?.structuralRelations.some((relation) => relation.to.endsWith("#handlePayment")));
  assert.ok(projection?.hierarchyNodes.length);
});

test("query routes exact and structural work and return original evidence anchors", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  await deriveFixture(store, checkpoint.id);
  await new IndexContextService(store).index(checkpoint.id, "2026-07-26T12:02:00.000Z");
  await store.replaceRepositoryAccess(tenantId, "alice", [repository]);
  const response = await new QueryContextService(store).query({
    tenantId,
    principalId: "alice",
    repository,
    ref: "main",
    question: "Where is handlePayment defined?",
    targets: { symbols: ["handlePayment"] }
  });
  assert.equal(response.coverage.status, "complete");
  assert.ok(response.coverage.retrieversUsed.includes("structural"));
  assert.ok(response.citations.length > 0);
  assert.ok(response.citations.some((citation) => citation.anchors.some((anchor) => anchor.sourceId === blobSha)));
  assert.equal(response.generation.commitSha, commitSha);
  assert.match(response.traceId, /^trace_/);
  const overview = await new QueryContextService(store).query({
    tenantId,
    principalId: "alice",
    repository,
    ref: "main",
    taskKind: "overview",
    question: "Give an overview of the billing component"
  });
  const knowledgeCitation = overview.citations.find((citation) => citation.sourceKind === "knowledge");
  assert.ok(knowledgeCitation);
  assert.match(knowledgeCitation.excerpt, /Source: src\/billing\.ts/);
  assert.match(knowledgeCitation.excerpt, /export function handlePayment/);
});

test("explicit file targets exclude provider records that merely mention the path", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    aclFingerprint: "acl-public",
    observationFrontier: "github:101",
    sourceComplete: true,
    createdAt,
    files: [
      {
        path: "README.md",
        blobSha,
        body: "# Canonical repository description",
        language: "markdown"
      }
    ],
    observations: [
      {
        sourceType: "issue",
        sourceId: "issue-readme",
        title: "Rewrite README.md with unrelated suggestions",
        payload: { body: "README.md README.md repository description" },
        observedAt: createdAt
      }
    ]
  });
  await new IndexContextService(store).index(checkpoint.id, createdAt);
  await store.replaceRepositoryAccess(tenantId, "alice", [repository]);
  const response = await new QueryContextService(store).query({
    tenantId,
    principalId: "alice",
    repository,
    ref: "main",
    taskKind: "lookup",
    question: "What is in the README file?",
    targets: { paths: ["README.md"] }
  });
  assert.equal(response.coverage.status, "complete");
  assert.ok(response.citations.length > 0);
  assert.ok(response.citations.every((citation) => citation.sourceKind === "code"));
  assert.ok(
    response.citations.every((citation) => citation.anchors.some((anchor) => anchor.pathOrUrl === "README.md"))
  );
});

test("ownership lookup includes CODEOWNERS while excluding provider chatter", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    aclFingerprint: "acl-public",
    observationFrontier: "github:102",
    sourceComplete: true,
    createdAt,
    files: [
      {
        path: "src/billing.ts",
        blobSha,
        body: source,
        language: "typescript"
      },
      {
        path: "CODEOWNERS",
        blobSha: "c".repeat(40),
        body: "src/billing.ts @acme/payments"
      }
    ],
    observations: [
      {
        sourceType: "issue",
        sourceId: "issue-owner",
        title: "Who owns src/billing.ts?",
        payload: { body: "Ownership is being discussed." },
        observedAt: createdAt
      }
    ]
  });
  await new IndexContextService(store).index(checkpoint.id, createdAt);
  await store.replaceRepositoryAccess(tenantId, "alice", [repository]);
  const response = await new QueryContextService(store).query({
    tenantId,
    principalId: "alice",
    repository,
    ref: "main",
    taskKind: "status",
    question: "Who owns src/billing.ts?",
    targets: { paths: ["src/billing.ts"] }
  });
  assert.ok(
    response.citations.some((citation) => citation.anchors.some((anchor) => anchor.pathOrUrl === "CODEOWNERS"))
  );
  assert.ok(response.citations.every((citation) => citation.sourceKind === "code"));
});

test("query rejects repository access before retrieval", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  await new IndexContextService(store).index(checkpoint.id, createdAt);
  await assert.rejects(
    () =>
      new QueryContextService(store).query({
        tenantId,
        principalId: "mallory",
        repository,
        question: "handlePayment"
      }),
    /access/
  );
});

test("explicit time windows filter provider evidence across every retrieval route", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  await store.replaceRepositoryAccess(tenantId, "alice", [repository]);
  await new IndexContextService(store).index(checkpoint.id, createdAt);
  const service = new QueryContextService(store);
  const historical = await service.query({
    tenantId,
    principalId: "alice",
    repository,
    taskKind: "status",
    question: "What is the state of issue #42?",
    targets: { issues: ["42"] },
    timeWindow: { to: "2026-07-25T23:59:59.000Z" }
  });
  assert.equal(
    historical.citations.some((citation) => citation.anchors.some((anchor) => anchor.sourceId === "issue-42")),
    false
  );
  const current = await service.query({
    tenantId,
    principalId: "alice",
    repository,
    taskKind: "status",
    question: "What is the state of issue #42?",
    targets: { issues: ["42"] },
    timeWindow: { from: "2026-07-26T00:00:00.000Z" }
  });
  assert.ok(current.citations.some((citation) => citation.anchors.some((anchor) => anchor.sourceId === "issue-42")));
});

test("candidate-level ACL filtering excludes inaccessible source and structural facts", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    aclFingerprint: "acl-public",
    observationFrontier: "1",
    sourceComplete: true,
    createdAt,
    files: [
      { path: "src/public.ts", blobSha, body: "export const publicValue = 1;", language: "typescript" },
      {
        path: "src/private.ts",
        blobSha: "d".repeat(40),
        body: "export const internalOnly = 2;",
        language: "typescript",
        aclFingerprint: "acl-private"
      }
    ]
  });
  await new IndexContextService(store).index(checkpoint.id, createdAt);
  const response = await new QueryContextService(
    store,
    new StaticScopeAuthorizer([{ tenantId, principalId: "alice", repository, aclFingerprints: ["acl-public"] }])
  ).query({
    tenantId,
    principalId: "alice",
    repository,
    question: "Where is internalOnly defined?",
    targets: { symbols: ["internalOnly"] }
  });
  assert.ok(
    response.citations.every((citation) => !citation.anchors.some((anchor) => anchor.pathOrUrl === "src/private.ts"))
  );
});

test("fallback hierarchy is deterministic and external hierarchy anchors are validated", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const first = await new IndexContextService(store, new FallbackHierarchyIndexer()).index(checkpoint.id, createdAt);
  const projection = await store.getGeneration(first.id);
  assert.ok(projection?.hierarchyNodes.some((node) => node.title === "Repository"));
  const client = {
    async probe() {
      return { available: true };
    },
    async build(input: HierarchyBuildInput) {
      return {
        adapterName: "external",
        adapterVersion: "1",
        diagnostics: [],
        nodes: [
          {
            externalId: "bad",
            documentId: input.documents[0]!.id,
            title: "Bad",
            summary: "Bad",
            depth: 1,
            preorderStart: 1,
            preorderEnd: 1,
            anchors: [
              {
                ...input.documents[0]!.anchors[0]!,
                contentDigest: fingerprint("tampered")
              }
            ]
          }
        ]
      };
    }
  };
  const adapter = new PageIndexHierarchyAdapter(client);
  const hierarchyAnchor = (await store.listEvidence(checkpoint.id))[0]!.anchor;
  await assert.rejects(
    () =>
      adapter.build({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        generationId: "generation",
        adapterVersion: "1",
        documents: [
          {
            id: "document",
            title: "Doc",
            body: "# Doc",
            anchors: [hierarchyAnchor],
            aclFingerprint: "acl-public"
          }
        ],
        limits: { timeoutMs: 100, maxDocumentCharacters: 1000, maxNodes: 10 }
      }),
    /outside the supplied source/
  );
});

test("planner preserves exact routes and adds hierarchy or temporal routes by need", () => {
  const structure = planContextQuery({
    tenantId,
    principalId: "alice",
    repository,
    question: "What imports `src/billing.ts`?"
  });
  assert.ok(structure.routes.some((route) => route.route === "exact"));
  assert.ok(structure.routes.some((route) => route.route === "structural"));
  const overview = planContextQuery({
    tenantId,
    principalId: "alice",
    repository,
    taskKind: "overview",
    question: "Give me an overview"
  });
  assert.ok(overview.routes.some((route) => route.route === "hierarchy"));
  const intent = planContextQuery({
    tenantId,
    principalId: "alice",
    repository,
    taskKind: "intent",
    question: "Why was this changed?"
  });
  assert.ok(intent.routes.some((route) => route.route === "temporal"));
});

function candidate(
  id: string,
  retriever: RetrievalCandidate["retriever"],
  score: number,
  metadata: Record<string, unknown> = {}
): RetrievalCandidate {
  const anchor: EvidenceAnchor = {
    tenantId,
    repository,
    sourceType: "blob",
    sourceId: blobSha,
    contentDigest: fingerprint(source),
    commitSha,
    pathOrUrl: "src/billing.ts"
  };
  return {
    id,
    retriever,
    sourceKind: "code",
    sourceId: id,
    title: id,
    excerpt: source,
    contextualText: "",
    anchors: [anchor],
    rawScore: score,
    scoreSemantics: "test",
    exactMatch: retriever === "exact",
    authorityClass: "source_code",
    effectiveAclFingerprint: "acl-public",
    contentFingerprint: fingerprint(id),
    explanation: "test",
    metadata
  };
}

test("fusion is invariant to retriever ordering and protects exact results", () => {
  const exact = [candidate("exact", "exact", 1)];
  const lexical = [candidate("lexical", "lexical", 10)];
  const left = fuseRetrievalCandidates([exact, lexical]);
  const right = fuseRetrievalCandidates([lexical, exact]);
  assert.deepEqual(
    left.map((value) => [value.candidate.id, value.score]),
    right.map((value) => [value.candidate.id, value.score])
  );
  assert.equal(left[0]!.candidate.id, "exact");
});

test("conflicts remain visible and cite both competing sources", () => {
  const open = candidate("open", "structured", 1, { claimSubject: "issue:42:state", claimValue: "open" });
  const closed = candidate("closed", "knowledge", 1, { claimSubject: "issue:42:state", claimValue: "closed" });
  const conflicts = detectSourceConflicts([open, closed]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.resolution, "unresolved");
  assert.deepEqual(conflicts[0]!.citationIds.sort(), ["closed", "open"]);
});

test("evidence packing enforces source boundaries and citation verification fails closed", () => {
  const fused = fuseRetrievalCandidates([[candidate("one", "exact", 1)], [candidate("two", "lexical", 1)]]);
  const pack = assembleEvidencePack(fused, { maxCharacters: source.length, maxItems: 1 });
  assert.equal(pack.items.length, 1);
  assert.equal(pack.omittedCandidateIds.length, 1);
  const citationId = pack.items[0]!.citationId;
  assert.equal(
    verifySynthesisCitations(
      {
        answer: "Supported claim",
        claims: [{ text: "Supported claim", citationIds: [citationId] }],
        ambiguities: [],
        missing: []
      },
      pack
    ).valid,
    true
  );
  assert.equal(
    verifySynthesisCitations(
      {
        answer: "Unsupported claim",
        claims: [{ text: "Unsupported claim", citationIds: ["missing"] }],
        ambiguities: [],
        missing: []
      },
      pack
    ).valid,
    false
  );
});

test("workflow names are clean and baseline indexing remains independent of derivation", async () => {
  assert.deepEqual(contextTaskTypes, {
    build: "build-context",
    ingestEvidence: "ingest-evidence",
    deriveKnowledge: "derive-knowledge",
    indexContext: "index-context"
  });
  assert.deepEqual(contextQueueTopics, {
    ingestEvidence: "run-ingest-evidence",
    deriveKnowledge: "run-derive-knowledge",
    indexContext: "run-index-context"
  });
  assert.equal(contextTaskTypeDefinitions.length, 4);
  const coordinator = new MemoryContextPipelineCoordinator();
  const build = await coordinator.createBuild({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    requestKey: "build-1",
    createdAt
  });
  const ingest = await coordinator.claim({
    tenantIds: [tenantId],
    workerId: "worker",
    topics: [contextQueueTopics.ingestEvidence],
    now: "2026-07-26T12:00:01.000Z",
    leaseExpiresAt: "2026-07-26T12:10:00.000Z"
  });
  assert.ok(ingest);
  assert.equal(ingest.stage.metadata.commitSha, commitSha);
  assert.equal(
    await coordinator.complete({
      tenantId,
      stageId: ingest.stage.id,
      fence: ingest.fence,
      outcome: "succeeded",
      now: "2026-07-26T12:00:02.000Z",
      metadata: { checkpointId: "checkpoint" }
    }),
    true
  );
  const index = await coordinator.claim({
    tenantId,
    workerId: "worker",
    topics: [contextQueueTopics.indexContext],
    now: "2026-07-26T12:00:03.000Z",
    leaseExpiresAt: "2026-07-26T12:10:00.000Z"
  });
  assert.ok(index);
  await coordinator.complete({
    tenantId,
    stageId: index.stage.id,
    fence: index.fence,
    outcome: "succeeded",
    now: "2026-07-26T12:00:04.000Z"
  });
  const derive = await coordinator.claim({
    tenantId,
    workerId: "worker",
    topics: [contextQueueTopics.deriveKnowledge],
    now: "2026-07-26T12:00:05.000Z",
    leaseExpiresAt: "2026-07-26T12:10:00.000Z"
  });
  assert.ok(derive);
  await coordinator.complete({
    tenantId,
    stageId: derive.stage.id,
    fence: derive.fence,
    outcome: "succeeded",
    now: "2026-07-26T12:00:06.000Z"
  });
  const updated = await coordinator.get(build.id);
  assert.equal(updated?.stages.find((stage) => stage.type === "index-context")?.status, "succeeded");
  assert.equal(updated?.status, "succeeded");
});

test("workflow release requeues work and stale leases cannot commit", async () => {
  const coordinator = new MemoryContextPipelineCoordinator();
  await coordinator.createBuild({ tenantId, repository, ref: "main", requestKey: "fence", createdAt });
  const claimed = await coordinator.claim({
    tenantId,
    workerId: "worker",
    topics: [contextQueueTopics.ingestEvidence],
    now: "2026-07-26T12:00:01.000Z",
    leaseExpiresAt: "2026-07-26T12:00:10.000Z"
  });
  assert.ok(claimed);
  assert.equal(
    await coordinator.release({
      tenantId,
      stageId: claimed.stage.id,
      leaseId: claimed.fence.leaseId,
      now: "2026-07-26T12:00:02.000Z",
      reason: "worker shutdown"
    }),
    true
  );
  const reclaimed = await coordinator.claim({
    tenantId,
    workerId: "new-worker",
    topics: [contextQueueTopics.ingestEvidence],
    now: "2026-07-26T12:00:03.000Z",
    leaseExpiresAt: "2026-07-26T12:00:10.000Z"
  });
  assert.ok(reclaimed);
  let now = "2026-07-26T12:00:04.000Z";
  const store = new MemoryContextEngineStore(coordinator, () => now);
  await new IngestEvidenceService(store).ingest(
    {
      tenantId,
      repository,
      ref: "main",
      commitSha,
      aclFingerprint: "acl",
      observationFrontier: "1",
      sourceComplete: true,
      createdAt,
      files: []
    },
    reclaimed.fence
  );
  now = "2026-07-26T12:00:11.000Z";
  await assert.rejects(
    () =>
      new IngestEvidenceService(store).ingest(
        {
          tenantId,
          repository,
          ref: "other",
          commitSha,
          aclFingerprint: "acl",
          observationFrontier: "2",
          sourceComplete: true,
          createdAt,
          files: []
        },
        reclaimed.fence
      ),
    /stale or invalid/
  );
});

test("outbox deliveries are independent per consumer and advance owned checkpoints", async () => {
  const outbox = new MemoryContextOutbox();
  const event = {
    id: "event-1",
    sequence: 1,
    tenantId,
    repository,
    aggregateType: "evidence" as const,
    aggregateId: "evidence-1",
    eventType: "evidence.recorded",
    payload: {},
    consumers: ["manifest", "lexical"] as const,
    occurredAt: createdAt
  };
  await outbox.append([{ ...event, consumers: [...event.consumers] }]);
  await outbox.append([{ ...event, consumers: [...event.consumers] }]);
  const manifest = await outbox.claim({
    consumer: "manifest",
    tenantId,
    repository,
    limit: 10,
    now: "2026-07-26T12:00:01.000Z",
    leaseExpiresAt: "2026-07-26T12:01:00.000Z"
  });
  assert.equal(manifest.length, 1);
  assert.equal(
    await outbox.acknowledge({
      consumer: "manifest",
      eventId: event.id,
      leaseId: manifest[0]!.leaseId!,
      processedAt: "2026-07-26T12:00:02.000Z",
      projectorVersion: "1"
    }),
    true
  );
  assert.equal((await outbox.checkpoint("manifest", tenantId, repository))?.sequence, 1);
  assert.equal(await outbox.checkpoint("lexical", tenantId, repository), undefined);
  const lexical = await outbox.claim({
    consumer: "lexical",
    tenantId,
    repository,
    limit: 10,
    now: "2026-07-26T12:00:03.000Z",
    leaseExpiresAt: "2026-07-26T12:01:00.000Z"
  });
  assert.equal(lexical.length, 1);
});

test("repository access replacement, tenant access migration, health, and close are explicit", async () => {
  const store = new MemoryContextEngineStore();
  await store.replaceRepositoryAccess("old", "alice", ["acme/repo"]);
  await store.migrateTenantAliases("old", "new");
  assert.deepEqual(await store.repositoriesForPrincipal("old", "alice"), []);
  assert.deepEqual(await store.repositoriesForPrincipal("new", "alice"), ["acme/repo"]);
  assert.deepEqual(await store.health(), { ok: true, adapter: "memory" });
  await store.close();
  assert.deepEqual(await store.health(), { ok: false, adapter: "memory" });
  await assert.rejects(() => ingestFixture(store), /closed/);
});

test("stable IDs and fingerprints ignore object key order", () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.equal(stableId("x", { b: 2, a: 1 }), stableId("x", { a: 1, b: 2 }));
});
