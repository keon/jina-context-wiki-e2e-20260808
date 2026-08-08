import assert from "node:assert/strict";
import { test } from "node:test";

import type { RuntimeReviewResult } from "../runtime-review/index.js";
import { runtimeReviewArtifactLogSummary, runtimeReviewLogSummary, summarizeFindingsForLog } from "./log.js";

type TestFinding = {
  fingerprint: string;
  file_path: string;
  line_number: number;
  risk: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  likelihood: "high" | "medium" | "low";
  category: string;
  title: string;
  body: string;
  root_cause: string;
  suggested_fix: string;
  evidence_files: string[];
  token?: string;
};

function finding(index: number): TestFinding {
  return {
    fingerprint: `finding-${index}`,
    file_path: `src/file-${index}.ts`,
    line_number: index,
    risk: "high",
    confidence: index % 2 === 0 ? "low" : "high",
    likelihood: "high",
    category: "correctness",
    title: `Finding ${index}`,
    body: "x".repeat(500),
    root_cause: "root cause ".repeat(50),
    suggested_fix: "fix ".repeat(80),
    evidence_files: [`src/file-${index}.ts`],
    token: "secret-token-value"
  };
}

test("summarizeFindingsForLog caps findings, truncates previews, and omits arbitrary fields", () => {
  const findings = Array.from({ length: 21 }, (_, index) => finding(index + 1));
  const summary = summarizeFindingsForLog(findings, {
    publishableFindings: [findings[0]],
    unanchoredFindings: [findings[1]],
    lowConfidenceFindings: [findings[1]]
  });

  assert.equal(summary.total_count, 21);
  assert.equal(summary.omitted_count, 1);
  assert.equal(summary.findings.length, 20);
  assert.equal(summary.findings[0].fingerprint, "finding-1");
  assert.equal(summary.findings[0].publishable, true);
  assert.equal(summary.findings[0].likelihood, "high");
  assert.equal(summary.findings[1].unanchored, true);
  assert.equal(summary.findings[1].low_confidence_held_back, true);
  assert.equal(typeof summary.findings[0].body_preview, "string");
  assert.ok((summary.findings[0].body_preview as string).length <= 240);
  assert.equal("token" in summary.findings[0], false);
  assert.equal("evidence_files" in summary.findings[0], false);
});

test("runtime review logs expose config, merge readiness, severities, and bounded artifacts", () => {
  const result = {
    schemaVersion: 2,
    status: "issues_found",
    summary: "One issue found.",
    commit: "abc123",
    changedFiles: ["src/app.ts", ".jina/config.json"],
    plan: {
      schemaVersion: 2,
      areas: [{ id: "area-1", title: "API", priority: "high", round: 1 }],
      scopeDecision: "investigate",
      intentSummary: "Change the API."
    },
    areas: [
      {
        areaId: "area-1",
        title: "API",
        status: "completed",
        summary: "Exercised the changed route.",
        tasks: [{ id: "task-1" }],
        issues: [{}],
        nonIssues: [],
        blocked: [],
      }
    ],
    findings: [],
    readiness: { score: 3, recommendation: "Merge after fixes", rationale: "One P1 remains." },
    publication: {
      areaSummaries: [{ areaId: "area-1", title: "API", summary: "Checked the API." }],
      issues: [
        {
          title: "Route returns the wrong status",
          body: "The new error path returns 200.",
          severity: "P1",
          severityDescription: "Should fix before merging",
          sourceFingerprints: ["finding-1"]
        }
      ]
    },
    jinaConfiguration: {
      appliedConfig: { depth: 2 },
      configSource: "defaults",
      configFilePresent: false,
      instructionSources: [".jina/instruction.md"],
      instructionSteps: ["planner", "replanner", "investigation", "review"],
      warnings: [],
      proposedConfigChange: {
        changedInPullRequest: true,
        changeKind: "added",
        changedKeys: ["depth"],
        proposedConfig: { depth: 4, source: ".jina/config.json" },
        proposedWarnings: [],
        appliesToCurrentReview: false
      }
    },
    model_call_summary: {
      attempted: 4,
      succeeded: 4,
      contextGraphStagesExpected: 4,
      contextGraphStagesObserved: 4,
      contextGraphQueriesAttempted: 5,
      contextGraphQueriesSucceeded: 4,
      contextGraphQueriesFailed: 1
    }
  } as unknown as RuntimeReviewResult;

  const summary = runtimeReviewLogSummary(result);
  assert.equal(summary.merge_score, 3);
  assert.deepEqual(summary.publication_issue_severity_counts, { P1: 1 });
  assert.equal(summary.jina_config_source, "defaults");
  assert.equal(summary.jina_config_changed_in_pr, true);
  assert.deepEqual(summary.jina_config_changed_keys, ["depth"]);
  assert.equal(summary.jina_proposed_config_applied_to_current_review, false);
  assert.equal(summary.context_graph_stages_expected, 4);
  assert.equal(summary.context_graph_stages_observed, 4);
  assert.equal(summary.context_graph_queries_attempted, 5);
  assert.equal(summary.context_graph_queries_succeeded, 4);
  assert.equal(summary.context_graph_queries_failed, 1);

  const artifacts = runtimeReviewArtifactLogSummary(result);
  const summarizer = artifacts.summarizer as Record<string, unknown>;
  assert.equal(summarizer.completed, true);
  assert.equal(summarizer.merge_score, 3);
  assert.deepEqual(summarizer.issue_severity_counts, { P1: 1 });
});
