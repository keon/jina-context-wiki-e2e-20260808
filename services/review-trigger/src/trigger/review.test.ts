import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failedCompletionUsageRecordsFallback,
  failedReviewCompletionRunId,
  insufficientCreditsReviewRunId,
  isInsufficientCreditsError,
  normalizeChildResult,
  reviewCompletionForStageResults,
  reviewFindingsForCompletion,
  usageRecordsFallbackForCompletion,
} from "./review.js";
import { InternalApiError } from "../shared/api.js";
import type { ReviewStageName, ReviewStageResult, ReviewSuperseded } from "../review/workflow.js";

test("failed review completion is not persisted after computed completion already succeeded", () => {
  assert.equal(
    failedReviewCompletionRunId({
      reviewRunId: "run-1",
      finalAttempt: true,
      reviewCompletionPersisted: true,
    }),
    undefined,
  );
});

test("failed review completion is persisted only for final failed attempts before completion", () => {
  assert.equal(
    failedReviewCompletionRunId({
      reviewRunId: "run-1",
      finalAttempt: true,
      reviewCompletionPersisted: false,
    }),
    "run-1",
  );
  assert.equal(
    failedReviewCompletionRunId({
      reviewRunId: "run-1",
      finalAttempt: false,
      reviewCompletionPersisted: false,
    }),
    undefined,
  );
  assert.equal(
    failedReviewCompletionRunId({
      reviewRunId: undefined,
      finalAttempt: true,
      reviewCompletionPersisted: false,
    }),
    undefined,
  );
});

test("consolidated review completion preserves legacy superseded terminal status", () => {
  const superseded: ReviewSuperseded = {
    reason: "the pull request head changed from abc123 to def456",
    expected_head_sha: "abc123",
    current_head_sha: "def456",
    current_state: "open",
    current_merged: false,
  };

  assert.deepEqual(
    reviewCompletionForStageResults([
      skipped("summary", superseded),
      skipped("runtime", superseded),
    ]),
    { status: "completed_superseded", superseded },
  );
});

test("consolidated review completion treats merged and closed skips as superseded", () => {
  const merged: ReviewSuperseded = {
    reason: "the pull request was merged",
    expected_head_sha: "abc123",
    current_head_sha: "abc123",
    current_state: "closed",
    current_merged: true,
  };
  const closed: ReviewSuperseded = {
    reason: "the pull request is closed",
    expected_head_sha: "abc123",
    current_head_sha: "abc123",
    current_state: "closed",
    current_merged: false,
  };

  assert.equal(
    reviewCompletionForStageResults([
      skipped("summary", merged),
      skipped("runtime", merged),
    ]).status,
    "completed_superseded",
  );
  assert.equal(
    reviewCompletionForStageResults([
      skipped("summary", closed),
      skipped("runtime", closed),
    ]).status,
    "completed_superseded",
  );
});

test("consolidated review completion keeps non-stale skips completed", () => {
  assert.equal(
    reviewCompletionForStageResults([
      skipped("summary", undefined, "installation token lacks pull_requests:write"),
      success("runtime"),
    ]).status,
    "completed",
  );
});

test("consolidated review completion treats mixed success and superseded as superseded", () => {
  const superseded: ReviewSuperseded = {
    reason: "the pull request head changed from abc123 to def456",
    expected_head_sha: "abc123",
    current_head_sha: "def456",
    current_state: "open",
    current_merged: false,
  };

  assert.deepEqual(
    reviewCompletionForStageResults([
      success("summary"),
      skipped("runtime", superseded),
    ]),
    { status: "completed_superseded", superseded },
  );
});

test("consolidated review completion preserves a successful runtime review when summary is superseded", () => {
  const superseded: ReviewSuperseded = {
    reason: "the pull request head changed from abc123 to def456",
    expected_head_sha: "abc123",
    current_head_sha: "def456",
    current_state: "open",
    current_merged: false,
  };

  assert.deepEqual(
    reviewCompletionForStageResults([
      skipped("summary", superseded),
      success("runtime"),
    ]),
    { status: "completed" },
  );
});

test("consolidated review completion gives failures precedence over superseded skips", () => {
  const superseded: ReviewSuperseded = {
    reason: "the pull request head changed from abc123 to def456",
    expected_head_sha: "abc123",
    current_head_sha: "def456",
    current_state: "open",
    current_merged: false,
  };

  assert.deepEqual(
    reviewCompletionForStageResults([
      skipped("summary", superseded),
      failed("runtime", "runtime broke"),
    ]),
    { status: "failed", error: "runtime: runtime broke" },
  );
});

test("consolidated review completion rejects incomplete or duplicate child results", () => {
  for (const stageResults of [
    [],
    [success("summary")],
    [success("summary"), success("summary")],
    [success("summary"), success("runtime"), success("runtime")],
  ]) {
    const completion = reviewCompletionForStageResults(stageResults);
    assert.equal(completion.status, "failed");
    assert.match(completion.error ?? "", /expected one summary and one runtime/);
  }
});

test("review completion carries runtime findings as a persistence backstop", () => {
  assert.deepEqual(
    reviewFindingsForCompletion([
      success("summary"),
      {
        ...success("runtime"),
        findings: [
          {
            fingerprint: "fp-1",
            file_path: "src/app.ts",
            line_number: 10,
            severity: "high",
            category: "correctness",
            body: "Runtime finding",
          },
        ],
      },
    ]),
    [
      {
        fingerprint: "fp-1",
        file_path: "src/app.ts",
        line_number: 10,
        severity: "high",
        category: "correctness",
        body: "Runtime finding",
      },
    ],
  );
});

test("completion collects usage-record fallbacks from stages that carry them", () => {
  const fallback = {
    stage: "runtime" as const,
    sandbox_id: "sandbox-1",
    key_source: "managed" as const,
    usage_records: [{ operation: "planner", request_seq: 1 }],
  };

  assert.deepEqual(
    usageRecordsFallbackForCompletion([
      success("summary"),
      { ...success("runtime"), usage_records_fallback: fallback },
    ]),
    [fallback],
  );
});

test("completion carries no usage fallback when every stage delivered its usage", () => {
  assert.deepEqual(
    usageRecordsFallbackForCompletion([success("summary"), success("runtime")]),
    [],
  );
});

test("failure completion carries the collected usage fallback so a failed /complete does not drop it", () => {
  const fallback = {
    stage: "runtime" as const,
    sandbox_id: "sandbox-1",
    key_source: "managed" as const,
    usage_records: [{ operation: "planner", request_seq: 1 }],
  };

  assert.deepEqual(
    failedCompletionUsageRecordsFallback([
      success("summary"),
      { ...success("runtime"), usage_records_fallback: fallback },
    ]),
    [fallback],
  );
});

test("failure completion omits the usage fallback when no stage results were collected", () => {
  assert.equal(failedCompletionUsageRecordsFallback(undefined), undefined);
});

test("failure completion omits the usage fallback when collected stages carry none", () => {
  assert.equal(
    failedCompletionUsageRecordsFallback([success("summary"), failed("runtime", "runtime broke")]),
    undefined,
  );
});

test("prepare-time 402 classifies as insufficient credits; other statuses do not", () => {
  assert.equal(isInsufficientCreditsError(new InternalApiError("/internal/reviews/prepare", 402, "blocked")), true);
  assert.equal(isInsufficientCreditsError(new InternalApiError("/internal/reviews/prepare", 500, "boom")), false);
  assert.equal(isInsufficientCreditsError(new Error("network down")), false);
});

test("prepare-time 402 exposes the created review run id from response details", () => {
  const error = new InternalApiError(
    "/internal/reviews/prepare",
    402,
    "blocked",
    { error: "insufficient credits", details: { review_run_id: "run-1" } },
  );

  assert.equal(insufficientCreditsReviewRunId(error), "run-1");
  assert.equal(
    insufficientCreditsReviewRunId(new InternalApiError("/internal/reviews/prepare", 402, "blocked", {})),
    undefined,
  );
});

test("unknown child run identifiers fall back to the expected child stage", () => {
  assert.equal(
    normalizeChildResult(
      {
        ok: false,
        taskIdentifier: undefined,
        error: new Error("runtime failed before metadata"),
      },
      "runtime",
    ).stage,
    "runtime",
  );
});

test("child outputs must match both their task and expected stage", () => {
  assert.equal(
    normalizeChildResult(
      { ok: true, taskIdentifier: "review-summary", output: success("runtime") },
      "summary",
    ).status,
    "failed",
  );
  assert.equal(
    normalizeChildResult(
      { ok: true, taskIdentifier: "review-runtime", output: success("runtime") },
      "summary",
    ).status,
    "failed",
  );
  assert.equal(normalizeChildResult({ ok: true, output: success("runtime") }, "runtime").status, "failed");
  assert.equal(
    normalizeChildResult({ ok: true, taskIdentifier: "unknown", output: success("runtime") }, "runtime").status,
    "failed",
  );
});

test("child outputs are runtime-validated before aggregation", () => {
  assert.equal(
    normalizeChildResult(
      {
        ok: true,
        taskIdentifier: "review-runtime",
        output: { ...success("runtime"), status: "garbage" },
      },
      "runtime",
    ).status,
    "failed",
  );
  assert.equal(
    normalizeChildResult(
      {
        ok: true,
        taskIdentifier: "review-runtime",
        output: { ...success("runtime"), findings: ["not-a-finding"] },
      },
      "runtime",
    ).status,
    "failed",
  );
  assert.equal(
    normalizeChildResult(
      {
        ok: true,
        taskIdentifier: "review-runtime",
        output: {
          ...success("runtime"),
          usage_records_fallback: { stage: "summary", sandbox_id: 42, key_source: "admin", usage_records: "bad" },
        },
      },
      "runtime",
    ).status,
    "failed",
  );
  const finding = {
    fingerprint: "fp-1",
    severity: "high",
    category: "correctness",
    body: "A real issue",
  };
  for (const output of [
    { ...success("runtime"), superseded: { reason: "stale", expected_head_sha: "abc" } },
    { ...success("runtime"), status: "skipped" },
    { ...success("runtime"), status: "failed" },
    { ...success("runtime"), findings: [{ ...finding, body: " " }] },
  ]) {
    assert.equal(
      normalizeChildResult({ ok: true, taskIdentifier: "review-runtime", output }, "runtime").status,
      "failed",
    );
  }
});

test("legacy count metadata cannot invalidate canonical child findings", () => {
  const findings = [
    { fingerprint: "fp-1", severity: "high", category: "correctness", body: "First issue" },
    { fingerprint: "fp-2", severity: "medium", category: "correctness", body: "Duplicate issue" },
  ];
  const output = {
    ...success("runtime"),
    findings,
    findingsCount: 2,
    publishableFindingsCount: 2,
    inlineCommentCount: 1,
    fileCommentCount: 0,
    unanchoredFindingsCount: 0,
  };

  const normalized = normalizeChildResult(
    { ok: true, taskIdentifier: "review-runtime", output },
    "runtime",
  );

  assert.equal(normalized.status, "success");
  assert.deepEqual(normalized.findings, findings);
});

function success(stage: ReviewStageName): ReviewStageResult {
  return {
    stage,
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
  };
}

function skipped(
  stage: ReviewStageName,
  superseded?: ReviewSuperseded,
  skippedReason = superseded?.reason ?? "skipped",
): ReviewStageResult {
  return {
    stage,
    status: "skipped",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
    skippedReason,
    superseded,
  };
}

function failed(stage: ReviewStageName, error: string): ReviewStageResult {
  return {
    stage,
    status: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
    error,
  };
}
