import assert from "node:assert/strict";
import test from "node:test";
import { contextPageArtifactName } from "./context-page-artifact-name.js";

test("collapsed page stages have distinct stable immutable artifact names", () => {
  const documentPath = "guides/order-workflow-state-machine.md";

  assert.equal(contextPageArtifactName(documentPath, "write-0"), "guides-order-workflow-state-machine-md.write-0.json");
  assert.notEqual(contextPageArtifactName(documentPath, "write-0"), contextPageArtifactName(documentPath, "repair-1"));
  assert.notEqual(contextPageArtifactName(documentPath, "audit-0"), contextPageArtifactName(documentPath, "audit-1"));
});

test("page artifact names remain within the API limit", () => {
  const name = contextPageArtifactName(`${"deep/".repeat(80)}architecture.md`, `repair-${"9".repeat(200)}`);

  assert.ok(name.length <= 180);
  assert.match(name, /^[a-z0-9][a-z0-9._-]*\.repair-9+\.json$/);
});
