import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contextBuildLabel,
  contextCheckpointCounts,
  contextDeadlineText,
  contextStageCounts,
  contextStageStatus,
  contextStageTiming,
  formatDuration,
  type ContextBuildStage,
} from "./context-progress";

const stage = (
  status: string,
  attempt = 1,
): ContextBuildStage => ({
  id: `${status}-${attempt}`,
  type: "context_page_write",
  title: "Write architecture context",
  status,
  attempt,
  updatedAt: "2026-07-31T12:00:00.000Z",
});

test("context progress reports running and waiting time without invented percentages", () => {
  const now = Date.parse("2026-07-31T12:02:05.000Z");
  assert.equal(contextStageTiming(stage("in_progress"), now), "Running for 2m 5s");
  assert.equal(contextStageTiming(stage("queued"), now), "Waiting for 2m 5s");
  assert.equal(contextStageStatus(stage("in_progress")), "In progress");
});

test("context build labels distinguish repeated refs by sequence and short commit", () => {
  assert.equal(
    contextBuildLabel({
      repository: "omxyz/jina",
      ref: "pull/198/head",
      refSequence: 42,
      commitSha: "deadbeefcafebabefeedface",
    }),
    "omxyz/jina · pull/198/head · seq 42 · deadbeef",
  );
  assert.equal(contextBuildLabel({ repository: "omxyz/jina", ref: "main" }), "omxyz/jina · main");
  assert.equal(contextBuildLabel({}), "Repository");
});

test("context progress summarizes task and retry counts", () => {
  assert.deepEqual(
    contextStageCounts([
      stage("done"),
      stage("in_progress", 2),
      stage("queued"),
      stage("failed", 3),
    ]),
    { complete: 1, running: 1, waiting: 1, failed: 1, retried: 2 },
  );
  assert.equal(formatDuration(3_725_000), "1h 2m");
});

test("context progress distinguishes checkpoint validation and the build deadline", () => {
  assert.deepEqual(
    contextCheckpointCounts([
      {
        documentPath: "architecture.md",
        title: "Architecture",
        bytes: 120,
        validationStatus: "valid",
        diagnostics: [],
        checkpointSequence: 1,
        updatedAt: "2026-07-31T12:00:00.000Z",
      },
      {
        documentPath: "operations.md",
        title: "Operations",
        bytes: 80,
        validationStatus: "invalid",
        diagnostics: ["Citation is unsupported."],
        checkpointSequence: 2,
        updatedAt: "2026-07-31T12:01:00.000Z",
      },
    ]),
    { verified: 1, pending: 0, invalid: 1 },
  );
  assert.equal(
    contextDeadlineText(
      "2026-07-31T12:05:00.000Z",
      Date.parse("2026-07-31T12:02:00.000Z"),
    ),
    "Deadline in 3m 0s",
  );
});
