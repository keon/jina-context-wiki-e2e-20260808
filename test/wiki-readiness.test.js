import assert from "node:assert/strict";
import test from "node:test";
import { wikiReadiness } from "../src/wiki-readiness.js";

test("only an assigned and accessible repository can start a Wiki", () => {
  assert.deepEqual(wikiReadiness({ assigned: false, available: true }), { state: "unassigned", canGenerate: false });
  assert.deepEqual(wikiReadiness({ assigned: true, available: false }), { state: "access-unavailable", canGenerate: false });
});

test("connected does not falsely imply generation is running", () => {
  assert.deepEqual(wikiReadiness({ assigned: true, available: true }), { state: "awaiting-first-wiki", canGenerate: true });
  assert.deepEqual(wikiReadiness({ assigned: true, available: true, activeBuild: true }), { state: "generating", canGenerate: false });
});

test("a canonical release is ready and may be refreshed", () => {
  const readiness = wikiReadiness({ assigned: true, available: true, releaseId: "canonical-1" });
  assert.deepEqual(readiness, { state: "ready", canGenerate: true, releaseId: "canonical-1" });
  assert.ok(Object.isFrozen(readiness));
});
