import assert from "node:assert/strict";
import test from "node:test";
import { contextPhaseCandidateArtifact } from "./phase-checkpoint-artifact.js";

test("phase candidates are content-addressed across same-attempt worker reclaims", () => {
  const first = contextPhaseCandidateArtifact("publication-plan.candidate", { pages: ["architecture"] });
  const replay = contextPhaseCandidateArtifact("publication-plan.candidate", { pages: ["architecture"] });
  const replacement = contextPhaseCandidateArtifact("publication-plan.candidate", { pages: ["runtime"] });

  assert.equal(first.name, replay.name);
  assert.notEqual(first.name, replacement.name);
  assert.match(first.name, /^publication-plan\.candidate\.[a-f0-9]{64}\.json$/);
  assert.equal(first.content.toString("utf8"), '{"pages":["architecture"]}');
});
