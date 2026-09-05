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

test("a refresh keeps the published release readable without admitting another build", () => {
  const readiness = wikiReadiness({ assigned: true, available: true, activeBuild: true, releaseId: "canonical-1" });
  assert.deepEqual(readiness, { state: "generating", canGenerate: false, releaseId: "canonical-1" });
  assert.ok(Object.isFrozen(readiness));
  assert.deepEqual(wikiReadiness({ assigned: true, available: true, activeBuild: true, releaseId: "  " }), { state: "generating", canGenerate: false });
});

test("a retained release never overrides repository access", () => {
  assert.deepEqual(wikiReadiness({ assigned: false, available: true, activeBuild: true, releaseId: "canonical-1" }), { state: "unassigned", canGenerate: false });
  assert.deepEqual(wikiReadiness({ assigned: true, available: false, activeBuild: true, releaseId: "canonical-1" }), { state: "access-unavailable", canGenerate: false });
});

test("generation allowance does not remove an existing readable release", () => {
  assert.deepEqual(wikiReadiness({ assigned: true, available: true, generationAllowed: false }), { state: "generation-unavailable", canGenerate: false });
  assert.deepEqual(wikiReadiness({ assigned: true, available: true, generationAllowed: false, releaseId: "canonical-1" }), { state: "ready", canGenerate: false, releaseId: "canonical-1" });
  assert.deepEqual(wikiReadiness({ assigned: true, available: true, generationAllowed: false, activeBuild: true, releaseId: "canonical-1" }), { state: "generating", canGenerate: false, releaseId: "canonical-1" });
});
