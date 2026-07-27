import assert from "node:assert/strict";
import test from "node:test";
import { repositoryAclFingerprint } from "./domain/fingerprint.js";
import { IngestEvidenceService } from "./ingest/pipeline.js";
import { MemoryContextEngineStore } from "./memory/store.js";
import { MemoryContextPipelineCoordinator } from "./workflow/coordinator.js";

test("ingestion preserves special Git entries without indexing symlink targets as source", async () => {
  const tenantId = "tenant-special-git";
  const repository = "acme/special-git";
  const store = new MemoryContextEngineStore(new MemoryContextPipelineCoordinator());
  const checkpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    commitSha: "a".repeat(40),
    files: [
      {
        path: "bin/run",
        blobSha: "b".repeat(40),
        body: "#!/bin/sh\n",
        executable: true
      },
      {
        path: "src/current.ts",
        blobSha: "c".repeat(40),
        body: "",
        contentOmitted: true,
        entryType: "symlink",
        linkTarget: "src/index.ts"
      },
      {
        path: "vendor/component",
        blobSha: "d".repeat(40),
        body: "",
        contentOmitted: true,
        entryType: "gitlink"
      }
    ],
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
    observationFrontier: "git:1",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceComplete: true
  });

  assert.deepEqual(
    (await store.listManifest(checkpoint.id)).map((entry) => ({
      path: entry.path,
      executable: entry.executable,
      contentAvailable: entry.contentAvailable,
      entryType: entry.entryType ?? "file",
      linkTarget: entry.linkTarget
    })),
    [
      {
        path: "bin/run",
        executable: true,
        contentAvailable: true,
        entryType: "file",
        linkTarget: undefined
      },
      {
        path: "src/current.ts",
        executable: false,
        contentAvailable: false,
        entryType: "symlink",
        linkTarget: "src/index.ts"
      },
      {
        path: "vendor/component",
        executable: false,
        contentAvailable: false,
        entryType: "gitlink",
        linkTarget: undefined
      }
    ]
  );
  assert.deepEqual(
    (await store.listEvidence(checkpoint.id)).map((record) => record.anchor.pathOrUrl),
    ["bin/run"]
  );
});
