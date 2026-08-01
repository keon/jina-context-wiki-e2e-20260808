import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeEvidenceCitation } from "../domain/knowledge.js";
import type { ContextDocument, GenerationProjection, IndexGeneration } from "../domain/projection.js";
import type { ContextEngineStore } from "../ports/context-engine-store.js";
import { ContextCatalogService } from "./catalog.js";

const anchor = {
  tenantId: "tenant-1",
  repository: "acme/widget",
  sourceType: "blob" as const,
  sourceId: "0123456789abcdef0123456789abcdef01234567",
  contentDigest: "digest-1",
  commitSha: "1111111111111111111111111111111111111111",
  pathOrUrl: "src/widget.ts",
  startLine: 1,
  endLine: 4
};

function generation(id: string, commitSha: string, createdAt: string): IndexGeneration {
  return {
    id,
    tenantId: "tenant-1",
    repository: "acme/widget",
    repositoryAccessFingerprint: "access",
    projectionInputFingerprint: "inputs",
    ref: "main",
    commitSha,
    checkpointId: `checkpoint-${id}`,
    status: "published",
    projectorVersions: {
      manifest: "v1",
      "knowledge-current": "v1",
      lexical: "v1",
      dense: "v1",
      hierarchy: "v1",
      structural: "v1",
      identity: "v1",
      acl: "v1",
      retention: "v1"
    },
    projectorStatuses: {
      manifest: "ready",
      "knowledge-current": "ready",
      lexical: "ready",
      dense: "disabled",
      hierarchy: "ready",
      structural: "skipped",
      identity: "ready",
      acl: "ready",
      retention: "ready"
    },
    capabilities: {
      sourceCompleteness: "complete",
      derivedKnowledge: "available",
      dense: "disabled",
      hierarchy: "available"
    },
    fingerprint: `fingerprint-${id}`,
    createdAt,
    publishedAt: createdAt
  };
}

function document(input: {
  id: string;
  generationId: string;
  logicalId: string;
  revisionId?: string;
  title: string;
  body: string;
  fingerprint?: string;
  sourceKind?: "code" | "provider" | "knowledge";
}): ContextDocument {
  return {
    id: input.id,
    generationId: input.generationId,
    tenantId: "tenant-1",
    repository: "acme/widget",
    ref: "main",
    commitSha: "1111111111111111111111111111111111111111",
    sourceKind: input.sourceKind ?? "knowledge",
    sourceId: input.logicalId,
    ...(input.revisionId ? { sourceRevisionId: input.revisionId } : {}),
    ...(input.sourceKind === "knowledge" || input.sourceKind === undefined ? { knowledgeKind: "component" } : {}),
    title: input.title,
    body: input.body,
    contextualText: `${input.title} summary`,
    metadata: {},
    authorityClass:
      input.sourceKind === "knowledge" || input.sourceKind === undefined ? "generated_interpretation" : "code",
    effectiveAclFingerprint: "acl",
    sourceFingerprint: input.fingerprint ?? input.revisionId ?? input.id,
    anchors: [anchor],
    projectorName: "test",
    projectorVersion: "v1",
    projectedAt: "2026-07-29T00:00:00.000Z"
  };
}

function projection(
  release: IndexGeneration,
  documents: ContextDocument[],
  hierarchyDocumentId = documents.find((candidate) => candidate.sourceKind === "knowledge")?.id
): GenerationProjection {
  return {
    generation: release,
    manifest: [],
    currentKnowledge: [],
    documents,
    fragments: documents.map((candidate, ordinal) => ({
      id: `fragment-${candidate.id}`,
      generationId: release.id,
      documentId: candidate.id,
      ordinal,
      sourceText: candidate.body,
      contextualText: candidate.contextualText,
      startOffset: 0,
      endOffset: candidate.body.length,
      anchors: candidate.anchors,
      tokenFingerprint: `tokens-${candidate.id}`
    })),
    exactIndex: [],
    hierarchyNodes: hierarchyDocumentId
      ? [
          {
            id: `node-${hierarchyDocumentId}`,
            generationId: release.id,
            documentId: hierarchyDocumentId,
            title: documents.find((candidate) => candidate.id === hierarchyDocumentId)!.title,
            summary: "How the widget cache works",
            depth: 1,
            preorderStart: 1,
            preorderEnd: 1,
            anchors: [anchor],
            adapterName: "test",
            adapterVersion: "v1"
          }
        ]
      : [],
    structuralRelations: []
  };
}

function storeFor(projections: GenerationProjection[]): ContextEngineStore {
  const byId = new Map(projections.map((candidate) => [candidate.generation.id, candidate]));
  const citations = new Map<string, KnowledgeEvidenceCitation[]>();
  for (const candidate of projections.flatMap((value) => value.documents)) {
    if (!candidate.sourceRevisionId) continue;
    citations.set(candidate.sourceRevisionId, [
      {
        id: `citation-${candidate.sourceRevisionId}`,
        revisionId: candidate.sourceRevisionId,
        ordinal: 1,
        claim: "export class WidgetCache",
        citationId: "cite_22222222222222222222",
        claimSpan: "The cache keeps widget state.",
        anchor
      }
    ]);
  }
  return {
    listGenerations: async () =>
      projections
        .map((candidate) => candidate.generation)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    getAuthorizedGeneration: async (id: string, principalId: string) =>
      principalId === "reader" ? byId.get(id) : undefined,
    getGeneration: async (id: string) => byId.get(id),
    aclFingerprintsForPrincipal: async (_tenantId: string, principalId: string) =>
      principalId === "reader" ? ["a".repeat(64)] : [],
    listCitations: async (revisionId: string) => citations.get(revisionId) ?? []
  } as unknown as ContextEngineStore;
}

test("context catalog lists and reads derived knowledge only", async () => {
  const release = generation("release-1", "1111111111111111111111111111111111111111", "2026-07-29T00:00:00.000Z");
  const derived = document({
    id: "derived-1",
    generationId: release.id,
    logicalId: "component:acme/widget:cache",
    revisionId: "revision-1",
    title: "Widget cache",
    body: "# Widget cache\n\nThe cache keeps widget state."
  });
  const raw = document({
    id: "raw-1",
    generationId: release.id,
    logicalId: "src/widget.ts",
    title: "src/widget.ts",
    body: "export class WidgetCache {}",
    sourceKind: "code"
  });
  const service = new ContextCatalogService(storeFor([projection(release, [raw, derived], derived.id)]));
  const listed = await service.listContext({
    tenantId: "tenant-1",
    principalId: "reader",
    repository: "acme/widget"
  });
  assert.deepEqual(
    listed.documents.map((candidate) => candidate.logicalId),
    ["component:acme/widget:cache"]
  );
  assert.equal(listed.tree[0]?.documentId, derived.id);
  const read = await service.readContext({
    tenantId: "tenant-1",
    principalId: "reader",
    repository: "acme/widget",
    document: derived.sourceId
  });
  assert.match(read.document.bodyMarkdown, /keeps widget state/);
  assert.equal(read.document.citations[0]?.anchor.pathOrUrl, "src/widget.ts");
  assert.equal(read.document.citations[0]?.citationId, "cite_22222222222222222222");
  assert.equal(read.document.citations[0]?.claimSpan, "The cache keeps widget state.");
});

test("prepared releases are hidden from current and explicit release access", async () => {
  const readyShape = generation(
    "release-prepared",
    "1111111111111111111111111111111111111111",
    "2026-07-29T00:00:00.000Z"
  );
  const { publishedAt: _publishedAt, ...withoutPublishedAt } = readyShape;
  const prepared: IndexGeneration = { ...withoutPublishedAt, status: "building" };
  const derived = document({
    id: "derived-prepared",
    generationId: prepared.id,
    logicalId: "component:acme/widget:prepared",
    revisionId: "revision-prepared",
    title: "Prepared context",
    body: "# Prepared context\n\nThis must remain private until PageIndex is attached."
  });
  const service = new ContextCatalogService(storeFor([projection(prepared, [derived])]));
  const access = {
    tenantId: "tenant-1",
    principalId: "reader",
    repository: "acme/widget"
  };

  assert.deepEqual(await service.listReleases(access), []);
  await assert.rejects(() => service.listContext(access), /published context release not found/);
  await assert.rejects(
    () => service.listContext({ ...access, releaseId: prepared.id }),
    /published context release not found/
  );
});

test("release listing preserves the store's authoritative current-before-history order", async () => {
  const current = generation("release-current", "2222222222222222222222222222222222222222", "2026-07-29T00:00:00.000Z");
  const historical = generation(
    "release-historical",
    "1111111111111111111111111111111111111111",
    "2026-07-30T00:00:00.000Z"
  );
  const store = storeFor([projection(current, []), projection(historical, [])]);
  store.listGenerations = async () => [current, historical];
  const releases = await new ContextCatalogService(store).listReleases({
    tenantId: "tenant-1",
    principalId: "reader",
    repository: "acme/widget"
  });

  assert.deepEqual(
    releases.map((release) => release.id),
    [current.id, historical.id]
  );
});

test("release listing authorizes metadata without hydrating release contents", async () => {
  const release = generation("release-current", "2222222222222222222222222222222222222222", "2026-07-29T00:00:00.000Z");
  const store = storeFor([projection(release, [])]);
  let hydrationCalls = 0;
  store.getAuthorizedGeneration = async () => {
    hydrationCalls += 1;
    return undefined;
  };

  const releases = await new ContextCatalogService(store).listReleases({
    tenantId: "tenant-1",
    principalId: "reader",
    repository: "acme/widget"
  });

  assert.deepEqual(
    releases.map((candidate) => candidate.id),
    [release.id]
  );
  assert.equal(hydrationCalls, 0);
});

test("public context search uses deterministic PageIndex-tree retrieval", async () => {
  const release = generation("release-1", "1111111111111111111111111111111111111111", "2026-07-29T00:00:00.000Z");
  const derived = document({
    id: "derived-1",
    generationId: release.id,
    logicalId: "component:acme/widget:cache",
    revisionId: "revision-1",
    title: "Widget cache",
    body: "# Widget cache\n\nThe cache invalidates entries after a commit."
  });
  const service = new ContextCatalogService(storeFor([projection(release, [derived])]));
  const response = await service.searchContext({
    tenantId: "tenant-1",
    principalId: "reader",
    repository: "acme/widget",
    query: "How is the cache invalidated?"
  });
  assert.equal(response.retrieval.method, "lexical_tree");
  assert.equal(response.retrieval.selector, "pageindex-lexical-tree-v1");
  assert.equal(response.results[0]?.logicalId, "component:acme/widget:cache");
  assert.ok(!("answer" in response));
});

test("context search execution records that no model selector was configured or attempted", async () => {
  const release = generation(
    "release-fallback",
    "3333333333333333333333333333333333333333",
    "2026-07-29T00:00:00.000Z"
  );
  const derived = document({
    id: "derived-fallback",
    generationId: release.id,
    logicalId: "component:acme/widget:cache",
    revisionId: "revision-fallback",
    title: "Widget cache",
    body: "# Widget cache\n\nThe cache invalidates entries after a commit."
  });
  const execution = await new ContextCatalogService(storeFor([projection(release, [derived])])).searchContextExecution({
    tenantId: "tenant-1",
    principalId: "reader",
    repository: "acme/widget",
    query: "cache invalidates commit"
  });
  assert.equal(execution.context.retrieval.method, "lexical_tree");
  assert.deepEqual(execution.selector, {
    configured: false,
    attempted: false,
    modelUsageObserved: false
  });
  assert.equal("modelUsage" in execution.context, false);
});

test("context diff compares immutable derived releases without a model", async () => {
  const first = generation("release-1", "1111111111111111111111111111111111111111", "2026-07-28T00:00:00.000Z");
  const second = generation("release-2", "2222222222222222222222222222222222222222", "2026-07-29T00:00:00.000Z");
  const oldCache = document({
    id: "old-cache",
    generationId: first.id,
    logicalId: "component:acme/widget:cache",
    revisionId: "revision-1",
    title: "Widget cache",
    body: "Old cache behavior",
    fingerprint: "old"
  });
  const newCache = document({
    id: "new-cache",
    generationId: second.id,
    logicalId: "component:acme/widget:cache",
    revisionId: "revision-2",
    title: "Widget cache",
    body: "New cache behavior",
    fingerprint: "new"
  });
  const added = document({
    id: "added",
    generationId: second.id,
    logicalId: "runbook:acme/widget:cache",
    revisionId: "revision-3",
    title: "Cache runbook",
    body: "Restart the cache",
    fingerprint: "added"
  });
  const service = new ContextCatalogService(
    storeFor([projection(first, [oldCache]), projection(second, [newCache, added], newCache.id)])
  );
  const diff = await service.diffContext({
    tenantId: "tenant-1",
    principalId: "reader",
    repository: "acme/widget",
    fromReleaseId: first.id,
    toReleaseId: second.id
  });
  assert.deepEqual(
    diff.changed.map((candidate) => candidate.after.logicalId),
    ["component:acme/widget:cache"]
  );
  assert.deepEqual(
    diff.added.map((candidate) => candidate.logicalId),
    ["runbook:acme/widget:cache"]
  );
  assert.deepEqual(diff.removed, []);
});
