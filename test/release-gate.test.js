import assert from "node:assert/strict";
import test from "node:test";

import { mayPromoteRelease, promotionSummary } from "../src/release-gate.js";

test("promotes only when review, wiki, and causal graph checks pass", () => {
  assert.equal(
    mayPromoteRelease([
      { name: "review", status: "passed" },
      { name: "wiki", status: "passed" },
      { name: "causal-graph", status: "passed" }
    ]),
    true
  );

  assert.equal(
    mayPromoteRelease([
      { name: "review", status: "passed" },
      { name: "wiki", status: "failed" },
      { name: "causal-graph", status: "passed" }
    ]),
    false
  );
});

test("summarizes a blocked promotion", () => {
  assert.equal(promotionSummary([{ name: "review", status: "passed" }]), "blocked");
});
