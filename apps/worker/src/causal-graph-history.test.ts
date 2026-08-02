import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalCausalGraphCommitTimestamp } from "./causal-graph-history.js";

test("causal graph commit timestamps accept git ISO offsets and become canonical UTC", () => {
  assert.equal(
    canonicalCausalGraphCommitTimestamp("2026-08-02T00:07:57-05:00", "commit time"),
    "2026-08-02T05:07:57.000Z"
  );
  assert.equal(
    canonicalCausalGraphCommitTimestamp("2026-08-02T05:07:57.123456Z", "commit time"),
    "2026-08-02T05:07:57.123Z"
  );
});

test("causal graph commit timestamps reject non-ISO dates", () => {
  assert.throws(
    () => canonicalCausalGraphCommitTimestamp("Sat, 02 Aug 2026 05:07:57 GMT", "commit time"),
    /commit time must be an ISO timestamp/
  );
  assert.throws(
    () => canonicalCausalGraphCommitTimestamp("2026-99-02T05:07:57Z", "commit time"),
    /commit time must be an ISO timestamp/
  );
});
