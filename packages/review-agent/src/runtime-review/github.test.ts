import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRuntimeReviewRequest,
  legacyRuntimeReviewMarker,
  runtimeReviewMarker,
  runtimeReviewMarkers
} from "./github.js";
import type { RuntimeReviewResult } from "./index.js";

const diffPatch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 export async function handler(req: Request) {
-  return Response.json({ ok: true });
+  const payload = await req.json();
+  return Response.json({ ok: payload.ok });
 }
`;

test("buildRuntimeReviewRequest creates inline comments and concise body", () => {
  const previousDashboardUrl = process.env.DASHBOARD_URL;
  process.env.DASHBOARD_URL = "https://jina.example";
  try {
    const result: RuntimeReviewResult = {
      schemaVersion: 1,
      status: "issues_found",
      summary: "Runtime review found request parsing issues.",
      readiness: {
        score: 2,
        recommendation: "Hold until request parsing is fixed",
        rationale:
          "A medium-risk request parsing issue remains accepted. This can affect normal API usage until it is fixed."
      },
      finalReviewSummary:
        "The investigation exercised request parsing and found three issues; the JSON parse crash must be addressed before merge.",
      commit: "abc123",
      diffStat: "src/app.ts | 3 ++-",
      changedFiles: ["src/app.ts"],
      diffPatch,
      plan: { schemaVersion: 1, areas: [] },
      markdown: "",
      areas: [
        {
          areaId: "request-body",
          title: "Request body parsing",
          status: "completed",
          summary: "Ran a focused handler probe and found invalid JSON can throw before a response is created.",
          tasks: [
            {
              id: "handler-probe",
              title: "Handler invalid JSON probe",
              purpose: "Validate request parsing behavior.",
              method: "execution",
              actionsTaken: [
                "Generated a focused handler script.",
                "Ran pnpm exec tsx .jina/runtime-review/probes/request-body/probe.ts."
              ],
              whatWasLearned: "Invalid JSON throws from req.json() before the handler creates an error response.",
              auditTrail: [
                {
                  type: "command",
                  detail: "pnpm exec tsx .jina/runtime-review/probes/request-body/probe.ts",
                  evidence: ["exitCode=1", "SyntaxError: Unexpected token"]
                }
              ],
              verdict: "issue_found",
              confidence: "high"
            }
          ],
          issues: [],
          nonIssues: [],
          blocked: [],
          toolCalls: []
        }
      ],
      findings: [
        {
          fingerprint: "request-json-throw",
          title: "Invalid JSON can crash the handler",
          risk: "medium",
          confidence: "high",
          likelihood: "medium",
          category: "correctness",
          file_path: "src/app.ts",
          line_number: 3,
          body: "The changed handler awaits req.json() without catching parse errors, so malformed JSON throws instead of returning a controlled 400 response.",
          root_cause: "The route moved parsing before validation and does not catch JSON parse failures.",
          why_it_matters: "Malformed requests can return a generic 500 and bypass expected API error handling.",
          evidence: ["Focused handler probe exited with SyntaxError before response creation."],
          reproduction_or_trace: "pnpm exec tsx .jina/runtime-review/probes/request-body/probe.ts",
          suggested_fix: "Wrap req.json() in a try/catch and return a 400 response for parse errors.",
          validation_method: "execution",
          audit_trail: ["Generated probe script.", "Ran focused handler probe."]
        },
        {
          fingerprint: "unanchored",
          title: "Follow-up response contract issue",
          risk: "medium",
          confidence: "medium",
          category: "data",
          file_path: "src/app.ts",
          line_number: 99,
          body: "The response shape no longer includes the legacy field expected by an unchanged caller.",
          root_cause: "The handler response contract changed without updating the caller.",
          why_it_matters: "The caller may render stale or missing state.",
          evidence: ["mental_trace followed the caller response path."],
          reproduction_or_trace: "mental_trace of caller response handling.",
          validation_method: "hybrid",
          audit_trail: ["Read caller source.", "Ran mental_trace."]
        },
        {
          fingerprint: "low",
          title: "Speculative low-confidence issue",
          risk: "low",
          confidence: "low",
          category: "other",
          body: "Low-confidence findings should be held back.",
          root_cause: "",
          why_it_matters: "",
          evidence: [],
          reproduction_or_trace: "",
          validation_method: "source_trace",
          audit_trail: []
        }
      ],
      // No stage creates review comments any more.
      comments: [],
      commentsCount: 0
    };

    const request = buildRuntimeReviewRequest({
      result,
      headSha: "abc123",
      reviewRunId: "run-1",
      issueMarkers: true,
      publishFileComments: true
    });

    assert.equal(request.body.includes(runtimeReviewMarker("abc123", "run-1")), true);
    assert.equal(request.comments.length, 1);
    assert.equal(request.fileComments.length, 0);
    assert.equal(request.comments[0].path, "src/app.ts");
    assert.equal(request.comments[0].line, 3);
    assert.equal(request.comments[0].side, "RIGHT");
    assert.match(request.comments[0].body, /<!-- jina:issue /);
    assert.match(request.comments[0].body, /"stage":"runtime"/);
    assert.match(request.comments[0].body, /"fingerprint":"request-json-throw"/);
    assert.match(request.comments[0].body, /### Invalid JSON can crash the handler/);
    assert.match(request.comments[0].body, /\*\*P1\*\* · High — Should fix/);
    assert.match(request.comments[0].body, /View full runtime review audit trail/);
    // Every issue the investigation found is reported: the low-confidence gate is gone,
    // so all three findings publish and none are held back.
    assert.equal(request.publishableFindings.length, 3);
    assert.equal(request.unanchoredFindings.length, 2);
    assert.equal(request.lowConfidenceFindings.length, 0);
    assert.match(request.body, /## Runtime Review — Merge Readiness 2\/5/);
    assert.match(request.body, /Hold until request parsing is fixed/);
    assert.match(request.body, /### 3 issues found - Hold until request parsing is fixed/);
    assert.match(
      request.body,
      /A medium-risk request parsing issue remains accepted\.\n\nThis can affect normal API usage until it is fixed\./
    );
    assert.match(request.body, /### Areas Investigated/);
    assert.match(request.body, /Request body parsing/);
    assert.match(request.body, /### Issues/);
    assert.match(request.body, /Follow-up response contract issue/);
    assert.match(request.body, /Speculative low-confidence issue/);
    assert.match(request.body, /View the full investigation report on the Jina dashboard/);
  } finally {
    if (previousDashboardUrl === undefined) {
      delete process.env.DASHBOARD_URL;
    } else {
      process.env.DASHBOARD_URL = previousDashboardUrl;
    }
  }
});

test("buildRuntimeReviewRequest publishes a body even with no findings", () => {
  const result: RuntimeReviewResult = {
    schemaVersion: 1,
    status: "passed",
    summary: "Runtime review found no publishable issues.",
    readiness: {
      score: 5,
      recommendation: "Ready to merge",
      rationale: "No accepted runtime issues remained after final review."
    },
    commit: "abc123",
    diffStat: "src/app.ts | 1 +",
    changedFiles: ["src/app.ts"],
    diffPatch,
    plan: { schemaVersion: 1, areas: [] },
    areas: [],
    findings: [],
    markdown: ""
  };

  const request = buildRuntimeReviewRequest({ result, headSha: "abc123" });

  assert.equal(request.body.includes(runtimeReviewMarker("abc123")), true);
  assert.equal(request.comments.length, 0);
  assert.equal(request.fileComments.length, 0);
  assert.equal(request.publishableFindings.length, 0);
  assert.equal(request.unanchoredFindings.length, 0);
  assert.match(request.body, /## Runtime Review — Merge Readiness 5\/5/);
  assert.match(request.body, /### 0 issues found - Ready to merge/);
  assert.match(request.body, /No qualifying runtime issues were reported/);
  assert.match(request.body, /No investigation areas were produced/);
});

test("buildRuntimeReviewRequest uses the current merge-confidence label when recommendation is missing", () => {
  const result: RuntimeReviewResult = {
    schemaVersion: 2,
    status: "warned",
    summary: "Reviewer omitted its recommendation label.",
    readiness: {
      score: 3,
      recommendation: "",
      rationale: "Moderate implementation issues remain."
    },
    commit: "abc123",
    diffStat: "src/app.ts | 1 +",
    changedFiles: ["src/app.ts"],
    diffPatch,
    plan: { schemaVersion: 2, areas: [] },
    areas: [],
    findings: [],
    markdown: ""
  };

  const request = buildRuntimeReviewRequest({ result, headSha: "abc123" });

  assert.match(request.body, /### 0 issues found - Merge is okay, fixes recommended/);
});

test("buildRuntimeReviewRequest accepts schema v2 runtime payload aliases", () => {
  const result: RuntimeReviewResult = {
    schemaVersion: 2,
    status: "issues_found",
    summary: "Runtime review accepted a v2 finding.",
    context: {
      repository: "octo/repo",
      pullRequestNumber: 42,
      baseRef: "main",
      headSha: "abc123",
      commit: "abc123",
      diffStat: "src/app.ts | 1 +",
      changedFiles: ["src/app.ts"],
      diffPatch,
      repoDir: "/tmp/repo",
      workspace: "/tmp/work",
      logsDir: "/tmp/work/logs",
      toolLogsDir: "/tmp/work/logs/tools",
      codegraphCli: "codegraph",
      codegraphMarkdown: "Codegraph status: ok",
      threadSummaryMarkdown: "PR thread context: none",
      threadItems: [],
      partialFailures: []
    },
    intent: {
      markdown: "The PR intends to parse request JSON safely.",
      metadata: { generatedAt: "2026-07-03T00:00:00.000Z", ambiguous: false }
    },
    plan: {
      schemaVersion: 2,
      areas: [
        {
          id: "request-json",
          title: "Request JSON parsing",
          priority: "medium",
          expectations: ["Malformed JSON returns 400."],
          potentialFailureModes: ["Malformed JSON throws."],
          whyWorthExploring: "The changed handler parses JSON.",
          runtimeHypotheses: ["Malformed JSON throws."],
          expectedSafeBehavior: ["Malformed JSON returns 400."],
          files: ["src/app.ts"],
          symbols: ["handler"],
          routesOrEntrypoints: ["handler(req)"],
          groundingEvidence: ["src/app.ts changed"]
        }
      ]
    },
    investigations: [],
    areas: [],
    finalReview: {
      summary: "Accepted one v2 candidate.",
      acceptedIssues: [
        {
          fingerprint: "v2-json",
          title: "Invalid JSON can crash the handler",
          risk: "medium",
          confidence: "high",
          category: "correctness",
          file_path: "src/app.ts",
          line_number: 3,
          body: "The handler awaits req.json() without catching parse failures.",
          root_cause: "Parsing is unguarded.",
          why_it_matters: "Malformed requests bypass API error handling.",
          evidence: ["Probe reproduced the throw."],
          reproduction_or_trace: "pnpm exec tsx probe.ts",
          validation_method: "execution",
          audit_trail: ["Ran probe."]
        }
      ],
      comments: [],
      dismissedCandidates: [],
      readiness: {
        score: 2,
        recommendation: "Do not merge until addressed",
        rationale: "A real runtime issue remains."
      }
    },
    readiness: { score: 2, recommendation: "Do not merge until addressed", rationale: "A real runtime issue remains." },
    commit: "abc123",
    diffStat: "src/app.ts | 1 +",
    changedFiles: ["src/app.ts"],
    diffPatch,
    findings: [
      {
        fingerprint: "v2-json",
        title: "Invalid JSON can crash the handler",
        risk: "medium",
        confidence: "high",
        category: "correctness",
        file_path: "src/app.ts",
        line_number: 3,
        body: "The handler awaits req.json() without catching parse failures.",
        root_cause: "Parsing is unguarded.",
        why_it_matters: "Malformed requests bypass API error handling.",
        evidence: ["Probe reproduced the throw."],
        reproduction_or_trace: "pnpm exec tsx probe.ts",
        validation_method: "execution",
        audit_trail: ["Ran probe."]
      }
    ],
    markdown: ""
  };

  const request = buildRuntimeReviewRequest({ result, headSha: "abc123", issueMarkers: true });

  assert.equal(request.publishableFindings.length, 1);
  assert.equal(request.comments.length, 1);
  assert.match(request.body, /Runtime Review — Merge Readiness 2\/5/);
  assert.match(request.comments[0].body, /"fingerprint":"v2-json"/);
});

test("buildRuntimeReviewRequest reports only actual file-level comments", () => {
  const result: RuntimeReviewResult = {
    schemaVersion: 1,
    status: "issues_found",
    summary: "Runtime review found a pathless issue.",
    commit: "abc123",
    diffStat: "",
    changedFiles: [],
    diffPatch: "",
    plan: { schemaVersion: 1, areas: [] },
    areas: [],
    markdown: "",
    findings: [
      {
        fingerprint: "pathless",
        title: "Pathless runtime issue",
        risk: "medium",
        confidence: "high",
        category: "correctness",
        body: "The runtime behavior fails but is not tied to a file.",
        root_cause: "The failure is cross-cutting.",
        why_it_matters: "The PR can fail at runtime.",
        evidence: ["Probe failed."],
        reproduction_or_trace: "Run the probe.",
        validation_method: "execution",
        audit_trail: ["Ran probe."]
      }
    ]
  };

  const request = buildRuntimeReviewRequest({
    result,
    headSha: "abc123",
    reviewRunId: "run-1",
    issueMarkers: true,
    publishFileComments: true
  });

  assert.equal(request.comments.length, 0);
  assert.equal(request.fileComments.length, 0);
  assert.equal(request.unanchoredFindings.length, 1);
  // The finding could not be anchored or attached to a changed file, so it is listed
  // in the review body instead. It is still reported.
  assert.match(request.body, /### Issues/);
  assert.match(request.body, /Pathless runtime issue/);
});

test("buildRuntimeReviewRequest keeps unpathed findings in the main review body", () => {
  const result: RuntimeReviewResult = {
    schemaVersion: 1,
    status: "issues_found",
    summary: "Runtime review found a cross-file issue.",
    commit: "abc123",
    diffStat: "src/app.ts | 1 +",
    changedFiles: ["src/app.ts"],
    diffPatch,
    plan: { schemaVersion: 1, areas: [] },
    areas: [],
    markdown: "",
    findings: [
      {
        fingerprint: "cross-file",
        title: "Cross-file runtime issue",
        risk: "medium",
        confidence: "high",
        category: "correctness",
        body: "The runtime behavior fails across files.",
        root_cause: "The failing behavior is not tied to one file.",
        why_it_matters: "The PR can fail at runtime.",
        evidence: ["Probe failed."],
        reproduction_or_trace: "Run the probe.",
        suggested_fix: "Adjust the flow.",
        validation_method: "execution",
        audit_trail: ["Ran probe."]
      }
    ]
  };

  const request = buildRuntimeReviewRequest({
    result,
    headSha: "abc123",
    reviewRunId: "run-1",
    fallbackFilePath: "src/app.ts",
    issueMarkers: true,
    publishFileComments: true
  });

  assert.equal(request.comments.length, 0);
  assert.equal(request.fileComments.length, 0);
  assert.match(request.body, /Cross-file runtime issue/);
});

test("buildRuntimeReviewRequest keeps outside-diff findings in the main review body", () => {
  const result: RuntimeReviewResult = {
    schemaVersion: 1,
    status: "issues_found",
    summary: "Runtime review found a cross-file issue.",
    commit: "abc123",
    diffStat: "src/app.ts | 1 +",
    changedFiles: ["src/app.ts"],
    diffPatch,
    plan: { schemaVersion: 1, areas: [] },
    areas: [],
    markdown: "",
    findings: [
      {
        fingerprint: "non-diff-file",
        title: "Runtime issue in a downstream file",
        risk: "medium",
        confidence: "high",
        category: "correctness",
        file_path: "src/downstream.ts",
        line_number: 10,
        body: "The runtime behavior fails in a file that was not directly changed.",
        root_cause: "The changed entrypoint passes an invalid value downstream.",
        why_it_matters: "The PR can fail at runtime.",
        evidence: ["Probe failed in src/downstream.ts."],
        reproduction_or_trace: "Run the probe.",
        suggested_fix: "Adjust the changed entrypoint.",
        validation_method: "execution",
        audit_trail: ["Ran probe."]
      }
    ]
  };

  const request = buildRuntimeReviewRequest({
    result,
    headSha: "abc123",
    reviewRunId: "run-1",
    fallbackFilePath: "src/app.ts",
    issueMarkers: true,
    publishFileComments: true
  });

  assert.equal(request.comments.length, 0);
  assert.equal(request.fileComments.length, 0);
  assert.match(request.body, /Runtime issue in a downstream file/);
  assert.equal(request.unanchoredFindings.length, 1);
});

test("buildRuntimeReviewRequest reports unanchored issues in the main review body", () => {
  const result: RuntimeReviewResult = {
    schemaVersion: 1,
    status: "issues_found",
    summary: "Runtime review found an unanchored issue.",
    commit: "abc123",
    diffStat: "src/app.ts | 1 +",
    changedFiles: ["src/app.ts"],
    diffPatch,
    plan: { schemaVersion: 1, areas: [] },
    areas: [],
    readiness: {
      score: 3,
      recommendation: "Owner review recommended",
      rationale: "The repository policy treats this bounded issue as reviewable."
    },
    publication: {
      areaSummaries: [],
      issues: [
        {
          title: "Runtime issue outside the diff",
          body: "The runtime behavior fails outside an anchorable line.",
          severity: "P3",
          severityDescription: "Low — Team follow-up requested",
          sourceFingerprints: ["unanchored-runtime"]
        }
      ]
    },
    markdown: "",
    findings: [
      {
        fingerprint: "unanchored-runtime",
        title: "Runtime issue outside the diff",
        risk: "medium",
        confidence: "medium",
        category: "correctness",
        file_path: "src/app.ts",
        line_number: 99,
        body: "The runtime behavior fails outside an anchorable line.",
        root_cause: "The failure is not tied to the submitted diff line.",
        why_it_matters: "The PR can fail at runtime.",
        evidence: ["Probe failed."],
        reproduction_or_trace: "Run the probe.",
        validation_method: "execution",
        audit_trail: ["Ran probe."]
      }
    ]
  };

  const request = buildRuntimeReviewRequest({ result, headSha: "abc123" });

  assert.equal(request.comments.length, 0);
  assert.equal(request.fileComments.length, 0);
  assert.equal(request.unanchoredFindings.length, 1);
  assert.match(request.body, /### Issues/);
  assert.match(request.body, /Runtime issue outside the diff/);
  assert.match(request.body, /\*\*P3\*\* · Low — Team follow-up requested/);
  assert.match(request.body, /Owner review recommended/);
});

test("buildRuntimeReviewRequest publishes every reviewer-validated severity", () => {
  const highFinding: RuntimeReviewResult["findings"][number] = {
    fingerprint: "high-regression",
    title: "Core request fails",
    risk: "high",
    confidence: "high",
    likelihood: "high",
    category: "correctness",
    file_path: "src/app.ts",
    line_number: 3,
    body: "The changed request path fails.",
    root_cause: "The new branch throws.",
    why_it_matters: "Core requests fail.",
    evidence: ["Probe failed."],
    reproduction_or_trace: "node probe.mjs",
    validation_method: "execution",
    audit_trail: []
  };
  const lowerFinding: RuntimeReviewResult["findings"][number] = {
    ...highFinding,
    fingerprint: "medium-regression",
    title: "Secondary status is stale",
    risk: "medium",
    likelihood: "medium",
    line_number: 4,
    body: "A secondary status is stale after refresh."
  };
  const highIssue = {
    title: highFinding.title,
    body: highFinding.body,
    severity: "P1" as const,
    severityDescription: "High — Should fix",
    sourceFingerprints: [highFinding.fingerprint]
  };
  const lowerIssue = {
    title: lowerFinding.title,
    body: lowerFinding.body,
    severity: "P2" as const,
    severityDescription: "Medium — Consider fixing",
    sourceFingerprints: [lowerFinding.fingerprint]
  };
  const result: RuntimeReviewResult = {
    schemaVersion: 2,
    status: "issues_found",
    summary: "Two validated issues remain.",
    commit: "abc123",
    diffStat: "src/app.ts | 2 ++",
    changedFiles: ["src/app.ts"],
    diffPatch,
    plan: { schemaVersion: 2, areas: [] },
    areas: [],
    findings: [highFinding, lowerFinding],
    readiness: {
      score: 3,
      recommendation: "Merge with caution",
      rationale: "The complete validated issue list includes one lower-severity issue."
    },
    publication: {
      areaSummaries: [],
      issues: [highIssue, lowerIssue],
      dismissedCandidates: []
    },
    markdown: ""
  };

  const request = buildRuntimeReviewRequest({ result, headSha: "abc123" });

  assert.equal(request.publishableFindings.length, 2, "raw dashboard findings remain unchanged");
  assert.equal(request.comments.length, 2);
  assert.match(request.comments[0]?.body ?? "", /Core request fails/);
  assert.match(request.comments[1]?.body ?? "", /Secondary status is stale/);
  assert.doesNotMatch(request.body, /omitted/);
  assert.match(request.body, /### 2 issues found/);
});

test("runtimeReviewMarkers include legacy issue-validation marker for dedupe", () => {
  assert.deepEqual(runtimeReviewMarkers("abc123"), [
    runtimeReviewMarker("abc123"),
    legacyRuntimeReviewMarker("abc123")
  ]);
  assert.deepEqual(runtimeReviewMarkers("abc123", "run-1"), [runtimeReviewMarker("abc123", "run-1")]);
});
