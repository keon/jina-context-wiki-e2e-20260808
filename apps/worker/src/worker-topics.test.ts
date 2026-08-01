import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_BOARD_TOPICS,
  configuredWorkerClaimMode,
  configuredWorkerTopics,
  requiresContextBoardExecutor,
  workerClaimTimeoutMs
} from "./worker-topics.js";

test("worker claim mode defaults enabled and accepts only the explicit paused drain mode", () => {
  assert.equal(configuredWorkerClaimMode(undefined), "enabled");
  assert.equal(configuredWorkerClaimMode(" enabled "), "enabled");
  assert.equal(configuredWorkerClaimMode("paused"), "paused");
  assert.throws(() => configuredWorkerClaimMode("disabled"), /must be enabled or paused/);
});

const LEGACY_CONTEXT_TOPICS = ["run-ingest-evidence", "run-derive-knowledge", "run-index-context"] as const;

test("worker topics reject every legacy Context executor route", () => {
  for (const topic of LEGACY_CONTEXT_TOPICS) {
    assert.throws(() => configuredWorkerTopics(topic), /unsupported topics/);
  }
  assert.deepEqual(configuredWorkerTopics(CONTEXT_BOARD_TOPICS.join("|")), CONTEXT_BOARD_TOPICS);
});

test("every Context topic requires the production Board executor preflight", () => {
  assert.equal(requiresContextBoardExecutor(configuredWorkerTopics("run-review")), false);
  for (const topic of CONTEXT_BOARD_TOPICS) {
    assert.equal(requiresContextBoardExecutor(configuredWorkerTopics(topic)), true, topic);
  }
});

test("Context claims use the long API timeout so committed claims are not orphaned", () => {
  assert.equal(workerClaimTimeoutMs(configuredWorkerTopics("run-review"), 30_000, 7_800_000), 30_000);
  assert.equal(
    workerClaimTimeoutMs(configuredWorkerTopics(CONTEXT_BOARD_TOPICS.join("|")), 30_000, 7_800_000),
    7_800_000
  );
});
