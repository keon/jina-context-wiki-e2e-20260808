import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_BOARD_TOPICS,
  CAUSAL_GRAPH_TOPICS,
  CONTEXT_BOARD_TOPICS,
  REVIEW_BOARD_TOPICS,
  configuredWorkerClaimMode,
  configuredWorkerPreferredRepository,
  configuredWorkerTopics,
  requiresBoardAgentExecutor,
  workerClaimTimeoutMs
} from "./worker-topics.js";

test("worker claim mode defaults enabled and accepts only the explicit paused drain mode", () => {
  assert.equal(configuredWorkerClaimMode(undefined), "enabled");
  assert.equal(configuredWorkerClaimMode(" enabled "), "enabled");
  assert.equal(configuredWorkerClaimMode("paused"), "paused");
  assert.throws(() => configuredWorkerClaimMode("disabled"), /must be enabled or paused/);
});

test("worker claim preference accepts only a repository identity", () => {
  assert.equal(configuredWorkerPreferredRepository(undefined), undefined);
  assert.equal(configuredWorkerPreferredRepository(" omxyz/jina "), "omxyz/jina");
  assert.throws(() => configuredWorkerPreferredRepository("omxyz"), /owner\/repository/);
});

const LEGACY_CONTEXT_TOPICS = [
  "run-ingest-evidence",
  "run-derive-knowledge",
  "run-index-context",
  "run-context-research-plan",
  "run-context-page-write",
  "run-context-pageindex"
] as const;

test("worker topics reject every legacy Context executor route", () => {
  for (const topic of LEGACY_CONTEXT_TOPICS) {
    assert.throws(() => configuredWorkerTopics(topic), /unsupported topics/);
  }
  assert.deepEqual(configuredWorkerTopics(CONTEXT_BOARD_TOPICS.join("|")), CONTEXT_BOARD_TOPICS);
});

test("every Context topic requires the production Board executor preflight", () => {
  assert.equal(requiresBoardAgentExecutor(configuredWorkerTopics("run-review")), false);
  for (const topic of CONTEXT_BOARD_TOPICS) {
    assert.equal(requiresBoardAgentExecutor(configuredWorkerTopics(topic)), true, topic);
  }
});

test("review Board topics use the task worker without the Context agent preflight", () => {
  assert.deepEqual(configuredWorkerTopics(REVIEW_BOARD_TOPICS.join("|")), REVIEW_BOARD_TOPICS);
  for (const topic of REVIEW_BOARD_TOPICS) {
    assert.equal(requiresBoardAgentExecutor(configuredWorkerTopics(topic)), false, topic);
  }
  assert.deepEqual(configuredWorkerTopics(CONTROL_BOARD_TOPICS.join("|")), CONTROL_BOARD_TOPICS);
  assert.equal(requiresBoardAgentExecutor(configuredWorkerTopics(CONTROL_BOARD_TOPICS[0])), false);
});

test("causal graph topics are an explicit worker-only allowlist disjoint from Context", () => {
  assert.equal(
    CAUSAL_GRAPH_TOPICS.some((topic) => CONTEXT_BOARD_TOPICS.includes(topic as never)),
    false
  );
  assert.deepEqual(configuredWorkerTopics(CAUSAL_GRAPH_TOPICS.join("|")), CAUSAL_GRAPH_TOPICS);
  for (const topic of CAUSAL_GRAPH_TOPICS) {
    assert.equal(requiresBoardAgentExecutor(configuredWorkerTopics(topic)), true, topic);
  }
});

test("Context claims use the long API timeout so committed claims are not orphaned", () => {
  assert.equal(workerClaimTimeoutMs(configuredWorkerTopics("run-review"), 30_000, 7_800_000), 30_000);
  assert.equal(
    workerClaimTimeoutMs(configuredWorkerTopics(CONTEXT_BOARD_TOPICS.join("|")), 30_000, 7_800_000),
    7_800_000
  );
});
