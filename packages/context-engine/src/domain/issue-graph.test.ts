import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveIssueCandidateLedger,
  issueGraphTrace,
  materializeIssueGraph,
  minimumDerivedIssueCount,
  parseIssueGraphArtifact,
  searchIssueGraph
} from "./issue-graph.js";

const introduced = "a".repeat(40);
const resolved = "b".repeat(40);
const followup = "c".repeat(40);

function candidate() {
  return {
    version: 1,
    summary: "Database pool contention and its follow-up failure mode.",
    issues: [
      {
        key: "pool-contention",
        title: "Context query fan-out saturates the database pool",
        summary: "Per-term query fan-out consumed the API connection pool and delayed otherwise independent reads.",
        evidence: [
          { commitSha: introduced, role: "introduced", messageStartLine: 1, messageEndLine: 1 },
          { commitSha: resolved, role: "resolved", messageStartLine: 1, messageEndLine: 2 }
        ]
      },
      {
        key: "claim-timeout",
        title: "Worker claims time out while the API is under pressure",
        summary: "Worker claim requests were aborted while database-backed API work was delayed.",
        evidence: [{ commitSha: followup, role: "resolved", messageStartLine: 1, messageEndLine: 1 }]
      }
    ],
    causalities: [
      {
        subjectKey: "pool-contention",
        predicate: "CAUSED_BY",
        objectKind: "commit",
        objectRef: introduced,
        why: "The cited commit message explicitly says the fan-out was introduced here.",
        confidence: "explicit",
        evidence: [{ commitSha: introduced, role: "introduced", messageStartLine: 1, messageEndLine: 1 }]
      },
      {
        subjectKey: "pool-contention",
        predicate: "RESOLVED_BY",
        objectKind: "commit",
        objectRef: resolved,
        why: "The cited commit removes the fan-out and records the read-pressure symptom.",
        confidence: "explicit",
        evidence: [{ commitSha: resolved, role: "resolved", messageStartLine: 1, messageEndLine: 2 }]
      },
      {
        subjectKey: "claim-timeout",
        predicate: "CAUSED_BY",
        objectKind: "issue",
        objectRef: "pool-contention",
        why: "The claim timeout repair identifies API pressure as the cause.",
        confidence: "explicit",
        evidence: [{ commitSha: followup, role: "resolved", messageStartLine: 1, messageEndLine: 1 }]
      }
    ]
  };
}

function materialize(value: unknown = candidate()) {
  return materializeIssueGraph({
    tenantId: "tenant-a",
    repository: "Acme/Widgets",
    ref: "main",
    refSequence: 2,
    commitSha: followup,
    generatedAt: "2026-08-01T15:00:00.000Z",
    historyComplete: true,
    history: [
      {
        sha: followup,
        parentShas: [resolved],
        message: "fix(worker): keep context claim requests alive",
        committedAt: "2026-08-01T14:00:00.000Z"
      },
      {
        sha: resolved,
        parentShas: [introduced],
        message: "perf(db): remove context query fan-out\nExpose pool checkout pressure.",
        committedAt: "2026-08-01T13:00:00.000Z"
      },
      {
        sha: introduced,
        parentShas: [],
        message: "feat(db): introduce per-term context lookups",
        committedAt: "2026-08-01T12:00:00.000Z"
      }
    ],
    candidate: value,
    generator: {
      name: "codex",
      version: "1",
      model: "gpt-5.6-terra",
      promptVersion: "issue-causality-v2"
    }
  });
}

test("materializes generalized commit and issue causes, stable identities, evidence excerpts, and causal traces", () => {
  const graph = materialize();
  assert.equal(graph.repository, "acme/widgets");
  assert.equal(graph.issues.length, 2);
  assert.equal(graph.causalities.length, 4);
  assert.equal(graph.generator.schemaVersion, "issue-causality-v2");
  assert.equal(
    graph.causalities.filter((edge) => edge.predicate === "CAUSED_BY" && edge.object.kind === "commit").length,
    1
  );
  assert.equal(
    graph.causalities.filter((edge) => edge.predicate === "CAUSED_BY" && edge.object.kind === "issue").length,
    1
  );
  assert.equal(graph.issues.find((issue) => issue.title.includes("fan-out"))?.state, "resolved");
  assert.match(graph.issues[0]!.id, /^issue_[0-9a-f]{32}$/);
  assert.equal(parseIssueGraphArtifact(graph).id, graph.id);
  assert.equal(searchIssueGraph(graph, "fan-out").length, 1);
  const root = graph.issues.find((issue) => issue.title.includes("claim"))!;
  const trace = issueGraphTrace(graph, root.id);
  assert.equal(trace.issues.length, 2);
  assert.equal(trace.causalities.filter((edge) => edge.object.kind === "issue").length, 1);
});

test("rejects evidence outside the observed commit message", () => {
  const invalid = candidate();
  invalid.issues[0]!.evidence[0]!.messageEndLine = 20;
  assert.throws(() => materialize(invalid), /outside commit/);
});

test("canonicalizes case-only differences in model-authored issue references", () => {
  const value = candidate();
  value.causalities[2]!.subjectKey = "CLAIM-TIMEOUT";
  value.causalities[2]!.objectRef = "POOL-CONTENTION";
  const graph = materialize(value);
  const edge = graph.causalities.find((causality) => causality.object.kind === "issue");
  assert.ok(edge);
  assert.notEqual(edge.subjectIssueId, edge.object.id);
});

test("normalizes unambiguous abbreviated evidence and causality commit SHAs", () => {
  const value = candidate();
  value.issues[0]!.evidence[0]!.commitSha = introduced.slice(0, 7);
  value.issues[0]!.evidence[1]!.commitSha = resolved.slice(0, 12);
  value.causalities[0]!.objectRef = introduced.slice(0, 8);
  value.causalities[0]!.evidence[0]!.commitSha = introduced.slice(0, 9);
  const graph = materialize(value);
  const issue = graph.issues.find((item) => item.title.includes("fan-out"));
  assert.deepEqual(
    issue?.evidence.map((item) => item.commitSha),
    [introduced, resolved]
  );
  assert.ok(
    graph.causalities.some(
      (edge) => edge.predicate === "CAUSED_BY" && edge.object.kind === "commit" && edge.object.id === introduced
    )
  );
});

test("rejects unknown and ambiguous abbreviated commit SHAs", () => {
  const unknown = candidate();
  unknown.issues[0]!.evidence[0]!.commitSha = "1234567";
  assert.throws(() => materialize(unknown), /does not identify a commit/);

  const ambiguousPrefix = "abcdef0";
  const left = `${ambiguousPrefix}${"1".repeat(33)}`;
  const right = `${ambiguousPrefix}${"2".repeat(33)}`;
  const ambiguous = candidate();
  ambiguous.issues[0]!.evidence[0]!.commitSha = ambiguousPrefix;
  assert.throws(
    () =>
      materializeIssueGraph({
        tenantId: "tenant-a",
        repository: "Acme/Widgets",
        ref: "main",
        refSequence: 2,
        commitSha: left,
        generatedAt: "2026-08-01T15:00:00.000Z",
        historyComplete: true,
        history: [
          { sha: left, parentShas: [right], message: "fix: first ambiguous commit" },
          { sha: right, parentShas: [], message: "fix: second ambiguous commit" }
        ],
        candidate: ambiguous,
        generator: { name: "codex", version: "1", model: "test", promptVersion: "issue-causality-v4" }
      }),
    /ambiguous in the observed history/
  );
});

test("rejects predicate endpoint mismatches and causal cycles", () => {
  const wrongKind = candidate();
  wrongKind.causalities[1]!.objectKind = "issue";
  wrongKind.causalities[1]!.objectRef = "claim-timeout";
  assert.throws(() => materialize(wrongKind), /requires a commit object/);

  const cyclic = candidate();
  cyclic.causalities.push({
    subjectKey: "pool-contention",
    predicate: "CONTRIBUTES_TO",
    objectKind: "issue",
    objectRef: "claim-timeout",
    why: "This creates the reverse of the existing issue-to-issue causal path.",
    confidence: "inferred",
    evidence: [{ commitSha: resolved, role: "observed", messageStartLine: 1, messageEndLine: 1 }]
  });
  assert.throws(() => materialize(cyclic), /acyclic/);
});

test("candidate ledger is deterministic and sets a bounded recall floor", () => {
  const history = [
    { sha: introduced, parentShas: [], message: "feat: add ordinary behavior" },
    { sha: resolved, parentShas: [introduced], message: "fix(api): prevent stale state rollback" },
    { sha: followup, parentShas: [resolved], message: "docs: explain retries after timeout failures" }
  ];
  const ledger = deriveIssueCandidateLedger(history);
  assert.deepEqual(
    ledger.candidates.map((item) => ({ sha: item.commitSha, signals: item.signals })),
    [
      { sha: resolved, signals: ["fix", "prevent", "rollback", "stale"] },
      { sha: followup, signals: ["failure", "timeout", "retry"] }
    ]
  );
  assert.deepEqual(deriveIssueCandidateLedger(history), ledger);
  assert.equal(minimumDerivedIssueCount(0), 0);
  assert.equal(minimumDerivedIssueCount(40), 6);
  assert.equal(minimumDerivedIssueCount(103), 15);
});

test("enforces exhaustive candidate disposition and synthesizes lifecycle edges", () => {
  const history = [
    {
      sha: followup,
      parentShas: [resolved],
      message: "fix(worker): retry a failed claim",
      committedAt: "2026-08-01T14:00:00.000Z"
    },
    {
      sha: resolved,
      parentShas: [introduced],
      message: "fix(worker): prevent claim timeout",
      committedAt: "2026-08-01T13:00:00.000Z"
    },
    {
      sha: introduced,
      parentShas: [],
      message: "feat(worker): hold claims while blocked",
      committedAt: "2026-08-01T12:00:00.000Z"
    }
  ];
  const ledger = deriveIssueCandidateLedger(history);
  const value = {
    version: 1,
    summary: "Claim handling could block and time out before the repair.",
    issues: [
      {
        key: "claim-timeout",
        title: "Blocked claims timed out",
        summary: "Claim processing remained blocked long enough for workers to time out.",
        evidence: [
          { commitSha: introduced, role: "introduced", messageStartLine: 1, messageEndLine: 1 },
          { commitSha: resolved, role: "resolved", messageStartLine: 1, messageEndLine: 1 }
        ]
      }
    ],
    causalities: [],
    candidateDispositions: ledger.candidates.map((item) => ({
      commitSha: item.commitSha.slice(0, 7),
      disposition: item.commitSha === followup ? "duplicate" : "issue",
      issueKeys: ["claim-timeout"],
      reason: "The commit describes the same blocked claim timeout failure."
    }))
  };
  const graph = materializeIssueGraph({
    tenantId: "tenant-a",
    repository: "Acme/Widgets",
    ref: "main",
    refSequence: 2,
    commitSha: followup,
    generatedAt: "2026-08-01T15:00:00.000Z",
    history,
    historyComplete: true,
    candidate: value,
    candidateLedger: ledger,
    generator: { name: "codex", version: "1", model: "test", promptVersion: "issue-causality-v3" }
  });
  assert.equal(graph.causalities.filter((edge) => edge.predicate === "CAUSED_BY").length, 1);
  assert.equal(graph.causalities.filter((edge) => edge.predicate === "RESOLVED_BY").length, 1);

  value.candidateDispositions.pop();
  assert.throws(
    () =>
      materializeIssueGraph({
        tenantId: "tenant-a",
        repository: "Acme/Widgets",
        ref: "main",
        refSequence: 2,
        commitSha: followup,
        generatedAt: "2026-08-01T15:00:00.000Z",
        history,
        historyComplete: true,
        candidate: value,
        candidateLedger: ledger,
        generator: { name: "codex", version: "1", model: "test", promptVersion: "issue-causality-v3" }
      }),
    /did not disposition/
  );
});
