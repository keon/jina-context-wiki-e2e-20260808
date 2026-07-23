import assert from "node:assert/strict";
import test from "node:test";
import { contextGraphHistoryPolicy } from "./history-limit.js";

test("uses a 500-commit partial-history default when a build does not request a limit", () => {
  assert.deepEqual(contextGraphHistoryPolicy(undefined, 10_000), { limit: 500 });
  assert.deepEqual(contextGraphHistoryPolicy(undefined, 250), { limit: 250 });
});

test("uses an explicit commit limit as a partial-history boundary", () => {
  assert.deepEqual(contextGraphHistoryPolicy(2_500, 10_000), { limit: 2_500 });
});

test("rejects malformed limits and requests above the service maximum", () => {
  assert.throws(() => contextGraphHistoryPolicy(0, 10_000), /must be a positive integer/);
  assert.throws(() => contextGraphHistoryPolicy(10_001, 10_000), /exceeds service maximum 10000/);
  assert.throws(() => contextGraphHistoryPolicy(undefined, 10_000, 0), /default history limit/);
});
