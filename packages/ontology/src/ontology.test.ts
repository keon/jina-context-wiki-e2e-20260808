import assert from "node:assert/strict";
import { test } from "node:test";
import { createOntologyGraph, parseGeneratedOntology, validateOntologyEvidence } from "./model.js";
import { MemoryOntologyGraphStore } from "./store.js";
import {
  ONTOLOGY_GENERATOR_VERSION,
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_REGISTRY_VERSION,
  assertionsFromGeneratedOntology,
  computeCommitChanges
} from "./pipeline.js";
import { analyzeSourceBlob } from "./parser.js";
import { predicateDefinition, validatePredicateEndpoints, validateQualifiers } from "./registry.js";
import {
  acceptanceRates,
  addRedirect,
  applyAssertion,
  emptyKnowledgeState,
  ensureEntity,
  reconcileAssertions,
  resolveEntityId,
  reviewAssertion,
  upsertIdentity
} from "./knowledge.js";
import { RepositoryContextOrchestrator, classifyTemplates } from "./retrieval.js";
import { linkedIssueNumbers, normalizeGitHubSourceObservation } from "./normalizers.js";

test("pure structural parsing produces versioned symbols and imports", () => {
  const analysis = analyzeSourceBlob("a".repeat(40), "typescript", 'import { helper } from "./helper";\nexport function main() {}\n');
  assert.equal(analysis.parserVersion, ONTOLOGY_PARSER_VERSION);
  assert.deepEqual(analysis.imports, [{ specifier: "./helper", line: 1 }]);
  assert.equal(analysis.symbols[0]?.name, "main");
  assert.equal(analysis.symbols[0]?.signatureHash.length, 64);
  assert.equal(analysis.edges.some((edge) => edge.kind === "imports" && edge.toMoniker === "module:./helper"), true);
});

test("computes first-parent additions, modifications, deletions, and exact renames", () => {
  const changes = computeCommitChanges([
    { path: "renamed.ts", blobSha: "a", size: 1 },
    { path: "changed.ts", blobSha: "c", size: 1 },
    { path: "added.ts", blobSha: "d", size: 1 }
  ], [
    { path: "old.ts", blobSha: "a", size: 1 },
    { path: "changed.ts", blobSha: "b", size: 1 },
    { path: "deleted.ts", blobSha: "e", size: 1 }
  ]);
  assert.deepEqual(changes, [
    { path: "added.ts", change: "add", newBlobSha: "d" },
    { path: "changed.ts", change: "modify", oldBlobSha: "b", newBlobSha: "c" },
    { path: "deleted.ts", change: "delete", oldBlobSha: "e" },
    { path: "renamed.ts", change: "rename", oldPath: "old.ts", oldBlobSha: "a", newBlobSha: "a" }
  ]);
});

test("registry validates endpoints and qualifier keys and keeps model inferences reviewable", () => {
  const ownership = predicateDefinition("owned-by");
  validatePredicateEndpoints(ownership, "File", "Team");
  validateQualifiers(ownership, { pattern: "src/**" });
  assert.equal(ownership.review, "manual");
  const causality = predicateDefinition("INTRODUCED_BY");
  validateQualifiers(causality, { reason: "the null branch bypassed authorization" });
  assert.throws(() => validateQualifiers(causality), /requires a nonempty causal reason/);
  assert.throws(() => validateQualifiers(ownership, { branch: "main" }), /does not declare qualifier branch/);
  assert.throws(() => validatePredicateEndpoints(predicateDefinition("INCLUDES"), "Issue", "Commit"), /subject kind Issue/);
});

test("knowledge writer enforces provenance, review, qualifier cardinality, audit, and measured labels", () => {
  let state = emptyKnowledgeState();
  const file = ensureEntity(state, { tenantId: "t", kind: "File", key: "repo:r:path:src/a.ts", now: "2026-01-01T00:00:00Z" });
  state = file.state;
  const teamA = ensureEntity(state, { tenantId: "t", kind: "Team", key: "team:a", now: "2026-01-01T00:00:00Z" });
  state = teamA.state;
  const teamB = ensureEntity(state, { tenantId: "t", kind: "Team", key: "team:b", now: "2026-01-01T00:00:00Z" });
  state = teamB.state;

  const proposed = applyAssertion(state, {
    tenantId: "t", repoId: "r", subjectId: file.entity.id, predicate: "OWNED_BY", objectId: teamA.entity.id,
    qualifiers: { pattern: "src/**" }, confidence: 0.9, sourceObservationId: "obs:codeowners",
    generator: "model:owner@1", recordedAt: "2026-01-02T00:00:00Z"
  });
  state = proposed.state;
  assert.equal(proposed.assertion.status, "proposed");
  const accepted = reviewAssertion(state, {
    tenantId: "t", assertionId: proposed.assertion.id, decision: "accept", actorId: "user:1", now: "2026-01-03T00:00:00Z"
  });
  state = accepted.state;
  assert.equal(accepted.assertion.status, "active");

  const replacement = applyAssertion(state, {
    tenantId: "t", repoId: "r", subjectId: file.entity.id, predicate: "OWNED_BY", objectId: teamB.entity.id,
    qualifiers: { pattern: "src/**" }, sourceObservationId: "obs:codeowners:2", recordedAt: "2026-01-04T00:00:00Z"
  });
  state = replacement.state;
  const replacementAccepted = reviewAssertion(state, {
    tenantId: "t", assertionId: replacement.assertion.id, decision: "accept", actorId: "user:1", now: "2026-01-05T00:00:00Z"
  });
  state = replacementAccepted.state;
  assert.equal(state.assertions.find((item) => item.id === proposed.assertion.id)?.status, "superseded");
  assert.equal(state.assertions.find((item) => item.id === proposed.assertion.id)?.supersededBy, replacement.assertion.id);
  assert.deepEqual(acceptanceRates(state, "t"), [{ generator: "model:owner@1", predicate: "OWNED_BY", accepted: 1, rejected: 0, rate: 1 }]);
  assert.throws(() => applyAssertion(state, {
    tenantId: "t", subjectId: file.entity.id, predicate: "OWNED_BY", objectId: teamA.entity.id,
    recordedAt: "2026-01-06T00:00:00Z"
  }), /sourceObservationId XOR assertedBy/);
});

test("identity redirects resolve without rewriting assertions and reconciliation removes logical collisions", () => {
  let state = emptyKnowledgeState();
  const fileA = ensureEntity(state, { tenantId: "t", kind: "File", key: "file:a", now: "2026-01-01T00:00:00Z" });
  state = fileA.state;
  const fileB = ensureEntity(state, { tenantId: "t", kind: "File", key: "file:b", now: "2026-01-01T00:00:00Z" });
  state = fileB.state;
  const team = ensureEntity(state, { tenantId: "t", kind: "Team", key: "team:a", now: "2026-01-01T00:00:00Z" });
  state = team.state;
  state = upsertIdentity(state, {
    tenantId: "t", source: "github", externalId: "team-a", entityId: team.entity.id, status: "accepted", now: "2026-01-01T00:00:00Z"
  }).state;
  const first = applyAssertion(state, {
    tenantId: "t", subjectId: fileA.entity.id, predicate: "OWNED_BY", objectId: team.entity.id,
    assertedBy: "user:1", recordedAt: "2026-01-02T00:00:00Z"
  });
  state = reviewAssertion(first.state, {
    tenantId: "t", assertionId: first.assertion.id, decision: "accept", actorId: "user:1", now: "2026-01-02T01:00:00Z"
  }).state;
  const second = applyAssertion(state, {
    tenantId: "t", subjectId: fileB.entity.id, predicate: "OWNED_BY", objectId: team.entity.id,
    assertedBy: "user:1", recordedAt: "2026-01-03T00:00:00Z"
  });
  state = reviewAssertion(second.state, {
    tenantId: "t", assertionId: second.assertion.id, decision: "accept", actorId: "user:1", now: "2026-01-03T01:00:00Z"
  }).state;
  const merged = addRedirect(state, {
    tenantId: "t", fromEntityId: fileA.entity.id, toEntityId: fileB.entity.id, kind: "merge", actorId: "user:1", now: "2026-01-04T00:00:00Z"
  });
  state = merged.state;
  assert.equal(resolveEntityId(state, "t", fileA.entity.id), fileB.entity.id);
  const reconciled = reconcileAssertions(state, { tenantId: "t", now: "2026-01-04T00:01:00Z", parentAuditId: merged.audit.id });
  assert.equal(reconciled.supersededCount, 1);
  assert.equal(reconciled.state.assertions.filter((item) => item.status === "active").length, 1);
  assert.equal(reconciled.state.assertions.find((item) => item.id === first.assertion.id)?.subjectId, fileA.entity.id, "as-asserted ids are immutable");
  const unmerged = addRedirect(reconciled.state, {
    tenantId: "t", fromEntityId: fileA.entity.id, toEntityId: fileB.entity.id, kind: "unmerge", actorId: "user:1", now: "2026-01-05T00:00:00Z"
  });
  assert.equal(resolveEntityId(unmerged.state, "t", fileA.entity.id), fileA.entity.id);
  assert.equal(unmerged.state.assertions.find((item) => item.id === first.assertion.id)?.status, "superseded", "unmerge does not silently restore knowledge");
});

test("orchestrator composes only fixed cited retrieval templates", async () => {
  assert.deepEqual(classifyTemplates("What changed in this PR, what might break, and who owns it?"), ["change", "ownership"]);
  assert.deepEqual(classifyTemplates("Which PR and commit resolved issue #7?"), ["issue_trace"]);
  assert.deepEqual(classifyTemplates(`Which issue did commit ${"a".repeat(40)} cause, and why?`), ["issue_trace"]);
  assert.deepEqual(classifyTemplates("Which issue did PR #42 introduce?"), ["issue_trace"]);
  const called: string[] = [];
  const orchestrator = new RepositoryContextOrchestrator({
    async retrieve(request) {
      called.push(request.template);
      return {
        template: request.template, repository: request.repository, ref: request.ref ?? "main", truncated: false,
        totalBeforeLimit: 1, limit: request.limit ?? 50,
        items: [{
          kind: "fixture", title: request.template, data: {}, score: 1,
          citations: [{ kind: "code", id: `${request.template}:1`, repository: request.repository, path: "src/a.ts", startLine: 1, endLine: 1 }]
        }]
      };
    }
  });
  const context = await orchestrator.answer({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo", question: "what changed and who owns it?"
  });
  assert.deepEqual(called, ["change", "ownership"]);
  assert.equal(context.citations.length, 2);

  called.length = 0;
  await orchestrator.answer({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo",
    question: "Which PR and commit resolved issue #7?"
  });
  assert.deepEqual(called, ["issue_trace"]);
});

test("GitHub normalizers derive explicit work links and pattern-scoped CODEOWNERS facts", () => {
  assert.deepEqual(linkedIssueNumbers("Fixes #12 and also discusses #13"), { resolves: [12], references: [13] });
  const ownership = normalizeGitHubSourceObservation({
    tenantId: "t", repository: "org/repo", kind: "codeowners", commitSha: "a".repeat(40), path: ".github/CODEOWNERS",
    entries: [{ pattern: "src/**", owners: ["@org/platform"] }], recordedAt: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(ownership.assertions, [{
    subject: { kind: "Repository", key: "github:repo:org/repo", displayName: "org/repo" },
    predicate: "OWNED_BY",
    object: { kind: "Team", key: "github:team:org/platform", displayName: "@org/platform" },
    qualifiers: { pattern: "src/**" }
  }]);
  const mergeSha = "b".repeat(40);
  const workItem = normalizeGitHubSourceObservation({
    tenantId: "t", repository: "org/repo", kind: "pull_request", number: 4,
    title: "Fix access", body: "Fixes #12", state: "closed", url: "https://github.com/org/repo/pull/4",
    recordedAt: "2026-01-02T00:00:00Z", mergedAt: "2026-01-02T00:00:00Z", mergeCommitSha: mergeSha,
    commitShas: [mergeSha], resolvesIssueNumbers: [12]
  });
  assert.deepEqual(workItem.assertions.map((assertion) => assertion.predicate), [
    "INCLUDES", "MERGED_AS", "RESOLVES", "RESOLVED_BY"
  ]);
  assert.equal(predicateDefinition("INTRODUCED_BY").review, "manual");
});

test("normalizes model output into distinct semantic entity identities", () => {
  const assertions = assertionsFromGeneratedOntology({
    summary: "symbols implement separate documents",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "symbol:src/app.ts:first", kind: "Symbol", label: "first", description: "first symbol", path: "src/app.ts", evidence: ["src/app.ts:1"] },
      { id: "symbol:src/app.ts:second", kind: "Symbol", label: "second", description: "second symbol", path: "src/app.ts", evidence: ["src/app.ts:2"] },
      { id: "doc:first", kind: "Document", label: "first docs", description: "docs", path: "README.md", evidence: ["README.md:2"] }
    ],
    edges: [
      { source: "symbol:src/app.ts:first", target: "doc:first", predicate: "IMPLEMENTS", plane: "knowledge", confidence: 0.91, evidence: ["src/app.ts:1"] },
      { source: "symbol:src/app.ts:second", target: "doc:first", predicate: "IMPLEMENTS", plane: "knowledge", confidence: 0.92, evidence: ["src/app.ts:2"] }
    ]
  }, "omxyz/demo");
  assert.deepEqual(assertions.map((assertion) => assertion.subject.naturalKey), [
    "repo:omxyz/demo:moniker:symbol:src/app.ts:first",
    "repo:omxyz/demo:moniker:symbol:src/app.ts:second"
  ]);
});

test("canonicalizes cited causal model assertions and rejects ambiguous entity ids", () => {
  const sha = "a".repeat(40);
  const generated = {
    summary: "explicit root cause",
    nodes: [
      { id: "repo", kind: "Repository" as const, label: "demo", description: "repo", evidence: ["ROOT_CAUSE.md:1"] },
      { id: "issue:7", kind: "Issue" as const, label: "Issue #7", description: "authorization regression", evidence: ["ROOT_CAUSE.md:2"] },
      { id: `commit:${sha}`, kind: "Commit" as const, label: sha.slice(0, 12), description: "bypassed the guard", evidence: ["ROOT_CAUSE.md:2"] }
    ],
    edges: [{
      source: "issue:7", target: `commit:${sha}`, predicate: "INTRODUCED_BY", plane: "knowledge" as const,
      confidence: 0.99, why: "The commit bypassed the authorization guard.", evidence: ["ROOT_CAUSE.md:2"]
    }]
  };
  const [assertion] = assertionsFromGeneratedOntology(generated, "omxyz/demo");
  assert.equal(assertion?.subject.naturalKey, "github:issue:omxyz/demo#7");
  assert.equal(assertion?.object.naturalKey, `repo:omxyz/demo:sha:${sha}`);
  assert.deepEqual(assertion?.qualifiers, { reason: "The commit bypassed the authorization guard." });
  assert.throws(() => assertionsFromGeneratedOntology({
    ...generated,
    nodes: generated.nodes.map((node) => node.kind === "Commit" ? { ...node, id: "commit:short" } : node),
    edges: [{ ...generated.edges[0]!, target: "commit:short" }]
  }, "omxyz/demo"), /full Git SHA/);
  assert.throws(() => assertionsFromGeneratedOntology({
    ...generated,
    edges: [{
      source: "issue:7", target: `commit:${sha}`, predicate: "INTRODUCED_BY", plane: "knowledge" as const,
      confidence: 0.99, evidence: ["ROOT_CAUSE.md:2"]
    }]
  }, "omxyz/demo"), /must explain why/);
});

test("creates a stable graph and removes dangling edges", () => {
  const generated = parseGeneratedOntology({
    summary: "A small service",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "file:src/app.ts", kind: "File", label: "app.ts", description: "entry", path: "src/app.ts", evidence: ["src/app.ts:1"] }
    ],
    edges: [
      { source: "repo", target: "file:src/app.ts", predicate: "contains", plane: "code", evidence: ["src/app.ts:1"] },
      { source: "missing", target: "repo", predicate: "references", plane: "knowledge", evidence: ["README.md:1"] }
    ]
  });
  const graph = createOntologyGraph({
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

test("keeps graph generations immutable per task", () => {
  const generated = parseGeneratedOntology({
    summary: "repo",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "readme", kind: "File", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  const build = (taskId: string) => createOntologyGraph({
    request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId },
    commitSha: "abc",
    generatedAt: "2026-01-01T00:00:00.000Z",
    executor: "fixture" as const,
    model: "fixture",
    generated
  });
  assert.notEqual(build("task-1").id, build("task-2").id);
});

test("does not overwrite an existing graph generation", async () => {
  const generated = parseGeneratedOntology({
    summary: "first",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "readme", kind: "File", label: "README", description: "docs", evidence: ["README.md:1"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  const graph = createOntologyGraph({
    request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId: "task" },
    commitSha: "abc",
    generatedAt: "2026-01-01T00:00:00.000Z",
    executor: "fixture",
    model: "fixture",
    generated
  });
  const store = new MemoryOntologyGraphStore();
  await store.save(graph);
  await store.save({ ...graph, summary: "replacement" });
  assert.equal((await store.get(graph.id, "tenant"))?.summary, "first");
});

test("validates citations against repository files", async () => {
  const generated = parseGeneratedOntology({
    summary: "repo",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:2"] },
      { id: "readme", kind: "File", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1-2"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  await validateOntologyEvidence(generated, async () => "line one\nline two");
  await assert.rejects(
    validateOntologyEvidence(generated, async () => "one line"),
    /outside README\.md/
  );
  assert.throws(
    () => parseGeneratedOntology({
      summary: "bad",
      nodes: [{ id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: [] }],
      edges: []
    }),
    /must include evidence/
  );
});

test("requires causal evidence to name the issue and offending commit", async () => {
  const sha = "3".repeat(40);
  const generated = parseGeneratedOntology({
    summary: "root cause",
    nodes: [
      { id: "4", kind: "Issue", label: "Issue #4", description: "regression", evidence: ["docs/root-cause.md:1"] },
      { id: sha, kind: "Commit", label: sha.slice(0, 12), description: "offending change", evidence: ["docs/root-cause.md:1"] }
    ],
    edges: [{
      source: "4", target: sha, predicate: "INTRODUCED_BY", plane: "knowledge", confidence: 0.99,
      why: "The commit removed the administrator bypass.", evidence: ["docs/root-cause.md:1-2"]
    }]
  });
  await validateOntologyEvidence(generated, async () =>
    `Issue #4 was caused by commit ${sha}.\nThe commit removed the administrator bypass.`
  );
  await assert.rejects(
    validateOntologyEvidence(generated, async () => "Issue #4 was caused by an earlier change.\nThe administrator bypass was removed."),
    /explicitly name Issue #4 and commit/
  );
});

test("reuses parsed blobs and projects canonical code facts plus active assertions", async () => {
  const store = new MemoryOntologyGraphStore();
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
    { blobSha: "c".repeat(40), parserVersion: ONTOLOGY_PARSER_VERSION, language: "markdown", symbols: [], imports: [], edges: [] },
    {
      blobSha: "d".repeat(40),
      parserVersion: ONTOLOGY_PARSER_VERSION,
      language: "typescript",
      symbols: [{ moniker: "main", name: "main", kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 1 }],
      imports: [], edges: []
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
    generatorVersion: ONTOLOGY_GENERATOR_VERSION,
    registryVersion: ONTOLOGY_REGISTRY_VERSION,
    model: "fixture",
    summary: "README documents the repository",
    rawOutput: {
      summary: "README documents the repository",
      nodes: [
        { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
        { id: "readme", kind: "Document", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
      ],
      edges: [{ source: "repo", target: "readme", predicate: "DOCUMENTED_BY", plane: "knowledge", confidence: 0.95, evidence: ["README.md:1"] }]
    },
    assertions: [{
      subject: { kind: "Repository", naturalKey: `github:repo:${snapshot.repository}`, label: "demo" },
      predicate: "DOCUMENTED_BY",
      object: { kind: "Document", naturalKey: `repo:${snapshot.repository}:path:README.md`, label: "README" },
      confidence: 0.95,
      evidence: ["README.md:1"]
    }]
  });
  assert.equal(assertions.activeCount, 0);
  assert.equal(assertions.proposedCount, 1);
  assert.equal((await store.hasAssertionGeneration(snapshot.tenantId, snapshot.repository, snapshot.commitSha, ONTOLOGY_GENERATOR_VERSION))?.cached, true);

  const graph = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    taskId: "project-task",
    generatedAt: "2026-07-19T00:02:00.000Z"
  });
  assert.equal(graph.generator.executor, "projection");
  assert.equal(graph.nodes.some((node) => node.kind === "Symbol" && node.label === "main"), true);
  assert.equal(graph.edges.some((edge) => edge.plane === "knowledge" && edge.predicate === "DOCUMENTED_BY"), false);

  const nextSnapshot = {
    ...snapshot,
    commitSha: "e".repeat(40),
    treeSha: "f".repeat(40),
    parents: [snapshot.commitSha],
    taskId: "next-ingest",
    files: [
      snapshot.files[0]!,
      { path: "src/index.ts", blobSha: "1".repeat(40), size: 21 }
    ]
  };
  const nextPlan = await store.planIngestion(nextSnapshot);
  assert.deepEqual(nextPlan.missingBlobs.map((blob) => blob.path), ["src/index.ts"]);
  assert.deepEqual(nextPlan.changedPaths, ["src/index.ts"]);
  await store.applyBlobAnalyses(nextSnapshot, [{
    blobSha: "1".repeat(40),
    parserVersion: ONTOLOGY_PARSER_VERSION,
    language: "typescript",
    symbols: [{ moniker: "main", name: "main", kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 1 }],
    imports: [], edges: []
  }]);
  const carried = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: nextSnapshot.commitSha,
    taskId: "next-project",
    generatedAt: "2026-07-19T00:03:00.000Z"
  });
  assert.equal(carried.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"), false, "unreviewed model assertions remain out of active projections");

  const changedReadme = {
    ...nextSnapshot,
    commitSha: "2".repeat(40),
    treeSha: "3".repeat(40),
    parents: [nextSnapshot.commitSha],
    taskId: "readme-ingest",
    files: [
      { path: "README.md", blobSha: "4".repeat(40), size: 11 },
      nextSnapshot.files[1]!
    ]
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
  assert.equal(withoutStaleAssertion.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"), false, "changed cited blobs invalidate old assertions");
});
