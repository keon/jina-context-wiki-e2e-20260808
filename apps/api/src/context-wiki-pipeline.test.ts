import assert from "node:assert/strict";
import test from "node:test";
import { contextWikiOrchestrator, parseContextWikiPipelineRouting } from "./context-wiki-pipeline.js";

test("wiki pipeline defaults to the legacy Board and rejects contradictory configuration", () => {
  const routing = parseContextWikiPipelineRouting({});
  assert.equal(routing.mode, "legacy-board");
  assert.equal(contextWikiOrchestrator(routing, { tenantId: "tenant-1", repository: "Acme/Docs" }), "legacy-board");

  assert.throws(
    () =>
      parseContextWikiPipelineRouting({
        JINA_WIKI_PIPELINE_MODE: "trigger",
        JINA_WIKI_TRIGGER_ALLOWLIST: "tenant-1/acme/docs"
      }),
    /accepted only/
  );
  assert.throws(
    () => parseContextWikiPipelineRouting({ JINA_WIKI_PIPELINE_MODE: "trigger-allowlist" }),
    /requires at least one/
  );
});

test("wiki Trigger allowlist routing is exact by tenant and normalized repository", () => {
  const routing = parseContextWikiPipelineRouting({
    JINA_WIKI_PIPELINE_MODE: "trigger-allowlist",
    JINA_WIKI_TRIGGER_ALLOWLIST: "tenant-1/Acme/Docs, tenant-2/other/repo"
  });

  assert.equal(contextWikiOrchestrator(routing, { tenantId: "tenant-1", repository: "acme/docs" }), "trigger");
  assert.equal(contextWikiOrchestrator(routing, { tenantId: "tenant-2", repository: "acme/docs" }), "legacy-board");
  assert.equal(contextWikiOrchestrator(routing, { tenantId: "tenant-1", repository: "other/repo" }), "legacy-board");
});

test("full Trigger mode assigns every new request to Trigger", () => {
  const routing = parseContextWikiPipelineRouting({ JINA_WIKI_PIPELINE_MODE: "trigger" });
  assert.equal(contextWikiOrchestrator(routing, { tenantId: "tenant-x", repository: "acme/docs" }), "trigger");
});
