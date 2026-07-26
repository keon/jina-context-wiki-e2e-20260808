import assert from "node:assert/strict";
import { test } from "node:test";
import { findExistingCodex, isTransientKnowledgeGenerationFailure } from "./knowledge-document-executor.js";

test("knowledge generation retry classification is bounded to transient failures", () => {
  assert.equal(isTransientKnowledgeGenerationFailure("HTTP 503 from sandbox gateway"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("stream disconnected while reconnecting"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("output failed JSON schema validation"), false);
  assert.equal(isTransientKnowledgeGenerationFailure("permission denied"), false);
});

test("snapshot reuse accepts only an absolute working Codex path", async () => {
  const found = await findExistingCodex({
    process: {
      async executeCommand() {
        return { exitCode: 0, result: "/opt/codex/bin/codex\n" };
      }
    }
  });
  assert.equal(found, "/opt/codex/bin/codex");

  const missing = await findExistingCodex({
    process: {
      async executeCommand() {
        return { exitCode: 0, result: "codex\n" };
      }
    }
  });
  assert.equal(missing, undefined);
});
