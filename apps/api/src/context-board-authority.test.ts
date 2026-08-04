import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BoardState } from "@jina/board";
import {
  FileContextArtifactStore,
  PAGEINDEX_OSS_ADAPTER_NAME,
  PAGEINDEX_OSS_SOURCE_DIGEST,
  PAGEINDEX_OSS_SOURCE_PIN,
  boardPageIndexAttachmentInputDigest,
  fingerprint,
  serializeBoardPageIndexTreeArtifact,
  type BoardPageIndexAttachCommit,
  type BoardPageIndexAttachmentRecord,
  type BoardPageIndexAttachmentTransactionPort,
  type BoardPageIndexTreeArtifactV1
} from "@jina/context-engine";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const TENANT = "tenant-http-pageindex";
const REPOSITORY = "acme/context";
const BUILD_ID = "task_http_pageindex_build";
const PAGEINDEX_TASK_ID = "task_http_pageindex";
const MESSAGE_ID = "outbox_http_pageindex";
const COMMIT_SHA = "7".repeat(40);
const RELEASE_ID = "cr_0123456789abcdef0123456789abcdef";
const TASK_CREATED_AT = "2026-07-29T20:00:00.000Z";

class PageIndexAttachmentCapture implements BoardPageIndexAttachmentTransactionPort {
  input?: BoardPageIndexAttachCommit;

  async attachPageIndexAtomically(input: BoardPageIndexAttachCommit): Promise<BoardPageIndexAttachmentRecord> {
    this.input = structuredClone(input);
    return {
      releaseId: input.releaseId,
      generationId: input.releaseId,
      attachmentInputDigest: input.attachmentInputDigest,
      treeArtifactRef: input.treeArtifactRef,
      treeDigest: input.treeArtifact.metrics.treeDigest,
      buildDigest: input.treeArtifact.metrics.buildDigest,
      adapterName: input.treeArtifact.source.adapterName,
      adapterVersion: input.treeArtifact.source.adapterVersion,
      documentCount: input.treeArtifact.metrics.documentCount,
      nodeCount: input.treeArtifact.metrics.nodeCount,
      maxDepth: input.treeArtifact.metrics.maxDepth,
      attachedAt: input.attachedAt
    };
  }

  captured(): BoardPageIndexAttachCommit {
    assert.ok(this.input);
    return this.input;
  }
}

test.skip("obsolete split PageIndex task authority fixture", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "jina-context-pageindex-http-"));
  const artifactStore = new FileContextArtifactStore(artifactRoot);
  const treeArtifact = pageIndexTree();
  const treeArtifactRef = await artifactStore.put({
    tenantId: TENANT,
    repository: REPOSITORY,
    buildId: BUILD_ID,
    kind: "pageindex-tree",
    name: `${RELEASE_ID}.json`,
    contentType: "application/json",
    content: serializeBoardPageIndexTreeArtifact(treeArtifact)
  });
  const capture = new PageIndexAttachmentCapture();
  const token = "context-pageindex-http-token";
  const store = mutableStateStore({
    intakeState: { board: pageIndexBoard(), pullRequests: [] },
    devDeliverySequence: 0
  });
  const server = createApiServer({
    tenantId: TENANT,
    stateStore: store,
    internalApiToken: token,
    contextArtifactStore: artifactStore,
    contextBoardPageIndexAttachmentTransaction: capture
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const lease = {
    messageId: MESSAGE_ID,
    taskId: PAGEINDEX_TASK_ID,
    leaseId: "lease-http-pageindex",
    attempt: 1,
    writeFenceToken: "fence-http-pageindex"
  };
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };

  try {
    const stale = await fetch(`${baseUrl}/internal/context/board/pageindex/attach`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...lease,
        writeFenceToken: "wrong-fence",
        releaseId: RELEASE_ID,
        treeArtifact: treeArtifactRef
      })
    });
    assert.equal(stale.status, 409);
    assert.equal(capture.input, undefined);

    const wrongAuthority = await fetch(`${baseUrl}/internal/context/board/publish`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...lease,
        certificationArtifact: treeArtifactRef
      })
    });
    assert.equal(wrongAuthority.status, 400);
    assert.equal(capture.input, undefined);

    const response = await fetch(`${baseUrl}/internal/context/board/pageindex/attach`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...lease,
        releaseId: RELEASE_ID,
        treeArtifact: treeArtifactRef
      })
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as Record<string, unknown>;
    assert.equal(result.releaseId, RELEASE_ID);
    assert.deepEqual(result.outputArtifact, treeArtifactRef);

    const expectedScope = {
      tenantId: TENANT,
      repository: REPOSITORY,
      ref: "main",
      refSequence: 3,
      commitSha: COMMIT_SHA,
      buildId: BUILD_ID
    };
    const attachedInput = capture.captured();
    assert.deepEqual(attachedInput.scope, expectedScope);
    assert.deepEqual(attachedInput.lease, {
      taskId: PAGEINDEX_TASK_ID,
      messageId: MESSAGE_ID,
      attempt: 1,
      leaseId: lease.leaseId,
      writeFenceToken: lease.writeFenceToken,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z"
    });
    assert.deepEqual(attachedInput.treeArtifact, treeArtifact);
    assert.equal(attachedInput.treeArtifactRef.sha256, treeArtifactRef.sha256);
    assert.equal(attachedInput.attachedAt, TASK_CREATED_AT);
    assert.equal(
      attachedInput.attachmentInputDigest,
      boardPageIndexAttachmentInputDigest({
        scope: expectedScope,
        releaseId: RELEASE_ID,
        treeArtifactRef,
        treeDigest: treeArtifact.metrics.treeDigest,
        buildDigest: treeArtifact.metrics.buildDigest
      })
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

function pageIndexTree(): BoardPageIndexTreeArtifactV1 {
  const anchor = {
    tenantId: TENANT,
    repository: REPOSITORY,
    sourceType: "blob" as const,
    sourceId: "6".repeat(40),
    contentDigest: fingerprint("export const context = true;\n"),
    commitSha: COMMIT_SHA,
    pathOrUrl: "src/context.ts",
    startLine: 1,
    endLine: 1
  };
  const nodes = [
    {
      externalId: "architecture-root",
      documentId: "kr_http_architecture",
      title: "Architecture",
      summary: "Published Context architecture.",
      depth: 1,
      preorderStart: 1,
      preorderEnd: 1,
      anchors: [anchor]
    }
  ];
  const inputDigest = fingerprint({
    releaseId: RELEASE_ID,
    documents: ["kr_http_architecture"]
  });
  const treeDigest = fingerprint(nodes);
  const publicSnapshotDigest = fingerprint("public Context");
  const buildDigest = fingerprint({
    version: 1,
    releaseId: RELEASE_ID,
    publicSnapshotDigest,
    inputDigest,
    treeDigest,
    adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
    adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
    sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
    sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
  });
  return {
    version: 1,
    release: {
      releaseId: RELEASE_ID,
      tenantId: TENANT,
      repository: REPOSITORY,
      ref: "main",
      refSequence: 3,
      commitSha: COMMIT_SHA,
      checkpointId: "ec_http_pageindex",
      buildId: BUILD_ID,
      publishedAt: TASK_CREATED_AT,
      publicSnapshotDigest,
      publicationInputDigest: fingerprint("publication input")
    },
    source: {
      adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
      adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
      sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
      sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
    },
    representedDocuments: [
      {
        documentId: "kr_http_architecture",
        documentPath: "architecture.md",
        title: "Architecture",
        rootCount: 1,
        nodeCount: 1,
        maxDepth: 1
      }
    ],
    metrics: {
      documentCount: 1,
      representedDocumentCount: 1,
      rootCount: 1,
      nodeCount: 1,
      maxDepth: 1,
      documentCharacters: 128,
      inputDigest,
      treeDigest,
      buildDigest
    },
    nodes,
    diagnostics: []
  };
}

function pageIndexBoard(): BoardState {
  const baseTask = {
    title: "fixture",
    assigneeRole: "context_worker",
    dedupeKey: "fixture",
    required: true,
    createdAt: TASK_CREATED_AT,
    updatedAt: TASK_CREATED_AT
  };
  return {
    tasks: [
      {
        ...baseTask,
        id: BUILD_ID,
        type: "build-context",
        kind: "aggregate",
        status: "in_progress",
        attempt: 0,
        assigneeRole: "system",
        metadata: {
          tenantId: TENANT,
          repository: REPOSITORY,
          ref: "main",
          refSequence: 3,
          commitSha: COMMIT_SHA
        }
      },
      {
        ...baseTask,
        id: PAGEINDEX_TASK_ID,
        type: "index-context-release",
        kind: "dispatchable",
        dispatchTopic: "run-context-pageindex",
        status: "in_progress",
        attempt: 1,
        metadata: {
          tenantId: TENANT,
          repository: REPOSITORY,
          ref: "main",
          refSequence: 3,
          commitSha: COMMIT_SHA,
          contextBuildId: BUILD_ID
        }
      }
    ],
    dependencies: [],
    outbox: [
      {
        id: MESSAGE_ID,
        taskId: PAGEINDEX_TASK_ID,
        topic: "run-context-pageindex",
        idempotencyKey: `${PAGEINDEX_TASK_ID}:1`,
        status: "leased",
        payload: { taskId: PAGEINDEX_TASK_ID, attempt: 1 },
        createdAt: TASK_CREATED_AT,
        leaseId: "lease-http-pageindex",
        writeFenceToken: "fence-http-pageindex",
        leasedAt: TASK_CREATED_AT,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z"
      }
    ],
    events: []
  } as unknown as BoardState;
}

function mutableStateStore(initial: ApiSnapshot): ApiStateStore & { current(): ApiSnapshot } {
  let snapshot = structuredClone(initial);
  return {
    current: () => structuredClone(snapshot),
    async load() {
      return structuredClone(snapshot);
    },
    async ping() {},
    async hasDelivery() {
      return false;
    },
    async save(next) {
      snapshot = structuredClone(next);
      return true;
    },
    async update<T>(
      operation: (current: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>
    ) {
      const updated = await operation(structuredClone(snapshot));
      snapshot = structuredClone(updated.state);
      return { committed: true, result: updated.result };
    },
    async close() {}
  };
}
