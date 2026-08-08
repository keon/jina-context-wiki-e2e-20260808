import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReviewWork } from "./review-work";
import type { ReviewEvent, ReviewRun } from "./types";

test("the current runtime payload exposes review work and publication details", () => {
  const run = reviewRun({
    events: [
      event("runtime_review_completed", {
        head_sha: "abc123",
        changed_files: ["src/app.ts"],
        diff_stat: "src/app.ts | 2 +-",
        runtime_review: {
          schemaVersion: 2,
          status: "issues_found",
          summary: "Runtime review found invalid JSON failures.",
          commit: "abc123",
          changedFiles: ["src/app.ts"],
          diffStat: "src/app.ts | 2 +-",
          plan: {
            schemaVersion: 2,
            intentSummary: "Parse request JSON while preserving controlled error handling.",
            areas: [],
          },
          readiness: { score: 2, rationale: "A runtime issue remains." },
          areas: [
            {
              areaId: "request-json",
              title: "Request JSON parsing",
              status: "completed",
              summary: "Traced malformed JSON.",
              tasks: [
                {
                  id: "trace-json",
                  title: "Trace malformed JSON",
                  goal: "Trace malformed JSON through the handler.",
                  hypothesis: "Parsing rejects before response construction.",
                  whyChosen: "This is the highest-signal failure mode.",
                  purpose: "Validate malformed request behavior.",
                  method: "source_trace",
                  actionsTaken: ["Traced the request parsing path."],
                  whatWasLearned: "Parsing can reject.",
                  verdict: "issue_found",
                  confidence: "high",
                  auditTrail: [{ type: "reasoning", detail: "invalid-json", evidence: ["contradicts_expected"] }],
                },
              ],
              issues: [],
              nonIssues: [{ hypothesis: "Valid JSON path", whyDismissed: "Unchanged", evidence: ["Trace supports expected behavior"] }],
            },
          ],
          findings: [
            {
              fingerprint: "runtime-json",
              title: "Invalid JSON escapes as a 500",
              risk: "medium",
              confidence: "low",
              likelihood: "medium",
              category: "correctness",
              file_path: "src/app.ts",
              line_number: 2,
              body: "The handler awaits req.json() without catching parse failures.",
              root_cause: "Parsing is unguarded.",
              why_it_matters: "Malformed requests bypass API error handling.",
              evidence: ["Source trace contradicted expected behavior"],
              reproduction_or_trace: "Source trace invalid-json",
              validation_method: "source_trace",
              audit_trail: ["Traced the request parsing path."],
            },
          ],
          areasCount: 1,
          tasksCount: 1,
          findingsCount: 1,
          publishableFindingsCount: 1,
          inlineCommentCount: 1,
          fileCommentCount: 0,
          unanchoredFindingsCount: 0,
          lowConfidenceFindingsHeldBack: 0,
          nonIssuesCount: 1,
        },
      }),
      event("github_runtime_review_published", { github_review_url: "https://github.test/runtime" }),
    ],
  });

  const work = buildReviewWork(run);

  assert.deepEqual(work.changeSummary.changedFiles, ["src/app.ts"]);
  assert.equal(work.runtimeReview?.githubReviewUrl, "https://github.test/runtime");
  assert.equal(work.runtimeReview?.intentMarkdown?.includes("Parse request JSON"), true);
  assert.equal(work.runtimeReview?.readinessScore, 2);
  assert.equal(work.runtimeReview?.tasks[0]?.goal, "Trace malformed JSON through the handler.");
  assert.equal(work.runtimeReview?.tasks[0]?.auditTrail[0]?.detail, "invalid-json");
  assert.equal(work.runtimeReview?.nonIssuesCount, 1);
  assert.equal(work.runtimeReview?.findings[0]?.fingerprint, "runtime-json");
  assert.equal(work.runtimeReview?.findings[0]?.heldBack, false);
  assert.equal(work.findings.length, 1);
});

test("a runtime publication failure surfaces as a notice", () => {
  const run = reviewRun({
    events: [
      event("runtime_review_completed", {
        runtime_review: currentEmptyReview(),
      }),
      event("github_runtime_review_publish_failed", { error: "GitHub API rejected the review" }),
    ],
  });

  const work = buildReviewWork(run);

  assert.equal(work.runtimeReview?.publishState, "failed");
  assert.equal(work.notices.some((notice) => notice.message === "GitHub API rejected the review"), true);
});

test("runtime file-comment dedupe failures surface as warning notices", () => {
  const run = reviewRun({
    events: [
      event("runtime_review_completed", { runtime_review: currentEmptyReview() }),
      event("github_runtime_file_comment_dedupe_unavailable", { error: "GitHub comment listing failed" }),
      event("github_runtime_review_published", { github_review_url: "https://github.test/runtime" }),
    ],
  });

  const work = buildReviewWork(run);

  assert.equal(work.runtimeReview?.publishState, "published");
  assert.equal(
    work.notices.some((notice) =>
      notice.status === "github_runtime_file_comment_dedupe_unavailable" &&
      notice.tone === "warn" &&
      notice.message === "GitHub comment listing failed"
    ),
    true,
  );
});

function currentEmptyReview(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    status: "passed",
    summary: "No issues found.",
    commit: "abc123",
    changedFiles: [],
    diffStat: "",
    plan: { schemaVersion: 2, intentSummary: "Review the change.", areas: [] },
    areas: [],
    findings: [],
    areasCount: 0,
    tasksCount: 0,
    findingsCount: 0,
    publishableFindingsCount: 0,
    inlineCommentCount: 0,
    fileCommentCount: 0,
    unanchoredFindingsCount: 0,
    lowConfidenceFindingsHeldBack: 0,
    nonIssuesCount: 0,
  };
}

function reviewRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    review_run_id: "run-1",
    status: "completed",
    bot: { type: "trigger", status: "completed" },
    repository: { full_name: "acme/widgets", owner: "acme", name: "widgets" },
    pull_request: {
      number: 42,
      title: "Tighten request handling",
      html_url: "https://github.test/acme/widgets/pull/42",
      head_sha: "abc123",
      head_ref: "feature",
      base_ref: "main",
    },
    events: [],
    created_at: "2026-06-22T01:00:00.000Z",
    updated_at: "2026-06-22T01:05:00.000Z",
    ...overrides,
  };
}

function event(status: string, payload: Record<string, unknown>, recordedAt = "2026-06-22T01:00:00.000Z"): ReviewEvent {
  return { status, payload, recorded_at: recordedAt };
}
