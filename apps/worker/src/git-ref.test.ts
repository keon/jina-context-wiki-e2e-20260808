import assert from "node:assert/strict";
import { test } from "node:test";
import { assertExpectedRemoteHead } from "./git-ref.js";

test("remote-head fence rejects an out-of-order historical push", () => {
  const older = "1".repeat(40);
  const newer = "2".repeat(40);
  assert.equal(assertExpectedRemoteHead("acme/repo", "main", newer, newer), newer);
  assert.throws(
    () => assertExpectedRemoteHead("acme/repo", "main", newer, older),
    /moved from expected .* refusing stale context build/
  );
});

test("remote-head fence selects the fetched head for manual current-ref builds", () => {
  const current = "a".repeat(40);
  assert.equal(assertExpectedRemoteHead("acme/repo", "main", current), current);
});
