import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  FallbackHierarchyIndexer,
  IndexContextService,
  IngestEvidenceService,
  KnowledgeOutputValidator,
  MemoryContextEngineStore,
  PageIndexHierarchyAdapter,
  QueryContextService,
  StaticScopeAuthorizer,
  StoreScopeAuthorizer,
  assembleEvidencePack,
  canonicalJson,
  derivationDetailLevels,
  isDerivationDetail,
  createKnowledgeCitation,
  createKnowledgeRevision,
  detectSourceConflicts,
  fingerprint,
  fuseRetrievalCandidates,
  markdownCatalogToOutput,
  parseMarkdownDocument,
  planContextQuery,
  repositoryAclFingerprint,
  stableId,
  validateEvidenceAnchor,
  verifySynthesisCitations,
  type EvidenceAnchor,
  type HierarchyBuildInput,
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

async function deriveFixture(store: MemoryContextEngineStore, checkpointId: string) {
  const checkpoint = await store.getCheckpoint(checkpointId);
  assert.ok(checkpoint);
  const validated = await new KnowledgeOutputValidator(store).validate({
    output: validOutput(),
    checkpointId,
    generatorName: "fixture-generator",
    generatorVersion: "1",
    model: "fixture-model",
    promptVersion: "fixture-prompt",
    createdAt: "2026-07-26T12:01:00.000Z"
  });
  return store.commitKnowledge({
    run: {
      id: stableId("dr", { checkpointId, fixture: true }),
      tenantId: checkpoint.tenantId,
      repository: checkpoint.repository,
      checkpointId,
      cacheKey: fingerprint({ checkpointId, fixture: true }),
      focusFingerprint: checkpoint.evidenceFingerprint,
      generatorName: "fixture-generator",
      generatorVersion: "1",
      model: "fixture-model",
      promptVersion: "fixture-prompt",
      schemaVersion: "fixture-schema",
      rawOutputs: [],
      status: "succeeded",
      diagnostics: [],
      revisionIds: validated.revisions.map((revision) => revision.id),
      createdAt: "2026-07-26T12:01:00.000Z"
    },
    revisions: validated.revisions,
    citations: validated.citations
  });
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

test("thin ingestion is content-addressed, idempotent, and does not derive structure", async () => {
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
  assert.deepEqual(facts, []);
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
  assert.equal(commit.anchor.pathOrUrl, `https://github.com/${repository}/commit/${commitSha}`);
  assert.deepEqual(commit.metadata.changedPaths, ["src/billing.ts"]);
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

test("inline Markdown validation retains the certified public claim association", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const body =
    "# Billing\n\nThe [billing module accepts payments](README.md#L3-L3) through the repository entry point.\n";
  const conversion = markdownCatalogToOutput(
    [parseMarkdownDocument("architecture", body)],
    repository,
    await store.listManifest(checkpoint.id),
    () => "The billing module accepts payments.",
    [],
    [],
    undefined,
    { naturalEvidenceLabels: true }
  );
  assert.deepEqual(conversion.problems, []);
  assert.deepEqual(conversion.output.documents[0]?.summaryCitationOrdinals, [1]);

  const validated = await new KnowledgeOutputValidator(store).validate({
    output: conversion.output,
    checkpointId: checkpoint.id,
    generatorName: "test",
    generatorVersion: "1",
    model: "test",
    promptVersion: "1",
    createdAt,
    inlineCitations: true
  });
  const citation = validated.citations[0];
  assert.match(citation?.citationId ?? "", /^cite_[a-f0-9]{20}$/);
  assert.equal(citation?.claimSpan, "The billing module accepts payments through the repository entry point.");

  const tampered = structuredClone(conversion.output);
  tampered.documents[0]!.citations[0]!.claimSpan = "A different public assertion.";
  await assert.rejects(
    () =>
      new KnowledgeOutputValidator(store).validate({
        output: tampered,
        checkpointId: checkpoint.id,
        generatorName: "test",
        generatorVersion: "1",
        model: "test",
        promptVersion: "1",
        createdAt,
        inlineCitations: true
      }),
    /not bound to one rendered public claim/
  );
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

test("derived-only indexes publish atomically and rebuild idempotently", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const service = new IndexContextService(store);
  const baseline = await service.index(checkpoint.id, "2026-07-26T12:01:00.000Z");
  assert.equal(baseline.capabilities.derivedKnowledge, "unavailable");
  assert.equal(baseline.projectorStatuses.lexical, "ready");
  assert.equal(baseline.projectorStatuses.dense, "disabled");
  const baselineProjection = await store.getGeneration(baseline.id);
  assert.deepEqual(baselineProjection?.documents, []);
  assert.deepEqual(baselineProjection?.fragments, []);
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
  assert.deepEqual(projection?.structuralRelations, []);
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

test("legacy query retrieval is derived-only and preserves supporting evidence anchors", async () => {
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
  assert.equal(response.coverage.retrieversUsed.includes("structural"), false);
  assert.ok(response.citations.length > 0);
  assert.ok(response.citations.every((citation) => citation.sourceKind === "knowledge"));
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

test("explicit file targets cannot surface raw source or provider evidence", async () => {
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
  assert.equal(response.coverage.status, "insufficient");
  assert.deepEqual(response.citations, []);
});

test("ownership lookup does not expose CODEOWNERS until ownership is derived", async () => {
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
  assert.equal(response.coverage.status, "insufficient");
  assert.deepEqual(response.citations, []);
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

test("provider evidence is never directly returned by retrieval regardless of time window", async () => {
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
  assert.equal(
    current.citations.some((citation) => citation.anchors.some((anchor) => anchor.sourceId === "issue-42")),
    false
  );
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

test("hierarchy indexes derived documents only and external hierarchy anchors are validated", async () => {
  const store = new MemoryContextEngineStore();
  const checkpoint = await ingestFixture(store);
  const first = await new IndexContextService(store, new FallbackHierarchyIndexer()).index(checkpoint.id, createdAt);
  const projection = await store.getGeneration(first.id);
  assert.deepEqual(projection?.hierarchyNodes, []);
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
  const store = new MemoryContextEngineStore();
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
  assert.equal((await store.verifyApiToken("a".repeat(64), "tenant-a"))?.tokenId, "atk_live");
  assert.equal(await store.verifyApiToken("a".repeat(64), "tenant-b"), undefined);
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

test("derivation detail is named for the choice, not the model setting it maps to", () => {
  assert.deepEqual([...derivationDetailLevels], ["concise", "standard", "thorough"]);
  assert.equal(isDerivationDetail("thorough"), true);
  assert.equal(isDerivationDetail("high"), false);
});
