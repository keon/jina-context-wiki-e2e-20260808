import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseContextPriorReleaseSeed,
  type CertifiedContextReleaseArtifactV1
} from "../publication/board-publication.js";
import {
  contextPriorReleaseCatalog,
  validateContextIncrementalAccounting,
  validatePublishedContextIncrement
} from "./incremental.js";

test("accounts for retained, revised, added, and retired pages across a provider-only frontier advance", () => {
  const prior = priorRelease();
  const plannedPages = [
    { path: "architecture.md", change: "retain" as const },
    { path: "components/api.md", change: "revise" as const },
    { path: "operations/deploy.md", change: "add" as const }
  ];
  const retiredPages = [{ path: "runbooks/legacy.md", reason: "The legacy worker was removed." }];
  const publishedPages = [
    {
      documentPath: "architecture.md",
      title: "Architecture",
      bodyMarkdown: prior.pages[0]!.bodyMarkdown
    },
    {
      documentPath: "components/api.md",
      title: "API",
      bodyMarkdown: "# API\n\nThe API now handles the newly observed provider event.\n"
    },
    {
      documentPath: "operations/deploy.md",
      title: "Deployment",
      bodyMarkdown: "# Deployment\n\nThe service deployment follows the current runtime topology.\n"
    }
  ];

  const accounting = validatePublishedContextIncrement({
    priorRelease: prior,
    plannedPages,
    retiredPages,
    publishedPages
  });

  assert.deepEqual(
    accounting.active.map(({ path, change }) => [path, change]),
    [
      ["architecture.md", "retain"],
      ["components/api.md", "revise"],
      ["operations/deploy.md", "add"]
    ]
  );
  assert.deepEqual(
    accounting.retired.map(({ path }) => path),
    ["runbooks/legacy.md"]
  );
  assert.equal(accounting.active[0]?.prior?.logicalId, "repository:acme/sample:architecture");
  assert.equal(accounting.active[1]?.prior?.logicalId, "component:acme/sample:api");
  // A provider-only build may keep the repository commit unchanged while its
  // ref sequence and provider observation frontier advance.
  assert.equal(prior.release.commitSha, "1".repeat(40));
});

test("rejects a prior page omitted without an explicit retirement", () => {
  const prior = priorRelease();
  assert.throws(
    () =>
      validateContextIncrementalAccounting({
        priorRelease: prior,
        pages: [
          { path: "architecture.md", change: "retain" },
          { path: "components/api.md", change: "revise" }
        ]
      }),
    /silently drops prior pages: runbooks\/legacy\.md/
  );
});

test("rejects changed bytes behind a retain disposition", () => {
  const prior = priorRelease();
  assert.throws(
    () =>
      validatePublishedContextIncrement({
        priorRelease: prior,
        plannedPages: [
          { path: "architecture.md", change: "retain" },
          { path: "components/api.md", change: "retain" },
          { path: "runbooks/legacy.md", change: "retain" }
        ],
        publishedPages: prior.pages.map((page) => ({
          documentPath: page.documentPath,
          title: page.title,
          bodyMarkdown:
            page.documentPath === "components/api.md"
              ? `${page.bodyMarkdown}\nChanged without revise.\n`
              : page.bodyMarkdown
        }))
      }),
    /retained Context page components\/api\.md changed published content/
  );
});

test("an explicit disposition may omit only a newly added page", () => {
  const publishedPages = [
    {
      documentPath: "architecture.md",
      title: "Architecture",
      bodyMarkdown: "# Architecture\n\nThe supported repository overview.\n"
    }
  ];

  assert.doesNotThrow(() =>
    validatePublishedContextIncrement({
      plannedPages: [
        { path: "architecture.md", change: "add" },
        { path: "legacy-administrator-deletion.md", change: "add" }
      ],
      omittedPages: [
        { path: "legacy-administrator-deletion.md", reasonCode: "unsupported_core_claims" }
      ],
      publishedPages
    })
  );
  assert.throws(
    () =>
      validatePublishedContextIncrement({
        priorRelease: priorRelease(),
        plannedPages: [
          { path: "architecture.md", change: "retain" },
          { path: "components/api.md", change: "revise" },
          { path: "runbooks/legacy.md", change: "retain" }
        ],
        omittedPages: [{ path: "components/api.md", reasonCode: "unsupported_core_claims" }],
        publishedPages: priorRelease().pages.map((page) => ({
          documentPath: page.documentPath,
          title: page.title,
          bodyMarkdown: page.bodyMarkdown
        }))
      }),
    /may omit only a new add page/
  );
});

test("derives stable logical IDs from the prior immutable catalog", () => {
  assert.deepEqual(
    contextPriorReleaseCatalog(priorRelease()).map(({ documentPath, logicalId }) => [documentPath, logicalId]),
    [
      ["architecture.md", "repository:acme/sample:architecture"],
      ["components/api.md", "component:acme/sample:api"],
      ["runbooks/legacy.md", "runbook:acme/sample:legacy"]
    ]
  );
});

test("prior seed parser rejects a cross-tenant release artifact key", () => {
  const release = priorRelease();
  assert.throws(
    () =>
      parseContextPriorReleaseSeed({
        version: 1,
        tenantId: release.release.tenantId,
        repository: release.release.repository,
        ref: release.release.ref,
        refSequence: release.release.refSequence,
        commitSha: release.release.commitSha,
        releaseId: release.release.releaseId,
        publicSnapshotDigest: release.publicSnapshotDigest,
        releaseArtifact: {
          ...release.certificationArtifact,
          key: "context/tenants/other/repositories/acme/sample/builds/task_prior/context-release/cr_prior.json"
        }
      }),
    /outside its immutable repository release scope/
  );
});

function priorRelease(): CertifiedContextReleaseArtifactV1 {
  const pages = [
    {
      documentPath: "architecture.md",
      title: "Architecture",
      bodyMarkdown: "# Architecture\n\nThe repository routes requests through its API.\n"
    },
    {
      documentPath: "components/api.md",
      title: "API",
      bodyMarkdown: "# API\n\nThe API accepts repository events.\n"
    },
    {
      documentPath: "runbooks/legacy.md",
      title: "Legacy recovery",
      bodyMarkdown: "# Legacy recovery\n\nThe legacy worker can be restarted.\n"
    }
  ].map((page, index) => ({
    ...page,
    bodySha256: digest(page.bodyMarkdown),
    revisionId: `kr_prior_${index}`,
    citations: []
  }));
  const artifact = {
    uri: "file:///prior.json",
    key: "context/tenants/tenant-a/repositories/acme/sample/builds/task_prior/context-release/cr_prior.json",
    contentType: "application/json",
    bytes: 1,
    sha256: "a".repeat(64)
  };
  return {
    version: 1,
    release: {
      releaseId: "cr_prior",
      tenantId: "tenant-a",
      repository: "acme/sample",
      ref: "main",
      refSequence: 1,
      commitSha: "1".repeat(40),
      checkpointId: "cp_prior",
      buildId: "task_prior",
      publishedAt: "2026-07-29T00:00:00.000Z"
    },
    certificationArtifact: artifact,
    publicationPlanArtifact: artifact,
    publicSnapshotDigest: "b".repeat(64),
    publicationInputDigest: "c".repeat(64),
    pages
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
