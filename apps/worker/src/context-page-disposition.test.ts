import assert from "node:assert/strict";
import test from "node:test";
import { contextPagePublicationDisposition, resolveContextPageOmission } from "./context-page-disposition.js";

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

test("unsupported revisions retain the certified prior page while unsupported additions may be omitted", () => {
  assert.deepEqual(resolveContextPageOmission({ plannedChange: "add", hasPriorPage: false }), {
    status: "omit_new_page"
  });
  assert.deepEqual(resolveContextPageOmission({ plannedChange: "revise", hasPriorPage: true }), {
    status: "retain_prior_page"
  });
  assert.deepEqual(resolveContextPageOmission({ plannedChange: "retain", hasPriorPage: true }), {
    status: "retain_prior_page"
  });
  assert.throws(
    () => resolveContextPageOmission({ plannedChange: "revise", hasPriorPage: false }),
    /has no certified prior page/
  );
});
