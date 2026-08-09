import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRelease, releaseDecisionSummary } from "../src/index.js";

test("a fully passing pipeline is ready", () => {
  assert.deepEqual(
    evaluateRelease({
      version: "2026.08.08",
      stages: [
        { name: "build", passed: true },
        { name: "test", passed: true },
        { name: "deploy", passed: true }
      ]
    }),
    { version: "2026.08.08", status: "ready", failedStages: [] }
  );
});

test("failed stages block the release in source order", () => {
  assert.deepEqual(
    evaluateRelease({
      version: "2026.08.08",
      stages: [
        { name: "build", passed: false },
        { name: "test", passed: true },
        { name: "deploy", passed: false }
      ]
    }).failedStages,
    ["build", "deploy"]
  );
});

test("duplicate stages are rejected", () => {
  assert.throws(
    () =>
      evaluateRelease({
        version: "2026.08.08",
        stages: [
          { name: "test", passed: true },
          { name: "test", passed: true }
        ]
      }),
    /duplicate stage/
  );
});

test("release summaries expose the blocking causal stages", () => {
  assert.equal(
    releaseDecisionSummary({
      version: "2026.08.09",
      status: "blocked",
      failedStages: ["test", "deploy"]
    }),
    "2026.08.09: blocked by test, deploy"
  );
});
