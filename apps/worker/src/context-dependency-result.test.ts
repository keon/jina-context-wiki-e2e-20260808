import assert from "node:assert/strict";
import test from "node:test";
import type { ContextArtifactRef } from "@jina/context-engine";
import { parsedContextDependencyResult } from "./context-dependency-result.js";

const outputArtifact: ContextArtifactRef = {
  uri: "gs://context/page.json",
  key: "context/page.json",
  contentType: "application/json",
  bytes: 128,
  sha256: "a".repeat(64)
};

test("claim parsing preserves the page disposition needed by publication", () => {
  const disposition = { status: "accepted", pageArtifact: outputArtifact };

  assert.deepEqual(parsedContextDependencyResult({ disposition }, outputArtifact), {
    version: 1,
    outputArtifact,
    disposition
  });
});

test("claim parsing keeps disposition optional for non-page dependencies", () => {
  assert.deepEqual(parsedContextDependencyResult({}, outputArtifact), {
    version: 1,
    outputArtifact
  });
});
