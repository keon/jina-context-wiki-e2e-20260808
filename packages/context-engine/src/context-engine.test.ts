import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  StoreScopeAuthorizer,
  assembleEvidencePack,
  buildKnowledgeFilePrompt,
  buildKnowledgePrompt,
  buildKnowledgeRepairPrompt,
  knowledgeDocumentJsonSchema,
  parseKnowledgeDocumentFile,
  canonicalJson,
  codexVerbosity,
  derivationDetailLevels,
  derivationDetailOrDefault,
  isDerivationDetail,
  contextQueueTopics,
  contextTaskTypeDefinitions,
  contextTaskTypes,
  createKnowledgeCitation,
  createKnowledgeRevision,
  detectSourceConflicts,
  fingerprint,
  fuseRetrievalCandidates,
  knowledgeGenerationJsonSchema,
  parseGeneratedKnowledgeDocuments,
  planContextQuery,
  repositoryAclFingerprint,
  serializeKnowledgeEvidence,
  selectPriorKnowledge,
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
const source = [
  "# Billing",
  "",
  "export function handlePayment(total: number) {",
  "  return total > 0;",
  "}",
  "",
  "export const distantOnlySymbol = true;"
].join("\n");

async function ingestFixture(
  store: MemoryContextEngineStore,
  aclFingerprint = repositoryAclFingerprint(tenantId, repository)
) {
  return new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
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
        payload: { number: 42, state: "open for retry", title: "Retry payments" },
        pathOrUrl: "https://example.test/acme/repo/issues/42",
        observedAt: createdAt,
        metadata: { claimSubject: "issue:42:state", claimValue: "open for retry" }
      }
    ]
  });
}

async function ingestSameCommitProviderState(
  store: MemoryContextEngineStore,
  refSequence: number,
  issueState: string,
  observationFrontier: string,
  observedAt: string
) {
  return new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    refSequence,
    commitSha,
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
    observationFrontier,
    sourceComplete: true,
    createdAt: observedAt,
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
        payload: { number: 42, state: issueState, title: "Retry payments" },
        pathOrUrl: "https://example.test/acme/repo/issues/42",
        observedAt,
        metadata: { claimSubject: "issue:42:state", claimValue: issueState }
      }
    ]
  });
}

function citedStructuredSummary(
  text: string,
  claimSubject?: string,
  claimValue?: string
): KnowledgeGenerationOutput["documents"][number]["structuredSummary"] {
  return {
    facts: [{ text, citationOrdinals: [1], confidence: 1 }],
    questionsAnswered: [],
    diagnostics: { symptoms: [], causes: [], checks: [], fixes: [] },
    ...(claimSubject === undefined ? {} : { claimSubject }),
    ...(claimValue === undefined ? {} : { claimValue }),
    claimCitationOrdinals: claimSubject === undefined ? [] : [1]
  };
}

function validOutput(): KnowledgeGenerationOutput {
  const claim = "export function handlePayment(total: number) { return total > 0; }";
  return {
    retiredDocuments: [],
    documents: [
      {
        logicalId: "component:acme/repo:billing",
        kind: "component",
        title: claim,
        summary: claim,
        summaryCitationOrdinals: [1],
        bodyMarkdown: `${claim} [cite:1]`,
        structuredSummary: {
          facts: [{ text: claim, citationOrdinals: [1], confidence: 1 }],
          questionsAnswered: [
            {
              text: "Why are zero and negative payment totals rejected?",
              citationOrdinals: [1],
              confidence: 0.95
            }
          ],
          diagnostics: {
            symptoms: [
              {
                text: "A zero or negative payment total is rejected.",
                citationOrdinals: [1],
                confidence: 0.95
              }
            ],
            causes: [
              {
                text: "handlePayment requires total to be greater than zero.",
                citationOrdinals: [1],
                confidence: 1
              }
            ],
            checks: [
              {
                text: "Inspect the total passed to handlePayment.",
                citationOrdinals: [1],
                confidence: 0.9
              }
            ],
            fixes: [
              {
                text: "Pass a positive payment total.",
                citationOrdinals: [1],
                confidence: 0.9
              }
            ]
          },
          claimSubject: "handlePayment",
          claimValue: claim,
          claimCitationOrdinals: [1]
        },
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
      },
      {
        logicalId: "issue:github:acme/repo#42",
        kind: "issue_explanation",
        title: "open for retry",
        summary: "open for retry",
        summaryCitationOrdinals: [1],
        bodyMarkdown: "open for retry [cite:1]",
        structuredSummary: citedStructuredSummary("open for retry", "open for retry", "open for retry"),
        scope: {
          paths: [],
          symbols: [],
          pullRequests: [],
          issues: ["42"]
        },
        confidence: 1,
        citations: [
          {
            claim: "open for retry",
            sourceType: "issue",
            sourceId: "issue-42",
            pathOrUrl: "https://example.test/acme/repo/issues/42",
            jsonPointer: "/state"
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
  assert.equal(run.status, "succeeded", run.diagnostics.join("; "));
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
  assert.equal(
    await store.projectionInputFingerprint(tenantId, repository),
    fingerprint({
      tenantId,
      repository,
      sequence: 1,
      eventId: `projection-input:evidence:${checkpoint.id}`
    })
  );
  const repeated = await ingestFixture(store);
  assert.equal(repeated.id, checkpoint.id);
  assert.equal((await store.listManifest(checkpoint.id)).length, 2);
  const facts = await store.listStructuralFacts(checkpoint.id);
  assert.ok(facts.some((fact) => fact.kind === "defines" && fact.to.endsWith("#handlePayment")));
  assert.equal((await store.listEvidence(checkpoint.id)).length, 3);
  const partial = await service.ingest({
    tenantId,
    repository,
    ref: "partial",
    refSequence: 1,
    commitSha,
    aclFingerprint: "acl",
    observationFrontier: "bounded:1",
    sourceComplete: false,
    createdAt,
    files: []
  });
  assert.equal(partial.sourceCompleteness, "partial");
});

test("omitted blobs remain unavailable without aliasing empty content and can later be completed", async () => {
  const store = new MemoryContextEngineStore();
  const service = new IngestEvidenceService(store);
  const partial = await service.ingest({
    tenantId,
    repository,
    ref: "binary",
    refSequence: 1,
    commitSha,
    aclFingerprint: "acl",
    observationFrontier: "bounded:omitted",
    sourceComplete: false,
    createdAt,
    files: [
      { path: "assets/one.bin", blobSha: "1".repeat(40), body: "", contentOmitted: true },
      { path: "assets/two.bin", blobSha: "2".repeat(40), body: "", contentOmitted: true }
    ]
  });
  const omittedManifest = await store.listManifest(partial.id);
  assert.equal((await store.listEvidence(partial.id)).length, 0);
  assert.equal(omittedManifest.length, 2);
  assert.ok(omittedManifest.every((entry) => !entry.contentAvailable));
  assert.equal(new Set(omittedManifest.map((entry) => entry.contentDigest)).size, 2);
  const partialGeneration = await new IndexContextService(store).index(partial.id, "2026-07-26T12:00:30.000Z");
  const partialProjection = await store.getGeneration(partialGeneration.id);
  assert.equal(partialProjection?.manifest.length, 2);
  assert.equal(partialProjection?.documents.length, 0);

  const completed = await service.ingest({
    tenantId,
    repository,
    ref: "binary",
    refSequence: 2,
    commitSha: "d".repeat(40),
    aclFingerprint: "acl",
    observationFrontier: "bounded:complete",
    sourceComplete: true,
    createdAt: "2026-07-26T12:01:00.000Z",
    files: [{ path: "assets/one.bin", blobSha: "1".repeat(40), body: "now available" }]
  });
  assert.equal((await store.listEvidence(completed.id)).length, 1);
  assert.deepEqual(
    (await store.listManifest(completed.id)).map((entry) => ({
      contentAvailable: entry.contentAvailable,
      contentDigest: entry.contentDigest
    })),
    [{ contentAvailable: true, contentDigest: fingerprint("now available") }]
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
  const mixedCase = structuredClone(validOutput());
  mixedCase.documents[0]!.logicalId = "Component:Acme/Repo:Billing";
  assert.equal(parseGeneratedKnowledgeDocuments(mixedCase).documents[0]?.logicalId, "component:acme/repo:billing");
  assert.throws(() => parseGeneratedKnowledgeDocuments({ documents: [], nodes: [] }), /nodes is prohibited/);
  assert.throws(() => parseGeneratedKnowledgeDocuments({ documents: [{ kind: "component" }] }), /citations|logicalId/);
  assert.deepEqual(knowledgeGenerationJsonSchema.required, ["documents", "retiredDocuments"]);
  const documentSchema = knowledgeGenerationJsonSchema.properties.documents.items;
  assert.deepEqual(documentSchema.required, [
    "logicalId",
    "kind",
    "title",
    "summary",
    "summaryCitationOrdinals",
    "bodyMarkdown",
    "structuredSummary",
    "scope",
    "confidence",
    "citations"
  ]);
  assert.ok("properties" in documentSchema);
  assert.ok("properties" in documentSchema.properties.structuredSummary);
  assert.ok("properties" in documentSchema.properties.scope);
  assert.ok("properties" in documentSchema.properties.citations.items);
});

test("knowledge revision identity is canonical across logical-id casing", () => {
  const base = {
    tenantId,
    repository,
    kind: "component" as const,
    title: "Billing",
    bodyMarkdown: "Billing",
    summary: "Billing",
    structuredSummary: {},
    scope: { ref: "main", commitSha, paths: [], symbols: [], pullRequests: [], issues: [] },
    evidenceFingerprint: fingerprint("billing"),
    generatorName: "test",
    generatorVersion: "1",
    model: "test",
    promptVersion: "1",
    confidence: 1,
    createdAt
  };
  const lowercase = createKnowledgeRevision({ ...base, logicalId: "component:acme/repo:billing" });
  const mixedCase = createKnowledgeRevision({ ...base, logicalId: "Component:Acme/Repo:Billing" });
  assert.equal(mixedCase.logicalId, lowercase.logicalId);
  assert.equal(mixedCase.id, lowercase.id);
  for (const changed of [
    { ...base, title: "Changed billing" },
    { ...base, summary: "Changed billing" },
    { ...base, structuredSummary: { changed: true } },
    { ...base, scope: { ...base.scope, paths: ["src/billing.ts"] } },
    { ...base, model: "different-model" },
    { ...base, promptVersion: "2" },
    { ...base, confidence: 0.5 }
  ]) {
    assert.notEqual(createKnowledgeRevision({ ...changed, logicalId: lowercase.logicalId }).id, lowercase.id);
  }
});

test("derivation repairs once, validates source ranges, and caches immutable input", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const bundle = await new EvidenceFocusSelector(store).select(checkpoint.id);
  const prompt = buildKnowledgePrompt(bundle);
  assert.match(prompt, /repository:acme\/repo:architecture/);
  assert.match(prompt, /change:acme\/repo:a{40}/);
  assert.match(prompt, /issue:<provider>:acme\/repo#<cited-number>/);
  assert.match(prompt, /<kind>:acme\/repo:<evidence-backed-slug>/);
  assert.match(prompt, /read-only shell tools/);
  const serializedEvidence = serializeKnowledgeEvidence(bundle);
  assert.match(serializedEvidence, /numberedBody/);
  assert.match(serializedEvidence, /3\|export function handlePayment/);
  const repairPrompt = buildKnowledgeRepairPrompt(prompt, ["documents[0].summary is unsupported"]);
  assert.match(repairPrompt, /corrected complete catalog/);
  assert.match(repairPrompt, /documents\[0\]\.summary is unsupported/);
  const generator = new SequenceGenerator([{ documents: [{ invalid: true }] }, validOutput()]);
  const service = new DeriveKnowledgeService(
    new EvidenceFocusSelector(store),
    generator,
    store,
    new KnowledgeOutputValidator(store)
  );
  const run = await service.derive(checkpoint.id, "2026-07-26T12:01:00.000Z");
  assert.equal(run.status, "succeeded", run.diagnostics.join("; "));
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

test("incremental derivation receives prior knowledge and can re-emit it with a newly observed issue", async () => {
  const store = new MemoryContextEngineStore();
  const initial = await ingestFixture(store);
  await deriveFixture(store, initial.id);
  const nextCommitSha = "f".repeat(40);
  const nextCreatedAt = "2026-07-26T12:05:00.000Z";
  const incremental = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    refSequence: 2,
    commitSha: nextCommitSha,
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
    observationFrontier: "github:101",
    sourceComplete: true,
    createdAt: nextCreatedAt,
    files: [
      {
        path: "README.md",
        blobSha: "c".repeat(40),
        body: "# Repository\n\nThe billing module accepts payments.",
        language: "markdown"
      },
      { path: "src/billing.ts", blobSha, body: source, language: "typescript" }
    ],
    observations: [
      {
        sourceType: "issue",
        sourceId: "issue-42",
        title: "Issue #42",
        payload: { number: 42, state: "open for retry", title: "Retry payments" },
        pathOrUrl: "https://example.test/acme/repo/issues/42",
        observedAt: nextCreatedAt,
        metadata: { claimSubject: "issue:42:state", claimValue: "open for retry" }
      },
      {
        sourceType: "issue",
        sourceId: "issue-43",
        title: "Issue #43",
        payload: {
          number: 43,
          state: "open",
          title: "Duplicate payment retry",
          body: "Concurrent retries can submit a payment twice."
        },
        pathOrUrl: "https://example.test/acme/repo/issues/43",
        observedAt: nextCreatedAt,
        metadata: { claimSubject: "issue:43:state", claimValue: "open" }
      }
    ]
  });
  const prior = await selectPriorKnowledge(store, incremental);
  assert.deepEqual(prior.map((entry) => entry.revision.logicalId).sort(), [
    "component:acme/repo:billing",
    "issue:github:acme/repo#42"
  ]);
  assert.ok(prior.every((entry) => entry.citations.length > 0));

  const output = validOutput();
  output.documents.push({
    logicalId: "issue:github:acme/repo#43",
    kind: "issue_explanation",
    title: "Duplicate payment retry",
    summary: "Concurrent retries can submit a payment twice.",
    summaryCitationOrdinals: [1],
    bodyMarkdown: "Concurrent retries can submit a payment twice. [cite:1]",
    structuredSummary: {
      facts: [
        {
          text: "Concurrent retries can submit a payment twice.",
          citationOrdinals: [1],
          confidence: 1
        }
      ],
      questionsAnswered: [
        {
          text: "Issue #43 records duplicate payment submission under concurrent retry.",
          citationOrdinals: [1],
          confidence: 0.95
        }
      ],
      diagnostics: {
        symptoms: [
          {
            text: "A payment is submitted twice.",
            citationOrdinals: [1],
            confidence: 0.9
          }
        ],
        causes: [
          {
            text: "Concurrent retries are the reported trigger.",
            citationOrdinals: [1],
            confidence: 0.85
          }
        ],
        checks: [],
        fixes: []
      },
      claimCitationOrdinals: []
    },
    scope: {
      paths: [],
      symbols: [],
      pullRequests: [],
      issues: ["43"]
    },
    confidence: 0.9,
    citations: [
      {
        claim: "Concurrent retries can submit a payment twice.",
        sourceType: "issue",
        sourceId: "issue-43",
        pathOrUrl: "https://example.test/acme/repo/issues/43",
        jsonPointer: "/body"
      }
    ]
  });
  const incomplete = structuredClone(output);
  incomplete.documents = [incomplete.documents.at(-1)!];
  const incompleteGenerator = new SequenceGenerator([incomplete, incomplete]);
  const incompleteRun = await new DeriveKnowledgeService(
    new EvidenceFocusSelector(store),
    incompleteGenerator,
    store,
    new KnowledgeOutputValidator(store)
  ).derive(incremental.id, nextCreatedAt);
  assert.equal(incompleteRun.status, "failed");
  assert.ok(incompleteRun.diagnostics.some((diagnostic) => diagnostic.includes("silently dropped")));
  const validated = await new KnowledgeOutputValidator(store).validate({
    output,
    checkpointId: incremental.id,
    generatorName: "fixture-generator",
    generatorVersion: "2",
    model: "fixture-model",
    promptVersion: "agentic-cited-knowledge-v1",
    createdAt: nextCreatedAt
  });
  assert.equal(validated.revisions.length, 3);
  assert.ok(validated.revisions.some((revision) => revision.logicalId === "issue:github:acme/repo#43"));
});

test("checkpoint commit evidence includes changed paths for issue inference", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    commitSha,
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
    observationFrontier: "git:1",
    sourceComplete: true,
    createdAt,
    files: [{ path: "src/billing.ts", blobSha, body: source, language: "typescript" }],
    git: {
      commit: {
        treeSha: "d".repeat(40),
        parentShas: ["e".repeat(40)],
        message: "Prevent duplicate charge after retry"
      },
      changes: [{ kind: "modify", path: "src/billing.ts", oldBlobSha: "1".repeat(40), newBlobSha: blobSha }]
    }
  });
  const commit = (await store.listEvidence(checkpoint.id)).find((record) => record.anchor.sourceType === "commit");
  assert.ok(commit);
  assert.match(commit.body, /Prevent duplicate charge after retry/);
  assert.match(commit.body, /src\/billing\.ts/);
  assert.deepEqual(commit.metadata.changedPaths, ["src/billing.ts"]);
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

test("derived prose is accepted with explicit citation mappings while source claims remain exact", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const output = validOutput();
  output.documents[0]!.title = "Billing input guard";
  output.documents[0]!.summary = "Billing accepts only positive totals.";
  output.documents[0]!.bodyMarkdown = "The billing function rejects zero and negative totals. [cite:1]";
  output.documents[0]!.structuredSummary = citedStructuredSummary(
    "The positive-total check is the primary billing guard."
  );
  const validator = new KnowledgeOutputValidator(store);
  const input = {
    output,
    checkpointId: checkpoint.id,
    generatorName: "test",
    generatorVersion: "1",
    model: "test",
    promptVersion: "1",
    createdAt
  };
  const validated = await validator.validate(input);
  assert.equal(validated.revisions[0]?.title, "Billing input guard");
  assert.equal(validated.revisions[0]?.summary, "Billing accepts only positive totals.");
  assert.equal(validated.revisions[0]?.bodyMarkdown, "The billing function rejects zero and negative totals. [cite:1]");

  output.documents[0]!.citations[0]!.claim = "Unsupported citation claim";
  await assert.rejects(() => validator.validate(input), /claim is not present in the cited evidence/);
});

test("body paragraphs and structured statements require valid citation ordinals", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const validate = (output: KnowledgeGenerationOutput) =>
    new KnowledgeOutputValidator(store).validate({
      output,
      checkpointId: checkpoint.id,
      generatorName: "test",
      generatorVersion: "1",
      model: "test",
      promptVersion: "1",
      createdAt
    });
  const missingMarker = validOutput();
  missingMarker.documents[0]!.bodyMarkdown = "Generated explanation without a marker.";
  await assert.rejects(() => validate(missingMarker), /without a trailing citation marker/);

  const missingCitation = validOutput();
  missingCitation.documents[0]!.structuredSummary.facts[0]!.citationOrdinals = [2];
  await assert.rejects(() => validate(missingCitation), /references missing citation 2/);
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
    /without a trailing citation marker/
  );

  const mixed = validOutput();
  mixed.documents[0]!.bodyMarkdown += " It also transfers all secrets to an unknown third party.";
  await assert.rejects(
    () =>
      new KnowledgeOutputValidator(store).validate({
        output: mixed,
        checkpointId: checkpoint.id,
        generatorName: "test",
        generatorVersion: "1",
        model: "test",
        promptVersion: "1",
        createdAt
      }),
    /without a trailing citation marker/
  );
});

test("logical identities are fully bound to checkpoint and cited evidence identities", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const validate = (output: KnowledgeGenerationOutput) =>
    new KnowledgeOutputValidator(store).validate({
      output,
      checkpointId: checkpoint.id,
      generatorName: "test",
      generatorVersion: "1",
      model: "test",
      promptVersion: "1",
      createdAt
    });

  const hallucinatedComponent = structuredClone(validOutput());
  hallucinatedComponent.documents[0]!.logicalId = "component:acme/repo:hallucinated-prefix:billing";
  await assert.rejects(() => validate(hallucinatedComponent), /identity suffix is not fully supported/);

  const wrongChange = structuredClone(validOutput());
  wrongChange.documents[0]!.kind = "change_summary";
  wrongChange.documents[0]!.logicalId = `change:acme/repo:${"f".repeat(40)}`;
  await assert.rejects(() => validate(wrongChange), /commit identity does not match/);

  const wrongIssue = structuredClone(validOutput());
  wrongIssue.documents[1]!.logicalId = "issue:github:acme/repo#99";
  wrongIssue.documents[1]!.scope.issues = [];
  await assert.rejects(() => validate(wrongIssue), /issue identity is not supported/);

  const hallucinatedIncident = structuredClone(validOutput());
  hallucinatedIncident.documents[0]!.kind = "incident";
  hallucinatedIncident.documents[0]!.logicalId = "incident:hallucinated-scope:billing";
  await assert.rejects(() => validate(hallucinatedIncident), /identity suffix is not fully supported/);

  const uncitedDistantSymbol = structuredClone(validOutput());
  uncitedDistantSymbol.documents[0]!.scope.symbols = ["distantOnlySymbol"];
  await assert.rejects(() => validate(uncitedDistantSymbol), /scope contains unsupported text/);

  const unrelatedManifestPath = structuredClone(validOutput());
  unrelatedManifestPath.documents[0]!.scope.paths = ["README.md"];
  await assert.rejects(() => validate(unrelatedManifestPath), /path not supported by cited evidence/);
});

test("citation claims must be verbatim in the exact cited evidence selection", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const unrelated = validOutput();
  unrelated.documents[0]!.citations[0]!.claim = "The payment function always retries failed charges.";
  unrelated.documents[0]!.bodyMarkdown = "The payment function always retries failed charges.";
  await assert.rejects(
    () =>
      new KnowledgeOutputValidator(store).validate({
        output: unrelated,
        checkpointId: checkpoint.id,
        generatorName: "test",
        generatorVersion: "1",
        model: "test",
        promptVersion: "1",
        createdAt
      }),
    /claim is not present in the cited evidence/
  );

  const mixedSelector = validOutput();
  mixedSelector.documents[0]!.citations[0]!.jsonPointer = "/state";
  await assert.rejects(
    () =>
      new KnowledgeOutputValidator(store).validate({
        output: mixedSelector,
        checkpointId: checkpoint.id,
        generatorName: "test",
        generatorVersion: "1",
        model: "test",
        promptVersion: "1",
        createdAt
      }),
    /does not resolve|invalid selector/
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
  assert.deepEqual(await store.listCurrentEligibleRevisions(tenantId, repository, checkpoint.id), []);
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
    (await store.listCurrentEligibleRevisions(tenantId, repository, checkpoint.id)).map((value) => value.id),
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

test("eligible knowledge is selected within ref and commit before logical-id recency", async () => {
  const store = new MemoryContextEngineStore();
  const mainCheckpoint = await ingestFixture(store);
  const mainRecord = (await store.listEvidence(mainCheckpoint.id)).find(
    (record) => record.anchor.sourceId === blobSha
  )!;
  const devCommitSha = "d".repeat(40);
  const devBlobSha = "e".repeat(40);
  const devCheckpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "dev",
    refSequence: 1,
    commitSha: devCommitSha,
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
    observationFrontier: "github:dev",
    sourceComplete: true,
    createdAt: "2026-07-26T12:03:00.000Z",
    files: [
      {
        path: "src/billing.ts",
        blobSha: devBlobSha,
        body: "export function handlePayment() { return 'dev'; }",
        language: "typescript"
      }
    ],
    observations: []
  });
  const devRecord = (await store.listEvidence(devCheckpoint.id))[0]!;
  const mainRevision = createKnowledgeRevision({
    logicalId: "component:acme/repo:billing",
    tenantId,
    repository,
    kind: "component",
    title: "main billing",
    bodyMarkdown: "main billing",
    summary: "main billing",
    structuredSummary: {},
    scope: { ref: "main", commitSha, paths: ["src/billing.ts"], symbols: [], pullRequests: [], issues: [] },
    evidenceFingerprint: fingerprint(mainRecord.anchor),
    generatorName: "test",
    generatorVersion: "1",
    model: "test",
    promptVersion: "1",
    confidence: 1,
    createdAt: "2026-07-26T12:01:00.000Z"
  });
  const { id: _mainRevisionId, bodyDigest: _mainBodyDigest, ...revisionBase } = mainRevision;
  const devRevision = createKnowledgeRevision({
    ...revisionBase,
    title: "dev billing",
    bodyMarkdown: "dev billing",
    summary: "dev billing",
    scope: {
      ref: "dev",
      commitSha: devCommitSha,
      paths: ["src/billing.ts"],
      symbols: [],
      pullRequests: [],
      issues: []
    },
    evidenceFingerprint: fingerprint(devRecord.anchor),
    createdAt: "2026-07-26T12:04:00.000Z"
  });
  for (const [runId, checkpointId, revision, record] of [
    ["run-main-scope", mainCheckpoint.id, mainRevision, mainRecord],
    ["run-dev-scope", devCheckpoint.id, devRevision, devRecord]
  ] as const) {
    await store.commitKnowledge({
      run: {
        id: runId,
        tenantId,
        repository,
        checkpointId,
        cacheKey: runId,
        focusFingerprint: runId,
        generatorName: "test",
        generatorVersion: "1",
        model: "test",
        promptVersion: "1",
        schemaVersion: "1",
        rawOutputs: [],
        status: "succeeded",
        diagnostics: [],
        revisionIds: [revision.id],
        createdAt: revision.createdAt
      },
      revisions: [revision],
      citations: [createKnowledgeCitation(revision.id, 0, revision.bodyMarkdown, record.anchor)]
    });
  }
  assert.deepEqual(
    (await store.listCurrentEligibleRevisions(tenantId, repository, mainCheckpoint.id)).map((item) => item.id),
    [mainRevision.id]
  );
  assert.deepEqual(
    (await store.listCurrentEligibleRevisions(tenantId, repository, devCheckpoint.id)).map((item) => item.id),
    [devRevision.id]
  );
  assert.equal(
    (await new IndexContextService(store).index(mainCheckpoint.id, "2026-07-26T12:05:00.000Z")).capabilities
      .derivedKnowledge,
    "available"
  );
  assert.equal(
    (await new IndexContextService(store).index(devCheckpoint.id, "2026-07-26T12:05:00.000Z")).capabilities
      .derivedKnowledge,
    "available"
  );
  const nextMainCheckpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    refSequence: 2,
    commitSha: "f".repeat(40),
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
    observationFrontier: "github:main-next",
    sourceComplete: true,
    createdAt: "2026-07-26T12:06:00.000Z",
    files: [
      {
        path: "src/billing.ts",
        blobSha: "a".repeat(40),
        body: "export function handlePayment() { return 'main-next'; }",
        language: "typescript"
      }
    ],
    observations: []
  });
  assert.deepEqual(
    (await selectPriorKnowledge(store, nextMainCheckpoint)).map((entry) => entry.revision.id),
    [mainRevision.id]
  );
});

test("knowledge reuse requires every citation digest to exist in the current checkpoint", async () => {
  const store = new MemoryContextEngineStore();
  const first = await ingestSameCommitProviderState(store, 1, "open for retry", "github:100", createdAt);
  const firstGenerator = new SequenceGenerator([validOutput()]);
  const firstRun = await new DeriveKnowledgeService(
    new EvidenceFocusSelector(store),
    firstGenerator,
    store,
    new KnowledgeOutputValidator(store)
  ).derive(first.id, "2026-07-26T12:01:00.000Z");
  assert.equal(firstRun.status, "succeeded");
  assert.equal(firstGenerator.calls, 1);

  const changed = await ingestSameCommitProviderState(
    store,
    2,
    "closed after retry",
    "github:101",
    "2026-07-26T12:02:00.000Z"
  );
  assert.deepEqual((await selectPriorKnowledge(store, changed)).map((entry) => entry.revision.logicalId).sort(), [
    "component:acme/repo:billing",
    "issue:github:acme/repo#42"
  ]);
  const beforeRederive = await new IndexContextService(store).index(changed.id, "2026-07-26T12:03:00.000Z");
  const beforeProjection = await store.getGeneration(beforeRederive.id);
  assert.ok(beforeProjection?.currentKnowledge.some((selection) => selection.logicalId.includes("component:")));
  assert.ok(!beforeProjection?.currentKnowledge.some((selection) => selection.logicalId.includes("issue:")));

  const changedOutput = structuredClone(validOutput());
  const issueDocument = changedOutput.documents[1]!;
  issueDocument.title = "closed after retry";
  issueDocument.summary = "closed after retry";
  issueDocument.bodyMarkdown = "closed after retry [cite:1]";
  issueDocument.structuredSummary = citedStructuredSummary(
    "closed after retry",
    "closed after retry",
    "closed after retry"
  );
  issueDocument.citations[0]!.claim = "closed after retry";
  const changedGenerator = new SequenceGenerator([changedOutput]);
  const changedRun = await new DeriveKnowledgeService(
    new EvidenceFocusSelector(store),
    changedGenerator,
    store,
    new KnowledgeOutputValidator(store)
  ).derive(changed.id, "2026-07-26T12:04:00.000Z");
  assert.equal(changedRun.status, "succeeded", changedRun.diagnostics.join("; "));
  const enriched = await new IndexContextService(store).index(changed.id, "2026-07-26T12:05:00.000Z");
  assert.ok(
    (await store.getGeneration(enriched.id))?.currentKnowledge.some(
      (selection) => selection.logicalId === "issue:github:acme/repo#42"
    )
  );

  const identical = await ingestSameCommitProviderState(
    store,
    3,
    "closed after retry",
    "github:102",
    "2026-07-26T12:02:00.000Z"
  );
  assert.equal(identical.evidenceFingerprint, changed.evidenceFingerprint);
  const cacheOnlyGenerator = new SequenceGenerator([]);
  const cached = await new DeriveKnowledgeService(
    new EvidenceFocusSelector(store),
    cacheOnlyGenerator,
    store,
    new KnowledgeOutputValidator(store)
  ).derive(identical.id, "2026-07-26T12:06:00.000Z");
  assert.equal(cached.id, changedRun.id);
  assert.equal(cacheOnlyGenerator.calls, 0);
  assert.equal(
    (await new IndexContextService(store).index(identical.id, "2026-07-26T12:07:00.000Z")).capabilities
      .derivedKnowledge,
    "available"
  );
});

test("knowledge retries preserve canonical timestamps and reject all other immutable changes", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const firstRun = await deriveFixture(store, checkpoint.id);
  const revision = await store.getRevision(firstRun.revisionIds[0]!);
  assert.ok(revision);
  const citations = await store.listCitations(revision.id);
  const retryCreatedAt = "2026-07-26T12:02:00.000Z";
  const retryRevision = { ...revision, createdAt: retryCreatedAt };
  const retryRun = {
    ...firstRun,
    id: "retry-run",
    cacheKey: "retry-cache",
    revisionIds: [retryRevision.id],
    createdAt: retryCreatedAt
  };
  await store.commitKnowledge({ run: retryRun, revisions: [retryRevision], citations });
  assert.equal((await store.getRevision(revision.id))?.createdAt, revision.createdAt);

  await assert.rejects(
    store.commitKnowledge({
      run: { ...retryRun, id: "divergent-revision-run", cacheKey: "divergent-revision-cache" },
      revisions: [{ ...retryRevision, title: "divergent title" }],
      citations
    }),
    /revision identity collision/
  );
  await assert.rejects(
    store.commitKnowledge({
      run: { ...retryRun, id: "divergent-citation-run", cacheKey: "divergent-citation-cache" },
      revisions: [retryRevision],
      citations: [{ ...citations[0]!, claim: "divergent claim" }, ...citations.slice(1)]
    }),
    /citations cannot be changed/
  );
  await assert.rejects(
    store.commitKnowledge({
      run: { ...retryRun, id: "removed-citation-run", cacheKey: "removed-citation-cache" },
      revisions: [retryRevision],
      citations: []
    }),
    /require source citations/
  );
  await assert.rejects(
    store.commitKnowledge({
      run: { ...retryRun, id: "added-citation-run", cacheKey: "added-citation-cache" },
      revisions: [retryRevision],
      citations: [
        ...citations,
        createKnowledgeCitation(retryRevision.id, citations.length, citations[0]!.claim, citations[0]!.anchor)
      ]
    }),
    /citations cannot be changed/
  );
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
    question: "Give an overview of handlePayment"
  });
  const knowledgeCitation = overview.citations.find((citation) => citation.sourceKind === "knowledge");
  assert.ok(knowledgeCitation);
  assert.match(knowledgeCitation.excerpt, /Source: src\/billing\.ts/);
  assert.match(knowledgeCitation.excerpt, /export function handlePayment/);
  const diagnosis = await new QueryContextService(store).query({
    tenantId,
    principalId: "alice",
    repository,
    ref: "main",
    taskKind: "diagnose",
    question: "Why are zero payment totals rejected, how can I check and fix it?"
  });
  assert.ok(diagnosis.coverage.retrieversUsed.includes("knowledge"));
  assert.ok(diagnosis.citations.some((citation) => citation.sourceKind === "knowledge"));
  const issueStatus = await new QueryContextService(store).query({
    tenantId,
    principalId: "alice",
    repository,
    ref: "main",
    taskKind: "intent",
    question: "Why is issue 42 open for retry?",
    targets: { issues: ["42"] }
  });
  const pointerCitation = issueStatus.citations.find((citation) =>
    citation.anchors.some((anchor) => anchor.sourceId === "issue-42" && anchor.jsonPointer === "/state")
  );
  assert.ok(pointerCitation);
  assert.equal(pointerCitation.excerpt, "Source: https://example.test/acme/repo/issues/42\nopen for retry");
  assert.doesNotMatch(pointerCitation.excerpt, /Retry payments|number/);
});

test("query defaults to main even when another ref was published more recently", async () => {
  const store = new MemoryContextEngineStore();
  const mainCheckpoint = await ingestFixture(store);
  await new IndexContextService(store).index(mainCheckpoint.id, "2026-07-26T12:01:00.000Z");
  const devCommitSha = "d".repeat(40);
  const devCheckpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "dev",
    refSequence: 1,
    commitSha: devCommitSha,
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
    observationFrontier: "github:dev-query",
    sourceComplete: true,
    createdAt: "2026-07-26T12:02:00.000Z",
    files: [
      {
        path: "README.md",
        blobSha: "d".repeat(40),
        body: "Development branch",
        language: "markdown"
      }
    ],
    observations: []
  });
  await new IndexContextService(store).index(devCheckpoint.id, "2026-07-26T12:03:00.000Z");
  await store.replaceRepositoryAccess(tenantId, "alice", [repository]);
  const response = await new QueryContextService(store).query({
    tenantId,
    principalId: "alice",
    repository,
    question: "repository"
  });
  assert.equal(response.generation.ref, "main");
  assert.equal(response.generation.commitSha, commitSha);
});

test("query revalidates repository access after evidence assembly and before returning", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  await new IndexContextService(store).index(checkpoint.id, createdAt);
  await store.replaceRepositoryAccess(tenantId, "alice", [repository]);
  class RevokingAuthorizer extends StoreScopeAuthorizer {
    calls = 0;

    override async authorize(input: Parameters<StoreScopeAuthorizer["authorize"]>[0]) {
      this.calls += 1;
      if (this.calls === 2) {
        await store.replaceRepositoryAccess(tenantId, "alice", []);
      }
      return super.authorize(input);
    }
  }
  await assert.rejects(
    () =>
      new QueryContextService(store, new RevokingAuthorizer(store)).query({
        tenantId,
        principalId: "alice",
        repository,
        question: "repository"
      }),
    /access changed|does not have repository access/i
  );
});

test("explicit file targets exclude provider records that merely mention the path", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    commitSha,
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
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
    refSequence: 1,
    commitSha,
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
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
    refSequence: 1,
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
  const diagnose = planContextQuery({
    tenantId,
    principalId: "alice",
    repository,
    question: "What is the root cause and how should we fix this failure?"
  });
  assert.equal(diagnose.taskKind, "diagnose");
  assert.ok(diagnose.routes.some((route) => route.route === "knowledge"));
  assert.ok(diagnose.routes.some((route) => route.route === "structured"));
  assert.ok(diagnose.routes.some((route) => route.route === "temporal"));
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

test("workflow names are clean and indexing is required after derivation", async () => {
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
    githubInstallationId: 140435029,
    requestKey: "build-1",
    createdAt
  });
  assert.ok(build.stages.every((stage) => stage.required));
  const ingest = await coordinator.claim({
    tenantIds: [tenantId],
    workerId: "worker",
    topics: [contextQueueTopics.ingestEvidence],
    now: "2026-07-26T12:00:01.000Z",
    leaseExpiresAt: "2026-07-26T12:10:00.000Z"
  });
  assert.ok(ingest);
  assert.equal(build.refSequence, 1);
  assert.equal(ingest.stage.metadata.refSequence, 1);
  assert.equal(ingest.stage.metadata.commitSha, commitSha);
  assert.equal(ingest.stage.metadata.githubInstallationId, 140435029);
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
  // Indexing is what makes the derived pages fast to query, so it waits for
  // them; derivation only needs the checkpoint manifest, which ingestion wrote.
  const [derive, prematureIndex] = await Promise.all([
    coordinator.claim({
      tenantId,
      workerId: "derive-worker",
      topics: [contextQueueTopics.deriveKnowledge],
      now: "2026-07-26T12:00:03.000Z",
      leaseExpiresAt: "2026-07-26T12:10:00.000Z"
    }),
    coordinator.claim({
      tenantId,
      workerId: "index-worker",
      topics: [contextQueueTopics.indexContext],
      now: "2026-07-26T12:00:03.000Z",
      leaseExpiresAt: "2026-07-26T12:10:00.000Z"
    })
  ]);
  assert.ok(derive);
  assert.equal(prematureIndex, undefined);
  await coordinator.complete({
    tenantId,
    stageId: derive.stage.id,
    fence: derive.fence,
    outcome: "succeeded",
    now: "2026-07-26T12:00:04.000Z"
  });
  const index = await coordinator.claim({
    tenantId,
    workerId: "worker",
    topics: [contextQueueTopics.indexContext],
    now: "2026-07-26T12:00:05.000Z",
    leaseExpiresAt: "2026-07-26T12:10:00.000Z"
  });
  assert.ok(index);
  await coordinator.complete({
    tenantId,
    stageId: index.stage.id,
    fence: index.fence,
    outcome: "succeeded",
    now: "2026-07-26T12:00:06.000Z"
  });
  const updated = await coordinator.get(build.id);
  assert.equal(updated?.stages.find((stage) => stage.type === "index-context")?.status, "succeeded");
  assert.equal(updated?.status, "succeeded");
});

test("a failed required derivation fails the context build", async () => {
  const coordinator = new MemoryContextPipelineCoordinator();
  const build = await coordinator.createBuild({
    tenantId,
    repository,
    ref: "main",
    requestKey: "required-derivation-failure",
    createdAt
  });
  const claimAndComplete = async (
    topic: (typeof contextQueueTopics)[keyof typeof contextQueueTopics],
    outcome: "succeeded" | "failed",
    second: number
  ) => {
    const claimedAt = `2026-07-26T12:00:${String(second).padStart(2, "0")}.000Z`;
    const completedAt = `2026-07-26T12:00:${String(second + 1).padStart(2, "0")}.000Z`;
    const claim = await coordinator.claim({
      tenantId,
      workerId: "worker",
      topics: [topic],
      now: claimedAt,
      leaseExpiresAt: "2026-07-26T12:10:00.000Z"
    });
    assert.ok(claim);
    assert.equal(
      await coordinator.complete({
        tenantId,
        stageId: claim.stage.id,
        fence: claim.fence,
        outcome,
        now: completedAt,
        ...(outcome === "failed" ? { error: "required derivation failed" } : {})
      }),
      true
    );
  };
  // Derivation runs second now, so a failure there means indexing is never
  // reached: there are no pages to make queryable.
  await claimAndComplete(contextQueueTopics.ingestEvidence, "succeeded", 1);
  await claimAndComplete(contextQueueTopics.deriveKnowledge, "failed", 3);
  const failed = await coordinator.get(build.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.stages.find((stage) => stage.type === "derive-knowledge")?.required, true);
});

test("per-ref build sequence prevents delayed older pushes from becoming current", async () => {
  const coordinator = new MemoryContextPipelineCoordinator();
  const older = await coordinator.createBuild({
    tenantId,
    repository,
    ref: "main",
    commitSha: "1".repeat(40),
    requestKey: "push-older",
    createdAt: "2026-07-26T12:00:00.000Z"
  });
  const newer = await coordinator.createBuild({
    tenantId,
    repository,
    ref: "main",
    commitSha: "2".repeat(40),
    requestKey: "push-newer",
    createdAt: "2026-07-26T12:00:01.000Z"
  });
  assert.equal(older.refSequence, 1);
  assert.equal(newer.refSequence, 2);

  const store = new MemoryContextEngineStore(coordinator);
  const initialFrontier = await store.projectionInputFingerprint(tenantId, repository);
  const delayedOlderCheckpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    refSequence: older.refSequence,
    commitSha: "1".repeat(40),
    aclFingerprint: "acl",
    observationFrontier: "older-delayed",
    sourceComplete: true,
    createdAt: "2026-07-26T12:00:02.000Z",
    files: []
  });
  assert.equal(await store.projectionInputFingerprint(tenantId, repository), initialFrontier);
  assert.equal(await store.latestCheckpoint(tenantId, repository, "main"), undefined);
  await assert.rejects(
    new IndexContextService(store).index(delayedOlderCheckpoint.id, "2026-07-26T12:00:03.000Z"),
    /superseded/
  );
  await assert.rejects(
    store.commitKnowledge({
      run: {
        id: "stale-derive-run",
        tenantId,
        repository,
        checkpointId: delayedOlderCheckpoint.id,
        cacheKey: "stale-derive-cache",
        focusFingerprint: "stale",
        generatorName: "test",
        generatorVersion: "1",
        model: "test",
        promptVersion: "1",
        schemaVersion: "1",
        rawOutputs: [],
        status: "succeeded",
        diagnostics: [],
        revisionIds: [],
        createdAt: "2026-07-26T12:00:03.000Z"
      },
      revisions: [],
      citations: []
    }),
    /superseded/
  );
  assert.equal(await store.projectionInputFingerprint(tenantId, repository), initialFrontier);

  const newerCheckpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    refSequence: newer.refSequence,
    commitSha: "2".repeat(40),
    aclFingerprint: "acl",
    observationFrontier: "newer",
    sourceComplete: true,
    createdAt: "2026-07-26T12:00:04.000Z",
    files: []
  });
  assert.equal((await store.latestCheckpoint(tenantId, repository, "main"))?.id, newerCheckpoint.id);
  assert.equal(
    (await new IndexContextService(store).index(newerCheckpoint.id, "2026-07-26T12:00:06.000Z")).commitSha,
    "2".repeat(40)
  );
});

test("canonical input frontier rejects an index that races evidence erasure", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const hierarchy = {
    async probe() {
      return { available: true };
    },
    async build(input: HierarchyBuildInput) {
      await store.eraseEvidence({
        tenantId,
        repository,
        sourceType: "blob",
        sourceId: blobSha,
        actorId: "security-test",
        reason: "race fixture",
        createdAt: "2026-07-26T12:00:01.000Z"
      });
      return {
        adapterName: "race-fixture",
        adapterVersion: input.adapterVersion,
        nodes: [],
        diagnostics: []
      };
    }
  };
  await assert.rejects(
    new IndexContextService(store, hierarchy).index(checkpoint.id, "2026-07-26T12:00:02.000Z"),
    /Canonical projection inputs changed/
  );
  assert.equal(await store.latestPublished(tenantId, repository, "main"), undefined);
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
      refSequence: 1,
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
          refSequence: 1,
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
  const firstGrant = await store.repositoryAccessFingerprint("old", "acme/repo");
  await store.replaceRepositoryAccess("old", "alice", ["acme/repo"]);
  assert.equal(await store.repositoryAccessFingerprint("old", "acme/repo"), firstGrant);
  await store.replaceRepositoryAccess("old", "alice", []);
  const revoked = await store.repositoryAccessFingerprint("old", "acme/repo");
  assert.notEqual(revoked, firstGrant);
  await store.replaceRepositoryAccess("old", "alice", ["acme/repo"]);
  assert.notEqual(await store.repositoryAccessFingerprint("old", "acme/repo"), firstGrant);
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
  const largeValue = Array.from({ length: 10_000 }, (_, index) => ({
    index,
    nested: { z: `value-${index}`, a: index % 7 }
  }));
  assert.equal(fingerprint(largeValue), createHash("sha256").update(canonicalJson(largeValue)).digest("hex"));
});

test("memory API tokens resolve their own tenant and go invisible once revoked or expired", async () => {
  const store = new MemoryContextEngineStore(new MemoryContextPipelineCoordinator());
  const mint = (id: string, tenantId: string, secretHash: string, expiresAt: string) =>
    store.mintApiToken({
      id,
      tenantId,
      principalId: "user:alice@example.com",
      name: id,
      secretHash,
      scopes: ["context:read"],
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "svc:api",
      expiresAt
    });

  const live = await mint("atk_live", "tenant-a", "a".repeat(64), "2999-01-01T00:00:00.000Z");
  await mint("atk_other", "tenant-b", "b".repeat(64), "2999-01-01T00:00:00.000Z");
  await mint("atk_expired", "tenant-a", "c".repeat(64), "2026-01-02T00:00:00.000Z");

  // The secret never survives a mint or a list, so no read path can leak it.
  assert.equal("secretHash" in live, false);
  assert.deepEqual(
    (await store.listApiTokens("tenant-a")).map((token) => "secretHash" in token),
    [false, false]
  );

  // Verification resolves the tenant from the token rather than being told it.
  assert.equal((await store.verifyApiToken("a".repeat(64)))?.tenantId, "tenant-a");
  assert.equal((await store.verifyApiToken("b".repeat(64)))?.tenantId, "tenant-b");
  assert.equal(await store.verifyApiToken("c".repeat(64)), undefined);
  assert.equal(await store.verifyApiToken("d".repeat(64)), undefined);

  // A duplicate secret cannot be minted twice, matching the unique index.
  await assert.rejects(mint("atk_dup", "tenant-b", "a".repeat(64), "2999-01-01T00:00:00.000Z"), /Duplicate/);

  await store.stampApiTokenUse("tenant-a", "atk_live", "2026-06-01T00:00:00.000Z");
  assert.equal((await store.verifyApiToken("a".repeat(64)))?.lastUsedAt, "2026-06-01T00:00:00.000Z");

  // Revocation takes effect immediately, and a second revocation preserves the
  // first revoker rather than overwriting the audit trail.
  const revoked = await store.revokeApiToken(
    "tenant-a",
    "atk_live",
    "user:admin@example.com",
    "2026-06-02T00:00:00.000Z"
  );
  assert.equal(revoked?.revokedBy, "user:admin@example.com");
  assert.equal(await store.verifyApiToken("a".repeat(64)), undefined);
  const again = await store.revokeApiToken(
    "tenant-a",
    "atk_live",
    "user:someone@example.com",
    "2026-06-03T00:00:00.000Z"
  );
  assert.equal(again?.revokedBy, "user:admin@example.com");
  assert.equal(again?.revokedAt, "2026-06-02T00:00:00.000Z");

  // A token belonging to another tenant is not revocable, and is not listed.
  assert.equal(
    await store.revokeApiToken("tenant-a", "atk_other", "user:admin@example.com", "2026-06-02T00:00:00.000Z"),
    undefined
  );
  assert.equal((await store.verifyApiToken("b".repeat(64)))?.tokenId, "atk_other");
});

test("the file contract asks for a maintenance wiki, written as it goes", () => {
  const bundle = {
    checkpoint: {
      repository: "omxyz/jina",
      ref: "main",
      commitSha: "a".repeat(40),
      sourceCompleteness: "complete" as const,
      evidenceFingerprint: "f".repeat(64)
    },
    items: [],
    omittedCount: 0,
    truncatedEvidenceIds: []
  };
  const catalog = buildKnowledgePrompt(bundle as never);
  const files = buildKnowledgeFilePrompt(bundle as never);

  // The catalog contract makes the final message the work product, which is what
  // makes compaction destructive: anything not yet emitted is lost.
  assert.match(catalog, /Return only the schema-conforming final JSON/);
  assert.match(catalog, /Re-emit every still-valid logical document/);

  // The file contract makes each finished document durable instead.
  assert.match(files, /Markdown file under/);
  assert.match(files, /before moving to the next subject/);
  assert.doesNotMatch(files, /Return only the schema-conforming final JSON/);
  assert.doesNotMatch(files, /Re-emit every still-valid logical document/);
  // The one write it may perform is scoped to the output directory.
  assert.match(files, /is the only path you may write to\. Never write repository files\./);

  // It asks for a maintenance aid rather than a description of the code.
  assert.match(files, /helps somebody maintain this repository/);
  assert.match(files, /what breaks if I change it/);
  // And lets the repository choose its own structure rather than imposing one.
  assert.match(files, /Choose the folder structure that fits this repository/);

  // Both reference forms, and the rule that makes a claim checkable.
  assert.match(files, /must occur verbatim in those exact lines/);
  assert.match(files, /relative Markdown links/);
  assert.match(files, /at least one evidence link, or it cannot be published/);
  // The diagnostic sections retrieval depends on.
  assert.match(files, /## Symptoms/);
  assert.match(files, /## Fixes/);
});

test("the per-document schema is the catalog's own item schema, so the two cannot drift", () => {
  const item = knowledgeGenerationJsonSchema.properties.documents.items as Record<string, unknown>;
  for (const key of Object.keys(item)) {
    assert.deepEqual(
      (knowledgeDocumentJsonSchema as Record<string, unknown>)[key],
      item[key],
      `document schema diverged at ${key}`
    );
  }
  // It stands alone, so it can be handed to --output-schema by itself.
  assert.equal(knowledgeDocumentJsonSchema.$id, "knowledge-documents-v4-document");
});

test("a document file is parsed by the same validation the catalog uses", () => {
  const document = {
    logicalId: "component:omxyz/jina:api/server",
    kind: "component",
    title: "API server",
    summary: "Serves the context routes.",
    summaryCitationOrdinals: [1],
    bodyMarkdown: "The server dispatches context routes. [cite:1]",
    structuredSummary: {
      facts: [],
      questionsAnswered: [],
      diagnostics: { symptoms: [], causes: [], checks: [], fixes: [] },
      claimSubject: null,
      claimValue: null,
      claimCitationOrdinals: []
    },
    scope: { paths: ["apps/api/src/server.ts"], symbols: [], pullRequests: [], issues: [] },
    confidence: 0.9,
    citations: [
      {
        claim: "dispatches context routes",
        sourceType: "blob",
        sourceId: "b".repeat(40),
        pathOrUrl: "apps/api/src/server.ts",
        startLine: 1,
        endLine: 2
      }
    ]
  };
  const parsed = parseKnowledgeDocumentFile(document, "file");
  assert.equal(parsed.logicalId, "component:omxyz/jina:api/server");
  assert.equal(parsed.kind, "component");
  // A malformed file fails the same way a malformed catalog entry does.
  assert.throws(() => parseKnowledgeDocumentFile({ ...document, citations: [] }, "file"), /at least one citation/);
});

test("derivation detail is named for the choice, not the model setting it maps to", () => {
  assert.deepEqual([...derivationDetailLevels], ["concise", "standard", "thorough"]);
  // The deployed default was the model's terse setting on a task whose output is
  // the document, which is a direct cause of one-paragraph knowledge.
  assert.equal(codexVerbosity("concise"), "low");
  assert.equal(codexVerbosity("standard"), "medium");
  assert.equal(codexVerbosity("thorough"), "high");

  // Unknown input falls back rather than throwing: a build at the default detail
  // beats no build, and the HTTP layer rejects a bad value before it reaches here.
  assert.equal(derivationDetailOrDefault(undefined), "standard");
  assert.equal(derivationDetailOrDefault("verbose"), "standard");
  assert.equal(derivationDetailOrDefault("thorough"), "thorough");
  assert.equal(derivationDetailOrDefault(undefined, "thorough"), "thorough");
  assert.equal(isDerivationDetail("thorough"), true);
  assert.equal(isDerivationDetail("high"), false);
});

test("a build carries its chosen detail to the derive stage, not to the others", async () => {
  const coordinator = new MemoryContextPipelineCoordinator();
  const build = await coordinator.createBuild({
    tenantId: "tenant-detail",
    repository: "omxyz/jina",
    ref: "main",
    requestKey: "rk-detail",
    createdAt: "2026-01-01T00:00:00.000Z",
    derivationDetail: "thorough"
  });
  const derive = build.stages.find((stage) => stage.type === "derive-knowledge");
  assert.equal(derive?.metadata.derivationDetail, "thorough");
  // The choice belongs to the stage that acts on it; nothing else should carry it.
  for (const stage of build.stages.filter((candidate) => candidate.type !== "derive-knowledge")) {
    assert.equal(stage.metadata.derivationDetail, undefined);
  }

  // A build that does not choose carries nothing, so the deployment default applies.
  const plain = await coordinator.createBuild({
    tenantId: "tenant-detail",
    repository: "omxyz/jina",
    ref: "main",
    requestKey: "rk-plain",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(plain.stages.find((stage) => stage.type === "derive-knowledge")?.metadata.derivationDetail, undefined);
});
