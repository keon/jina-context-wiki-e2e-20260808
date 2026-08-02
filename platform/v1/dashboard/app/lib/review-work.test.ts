import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReviewWork, hasScenarioReviewWork } from "./review-work";
import type { ReviewEvent, ReviewRun } from "./types";

test("structured static and runtime payloads produce review work details", () => {
  const run = reviewRun({
    events: [
      event("static_review_completed", {
        static_review: {
          status: "issues_found",
          summary: "Static review found an auth issue.",
          commit: "abc123",
          changedFiles: ["src/auth.ts"],
          diffStat: "src/auth.ts | 2 +-",
          findingsCount: 1,
          publishableFindingsCount: 1,
          inlineCommentCount: 1,
          fileCommentCount: 2,
          unanchoredFindingsCount: 0,
          findings: [
            {
              fingerprint: "static-auth",
              file_path: "src/auth.ts",
              line_number: 12,
              risk: "high",
              confidence: "high",
              likelihood: "medium",
              category: "auth",
              title: "Missing ownership check",
              body: "The changed branch accepts any signed-in user.",
              root_cause: "The owner id comparison was removed.",
              why_it_matters: "Users can see another account.",
              reproduction_or_trace: "Trace canAccess with mismatched owner ids.",
              suggested_fix: "Restore the owner id check.",
              suggested_change: "return user.id === ownerId;",
              evidence_files: ["src/auth.ts"],
            },
          ],
        },
      }),
      event("github_static_review_published", { github_review_url: "https://github.test/static" }),
      event("runtime_review_completed", {
        runtime_review: {
          status: "issues_found",
          summary: "Runtime review reproduced invalid JSON failures.",
          commit: "abc123",
          changedFiles: ["src/handler.ts"],
          diffStat: "src/handler.ts | 4 +++-",
          findingsCount: 1,
          publishableFindingsCount: 0,
          inlineCommentCount: 0,
          fileCommentCount: 2,
          unanchoredFindingsCount: 0,
          areasCount: 1,
          tasksCount: 1,
          blockedCount: 0,
          nonIssuesCount: 1,
          areas: [
            {
              areaId: "request-json",
              title: "Request JSON parsing",
              status: "completed",
              summary: "A focused probe showed parse errors escape.",
              tasks: [
                {
                  id: "probe-invalid-json",
                  title: "Probe invalid JSON",
                  purpose: "Validate malformed request behavior.",
                  method: "execution",
                  actionsTaken: ["Generated a focused route probe.", "Ran pnpm exec tsx probe.ts."],
                  whatWasLearned: "Malformed JSON throws before a response is created.",
                  verdict: "issue_found",
                  confidence: "high",
                  auditTrail: [
                    { type: "command", detail: "pnpm exec tsx probe.ts", evidence: ["exitCode=1"] },
                  ],
                },
              ],
              issues: [],
              nonIssues: [{ hypothesis: "Valid JSON still works", whyDismissed: "Probe returned 200.", evidence: ["exitCode=0"] }],
              blocked: [],
            },
          ],
          findings: [
            {
              fingerprint: "runtime-json",
              file_path: "src/handler.ts",
              line_number: 8,
              risk: "medium",
              confidence: "low",
              likelihood: "high",
              category: "correctness",
              title: "Invalid JSON escapes as a 500",
              body: "The handler awaits req.json() without catching parse failures.",
              root_cause: "Parsing moved before validation.",
              why_it_matters: "Malformed requests bypass API error handling.",
              reproduction_or_trace: "pnpm exec tsx probe.ts",
              suggested_fix: "Catch SyntaxError and return 400.",
              evidence: ["Focused probe exited before response creation."],
              validation_method: "execution",
              audit_trail: ["Generated probe.", "Ran probe."],
            },
          ],
        },
      }),
    ],
  });

  const work = buildReviewWork(run);

  assert.equal(work.changeSummary.changedFiles.length, 1);
  assert.equal(work.staticReview?.detailsAvailable, true);
  assert.equal(work.staticReview?.findings[0]?.rootCause, "The owner id comparison was removed.");
  assert.equal(work.staticReview?.githubReviewUrl, "https://github.test/static");
  assert.equal(work.runtimeReview?.tasksCount, 1);
  assert.equal(work.runtimeReview?.fileCommentCount, 2);
  assert.equal(work.runtimeReview?.tasks[0]?.auditTrail[0]?.detail, "pnpm exec tsx probe.ts");
  assert.equal(work.runtimeReview?.nonIssuesCount, 1);
  // No stage filters findings any more: a payload without an explicit
  // publishAcceptedLowConfidence flag is a new-shape run, and everything publishes.
  assert.equal(work.runtimeReview?.findings[0]?.heldBack, false);
  assert.equal(work.staticReview?.findings[0]?.likelihood, "medium");
  assert.equal(work.runtimeReview?.findings[0]?.likelihood, "high");
  assert.equal(work.findings.length, 2);
  assert.equal(work.findings.some((finding) => finding.suggestedCodeChange === "return user.id === ownerId;"), true);
});

test("legacy count-only payloads render summaries without details", () => {
  const run = reviewRun({
    events: [
      event("static_review_completed", {
        status: "passed",
        summary: "No static issues.",
        findings_count: 0,
        publishable_findings_count: 0,
        inline_comment_count: 0,
        unanchored_findings_count: 0,
        changed_files: ["src/app.ts"],
        diff_stat: "src/app.ts | 1 +",
      }),
      event("runtime_review_completed", {
        status: "warned",
        summary: "Runtime review completed with warnings.",
        findings_count: 0,
        publishable_findings_count: 0,
        file_comment_count: 2,
        areas_count: 2,
        tasks_count: 3,
        blocked_count: 1,
      }),
    ],
  });

  const work = buildReviewWork(run);

  assert.equal(work.staticReview?.detailsAvailable, false);
  assert.equal(work.staticReview?.findingsCount, 0);
  assert.equal(work.runtimeReview?.detailsAvailable, false);
  assert.equal(work.runtimeReview?.areasCount, 2);
  assert.equal(work.runtimeReview?.tasksCount, 3);
  assert.equal(work.runtimeReview?.fileCommentCount, 2);
  assert.equal(work.findings.length, 0);
});

test("schema v2 runtime payloads expose intent, investigations, blocked work, non-issues, and final accepted issues", () => {
  const run = reviewRun({
    events: [
      event("runtime_review_completed", {
        runtime_review: {
          schemaVersion: 2,
          status: "issues_found",
          summary: "Runtime review found invalid JSON failures.",
          context: {
            commit: "abc123",
            changedFiles: ["src/app.ts"],
            diffStat: "src/app.ts | 2 +-",
          },
          intent: {
            markdown: "The PR intends to parse request JSON while preserving controlled error handling.",
            metadata: { ambiguous: false },
          },
          plan: {
            schemaVersion: 2,
            areas: [
              {
                id: "request-json",
                title: "Request JSON parsing",
                expectations: ["Malformed JSON returns 400."],
                potentialFailureModes: ["Malformed JSON throws before response construction."],
              },
            ],
          },
          investigations: [
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
                  whyChosen: "This is the area’s highest-signal failure mode.",
                  method: "mental_trace",
                  actionsTaken: ["Requested mental_trace."],
                  whatWasLearned: "Parsing can reject.",
                  verdict: "issue_found",
                  confidence: "high",
                  auditTrail: [{ type: "mental_trace", detail: "invalid-json", evidence: ["contradicts_expected"] }],
                },
              ],
              issues: [],
              blocked: [{ task: "Run browser flow", reason: "No frontend app", fallbackUsed: "source trace" }],
              nonIssues: [{ hypothesis: "Valid JSON path", whyDismissed: "Unchanged", evidence: ["Trace supports expected behavior"] }],
            },
          ],
          finalReview: {
            summary: "Accepted the malformed JSON candidate.",
            readiness: { score: 2, rationale: "A real runtime issue remains." },
            publishAcceptedLowConfidence: true,
            acceptedIssues: [
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
                evidence: ["mental_trace contradicted expected behavior"],
                reproduction_or_trace: "mental_trace invalid-json",
                validation_method: "mental_trace",
                audit_trail: ["Requested trace."],
              },
            ],
          },
        },
      }),
    ],
  });

  const work = buildReviewWork(run);

  assert.equal(work.runtimeReview?.detailsAvailable, true);
  assert.equal(work.runtimeReview?.commit, "abc123");
  assert.deepEqual(work.runtimeReview?.changedFiles, ["src/app.ts"]);
  assert.equal(work.runtimeReview?.intentMarkdown?.includes("parse request JSON"), true);
  assert.equal(work.runtimeReview?.readinessScore, 2);
  assert.equal(work.runtimeReview?.finalReviewSummary, "Accepted the malformed JSON candidate.");
  assert.equal(work.runtimeReview?.publishAcceptedLowConfidence, true);
  assert.equal(work.runtimeReview?.areasCount, 1);
  assert.equal(work.runtimeReview?.tasksCount, 1);
  assert.equal(work.runtimeReview?.blockedCount, 1);
  assert.equal(work.runtimeReview?.nonIssuesCount, 1);
  assert.equal(work.runtimeReview?.tasks[0]?.goal, "Trace malformed JSON through the handler.");
  assert.equal(work.runtimeReview?.tasks[0]?.whyChosen, "This is the area’s highest-signal failure mode.");
  assert.equal(work.runtimeReview?.findings[0]?.fingerprint, "runtime-json");
  assert.equal(work.runtimeReview?.findings[0]?.likelihood, "medium");
  assert.equal(work.runtimeReview?.findings[0]?.heldBack, false);
  assert.equal(work.findings.length, 1);
});

test("publish skipped and failed states surface as notices", () => {
  const run = reviewRun({
    events: [
      event("static_review_completed", { status: "passed", findings_count: 0 }),
      event("github_static_review_publish_skipped", { reason: "installation token lacks pull_requests:write" }),
      event("runtime_review_completed", { status: "passed", findings_count: 0 }),
      event("github_runtime_review_publish_failed", { error: "GitHub API rejected the review" }),
    ],
  });

  const work = buildReviewWork(run);

  assert.equal(work.staticReview?.publishState, "skipped");
  assert.equal(work.runtimeReview?.publishState, "failed");
  assert.equal(work.notices.some((notice) => notice.message === "installation token lacks pull_requests:write"), true);
  assert.equal(work.notices.some((notice) => notice.message === "GitHub API rejected the review"), true);
});

test("runtime file comment dedupe failures surface as warning notices", () => {
  const run = reviewRun({
    events: [
      event("runtime_review_completed", { status: "issues_found", findings_count: 1, file_comment_count: 1 }),
      event("github_runtime_file_comment_dedupe_unavailable", {
        error: "GitHub comment listing failed",
        skipped_file_comment_count: 1,
      }),
      event("github_runtime_review_published", {
        file_comment_count: 0,
        planned_file_comment_count: 1,
        skipped_file_comment_count: 1,
      }),
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

test("paused static/runtime-only runs have no scenario history", () => {
  const run = reviewRun({
    result: {
      run_plan: { mode: "qa", stages: { generate: false, simulate: false, finalReview: false } },
      review_markdown: "",
      findings: [],
    },
    events: [event("static_review_completed", { status: "passed", findings_count: 0 })],
  });

  assert.equal(hasScenarioReviewWork(run), false);
  assert.equal(buildReviewWork(run).hasScenarioHistory, false);
});

test("historical scenario runs still expose scenario history", () => {
  const run = reviewRun({
    result: {
      scenario_json: {
        scenarios: [
          {
            id: "sc-auth",
            title: "Authorization scenario",
            riskLevel: "high",
            steps: ["Open an account that is not owned by the user."],
            expectedOutcome: ["Access is denied."],
            rationale: "Changed auth branch.",
          },
        ],
      },
      final_review: {
        status: "passed",
        summary: "No issues.",
        markdown: "## Final Review",
        findings: [],
      },
    },
  });

  assert.equal(hasScenarioReviewWork(run), true);
  assert.equal(buildReviewWork(run).hasScenarioHistory, true);
});

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
