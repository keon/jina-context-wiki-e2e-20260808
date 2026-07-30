import assert from "node:assert/strict";
import test from "node:test";
import { contextFailureText } from "./context-failures.ts";

test("admin failure presentation requires the bounded public reason", () => {
  assert.equal(
    contextFailureText({
      failureCode: "context_validation",
      failureReason: "Generated Context did not pass deterministic validation."
    }),
    "context_validation: Generated Context did not pass deterministic validation."
  );
  assert.equal(contextFailureText({ failureCode: "context_validation" }), undefined);
});
