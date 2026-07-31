import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalPageIndexClient,
  PAGEINDEX_OSS_ADAPTER_NAME,
  PAGEINDEX_OSS_SOURCE_DIGEST,
  PAGEINDEX_OSS_SOURCE_PIN,
  boardContextPublicationInputDigest,
  boardContextReleaseId,
  contextPublicSnapshotDigest,
  fingerprint,
  type CertifiedContextReleaseArtifactV1,
  type ContextArtifactRef,
  type KnowledgeEvidenceCitation
} from "@jina/context-engine";
import { BoardPageIndexError, buildBoardPageIndex } from "./board-pageindex.js";

const tenantId = "tenant-pageindex";
const repository = "acme/context";
const commitSha = "8".repeat(40);
const buildId = "task_context_build";

type FakeWorkerMode = "success" | "incomplete" | "malformed" | "invalid-json" | "timeout" | "version-mismatch";

test("board PageIndex execution indexes every certified page with pinned source metadata", async () => {
  await withFakeWorker("success", async (client) => {
    const release = fixtureRelease();
    const result = await buildBoardPageIndex(client, release);

    assert.equal(result.artifact.version, 1);
    assert.equal(result.artifact.release.releaseId, release.release.releaseId);
    assert.deepEqual(
      result.artifact.representedDocuments.map((document) => document.documentPath),
      ["architecture.md", "operations/runtime.md"]
    );
    assert.deepEqual(result.artifact.metrics, {
      documentCount: 2,
      representedDocumentCount: 2,
      rootCount: 2,
      nodeCount: 4,
      maxDepth: 2,
      documentCharacters: release.pages.reduce((total, page) => total + page.bodyMarkdown.length, 0),
      inputDigest: result.artifact.metrics.inputDigest,
      treeDigest: result.artifact.metrics.treeDigest,
      buildDigest: result.artifact.metrics.buildDigest
    });
    assert.equal(result.artifact.source.adapterName, PAGEINDEX_OSS_ADAPTER_NAME);
    assert.equal(result.artifact.source.adapterVersion, PAGEINDEX_OSS_SOURCE_PIN);
    assert.equal(result.artifact.source.sourcePin, PAGEINDEX_OSS_SOURCE_PIN);
    assert.equal(result.artifact.source.sourceDigest, PAGEINDEX_OSS_SOURCE_DIGEST);
    assert.match(result.artifact.metrics.inputDigest, /^[0-9a-f]{64}$/);
    assert.match(result.artifact.metrics.treeDigest, /^[0-9a-f]{64}$/);
    assert.match(result.artifact.metrics.buildDigest, /^[0-9a-f]{64}$/);
    assert.equal(fingerprint(result.artifactContent), result.artifactSha256);
    assert.equal(result.releaseMetadata.artifactSha256, result.artifactSha256);
    assert.equal(result.artifactContent.includes("bodyMarkdown"), false);
    assert.equal(result.artifactContent.includes("publicationPlanArtifact"), false);
    assert.equal(result.artifactContent.includes("certificationArtifact"), false);
  });
});

test("board PageIndex execution preserves an RFC 6901 root JSON Pointer citation", async () => {
  await withFakeWorker("success", async (client) => {
    const result = await buildBoardPageIndex(client, fixtureRelease({ rootJsonPointer: true }));
    assert.ok(result.artifact.nodes.some((node) => node.anchors.some((anchor) => anchor.jsonPointer === "")));
  });
});

test("board PageIndex execution rejects an incomplete certified-document tree", async () => {
  await withFakeWorker("incomplete", async (client) => {
    await assert.rejects(
      buildBoardPageIndex(client, fixtureRelease()),
      (error: unknown) =>
        error instanceof BoardPageIndexError &&
        error.code === "incomplete_tree" &&
        error.message.includes("omitted certified document")
    );
  });
});

test("board PageIndex execution rejects malformed hierarchy intervals and malformed worker JSON", async () => {
  await withFakeWorker("malformed", async (client) => {
    await assert.rejects(
      buildBoardPageIndex(client, fixtureRelease()),
      (error: unknown) =>
        error instanceof BoardPageIndexError &&
        error.code === "invalid_tree" &&
        error.message.includes("malformed node fields")
    );
  });
  await withFakeWorker("invalid-json", async (client) => {
    await assert.rejects(
      buildBoardPageIndex(client, fixtureRelease()),
      (error: unknown) =>
        error instanceof BoardPageIndexError &&
        error.code === "worker_unavailable" &&
        error.message.includes("build failed")
    );
  });
});

test("board PageIndex execution fails closed on timeout and source-version mismatch", async () => {
  await withFakeWorker(
    "timeout",
    async (client) => {
      await assert.rejects(
        buildBoardPageIndex(client, fixtureRelease(), { timeoutMs: 200 }),
        (error: unknown) => error instanceof BoardPageIndexError && error.code === "worker_timeout"
      );
    },
    40
  );
  await withFakeWorker("version-mismatch", async (client) => {
    await assert.rejects(
      buildBoardPageIndex(client, fixtureRelease()),
      (error: unknown) => error instanceof BoardPageIndexError && error.code === "version_mismatch"
    );
  });
});

test("board PageIndex artifact bytes and digests are idempotent for the same certified release", async () => {
  await withFakeWorker("success", async (client) => {
    const release = fixtureRelease();
    const first = await buildBoardPageIndex(client, release);
    const second = await buildBoardPageIndex(client, release);
    assert.equal(second.artifactContent, first.artifactContent);
    assert.equal(second.artifactSha256, first.artifactSha256);
    assert.deepEqual(second.releaseMetadata, first.releaseMetadata);
    assert.deepEqual(second.artifact, first.artifact);
  });
});

async function withFakeWorker(
  mode: FakeWorkerMode,
  operation: (client: LocalPageIndexClient) => Promise<void>,
  timeoutMs = 10_000
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jina-pageindex-board-"));
  try {
    const workerPath = join(root, `fake-pageindex-${mode}.cjs`);
    await writeFile(workerPath, fakeWorkerSource(mode), "utf8");
    const client = new LocalPageIndexClient({
      python: process.execPath,
      workerPath,
      timeoutMs
    });
    await operation(client);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeWorkerSource(mode: FakeWorkerMode): string {
  return [
    "const mode = " + JSON.stringify(mode) + ";",
    "const pin = " + JSON.stringify(PAGEINDEX_OSS_SOURCE_PIN) + ";",
    "const digest = " + JSON.stringify(PAGEINDEX_OSS_SOURCE_DIGEST) + ";",
    "const name = " + JSON.stringify(PAGEINDEX_OSS_ADAPTER_NAME) + ";",
    "if (process.argv.includes('--probe')) {",
    "  process.stdout.write(JSON.stringify({",
    "    available: true,",
    "    adapterName: name,",
    "    version: mode === 'version-mismatch' ? '0'.repeat(40) : pin,",
    "    sourcePin: mode === 'version-mismatch' ? '0'.repeat(40) : pin,",
    "    sourceDigest: digest",
    "  }));",
    "  process.exit(0);",
    "}",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  if (mode === 'timeout') { setTimeout(() => {}, 10_000); return; }",
    "  if (mode === 'invalid-json') { process.stdout.write('{not-json'); return; }",
    "  const request = JSON.parse(input);",
    "  const documents = mode === 'incomplete' ? request.input.documents.slice(0, 1) : request.input.documents;",
    "  const nodes = documents.flatMap(document => [",
    "    {",
    "      externalId: `root-${document.id}`, documentId: document.id, title: document.title,",
    "      summary: `Root for ${document.title}`, depth: 1, preorderStart: 1, preorderEnd: 2,",
    "      anchors: document.anchors",
    "    },",
    "    {",
    "      externalId: `child-${document.id}`, documentId: document.id, parentExternalId: `root-${document.id}`,",
    "      title: 'Details', summary: 'Derived context details',",
    "      depth: 2, preorderStart: 2, preorderEnd: mode === 'malformed' ? 1 : 2,",
    "      anchors: document.anchors",
    "    }",
    "  ]);",
    "  process.stdout.write(JSON.stringify({",
    "    adapterName: name, adapterVersion: pin, sourcePin: pin, sourceDigest: digest, nodes, diagnostics: []",
    "  }));",
    "});"
  ].join("\n");
}

function fixtureRelease(options: { readonly rootJsonPointer?: boolean } = {}): CertifiedContextReleaseArtifactV1 {
  const pageInputs = [
    {
      documentPath: "operations/runtime.md",
      title: "Runtime operations",
      bodyMarkdown:
        "# Runtime operations\n\nThe worker retries a lease after a bounded failure.\n\n## Recovery\n\nResume from the certified checkpoint."
    },
    {
      documentPath: "architecture.md",
      title: "Architecture",
      bodyMarkdown:
        "# Architecture\n\nA board task owns each durable stage.\n\n## Data flow\n\nCertified derived context enters retrieval."
    }
  ];
  const pages = pageInputs
    .map((page, pageIndex) => {
      const revisionId = `kr_fixture_${pageIndex}`;
      const anchor: KnowledgeEvidenceCitation["anchor"] =
        options.rootJsonPointer && pageIndex === 0
          ? {
              tenantId,
              repository,
              sourceType: "issue",
              sourceId: "42",
              contentDigest: fingerprint("fixture issue 42"),
              pathOrUrl: "https://github.com/acme/context/issues/42",
              jsonPointer: ""
            }
          : {
              tenantId,
              repository,
              sourceType: "blob",
              sourceId: `${commitSha}:src/file-${pageIndex}.ts`,
              contentDigest: fingerprint(`fixture source ${pageIndex}`),
              commitSha,
              pathOrUrl: `src/file-${pageIndex}.ts`,
              startLine: 1,
              endLine: 1
            };
      const citation: KnowledgeEvidenceCitation = {
        id: `kc_fixture_${pageIndex}`,
        revisionId,
        ordinal: 0,
        claim: page.bodyMarkdown.split("\n")[2]!,
        citationId: `cite_${String(pageIndex).padStart(20, "0")}`,
        claimSpan: page.bodyMarkdown.split("\n")[2]!,
        anchor
      };
      return {
        ...page,
        bodySha256: fingerprint(page.bodyMarkdown),
        revisionId,
        citations: [citation]
      };
    })
    .sort((left, right) => left.documentPath.localeCompare(right.documentPath));
  const certificationArtifact = artifactRef("certification", "certification.json");
  const publicationPlanArtifact = artifactRef("publication-plan", "plan.json");
  const publicSnapshotDigest = contextPublicSnapshotDigest(pages);
  const scope = {
    tenantId,
    repository,
    ref: "main",
    refSequence: 7,
    commitSha,
    buildId
  };
  const publicationInputDigest = boardContextPublicationInputDigest({
    scope,
    certificationArtifact,
    publicationPlanArtifact,
    checkpointId: "checkpoint-fixture",
    publicSnapshotDigest,
    pages: pages.map((page) => ({
      documentPath: page.documentPath,
      bodySha256: page.bodySha256,
      revisionId: page.revisionId,
      citationIds: page.citations.map((citation) => citation.id)
    }))
  });
  return {
    version: 1,
    release: {
      releaseId: boardContextReleaseId(publicationInputDigest),
      ...scope,
      checkpointId: "checkpoint-fixture",
      publishedAt: "2026-07-30T12:00:00.000Z"
    },
    certificationArtifact,
    publicationPlanArtifact,
    publicSnapshotDigest,
    publicationInputDigest,
    pages
  };
}

function artifactRef(kind: string, name: string): ContextArtifactRef {
  const key = [
    "context-v2",
    "tenants",
    tenantId,
    "repositories",
    "acme",
    "context",
    "builds",
    buildId,
    kind,
    name
  ].join("/");
  return {
    uri: `gs://context-artifacts/${key}`,
    key,
    contentType: "application/json",
    bytes: 100,
    sha256: fingerprint(`${kind}:${name}`),
    objectGeneration: "42"
  };
}
