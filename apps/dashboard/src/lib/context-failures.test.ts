import assert from "node:assert/strict";
import test from "node:test";
import { contextFailureText } from "./context-failures.ts";

test("context failure presentation uses only the bounded public fields", () => {
  assert.equal(
    contextFailureText({
      failureCode: "daytona",
      failureReason: "The isolated execution sandbox did not complete this stage."
    }),
    "daytona: The isolated execution sandbox did not complete this stage."
  );
  assert.equal(contextFailureText({ failureCode: "daytona" }), undefined);
  assert.equal(contextFailureText({ failureReason: "  A safe reason.  " }), "A safe reason.");
});
