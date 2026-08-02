import assert from "node:assert/strict";
import test from "node:test";
import { issueGraphTrace, materializeIssueGraph, parseIssueGraphArtifact, searchIssueGraph } from "./issue-graph.js";

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
        predicate: "INTRODUCED_BY",
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
      promptVersion: "issue-causality-v1"
    }
  });
}

test("materializes stable issue identities, evidence excerpts, and causal traces", () => {
  const graph = materialize();
  assert.equal(graph.repository, "acme/widgets");
  assert.equal(graph.issues.length, 2);
  assert.equal(graph.causalities.length, 3);
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

test("rejects predicate endpoint mismatches and causal cycles", () => {
  const wrongKind = candidate();
  wrongKind.causalities[0]!.objectKind = "issue";
  wrongKind.causalities[0]!.objectRef = "claim-timeout";
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
