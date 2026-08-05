import assert from "node:assert/strict";
import test from "node:test";
import { contextPagePublicationDisposition, unsupportedContextPageFallback } from "./context-page-disposition.js";

test("publication includes accepted pages and skips explicitly omitted pages", () => {
  const artifact = { key: "context/page.json", sha256: "a".repeat(64) };

  assert.deepEqual(contextPagePublicationDisposition({ disposition: { status: "accepted", pageArtifact: artifact } }), {
    status: "accepted",
    pageArtifact: artifact
  });
  assert.deepEqual(
    contextPagePublicationDisposition({ disposition: { status: "retained_stale", pageArtifact: artifact } }),
    { status: "retained_stale", pageArtifact: artifact }
  );
  assert.deepEqual(
    contextPagePublicationDisposition({ disposition: { status: "omitted", reasonCode: "unsupported_core_claims" } }),
    { status: "omitted", reasonCode: "unsupported_core_claims" }
  );
  assert.throws(() => contextPagePublicationDisposition({}), /disposition is missing/);
  assert.throws(
    () => contextPagePublicationDisposition({ disposition: { status: "omitted" } }),
    /reasonCode is missing/
  );
});

test("unsupported Context revisions retain the prior certified page while new pages are omitted", () => {
  const priorPage = { documentPath: "architecture.md", revisionId: "kr_prior" };
  assert.deepEqual(unsupportedContextPageFallback("revise", priorPage), {
    status: "retained_stale",
    reasonCode: "unsupported_core_claims",
    priorPage
  });
  assert.deepEqual(unsupportedContextPageFallback("add", undefined), {
    status: "omitted",
    reasonCode: "unsupported_core_claims"
  });
  assert.throws(() => unsupportedContextPageFallback("revise", undefined), /requires a prior certified page/);
  assert.throws(() => unsupportedContextPageFallback("retain", priorPage), /does not accept retain/);
});
