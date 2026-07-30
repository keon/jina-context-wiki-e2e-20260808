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
  TemporalRetriever,
  createKnowledgeCitation,
  createKnowledgeRevision,
  evidenceExcerpt,
  fingerprint,
  repositoryAclFingerprint
} from "../packages/context-engine/dist/index.js";

const fixtureUrl = new URL("../packages/context-engine/evaluation/fixtures.v1.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
if (fixture.schemaVersion !== "context-evaluation-v1") throw new Error("Unsupported evaluation fixture schema");

let database;
let store;
if (process.env.TEST_DATABASE_URL) {
  const { ContextDatabase, PostgresContextEngineStore } = await import("../packages/db/dist/index.js");
  const bootstrap = new ContextDatabase({
    connectionString: process.env.TEST_DATABASE_URL,
    manageSchema: false,
    manageRoles: false
  });
  await bootstrap.pool.query("drop schema if exists jina_context cascade");
  await bootstrap.close();
  database = new ContextDatabase({
    connectionString: process.env.TEST_DATABASE_URL,
    manageSchema: true,
    manageRoles: true
  });
  store = new PostgresContextEngineStore(database);
} else {
  store = new MemoryContextEngineStore();
}
await store.replaceRepositoryAccess(fixture.tenantId, fixture.principalId, [fixture.repository]);
const files = fixture.files.map((file) => ({
  ...file,
  ...(file.aclFingerprint ? { aclFingerprint: fingerprint(file.aclFingerprint) } : {}),
  body:
    file.repeatParagraphs > 0
      ? `${"# Operational checkpoint\n\nVerify leases, generation identity, and source citations.\n\n".repeat(file.repeatParagraphs)}${file.body}`
      : file.body
}));
const checkpoint = await new IngestEvidenceService(store).ingest({
  tenantId: fixture.tenantId,
  repository: fixture.repository,
  ref: fixture.ref,
  refSequence: 1,
  commitSha: fixture.commitSha,
  files,
  observations: fixture.observations,
  aclFingerprint: repositoryAclFingerprint(fixture.tenantId, fixture.repository),
  observationFrontier: fixture.createdAt,
  createdAt: fixture.createdAt,
  sourceComplete: true
});
const evidenceRecords = await store.listEvidence(checkpoint.id);
const evidenceRecord = (sourceId, label) => {
  const record = evidenceRecords.find((candidate) => candidate.anchor.sourceId === sourceId);
  if (!record) throw new Error(`Evaluation ${label} evidence was not ingested`);
  return record;
};
const readmeRecord = evidenceRecord("2222222222222222222222222222222222222222", "README");
const authRecord = evidenceRecord("3333333333333333333333333333333333333333", "auth");
const codeownersRecord = evidenceRecord("4444444444444444444444444444444444444444", "CODEOWNERS");
const runbookRecord = evidenceRecord("5555555555555555555555555555555555555555", "runbook");
const pullRequestRecord = evidenceRecord("github:pull_request:42", "pull request");
const issueRecord = evidenceRecord("github:issue:77", "issue");
const staleIssueRecord = evidenceRecord("github:issue:77:stale", "stale issue");
const knowledge = createKnowledgeRevision({
  logicalId: `component:${fixture.repository}:context-service`,
  tenantId: fixture.tenantId,
  repository: fixture.repository,
  kind: "component",
  title: "Context service knowledge",
  bodyMarkdown:
    "The service ingests immutable evidence. If publication stalls, inspect the required projector barrier and replay the idempotent projector delivery.",
  summary: "The service ingests immutable evidence and provides a cited publication-stall diagnostic.",
  structuredSummary: {
    facts: [
      {
        text: "The service ingests immutable evidence.",
        citationOrdinals: [1],
        confidence: 1
      }
    ],
    questionsAnswered: [
      {
        text: "How should a stalled context publication be diagnosed?",
        citationOrdinals: [2],
        confidence: 0.9
      }
    ],
    diagnostics: {
      symptoms: [
        {
          text: "A context publication can stall.",
          citationOrdinals: [2],
          confidence: 0.9
        }
      ],
      causes: [
        {
          text: "A required projector barrier may remain incomplete.",
          citationOrdinals: [2],
          confidence: 0.85
        }
      ],
      checks: [
        {
          text: "Inspect the required projector barrier and outbox age.",
          citationOrdinals: [2],
          confidence: 0.95
        }
      ],
      fixes: [
        {
          text: "Replay the idempotent projector delivery.",
          citationOrdinals: [2],
          confidence: 0.95
        }
      ]
    },
    claimCitationOrdinals: []
  },
  scope: {
    ref: fixture.ref,
    commitSha: fixture.commitSha,
    paths: ["README.md", "docs/runbook.md"],
    symbols: [],
    pullRequests: [],
    issues: []
  },
  evidenceFingerprint: fingerprint([readmeRecord.anchor, runbookRecord.anchor]),
  generatorName: "evaluation",
  generatorVersion: "v1",
  model: "deterministic-evaluation",
  promptVersion: "v1",
  confidence: 1,
  createdAt: fixture.createdAt
});
const derivedRevision = (input) =>
  createKnowledgeRevision({
    logicalId: input.logicalId,
    tenantId: fixture.tenantId,
    repository: fixture.repository,
    kind: input.kind,
    title: input.title,
    bodyMarkdown: input.bodyMarkdown,
    summary: input.summary,
    structuredSummary: {
      facts: [{ text: input.summary, citationOrdinals: [1], confidence: 1 }],
      questionsAnswered: [],
      diagnostics: { symptoms: [], causes: [], checks: [], fixes: [] },
      ...(input.claimSubject ? { claimSubject: input.claimSubject } : {}),
      ...(input.claimValue ? { claimValue: input.claimValue } : {}),
      claimCitationOrdinals: [1]
    },
    scope: {
      ref: fixture.ref,
      commitSha: fixture.commitSha,
      paths: input.paths ?? [],
      symbols: input.symbols ?? [],
      pullRequests: input.pullRequests ?? [],
      issues: input.issues ?? []
    },
    evidenceFingerprint: fingerprint(input.anchor),
    generatorName: "evaluation",
    generatorVersion: "v2",
    model: "deterministic-evaluation",
    promptVersion: "derived-only-v1",
    confidence: 1,
    createdAt: fixture.createdAt
  });
const authKnowledge = derivedRevision({
  logicalId: `component:${fixture.repository}:authorization`,
  kind: "component",
  title: "Repository authorization flow",
  bodyMarkdown:
    "# Repository authorization flow\n\n`authorizeRepository` is defined in `src/auth.ts`. `createContext` calls `authorizeRepository` before it returns `ready` or `denied`.",
  summary: "Repository authorization runs before context retrieval.",
  paths: ["src/auth.ts"],
  symbols: ["authorizeRepository", "createContext"],
  anchor: authRecord.anchor
});
const ownershipKnowledge = derivedRevision({
  logicalId: `topic:${fixture.repository}:ownership`,
  kind: "topic",
  title: "Authorization ownership",
  bodyMarkdown: "# Authorization ownership\n\nAccording to CODEOWNERS, src/auth.ts is owned by `@acme/security`.",
  summary: "CODEOWNERS assigns src/auth.ts to @acme/security.",
  paths: ["CODEOWNERS", "src/auth.ts"],
  anchor: codeownersRecord.anchor
});
const changeKnowledge = derivedRevision({
  logicalId: `change:${fixture.repository}:${fixture.commitSha}`,
  kind: "change_summary",
  title: "PR #42 atomic context publication",
  bodyMarkdown:
    "# PR #42: atomic context publication\n\nRepository activity after 10:30 included PR #42, which changed publication to require every required projector before a generation becomes visible.",
  summary: "Repository activity includes PR #42 making publication atomic across required projectors.",
  pullRequests: ["42"],
  anchor: pullRequestRecord.anchor
});
const issueKnowledge = derivedRevision({
  logicalId: `topic:${fixture.repository}:issue-77-current`,
  kind: "topic",
  title: "Issue #77 current state",
  bodyMarkdown: "# Issue #77 current state\n\nThe current provider record reports issue #77 as closed.",
  summary: "Issue #77 is currently closed.",
  issues: ["77"],
  claimSubject: "issue:77:state",
  claimValue: "closed",
  anchor: issueRecord.anchor
});
const staleIssueKnowledge = derivedRevision({
  logicalId: `topic:${fixture.repository}:issue-77-stale`,
  kind: "topic",
  title: "Issue #77 stale replica",
  bodyMarkdown: "# Issue #77 stale replica\n\nA stale provider replica reports issue #77 as open.",
  summary: "A stale replica reports issue #77 as open.",
  issues: ["77"],
  claimSubject: "issue:77:state",
  claimValue: "open",
  anchor: staleIssueRecord.anchor
});
const runbookKnowledge = derivedRevision({
  logicalId: `runbook:${fixture.repository}:publication-stall`,
  kind: "runbook",
  title: "Publication stall runbook",
  bodyMarkdown:
    "# Publication stall runbook\n\nInspect the required projector barrier and outbox age when context publication stalls.\n\n" +
    "Operational checkpoint: verify leases, generation identity, and source citations.\n\n".repeat(240),
  summary: "Investigate stalled publication through projector, outbox, lease, and generation checkpoints.",
  paths: ["docs/runbook.md"],
  anchor: runbookRecord.anchor
});
const revisions = [
  knowledge,
  authKnowledge,
  ownershipKnowledge,
  changeKnowledge,
  issueKnowledge,
  staleIssueKnowledge,
  runbookKnowledge
];
const citations = [
  createKnowledgeCitation(knowledge.id, 0, "The service ingests immutable evidence", readmeRecord.anchor),
  createKnowledgeCitation(
    knowledge.id,
    1,
    "If context publication stalls, inspect the required projector barrier and outbox age.",
    runbookRecord.anchor
  ),
  createKnowledgeCitation(authKnowledge.id, 0, "export function authorizeRepository", authRecord.anchor),
  createKnowledgeCitation(ownershipKnowledge.id, 0, "src/auth.ts @acme/security", codeownersRecord.anchor),
  createKnowledgeCitation(
    changeKnowledge.id,
    0,
    "Changed publication to require every required projector before the generation becomes visible.",
    pullRequestRecord.anchor
  ),
  createKnowledgeCitation(issueKnowledge.id, 0, "closed", issueRecord.anchor),
  createKnowledgeCitation(staleIssueKnowledge.id, 0, "open", staleIssueRecord.anchor),
  createKnowledgeCitation(
    runbookKnowledge.id,
    0,
    "If context publication stalls, inspect the required projector barrier and outbox age.",
    runbookRecord.anchor
  )
];
await store.commitKnowledge({
  run: {
    id: "evaluation-derivation",
    tenantId: fixture.tenantId,
    repository: fixture.repository,
    checkpointId: checkpoint.id,
    cacheKey: fingerprint({ checkpointId: checkpoint.id, evaluation: true }),
    focusFingerprint: fingerprint(["README.md"]),
    generatorName: "evaluation",
    generatorVersion: "v1",
    model: "deterministic-evaluation",
    promptVersion: "v1",
    schemaVersion: "knowledge-v1",
    rawOutputs: [],
    status: "succeeded",
    diagnostics: [],
    revisionIds: revisions.map((revision) => revision.id),
    createdAt: fixture.createdAt
  },
  revisions,
  citations
});
const persistedKnowledgeCitations = (
  await Promise.all(revisions.map((revision) => store.listCitations(revision.id)))
).flat();
const groundedKnowledgeCitation = (
  await Promise.all(
    persistedKnowledgeCitations.map(async (citation) => {
      const evidence = await store.resolveAnchor(checkpoint.id, citation.anchor);
      const excerpt = evidence ? evidenceExcerpt(evidence, citation.anchor) : undefined;
      return excerpt !== undefined && excerpt.includes(citation.claim);
    })
  )
).every(Boolean);
const benchmarkGeneration = await new IndexContextService(store).index(checkpoint.id, fixture.createdAt);

const projectionStore = new Proxy(store, {
  get(target, property) {
    if (property === "latestAuthorizedGeneration" || property === "retrieveIndexed") return undefined;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  }
});
// This benchmark owns an exact immutable generation created above. Production
// discovery intentionally exposes only Board releases after PageIndex
// attachment, so pin the benchmark generation instead of manufacturing a
// public Board pointer or weakening the public lookup fence.
const indexedRuntimeStore = new Proxy(store, {
  get(target, property) {
    if (property === "latestAuthorizedGeneration") {
      return async (tenantId, repository, ref, principalId) => {
        const projection = await target.getAuthorizedGeneration(benchmarkGeneration.id, principalId);
        const generation = projection?.generation;
        return generation?.tenantId === tenantId && generation.repository === repository && generation.ref === ref
          ? generation
          : undefined;
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  }
});
const fullRetrievers = () => [
  new ExactRetriever(),
  new StructuredRetriever(),
  new StructuralRetriever(),
  new LexicalRetriever(),
  new KnowledgeRetriever(),
  new TemporalRetriever(),
  new LongContextRetriever(),
  new HierarchyIndexRetriever()
];
const indexedRouteExpectations = {
  "exact-symbol": { route: "exact", explanation: "materialized exact-index term match" },
  // Raw AST/call-graph projection is intentionally disabled: public Context
  // contains derived documents, and identifiers within those documents are
  // served by the exact index.
  "structure-call": { route: "exact", explanation: "materialized exact-index term match" },
  "architecture-overview": { route: "hierarchy", explanation: "indexed hierarchy-node match" },
  "derived-knowledge": { route: "knowledge", explanation: "indexed knowledge retrieval" },
  "long-document": { route: "long_context", explanation: "indexed full-document long-context match" },
  "temporal-window": { route: "temporal", explanation: "indexed time-window retrieval" }
};
const variants = {
  lexical_only: { retrievers: [new LexicalRetriever()] },
  lexical_structural: { retrievers: [new LexicalRetriever(), new StructuralRetriever()] },
  lexical_dense: { retrievers: [new LexicalRetriever()] },
  lexical_hierarchy: { retrievers: [new LexicalRetriever(), new HierarchyIndexRetriever()] },
  lexical_knowledge: { retrievers: [new LexicalRetriever(), new KnowledgeRetriever()] },
  full_routed_hybrid: { retrievers: fullRetrievers() },
  full_without_reranking: { retrievers: fullRetrievers() },
  routed_long_context: {
    retrievers: [new LexicalRetriever(), new HierarchyIndexRetriever(), new LongContextRetriever()]
  },
  indexed_runtime_hybrid: { retrievers: fullRetrievers(), indexed: true }
};

const reports = [];
for (const [name, variant] of Object.entries(variants)) {
  let expected = 0;
  let found = 0;
  let validCitations = 0;
  let citations = 0;
  let exactExpected = 0;
  let exactFound = 0;
  let forbiddenCitationCount = 0;
  let conflictFailures = 0;
  let requiredSourceKindFailures = 0;
  let indexedPrimitiveFailures = 0;
  const cases = [];
  for (const testCase of fixture.cases) {
    const service = new QueryContextService(
      variant.indexed ? indexedRuntimeStore : projectionStore,
      undefined,
      undefined,
      variant.retrievers
    );
    const execution = await service.queryWithTrace({
      tenantId: fixture.tenantId,
      principalId: fixture.principalId,
      repository: fixture.repository,
      ref: fixture.ref,
      question: testCase.question,
      taskKind: testCase.taskKind,
      ...(testCase.targets ? { targets: testCase.targets } : {}),
      ...(testCase.timeWindow ? { timeWindow: testCase.timeWindow } : {})
    });
    const response = execution.response;
    const indexedExpectation = indexedRouteExpectations[testCase.id];
    if (
      variant.indexed &&
      database &&
      indexedExpectation &&
      !execution.telemetry.candidates.some(
        (candidate) =>
          candidate.retriever === indexedExpectation.route &&
          candidate.diagnostics.explanation === indexedExpectation.explanation
      )
    ) {
      indexedPrimitiveFailures += 1;
    }
    const sourceIds = new Set(
      response.citations.flatMap((citation) => citation.anchors.map((anchor) => anchor.sourceId))
    );
    const matched = testCase.expectedSourceIds.filter((sourceId) => sourceIds.has(sourceId)).length;
    expected += testCase.expectedSourceIds.length;
    found += matched;
    const forbidden = (testCase.forbiddenSourceIds ?? []).filter((sourceId) => sourceIds.has(sourceId));
    forbiddenCitationCount += forbidden.length;
    if (testCase.expectedConflictCount !== undefined && response.conflicts.length !== testCase.expectedConflictCount) {
      conflictFailures += 1;
    }
    if (
      testCase.requiredSourceKind &&
      !response.citations.some((citation) => citation.sourceKind === testCase.requiredSourceKind)
    ) {
      requiredSourceKindFailures += 1;
    }
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
      forbidden: forbidden.length,
      conflicts: response.conflicts.length,
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
    aclLeakageCount: forbiddenCitationCount,
    conflictFailureCount: conflictFailures,
    requiredSourceKindFailureCount: requiredSourceKindFailures,
    indexedPrimitiveFailureCount: indexedPrimitiveFailures,
    cases
  });
}

const full = reports.find((report) => report.variant === "full_routed_hybrid");
const indexed = reports.find((report) => report.variant === "indexed_runtime_hybrid");
await store.replaceRepositoryAccess(fixture.tenantId, fixture.principalId, []);
const revocationEnforced = await new QueryContextService(store)
  .query({
    tenantId: fixture.tenantId,
    principalId: fixture.principalId,
    repository: fixture.repository,
    question: "What is indexed?"
  })
  .then(
    () => false,
    () => true
  );
const output = {
  schemaVersion: "context-evaluation-report-v1",
  fixtureVersion: fixture.schemaVersion,
  adapter: database ? "postgres" : "memory",
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
    evidenceRecallAt20: full.evidenceRecall,
    aclLeakageCount: full.aclLeakageCount,
    conflictFailureCount: full.conflictFailureCount,
    requiredSourceKindFailureCount: full.requiredSourceKindFailureCount,
    groundedKnowledgeCitation,
    revocationEnforced,
    indexedRuntime: {
      exactCompleteness: indexed.exactCompleteness,
      citationIntegrity: indexed.citationIntegrity,
      evidenceRecallAt20: indexed.evidenceRecall,
      aclLeakageCount: indexed.aclLeakageCount,
      conflictFailureCount: indexed.conflictFailureCount,
      requiredSourceKindFailureCount: indexed.requiredSourceKindFailureCount,
      indexedPrimitiveFailureCount: indexed.indexedPrimitiveFailureCount
    }
  }
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
await store.close();
if (
  full.exactCompleteness !== 1 ||
  full.citationIntegrity !== 1 ||
  full.evidenceRecall < 0.9 ||
  full.aclLeakageCount !== 0 ||
  full.conflictFailureCount !== 0 ||
  full.requiredSourceKindFailureCount !== 0 ||
  indexed.exactCompleteness !== 1 ||
  indexed.citationIntegrity !== 1 ||
  indexed.evidenceRecall < 0.9 ||
  indexed.aclLeakageCount !== 0 ||
  indexed.conflictFailureCount !== 0 ||
  indexed.requiredSourceKindFailureCount !== 0 ||
  indexed.indexedPrimitiveFailureCount !== 0 ||
  !groundedKnowledgeCitation ||
  !revocationEnforced
) {
  process.exitCode = 1;
}
