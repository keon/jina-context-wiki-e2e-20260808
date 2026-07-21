import assert from "node:assert/strict";
import { test } from "node:test";
import { createOntologyGraph, parseGeneratedOntology, validateOntologyEvidence } from "./model.js";
import { MemoryOntologyGraphStore } from "./store.js";
import {
  ONTOLOGY_GENERATOR_VERSION,
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_REGISTRY_VERSION,
  assertionEvidenceFingerprint,
  assertionsFromGeneratedOntology,
  computeCommitChanges,
  derivedIssueNaturalKey,
  featureNaturalKey
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
import {
  RepositoryContextOrchestrator,
  classifyTemplates,
  extractFeatureText,
  extractIssueText,
  extractRepositoryPath,
  extractSymbol,
  type RetrievalRequest
} from "./retrieval.js";
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
  assert.deepEqual(classifyTemplates('Which PR or commit caused "Administrators cannot delete resources"?'), ["issue_trace"]);
  assert.deepEqual(classifyTemplates("What changed in PR #5?"), ["change"]);
  assert.equal(extractIssueText('What caused “Administrators   cannot delete resources”?'), "Administrators cannot delete resources");
  assert.equal(extractIssueText("Which PR or commit caused Administrators cannot delete resources, and why?"), "Administrators cannot delete resources");
  assert.equal(extractRepositoryPath("Why was src/access-policy.ts changed?"), "src/access-policy.ts");
  assert.equal(extractSymbol("Where is authorize implemented and what calls it?"), "authorize");
  const called: string[] = [];
  const issueTexts: Array<string | undefined> = [];
  const issueEntityIds: Array<string | undefined> = [];
  const symbols: Array<string | undefined> = [];
  const paths: Array<string | undefined> = [];
  const orchestrator = new RepositoryContextOrchestrator({
    async retrieve(request) {
      called.push(request.template);
      issueTexts.push(request.issueText);
      issueEntityIds.push(request.issueEntityId);
      symbols.push(request.symbol);
      paths.push(request.path);
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
  assert.match(context.answer, /cited change set/i);
  assert.equal(context.citedClaims.length, 2);

  called.length = 0;
  await orchestrator.answer({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo",
    question: "Which PR and commit resolved issue #7?"
  });
  assert.deepEqual(called, ["issue_trace"]);

  called.length = 0;
  issueEntityIds.length = 0;
  await orchestrator.answer({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo",
    question: "What resolved this issue?", issueEntityId: "entity_virtual"
  });
  assert.deepEqual(called, ["issue_trace"]);
  assert.deepEqual(issueEntityIds, ["entity_virtual"]);

  called.length = 0;
  issueTexts.length = 0;
  await orchestrator.answer({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo",
    question: 'Which PR or commit caused "Administrators cannot delete resources"?'
  });
  assert.deepEqual(called, ["issue_trace"]);
  assert.deepEqual(issueTexts, ["Administrators cannot delete resources"]);

  called.length = 0;
  issueTexts.length = 0;
  await orchestrator.answer({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo",
    question: "Which PR or commit caused Administrators cannot delete resources, and why?"
  });
  assert.deepEqual(called, ["issue_trace"]);
  assert.deepEqual(issueTexts, ["Administrators cannot delete resources"]);

  called.length = 0;
  symbols.length = 0;
  await orchestrator.answer({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo",
    question: "Where is authorize implemented and what calls it?"
  });
  assert.deepEqual(called, ["structure"]);
  assert.deepEqual(symbols, ["authorize"]);

  called.length = 0;
  paths.length = 0;
  await orchestrator.answer({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo",
    question: "Who owns src/access-policy.ts?"
  });
  assert.deepEqual(called, ["ownership"]);
  assert.deepEqual(paths, ["src/access-policy.ts"]);
  assert.equal(extractRepositoryPath("Who owns README.md?"), "README.md");
  assert.equal(extractRepositoryPath("Why does Dockerfile exist?"), "Dockerfile");
});

test("orchestrator produces a direct cited causal answer and withholds unreviewed causality", async () => {
  const citations = [{
    kind: "assertion" as const,
    id: "assertion-cause",
    repository: "org/repo",
    commitSha: "3".repeat(40),
    path: "src/access-policy.ts",
    startLine: 12,
    endLine: 18
  }];
  const answerWith = (introducedBy: readonly unknown[]) => new RepositoryContextOrchestrator({
    async retrieve(request) {
      return {
        template: request.template,
        repository: request.repository,
        ref: "main",
        truncated: false,
        totalBeforeLimit: 1,
        limit: request.limit ?? 50,
        items: [{
          kind: "issue_trace",
          title: "Issue #123",
          data: {
            issue: { number: 123, title: "Administrators cannot delete resources" },
            resolutions: [{ pullRequestNumber: 5, commits: [{ sha: "5".repeat(40) }], assertionIds: ["assertion-fix"], observationIds: ["observation-fix"] }],
            introducedBy
          },
          citations,
          score: 3
        }]
      };
    }
  }).answer({
    tenantId: "t",
    allowedRepositories: ["org/repo"],
    repository: "org/repo",
    question: "Which PR or commit caused Administrators cannot delete resources, and why?"
  });

  const reviewed = await answerWith([{
    sha: "3".repeat(40),
    why: "the administrator bypass was removed",
    assertionIds: ["assertion-cause"],
    pullRequests: [{ number: 3 }]
  }]);
  assert.match(reviewed.answer, /PR #3.*commit 333333333333.*because the administrator bypass was removed/);
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
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo",
    question: "Which commit caused cannot delete resources, and why?"
  });
  assert.match(ambiguous.answer, /Multiple issues matched/);
  assert.equal(ambiguous.citedClaims.length, 0);
  assert.equal(ambiguous.unresolvedAmbiguities.length, 1);

  const selected = await orchestrator.answer({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo",
    question: "Did PR #3 cause issue #123, and why?"
  });
  assert.match(selected.answer, /PR #3.*333333333333.*requested cause/);
  assert.deepEqual(selected.citedClaims[0]?.citations.map((citation) => citation.id), ["cause-3"]);
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

test("source ingestion distinguishes new, updated, and confirmed GitHub observations", async () => {
  const store = new MemoryOntologyGraphStore();
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
  const updated = await store.applyGitHubObservations([{
    ...issue,
    title: "Updated title",
    occurredAt: "2026-07-20T00:02:00.000Z",
    recordedAt: "2026-07-20T00:02:01.000Z"
  }]);
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

test("reviews and retrieves a virtual issue through the generalized Issue assertion", async () => {
  const store = new MemoryOntologyGraphStore();
  const repository = "org/repo";
  const observedAt = "2026-07-20T00:00:00.000Z";
  const source = await store.applyGitHubObservations([{
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
  }]);
  const evidence = await store.loadAssertionEvidence("t", repository, source.observationIds);
  assert.equal((evidence[0]?.payload as { title?: string }).title, "Restore administrator deletion");

  const rawOutput = {
    summary: "PR 42 fixes a deletion regression",
    nodes: [
      { id: "repo", kind: "Repository" as const, label: repository, description: "repo", evidence: ["README.md:1"] },
      { id: "42", kind: "PullRequest" as const, label: "PR #42", description: "restores deletion", evidence: ["src/auth.ts:10"] },
      {
        id: "virtual:pr:42",
        kind: "Issue" as const,
        label: "Administrators cannot delete resources",
        description: "Administrator deletion is incorrectly denied.",
        evidence: ["src/auth.ts:10"]
      }
    ],
    edges: [{
      source: "42",
      target: "virtual:pr:42",
      predicate: "RESOLVES",
      plane: "knowledge" as const,
      confidence: 0.94,
      evidence: ["src/auth.ts:10"]
    }]
  };
  await store.saveAssertionBatch({
    tenantId: "t",
    repository,
    ref: "main",
    commitSha: "a".repeat(40),
    taskId: "assert-virtual",
    generatedAt: "2026-07-20T00:01:00.000Z",
    generatorVersion: ONTOLOGY_GENERATOR_VERSION,
    registryVersion: ONTOLOGY_REGISTRY_VERSION,
    evidenceFingerprint: "virtual-evidence",
    evidenceObservationIds: source.observationIds,
    model: "fixture",
    summary: rawOutput.summary,
    rawOutput,
    assertions: assertionsFromGeneratedOntology(rawOutput, repository, { sourcePullRequestNumbers: [42] })
  });
  const proposal = (await store.listAssertions("t", repository, { status: "proposed", predicate: "RESOLVES" }))[0];
  assert.ok(proposal);
  await store.executeCommand("t", "svc:test", {
    type: "review_assertion",
    assertionId: proposal.id,
    decision: "accept"
  }, "2026-07-20T00:02:00.000Z");

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
});

test("resolves derived issue descriptions by PR anchor when titles collide", async () => {
  const store = new MemoryOntologyGraphStore();
  const repository = "org/repo";
  const observedAt = "2026-07-20T00:00:00.000Z";
  const source = await store.applyGitHubObservations([42, 43].map((number) => ({
    tenantId: "t", repository, kind: "pull_request" as const, number,
    title: `Fix regression ${number}`, body: `Regression fixed by PR ${number}.`, state: "closed",
    url: `https://github.com/${repository}/pull/${number}`, occurredAt: observedAt, recordedAt: observedAt,
    commitShas: [], resolvesIssueNumbers: [], referencesIssueNumbers: []
  })));
  const rawOutput = {
    summary: "Two independent authorization regressions",
    nodes: [
      { id: "repo", kind: "Repository" as const, label: repository, description: "repo", evidence: ["README.md:1"] },
      { id: "42", kind: "PullRequest" as const, label: "PR #42", description: "fix", evidence: ["src/auth.ts:10"] },
      { id: "43", kind: "PullRequest" as const, label: "PR #43", description: "fix", evidence: ["src/audit.ts:10"] },
      {
        id: "virtual:pr:42", kind: "Issue" as const, label: "Administrators encounter an authorization error",
        description: "Administrator deletion is incorrectly denied.", evidence: ["src/auth.ts:10"]
      },
      {
        id: "virtual:pr:43", kind: "Issue" as const, label: "Administrators encounter an authorization error",
        description: "Administrator audit export is incorrectly denied.", evidence: ["src/audit.ts:10"]
      }
    ],
    edges: [42, 43].map((number) => ({
      source: String(number), target: `virtual:pr:${number}`, predicate: "RESOLVES", plane: "knowledge" as const,
      confidence: 0.94, evidence: [number === 42 ? "src/auth.ts:10" : "src/audit.ts:10"]
    }))
  };
  await store.saveAssertionBatch({
    tenantId: "t", repository, ref: "main", commitSha: "b".repeat(40), taskId: "assert-colliding-titles",
    generatedAt: "2026-07-20T00:01:00.000Z", generatorVersion: ONTOLOGY_GENERATOR_VERSION,
    registryVersion: ONTOLOGY_REGISTRY_VERSION, evidenceFingerprint: "colliding-title-evidence",
    evidenceObservationIds: source.observationIds, model: "fixture", summary: rawOutput.summary, rawOutput,
    assertions: assertionsFromGeneratedOntology(rawOutput, repository, { sourcePullRequestNumbers: [42, 43] })
  });
  const resolutions = await store.listAssertions("t", repository, { status: "proposed", predicate: "RESOLVES" });
  for (const [index, resolution] of resolutions.entries()) {
    await store.executeCommand("t", "svc:test", {
      type: "review_assertion", assertionId: resolution.id, decision: "accept"
    }, `2026-07-20T00:02:0${index}.000Z`);
  }
  const trace = await store.retrieve({
    tenantId: "t", allowedRepositories: [repository], repository, ref: "main", template: "issue_trace",
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
  const store = new MemoryOntologyGraphStore();
  await store.applyGitHubObservations([{
    tenantId: "t", repository: "org/repo", kind: "pull_request", number: 4,
    title: "Fix access", state: "closed", url: "https://github.com/org/repo/pull/4",
    recordedAt: "2026-07-20T00:00:00.000Z", occurredAt: "2026-07-20T00:00:00.000Z",
    commitShas: ["4".repeat(40)], resolvesIssueNumbers: [12]
  }, {
    tenantId: "t", repository: "org/repo", kind: "codeowners", commitSha: "4".repeat(40), path: "CODEOWNERS",
    entries: [{ pattern: "*", owners: ["@org/platform"] }], recordedAt: "2026-07-20T00:00:00.000Z"
  }]);
  const assertions = await store.listAssertions("t", "org/repo");
  assert.equal(assertions.some((assertion) => assertion.predicate === "RESOLVES" && assertion.commitSha === "source"), true);
  assert.equal(assertions.some((assertion) => assertion.predicate === "OWNED_BY" && assertion.commitSha === "source"), true);
  const ownership = await store.retrieve({
    tenantId: "t", allowedRepositories: ["org/repo"], repository: "org/repo", template: "ownership", path: "README.md"
  });
  assert.equal(ownership.items.length, 1);
  assert.match(ownership.items[0]?.title ?? "", /platform/);
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

test("normalizes a PR-anchored virtual issue as the generalized Issue kind", () => {
  const repository = "omxyz/demo";
  const assertions = assertionsFromGeneratedOntology({
    summary: "PR 42 fixes an authorization regression",
    nodes: [
      { id: "repo", kind: "Repository", label: repository, description: "repo", evidence: ["README.md:1"] },
      { id: "42", kind: "PullRequest", label: "PR #42", description: "restores deletion", evidence: ["src/auth.ts:10"] },
      {
        id: "virtual:pr:42",
        kind: "Issue",
        label: "Administrators cannot delete resources",
        description: "Administrator deletion is incorrectly denied.",
        evidence: ["src/auth.ts:10"]
      }
    ],
    edges: [{
      source: "42",
      target: "virtual:pr:42",
      predicate: "RESOLVES",
      plane: "knowledge",
      confidence: 0.94,
      evidence: ["src/auth.ts:10"]
    }]
  }, repository, { sourcePullRequestNumbers: [42] });
  const assertion = assertions.find((candidate) => candidate.predicate === "RESOLVES");
  const inverse = assertions.find((candidate) => candidate.predicate === "RESOLVED_BY");
  assert.equal(assertion?.subject.naturalKey, `github:pr:${repository}#42`);
  assert.equal(assertion?.object.kind, "Issue");
  assert.equal(assertion?.object.naturalKey, derivedIssueNaturalKey(repository, 42));
  assert.equal(assertion?.object.naturalKey.startsWith("github:issue:"), false);
  assert.equal(inverse?.subject.naturalKey, assertion?.object.naturalKey);
  assert.equal(inverse?.object.naturalKey, assertion?.subject.naturalKey);
  assert.throws(
    () => assertionsFromGeneratedOntology(generatedVirtualIssue(repository, 42), repository),
    /not present in source evidence/
  );
  assert.throws(
    () => assertionsFromGeneratedOntology({
      ...generatedVirtualIssue(repository, 42),
      edges: [{
        source: "43", target: "virtual:pr:42", predicate: "RESOLVES", plane: "knowledge", confidence: 0.9,
        evidence: ["src/auth.ts:10"]
      }],
      nodes: [
        ...generatedVirtualIssue(repository, 42).nodes.filter((node) => node.id !== "42"),
        { id: "43", kind: "PullRequest", label: "PR #43", description: "wrong anchor", evidence: ["src/auth.ts:10"] }
      ]
    }, repository, { sourcePullRequestNumbers: [42] }),
    /must be resolved by pull request #42/
  );
  assert.throws(
    () => assertionsFromGeneratedOntology(generatedVirtualIssue(repository, 42), repository, {
      sourcePullRequestNumbers: [42], resolvedPullRequestNumbers: [42]
    }),
    /already explicitly resolves an issue/
  );
});

test("ignores model duplicates of deterministic GitHub issue resolutions", () => {
  const repository = "omxyz/demo";
  const sha = "a".repeat(40);
  const assertions = assertionsFromGeneratedOntology({
    summary: "PR 5 resolves issue 4 caused by an earlier commit",
    nodes: [
      { id: "5", kind: "PullRequest", label: "PR #5", description: "restores deletion", evidence: ["ROOT_CAUSE.md:2"] },
      { id: "4", kind: "Issue", label: "Issue #4", description: "administrators cannot delete", evidence: ["ROOT_CAUSE.md:2"] },
      { id: sha, kind: "Commit", label: sha.slice(0, 12), description: "introduced the regression", evidence: ["ROOT_CAUSE.md:2"] }
    ],
    edges: [{
      source: "5", target: "4", predicate: "RESOLVES", plane: "knowledge", confidence: 0.99,
      evidence: ["ROOT_CAUSE.md:2"]
    }, {
      source: "4", target: sha, predicate: "INTRODUCED_BY", plane: "knowledge", confidence: 0.99,
      why: "The commit bypassed the administrator authorization guard.", evidence: ["ROOT_CAUSE.md:2"]
    }]
  }, repository);

  assert.deepEqual(assertions.map((assertion) => assertion.predicate), ["INTRODUCED_BY"]);
  assert.equal(assertions[0]?.subject.naturalKey, `github:issue:${repository}#4`);
  assert.equal(assertions[0]?.object.naturalKey, `repo:${repository}:sha:${sha}`);
});

test("infers a reviewed Feature and answers from its projected relationships", async () => {
  const tenantId = "feature-tenant";
  const repository = "omxyz/feature-fixture";
  const commitSha = "f".repeat(40);
  const store = new MemoryOntologyGraphStore();
  assert.equal(extractFeatureText("What implements the administrator deletion feature?"), "administrator deletion");
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
        id: "auth-file", kind: "File" as const, label: "src/auth.ts", description: "authorization",
        path: "src/auth.ts", evidence: ["src/auth.ts:1"]
      },
      {
        id: "readme", kind: "Document" as const, label: "README", description: "product docs",
        path: "README.md", evidence: ["README.md:2"]
      },
      {
        id: "audit-file", kind: "File" as const, label: "src/audit.ts", description: "audit export",
        path: "src/audit.ts", evidence: ["src/audit.ts:1"]
      }
    ],
    edges: [{
      source: "auth-file", target: "feature:administrator-deletion", predicate: "IMPLEMENTS",
      plane: "knowledge" as const, confidence: 0.96, evidence: ["src/auth.ts:1"]
    }, {
      source: "feature:administrator-deletion", target: "readme", predicate: "DOCUMENTED_BY",
      plane: "knowledge" as const, confidence: 0.98, evidence: ["README.md:2"]
    }, {
      source: "audit-file", target: "feature:administrator-audit", predicate: "IMPLEMENTS",
      plane: "knowledge" as const, confidence: 0.95, evidence: ["src/audit.ts:1"]
    }]
  };
  const generatedAssertions = assertionsFromGeneratedOntology(rawOutput, repository);
  assert.equal(generatedAssertions[0]?.object.naturalKey, featureNaturalKey(repository, "feature:administrator-deletion"));
  assert.throws(
    () => featureNaturalKey(repository, "administrator deletion"),
    /Feature id must use feature/
  );
  await store.saveAssertionBatch({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    taskId: "feature-assert",
    generatedAt: "2026-07-20T00:01:00.000Z",
    generatorVersion: ONTOLOGY_GENERATOR_VERSION,
    registryVersion: ONTOLOGY_REGISTRY_VERSION,
    evidenceFingerprint: "feature-evidence",
    evidenceObservationIds: [],
    model: "fixture",
    summary: rawOutput.summary,
    rawOutput,
    assertions: generatedAssertions
  });
  const proposals = await store.listAssertions(tenantId, repository, { status: "proposed" });
  assert.equal(proposals.length, 3);
  for (const [index, proposal] of proposals.entries()) {
    await store.executeCommand(tenantId, "svc:test", {
      type: "review_assertion", assertionId: proposal.id, decision: "accept"
    }, `2026-07-20T00:02:0${index}.000Z`);
  }
  const graph = await store.project({
    tenantId,
    repository,
    ref: "main",
    commitSha,
    taskId: "feature-project",
    generatedAt: "2026-07-20T00:03:00.000Z"
  });
  assert.equal(graph.nodes.some((node) => node.kind === "Feature" && node.label === "Administrator deletion"), true);
  assert.equal(graph.edges.some((edge) => edge.predicate === "IMPLEMENTS"), true);

  const answer = await new RepositoryContextOrchestrator(store).answer({
    tenantId,
    allowedRepositories: [repository],
    repository,
    ref: "main",
    question: 'Which files implement "administrator deletion"?'
  });
  assert.match(answer.answer, /src\/auth\.ts implements Administrator deletion/);
  assert.equal(answer.calls[0]?.template, "feature_trace");
  assert.equal(answer.citedClaims[0]?.citations.some((citation) => citation.kind === "assertion"), true);
  assert.equal(answer.citedClaims[0]?.citations.some((citation) => citation.kind === "code" && citation.path === "src/auth.ts"), true);
  const ambiguous = await new RepositoryContextOrchestrator(store).answer({
    tenantId,
    allowedRepositories: [repository],
    repository,
    ref: "main",
    question: 'Which files implement "administrator"?'
  });
  assert.match(ambiguous.unresolvedAmbiguities[0] ?? "", /Multiple features matched/);
});

function generatedVirtualIssue(repository: string, pullRequestNumber: number) {
  return {
    summary: `PR ${pullRequestNumber} fixes an authorization regression`,
    nodes: [
      { id: "repo", kind: "Repository" as const, label: repository, description: "repo", evidence: ["README.md:1"] },
      {
        id: String(pullRequestNumber), kind: "PullRequest" as const, label: `PR #${pullRequestNumber}`,
        description: "restores deletion", evidence: ["src/auth.ts:10"]
      },
      {
        id: `virtual:pr:${pullRequestNumber}`, kind: "Issue" as const, label: "Administrators cannot delete resources",
        description: "Administrator deletion is incorrectly denied.", evidence: ["src/auth.ts:10"]
      }
    ],
    edges: [{
      source: String(pullRequestNumber), target: `virtual:pr:${pullRequestNumber}`, predicate: "RESOLVES",
      plane: "knowledge" as const, confidence: 0.94, evidence: ["src/auth.ts:10"]
    }]
  };
}

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

test("content-addresses identical projection generations across worker tasks", () => {
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
    executor: "projection" as const,
    model: "current-graph-v1",
    contentAddressed: true,
    generated
  });
  assert.equal(build("task-1").id, build("task-2").id);
  const reordered = { ...generated, nodes: [...generated.nodes].reverse(), edges: [...generated.edges].reverse() };
  assert.equal(build("task-1").id, createOntologyGraph({
    request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId: "task-3" },
    commitSha: "abc", generatedAt: "2026-01-01T00:00:00.000Z", executor: "projection", model: "current-graph-v1",
    contentAddressed: true, generated: reordered
  }).id);
  assert.notEqual(build("task-1").id, createOntologyGraph({
    request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId: "task-4" },
    commitSha: "abc", generatedAt: "2026-01-01T00:00:00.000Z", executor: "projection", model: "current-graph-v1",
    contentAddressed: true,
    generated: { ...generated, nodes: generated.nodes.map((node) => node.id === "readme" ? { ...node, label: "Changed README" } : node) }
  }).id);
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
  const derived = parseGeneratedOntology({
    summary: "derived root cause",
    nodes: [
      {
        id: "virtual:pr:42", kind: "Issue", label: "Administrators cannot delete resources",
        description: "Administrator deletion is incorrectly denied.", evidence: ["docs/root-cause.md:1"]
      },
      { id: sha, kind: "Commit", label: sha.slice(0, 12), description: "offending change", evidence: ["docs/root-cause.md:1"] }
    ],
    edges: [{
      source: "virtual:pr:42", target: sha, predicate: "INTRODUCED_BY", plane: "knowledge", confidence: 0.99,
      why: "The commit removed the administrator bypass.", evidence: ["docs/root-cause.md:1-2"]
    }]
  });
  await validateOntologyEvidence(derived, async () =>
    `Administrators cannot delete resources was caused by commit ${sha}.\nThe commit removed the administrator bypass.`
  );
  await assert.rejects(
    validateOntologyEvidence(derived, async () =>
      `A deletion bug was caused by commit ${sha}.\nThe commit removed the administrator bypass.`
    ),
    /explicitly name derived Issue Administrators cannot delete resources and commit/
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
    evidenceFingerprint: "evidence-fixture",
    evidenceObservationIds: [],
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
  assert.equal((await store.hasAssertionGeneration(
    snapshot.tenantId,
    snapshot.repository,
    snapshot.commitSha,
    ONTOLOGY_GENERATOR_VERSION,
    ONTOLOGY_REGISTRY_VERSION,
    "evidence-fixture"
  ))?.cached, true);
  assert.equal(await store.hasAssertionGeneration(
    snapshot.tenantId, snapshot.repository, snapshot.commitSha, ONTOLOGY_GENERATOR_VERSION,
    ONTOLOGY_REGISTRY_VERSION, "different-evidence"
  ), undefined);
  assert.equal(await store.hasAssertionGeneration(
    snapshot.tenantId, snapshot.repository, snapshot.commitSha, ONTOLOGY_GENERATOR_VERSION,
    "different-registry", "evidence-fixture"
  ), undefined);

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
  const repeatedGraph = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    taskId: "second-project-task",
    generatedAt: "2026-07-19T00:02:30.000Z"
  });
  assert.equal(repeatedGraph.id, graph.id);
  assert.equal((await store.list(snapshot.tenantId)).length, 1, "identical projection content does not create a second graph generation");

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
