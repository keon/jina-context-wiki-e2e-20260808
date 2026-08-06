import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSupersededStageResult,
  manualReviewScopeTag,
  newerManualReviewDetails,
  supersededDetails,
  supersededStageResult,
  type ReviewSuperseded,
} from "./workflow.js";

test("newer authorized manual comments supersede older commands on the same PR", () => {
  const current = "manual-command:1000:issue_comment:10";
  const newer = "manual-command:2000:pull_request_review_comment:5";
  assert.equal(manualReviewScopeTag(1, 2, 3), "manual-pr:1:2:3");
  assert.deepEqual(newerManualReviewDetails({
    currentCommandTag: current,
    headSha: "abc123",
    runs: [
      { tags: [current], createdAt: "2026-01-01T00:00:01Z" },
      { tags: [newer], createdAt: "2026-01-01T00:00:02Z" },
    ],
  }), {
    reason: "a newer @usejina comment (5) superseded comment 10",
    expected_head_sha: "abc123",
    requested_comment_id: 10,
    newer_comment_id: 5,
  });
});

test("older commands and same-comment redeliveries do not supersede the latest command", () => {
  const current = "manual-command:2000:issue_comment:20";
  const runs = [
    { tags: ["manual-command:1000:issue_comment:10"], createdAt: "2026-01-01T00:00:02Z" },
    { tags: [current], createdAt: "2026-01-01T00:00:01Z" },
    { tags: [current], createdAt: "2026-01-01T00:00:03Z" },
  ];
  assert.equal(newerManualReviewDetails({ currentCommandTag: current, headSha: "abc123", runs }), undefined);
  assert.equal(newerManualReviewDetails({
    currentCommandTag: "manual-command:2000:issue_comment:19",
    headSha: "abc123",
    runs,
  })?.newer_comment_id, 20);
});

test("supersededDetails detects head changes", () => {
  assert.deepEqual(
    supersededDetails({ state: "open", merged: false, head: { sha: "def456789abc" } }, "abc123789abc"),
    {
      reason: "the pull request head changed from abc123789abc to def456789abc",
      expected_head_sha: "abc123789abc",
      current_head_sha: "def456789abc",
      current_state: "open",
      current_merged: false,
    },
  );
});

test("supersededDetails detects merged and closed pull requests", () => {
  assert.deepEqual(
    supersededDetails({ state: "closed", merged: true, head: { sha: "abc123" } }, "abc123"),
    {
      reason: "the pull request was merged",
      expected_head_sha: "abc123",
      current_head_sha: "abc123",
      current_state: "closed",
      current_merged: true,
    },
  );
  assert.deepEqual(
    supersededDetails({ state: "closed", merged: false, head: { sha: "abc123" } }, "abc123"),
    {
      reason: "the pull request is closed",
      expected_head_sha: "abc123",
      current_head_sha: "abc123",
      current_state: "closed",
      current_merged: false,
    },
  );
});

test("isSupersededStageResult distinguishes stale skips from ordinary skips", () => {
  const superseded: ReviewSuperseded = {
    reason: "the pull request was merged",
    expected_head_sha: "abc123",
    current_head_sha: "abc123",
    current_state: "closed",
    current_merged: true,
  };
  const stale = supersededStageResult({
    stage: "runtime",
    startedAt: "2026-01-01T00:00:00.000Z",
    startedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
    superseded,
  });

  assert.equal(isSupersededStageResult(stale), true);
  assert.equal(
    isSupersededStageResult({
      stage: "runtime",
      status: "skipped",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1_000,
      skippedReason: "installation token lacks pull_requests:write",
    }),
    false,
  );
});
