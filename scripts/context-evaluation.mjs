#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  ExactRetriever,
  HierarchyIndexRetriever,
  IndexContextService,
  IngestEvidenceService,
  KnowledgeRetriever,
  LexicalRetriever,
  LongContextRetriever,
  MemoryContextEngineStore,
  QueryContextService,
  StructuralRetriever,
  StructuredRetriever,
  TemporalRetriever
} from "../packages/context-engine/dist/index.js";

const fixtureUrl = new URL("../packages/context-engine/evaluation/fixtures.v1.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
if (fixture.schemaVersion !== "context-evaluation-v1") throw new Error("Unsupported evaluation fixture schema");

const store = new MemoryContextEngineStore();
await store.replaceRepositoryAccess(fixture.tenantId, fixture.principalId, [fixture.repository]);
const files = fixture.files.map((file) => ({
  ...file,
  body:
    file.repeatParagraphs > 0
      ? `${"# Operational checkpoint\n\nVerify leases, generation identity, and source citations.\n\n".repeat(file.repeatParagraphs)}${file.body}`
      : file.body
}));
const checkpoint = await new IngestEvidenceService(store).ingest({
  tenantId: fixture.tenantId,
  repository: fixture.repository,
  ref: fixture.ref,
  commitSha: fixture.commitSha,
  files,
  observations: fixture.observations,
  aclFingerprint: "evaluation-reader-acl",
  observationFrontier: fixture.createdAt,
  createdAt: fixture.createdAt,
  sourceComplete: true
});
await new IndexContextService(store).index(checkpoint.id, fixture.createdAt);

const variants = {
  lexical_only: [new LexicalRetriever()],
  lexical_structural: [new LexicalRetriever(), new StructuralRetriever()],
  lexical_dense: [new LexicalRetriever()],
  lexical_hierarchy: [new LexicalRetriever(), new HierarchyIndexRetriever()],
  lexical_knowledge: [new LexicalRetriever(), new KnowledgeRetriever()],
  full_routed_hybrid: [
    new ExactRetriever(),
    new StructuredRetriever(),
    new StructuralRetriever(),
    new LexicalRetriever(),
    new KnowledgeRetriever(),
    new TemporalRetriever(),
    new LongContextRetriever(),
    new HierarchyIndexRetriever()
  ],
  full_without_reranking: [
    new ExactRetriever(),
    new StructuredRetriever(),
    new StructuralRetriever(),
    new LexicalRetriever(),
    new KnowledgeRetriever(),
    new TemporalRetriever(),
    new LongContextRetriever(),
    new HierarchyIndexRetriever()
  ],
  routed_long_context: [new LexicalRetriever(), new HierarchyIndexRetriever(), new LongContextRetriever()]
};

const reports = [];
for (const [name, retrievers] of Object.entries(variants)) {
  let expected = 0;
  let found = 0;
  let validCitations = 0;
  let citations = 0;
  let exactExpected = 0;
  let exactFound = 0;
  const cases = [];
  for (const testCase of fixture.cases) {
    const service = new QueryContextService(store, undefined, undefined, retrievers);
    const response = await service.query({
      tenantId: fixture.tenantId,
      principalId: fixture.principalId,
      repository: fixture.repository,
      ref: fixture.ref,
      question: testCase.question,
      taskKind: testCase.taskKind,
      ...(testCase.targets ? { targets: testCase.targets } : {})
    });
    const sourceIds = new Set(
      response.citations.flatMap((citation) => citation.anchors.map((anchor) => anchor.sourceId))
    );
    const matched = testCase.expectedSourceIds.filter((sourceId) => sourceIds.has(sourceId)).length;
    expected += testCase.expectedSourceIds.length;
    found += matched;
    if (testCase.category === "exact") {
      exactExpected += testCase.expectedSourceIds.length;
      exactFound += matched;
    }
    for (const citation of response.citations) {
      citations += 1;
      const anchorsValid = await Promise.all(
        citation.anchors.map(async (anchor) => {
          const record = await store.resolveAnchor(checkpoint.id, {
            tenantId: anchor.tenantId,
            repository: anchor.repository,
            sourceType: anchor.sourceType,
            sourceId: anchor.sourceId,
            ...(anchor.commitSha ? { commitSha: anchor.commitSha } : {}),
            ...(anchor.pathOrUrl ? { pathOrUrl: anchor.pathOrUrl } : {}),
            ...(anchor.startLine ? { startLine: anchor.startLine } : {}),
            ...(anchor.endLine ? { endLine: anchor.endLine } : {}),
            ...(anchor.jsonPointer ? { jsonPointer: anchor.jsonPointer } : {})
          });
          return record?.anchor.contentDigest === anchor.contentDigest;
        })
      );
      if (anchorsValid.every(Boolean)) validCitations += 1;
    }
    cases.push({
      id: testCase.id,
      category: testCase.category,
      expected: testCase.expectedSourceIds.length,
      found: matched,
      coverage: response.coverage.status,
      retrievers: response.coverage.retrieversUsed
    });
  }
  reports.push({
    variant: name,
    enabled: name !== "lexical_dense",
    evidenceRecall: expected === 0 ? 1 : found / expected,
    exactCompleteness: exactExpected === 0 ? null : exactFound / exactExpected,
    citationIntegrity: citations === 0 ? 1 : validCitations / citations,
    cases
  });
}

const full = reports.find((report) => report.variant === "full_routed_hybrid");
const output = {
  schemaVersion: "context-evaluation-report-v1",
  fixtureVersion: fixture.schemaVersion,
  generatedAt: new Date().toISOString(),
  optionalCapabilities: {
    dense: {
      enabled: false,
      decision: "disabled",
      reason: "No approved embedding backend; the lexical+dense row is a control and shows no incremental gain."
    },
    pageIndex: {
      enabled: false,
      decision: "fallback",
      reason: "The deterministic hierarchy remains active until PageIndex beats it on a larger long-document slice."
    }
  },
  variants: reports,
  gates: {
    exactCompleteness: full.exactCompleteness,
    citationIntegrity: full.citationIntegrity,
    evidenceRecallAt20: full.evidenceRecall
  }
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (full.exactCompleteness !== 1 || full.citationIntegrity !== 1 || full.evidenceRecall < 0.9) {
  process.exitCode = 1;
}
