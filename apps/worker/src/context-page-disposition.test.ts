import assert from "node:assert/strict";
import test from "node:test";
import { contextPageDispositionArtifact } from "./context-page-disposition.js";

test("publication includes accepted pages and skips explicitly omitted pages", () => {
  const artifact = { key: "context/page.json", sha256: "a".repeat(64) };

  assert.equal(
    contextPageDispositionArtifact({ disposition: { status: "accepted", pageArtifact: artifact } }),
    artifact
  );
  assert.equal(
    contextPageDispositionArtifact({ disposition: { status: "retained_stale", pageArtifact: artifact } }),
    artifact
  );
  assert.equal(
    contextPageDispositionArtifact({ disposition: { status: "omitted", reasonCode: "unsupported_core_claims" } }),
    undefined
  );
  assert.throws(() => contextPageDispositionArtifact({}), /disposition is missing/);
});
