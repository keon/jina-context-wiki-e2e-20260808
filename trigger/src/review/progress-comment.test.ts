import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialReviewProgressState,
  mergeReviewProgressState,
  parseReviewProgressCommentState,
  renderReviewProgressComment,
  reviewProgressCommentMarker,
  reviewProgressUpdateForStageResults,
} from "./progress-comment.js";
import type { ReviewStageName, ReviewStageResult } from "./workflow.js";

test("progress comment renders queued review state separately from findings state", () => {
  const body = renderReviewProgressComment(initialReviewProgressState("run-1", "abc123"));

  assert.match(body, /<!-- jina-simulation:review-summary:abc123:run-1 -->/);
  assert.match(body, /<!-- jina-simulation:review-progress /);
  assert.match(body, /Jina is working on this PR\./);
  assert.match(body, /\| Review \| Queued \|/);
  assert.match(body, /\| Findings \| Pending \|/);
  assert.equal(parseReviewProgressCommentState(body)?.status, "Queued");
  assert.equal(parseReviewProgressCommentState(body)?.findings, "Pending");
});

test("progress comment renders in-progress state", () => {
  const state = mergeReviewProgressState(initialReviewProgressState("run-1", "abc123"), {
    reviewRunId: "run-1",
    headSha: "abc123",
    status: "In progress",
  });

  const body = renderReviewProgressComment(state);
  assert.match(body, /\| Review \| In progress \|/);
  assert.match(body, /\| Findings \| Pending \|/);
});

test("progress comment renders completed state and findings without claiming publishing", () => {
  const previousDashboardUrl = process.env.DASHBOARD_URL;
  process.env.DASHBOARD_URL = "https://dashboard.example.test";
  try {
    const state = mergeReviewProgressState(initialReviewProgressState("run-1", "abc123"), {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Completed",
      findings: "Issues found",
    });

    const body = renderReviewProgressComment(state);
    assert.match(body, /Jina has completed this review\./);
    assert.match(body, /\| Review \| Completed \|/);
    assert.match(body, /\| Findings \| Issues found \|/);
    assert.doesNotMatch(body, /published its findings/);
    assert.match(body, /Review: https:\/\/dashboard\.example\.test\/reviews\/run-1/);
  } finally {
    if (previousDashboardUrl === undefined) {
      delete process.env.DASHBOARD_URL;
    } else {
      process.env.DASHBOARD_URL = previousDashboardUrl;
    }
  }
});

test("progress comment renders skipped and blocked states", () => {
  const skipped = renderReviewProgressComment(
    mergeReviewProgressState(initialReviewProgressState("run-1", "abc123"), {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Skipped",
      findings: "Unavailable",
    }),
  );
  assert.match(skipped, /Jina skipped this review\./);
  assert.match(skipped, /\| Review \| Skipped \|/);
  assert.match(skipped, /\| Findings \| Unavailable \|/);

  const blocked = renderReviewProgressComment(
    mergeReviewProgressState(initialReviewProgressState("run-1", "abc123"), {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Blocked",
      findings: "Unavailable",
    }),
  );
  assert.match(blocked, /Jina was blocked while reviewing this PR\./);
  assert.match(blocked, /\| Review \| Blocked \|/);
});

test("progress comment safely explains a fail-and-notify provider failure", () => {
  const previousDashboardUrl = process.env.DASHBOARD_URL;
  process.env.DASHBOARD_URL = "https://dashboard.example.test";
  try {
    const body = renderReviewProgressComment(
      mergeReviewProgressState(initialReviewProgressState("run-1", "abc123"), {
        reviewRunId: "run-1",
        headSha: "abc123",
        status: "Blocked",
        findings: "Unavailable",
        notice: {
          kind: "provider_failure",
          category: "quota",
          provider: "codex",
          quotaReason: "exhausted",
        },
      }),
    );

    assert.match(body, /Model provider action required/);
    assert.match(body, /Codex has no remaining credits or usage allowance/);
    assert.match(body, /limit to reset/);
    assert.match(body, /Managed fallback is disabled/);
    assert.match(body, /https:\/\/dashboard\.example\.test\/models/);
    assert.doesNotMatch(body, /sk-|Bearer|stack trace|raw provider error/i);
    assert.deepEqual(parseReviewProgressCommentState(body)?.notice, {
      kind: "provider_failure",
      category: "quota",
      provider: "codex",
      quotaReason: "exhausted",
    });
  } finally {
    if (previousDashboardUrl === undefined) {
      delete process.env.DASHBOARD_URL;
    } else {
      process.env.DASHBOARD_URL = previousDashboardUrl;
    }
  }
});

test("final progress reconciliation preserves a provider failure notice", () => {
  const failed = mergeReviewProgressState(initialReviewProgressState("run-1", "abc123"), {
    reviewRunId: "run-1",
    headSha: "abc123",
    status: "Blocked",
    findings: "Unavailable",
    notice: { kind: "provider_failure", category: "authentication", provider: "byok" },
  });
  const finalized = mergeReviewProgressState(
    parseReviewProgressCommentState(renderReviewProgressComment(failed)),
    {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Blocked",
      findings: "Unavailable",
    },
  );

  assert.deepEqual(finalized.notice, {
    kind: "provider_failure",
    category: "authentication",
    provider: "byok",
  });
});

test("legacy provider failure notices remain visible with safe generic copy", () => {
  const legacyBody = [
    reviewProgressCommentMarker("abc123", "run-1"),
    '<!-- jina-simulation:review-progress {"v":1,"reviewRunId":"run-1","headSha":"abc123","status":"Blocked","findings":"Unavailable","notice":{"kind":"provider_failure","category":"quota"}} -->',
    "## Jina Review",
  ].join("\n");

  const parsed = parseReviewProgressCommentState(legacyBody);
  assert.deepEqual(parsed?.notice, {
    kind: "provider_failure",
    category: "quota",
    provider: "unknown",
  });
  assert.match(
    renderReviewProgressComment(parsed!),
    /selected model provider has no available quota, credits, or rate-limit capacity/i,
  );
});

test("progress state parsing and merging preserves existing fields", () => {
  const existing = mergeReviewProgressState(initialReviewProgressState("run-1", "abc123"), {
    reviewRunId: "run-1",
    headSha: "abc123",
    status: "In progress",
  });
  const parsed = parseReviewProgressCommentState(renderReviewProgressComment(existing));
  const merged = mergeReviewProgressState(parsed, {
    reviewRunId: "run-1",
    headSha: "abc123",
    findings: "Issues found",
  });

  assert.equal(merged.status, "In progress");
  assert.equal(merged.findings, "Issues found");
});

test("progress state merging refuses to downgrade terminal review state", () => {
  const existing = mergeReviewProgressState(initialReviewProgressState("run-1", "abc123"), {
    reviewRunId: "run-1",
    headSha: "abc123",
    status: "Completed",
    findings: "Issues found",
  });

  const merged = mergeReviewProgressState(existing, {
    reviewRunId: "run-1",
    headSha: "abc123",
    status: "In progress",
    findings: "Pending",
  });

  assert.equal(merged.status, "Completed");
  assert.equal(merged.findings, "Issues found");
});

test("progress state never carries terminal fields into another review run", () => {
  const existing = mergeReviewProgressState(initialReviewProgressState("run-1", "abc123"), {
    reviewRunId: "run-1",
    headSha: "abc123",
    status: "Completed",
    findings: "Issues found",
  });
  const merged = mergeReviewProgressState(existing, {
    reviewRunId: "run-2",
    headSha: "abc123",
    status: "Queued",
    findings: "Pending",
  });

  assert.deepEqual(merged, initialReviewProgressState("run-2", "abc123"));
});

test("parent final reconciliation maps child results to aggregate review state", () => {
  assert.deepEqual(
    reviewProgressUpdateForStageResults({
      reviewRunId: "run-1",
      headSha: "abc123",
      stageResults: [result("summary", "success"), result("runtime", "success", 1)],
      failed: false,
      superseded: false,
    }),
    {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Completed",
      findings: "Issues found",
    },
  );
});

test("parent final reconciliation reports no issues separately from completed review state", () => {
  assert.deepEqual(
    reviewProgressUpdateForStageResults({
      reviewRunId: "run-1",
      headSha: "abc123",
      stageResults: [result("summary", "success"), result("runtime", "success", 0)],
      failed: false,
      superseded: false,
    }),
    {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Completed",
      findings: "No issues found",
    },
  );
});

test("permission-skipped publish paths can complete review without claiming published findings", () => {
  assert.deepEqual(
    reviewProgressUpdateForStageResults({
      reviewRunId: "run-1",
      headSha: "abc123",
      stageResults: [
        result("summary", "success"),
        skipped("runtime", "installation token lacks pull_requests:write", 2),
      ],
      failed: false,
      superseded: false,
    }),
    {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Completed",
      findings: "Issues found",
    },
  );
});

test("progress findings status is unavailable when the runtime result omits findings", () => {
  assert.deepEqual(
    reviewProgressUpdateForStageResults({
      reviewRunId: "run-1",
      headSha: "abc123",
      stageResults: [result("summary", "success"), result("runtime", "success")],
      failed: false,
      superseded: false,
    }),
    {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Completed",
      findings: "Unavailable",
    },
  );
});

test("progress findings status prefers the canonical persisted findings array", () => {
  assert.equal(
    reviewProgressUpdateForStageResults({
      reviewRunId: "run-1",
      headSha: "abc123",
      stageResults: [
        result("summary", "success"),
        { ...result("runtime", "success", 0), findings: [{
          fingerprint: "fp-1",
          severity: "high",
          category: "correctness",
          body: "Issue",
        }] },
      ],
      failed: false,
      superseded: false,
    }).findings,
    "Issues found",
  );
});

test("blocked and superseded final states mark findings unavailable", () => {
  assert.deepEqual(
    reviewProgressUpdateForStageResults({
      reviewRunId: "run-1",
      headSha: "abc123",
      stageResults: [result("summary", "success"), result("runtime", "failed")],
      failed: true,
      superseded: false,
    }),
    {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Blocked",
      findings: "Unavailable",
    },
  );

  assert.deepEqual(
    reviewProgressUpdateForStageResults({
      reviewRunId: "run-1",
      headSha: "abc123",
      stageResults: [skipped("summary", "the pull request head changed")],
      failed: false,
      superseded: true,
    }),
    {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Skipped",
      findings: "Unavailable",
    },
  );
});

test("invalid child topology is rendered as blocked", () => {
  assert.deepEqual(
    reviewProgressUpdateForStageResults({
      reviewRunId: "run-1",
      headSha: "abc123",
      stageResults: [],
      failed: true,
      superseded: false,
    }),
    {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Blocked",
      findings: "Unavailable",
    },
  );
});

test("completed runtime findings remain visible when the summary was superseded", () => {
  assert.deepEqual(
    reviewProgressUpdateForStageResults({
      reviewRunId: "run-1",
      headSha: "abc123",
      stageResults: [
        skipped("summary", "the pull request head changed"),
        result("runtime", "success", 7),
      ],
      failed: false,
      superseded: false,
    }),
    {
      reviewRunId: "run-1",
      headSha: "abc123",
      status: "Completed",
      findings: "Issues found",
    },
  );
});

test("summary marker isolates independent reviews on the same head", () => {
  assert.notEqual(
    reviewProgressCommentMarker("abc123", "run-1"),
    reviewProgressCommentMarker("abc123", "run-2"),
  );
});

function result(
  stage: ReviewStageName,
  status: ReviewStageResult["status"],
  findingsCount?: number,
): ReviewStageResult {
  return {
    stage,
    status,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
    findings: findingsCount === undefined
      ? undefined
      : Array.from({ length: findingsCount }, (_, index) => ({
          fingerprint: `fp-${index + 1}`,
          severity: "medium",
          category: "correctness",
          body: `Issue ${index + 1}`,
        })),
  };
}

function skipped(stage: ReviewStageName, skippedReason: string, findingsCount?: number): ReviewStageResult {
  return {
    ...result(stage, "skipped", findingsCount),
    skippedReason,
  };
}
