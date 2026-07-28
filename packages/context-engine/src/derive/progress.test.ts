import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryContextEngineStore } from "../memory/store.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

test("a stopped run keeps the pages it had already written", async () => {
  const store = new MemoryContextEngineStore();
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_1",
    stageId: "cs_1",
    checkpointId: "ck_1",
    pages: [{ documentPath: "architecture", title: "Architecture", bodyMarkdown: "# Architecture\n\nfirst\n" }],
    at: "2026-07-28T12:00:00.000Z"
  });

  // The agent rewrites a page it is still working on, so the newest body wins
  // while the moment it first appeared is preserved.
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_1",
    stageId: "cs_1",
    checkpointId: "ck_1",
    pages: [
      { documentPath: "architecture", title: "Architecture", bodyMarkdown: "# Architecture\n\nfirst and second\n" },
      { documentPath: "flows/publish", title: "Publish", bodyMarkdown: "# Publish\n\nflow\n" }
    ],
    at: "2026-07-28T12:01:00.000Z"
  });

  // Nothing committed the stage, which is what being stopped looks like: the
  // work is still here to be resumed from.
  const resumable = await store.derivationProgressPages(TENANT, "cs_1");
  assert.deepEqual(resumable.map((page) => page.documentPath).sort(), ["architecture", "flows/publish"]);
  assert.equal(resumable.find((page) => page.documentPath === "architecture")?.bodyMarkdown.includes("second"), true);

  const snapshot = await store.derivationProgress(TENANT, "cb_1");
  assert.deepEqual(
    snapshot.pages.map((page) => page.documentPath),
    ["architecture", "flows/publish"]
  );
  assert.equal(snapshot.pages[0]?.firstSeenAt, "2026-07-28T12:00:00.000Z");
  assert.equal(snapshot.pages[0]?.updatedAt, "2026-07-28T12:01:00.000Z");
  assert.equal(snapshot.updatedAt, "2026-07-28T12:01:00.000Z");

  // Once the pages exist as revisions this must stop shadowing the catalog.
  await store.clearDerivationProgress(TENANT, "cs_1");
  assert.deepEqual(await store.derivationProgressPages(TENANT, "cs_1"), []);
  assert.deepEqual((await store.derivationProgress(TENANT, "cb_1")).pages, []);
});

test("one tenant cannot watch another tenant's build", async () => {
  const store = new MemoryContextEngineStore();
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_1",
    stageId: "cs_1",
    checkpointId: "ck_1",
    pages: [{ documentPath: "architecture", title: "Architecture", bodyMarkdown: "# Architecture\n" }],
    at: "2026-07-28T12:00:00.000Z"
  });
  const other = await store.derivationProgress("22222222-2222-4222-8222-222222222222", "cb_1");
  assert.deepEqual(other.pages, []);
});
