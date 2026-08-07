import assert from "node:assert/strict";
import { test } from "node:test";

import { completedContextStageCount, newestContextBuild } from "./context-builds.ts";
import type { ContextBuildSummary } from "./types.ts";

function build(
  id: string,
  status: ContextBuildSummary["status"],
  updatedAt: string,
  refSequence: number
): ContextBuildSummary {
  return {
    id,
    repository: "omxyz/jina-context-graph-e2e",
    ref: "main",
    refSequence,
    status,
    stages: [],
    createdAt: updatedAt,
    updatedAt
  };
}

test("newest context build does not let an older failure hide a completed build", () => {
  const failed = build("task_old_failed", "failed", "2026-08-02T05:00:00.000Z", 1);
  const completed = build("task_new_completed", "completed", "2026-08-03T05:00:00.000Z", 2);

  assert.equal(newestContextBuild([failed, completed])?.id, completed.id);
  assert.equal(newestContextBuild([completed, failed])?.id, completed.id);
});

test("newest context build uses ref sequence for equal timestamps", () => {
  const timestamp = "2026-08-03T05:00:00.000Z";
  assert.equal(
    newestContextBuild([build("task_seq_2", "completed", timestamp, 2), build("task_seq_3", "active", timestamp, 3)])
      ?.id,
    "task_seq_3"
  );
});

test("newest context build returns undefined for an empty scope", () => {
  assert.equal(newestContextBuild([]), undefined);
});

test("completed context stage count accepts Board and public terminal statuses", () => {
  assert.equal(
    completedContextStageCount([
      { status: "done" },
      { status: "completed" },
      { status: "in_progress" },
      { status: "failed" }
    ]),
    2
  );
});
