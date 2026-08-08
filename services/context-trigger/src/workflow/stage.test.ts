import assert from "node:assert/strict";
import test from "node:test";

import { runContextWikiStage } from "./stage.js";

test("runContextWikiStage preserves scoped authority and operation identity", async () => {
  const calls: unknown[] = [];
  const result = await runContextWikiStage(
    "plan",
    {
      schemaVersion: 1,
      authorityId: "build-1",
      requestDigest: "a".repeat(64),
      executionGrant: "g".repeat(32),
      operationId: "operation-1",
      input: { dependsOn: ["operation-0"] }
    },
    {
      runStage: async (input) => {
        calls.push(input);
        return { operationId: "operation-1", status: "completed", output: { pageJobs: [{}] } };
      }
    }
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    {
      authorityId: "build-1",
      stage: "plan",
      executionGrant: "g".repeat(32),
      operationId: "operation-1",
      stageInput: { dependsOn: ["operation-0"] }
    }
  ]);
});

test("runContextWikiStage rejects a mismatched operation receipt", async () => {
  await assert.rejects(
    () =>
      runContextWikiStage(
        "snapshot",
        {
          schemaVersion: 1,
          authorityId: "build-1",
          requestDigest: "a".repeat(64),
          executionGrant: "g".repeat(32),
          operationId: "operation-1",
          input: {}
        },
        {
          runStage: async () => ({ operationId: "operation-2", status: "completed", output: {} })
        }
      ),
    /does not match/
  );
});
