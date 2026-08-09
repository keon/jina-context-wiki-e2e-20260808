import assert from "node:assert/strict";
import test from "node:test";

import { canPromote } from "../src/promotion.js";

test("promotion requires wiki, causal graph, and review readiness", () => {
  assert.equal(
    canPromote({
      environment: "staging",
      wikiReady: true,
      causalGraphReady: true,
      reviewReady: true
    }),
    true
  );
  assert.equal(
    canPromote({
      environment: "staging",
      wikiReady: true,
      causalGraphReady: false,
      reviewReady: true
    }),
    false
  );
});
