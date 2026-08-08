import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ContextEngineStore, GenerationProjection } from "@jina/context-engine";
import { ContextQuotaService, InMemoryContextQuotaStore } from "./context-quotas.js";
import type { WikiReleaseIdentity, WikiReleaseQueryStore } from "./context-wiki-query.js";
import { createApiServer } from "./server.js";

const tenantId = "tenant-search-accounting";
const principalId = "user:search@example.com";
const repository = "acme/widget";

test("HTTP and MCP Context searches consume query quota but never model quota", async () => {
  const quota = quotaService();
  await withServer(projection(true), quota, async (baseUrl) => {
    const first = await search(baseUrl, "caller-reused-id");
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.deepEqual(record(first.body.retrieval), {
      method: "lexical_tree",
      selector: "pageindex-lexical-tree-v1"
    });
    assert.equal("modelUsage" in first.body, false);

    const replayedCallerId = await search(baseUrl, "caller-reused-id");
    assert.equal(replayedCallerId.response.status, 200, JSON.stringify(replayedCallerId.body));

    let snapshot = await quota.snapshot(tenantId);
    assert.equal(snapshot.rates.query.used, 1, "query-rate idempotency remains keyed by the caller request id");
    assert.equal(snapshot.monthlyModel.requests, 0);
    assert.equal(snapshot.monthlyModel.inputTokens, 0);
    assert.equal(snapshot.monthlyModel.cachedInputTokens, 0);
    assert.equal(snapshot.monthlyModel.outputTokens, 0);
    assert.equal(snapshot.active.modelTasks, 0);

    const client = new Client({ name: "context-search-accounting", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: headers("mcp-query-id") }
    });
    try {
      await client.connect(transport as unknown as Transport);
      const result = await client.callTool({
        name: "search_context",
        arguments: { repository, query: "How is the cache invalidated?" }
      });
      assert.notEqual(result.isError, true);
      const content = record(result.structuredContent ?? {});
      assert.equal("modelUsage" in content, false);
      assert.equal(record(content.retrieval).method, "lexical_tree");
    } finally {
      await client.close();
    }
    snapshot = await quota.snapshot(tenantId);
    assert.equal(snapshot.monthlyModel.requests, 0);
    assert.equal(snapshot.monthlyModel.inputTokens, 0);
    assert.equal(snapshot.monthlyModel.outputTokens, 0);

    for (const path of [
      `/wiki/list?repository=${repository}`,
      `/wiki/read?repository=${repository}&document=derived-1`,
      `/wiki/diff?repository=${repository}&fromReleaseId=release-1&toReleaseId=release-1`
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: headers() });
      assert.equal(response.status, 200, `${path}: ${await response.text()}`);
    }
    const afterReads = await quota.snapshot(tenantId);
    assert.equal(afterReads.monthlyModel.requests, 0);
    assert.equal(afterReads.monthlyModel.inputTokens, 0);
  });
});

test("deterministic search remains model-free when the published hierarchy is empty", async () => {
  const emptyQuota = quotaService();
  await withServer(projection(false), emptyQuota, async (baseUrl) => {
    const empty = await search(baseUrl);
    assert.equal(empty.response.status, 200);
    assert.deepEqual(record(empty.body.retrieval), {
      method: "lexical_tree",
      selector: "pageindex-lexical-tree-v1"
    });
    assert.deepEqual(empty.body.results, []);
    const snapshot = await emptyQuota.snapshot(tenantId);
    assert.equal(snapshot.active.modelTasks, 0);
    assert.equal(snapshot.monthlyModel.inputTokens, 0);
    assert.equal(snapshot.monthlyModel.outputTokens, 0);
    assert.equal(snapshot.monthlyModel.reservedTokens, 0);
  });
});

test("query-rate limits remain enforced without consuming model quota", async () => {
  const quota = quotaService({
    queryRequestsPerWindow: 1,
    monthlyModelRequests: 1
  });
  await withServer(projection(true), quota, async (baseUrl) => {
    const accepted = await search(baseUrl, "same-query-operation");
    assert.equal(accepted.response.status, 200);

    const replayed = await search(baseUrl, "same-query-operation");
    assert.equal(replayed.response.status, 200);

    const queryLimited = await search(baseUrl, "different-query-operation");
    assert.equal(queryLimited.response.status, 429);
    assert.match(String(queryLimited.body.error), /query rate limit/);
    const snapshot = await quota.snapshot(tenantId);
    assert.equal(snapshot.monthlyModel.requests, 0);
    assert.equal(snapshot.active.modelTasks, 0);
  });
});

test("HTTP wiki queries resolve strict selectors, locale, audit, ask, and export against one immutable release", async () => {
  await withServer(
    projection(true),
    quotaService(),
    async (baseUrl) => {
      const selected = await fetch(`${baseUrl}/wiki/list?repository=${repository}&branch=main&locale=en`, {
        headers: headers()
      });
      assert.equal(selected.status, 200, await selected.clone().text());
      const selectedBody = record(await selected.json());
      assert.equal(record(selectedBody.release).releaseId, "release-1");
      assert.equal(record(selectedBody.release).locale, "en");
      assert.equal(record(selectedBody.audit).quality, "passed");

      const ambiguous = await fetch(
        `${baseUrl}/wiki/list?repository=${repository}&branch=main&commitSha=${"1".repeat(40)}`,
        { headers: headers() }
      );
      assert.equal(ambiguous.status, 400);

      const wrongLocale = await fetch(
        `${baseUrl}/wiki/read?repository=${repository}&releaseId=release-1&locale=fr&document=derived-1`,
        { headers: headers() }
      );
      assert.equal(wrongLocale.status, 400);

      const searched = await fetch(`${baseUrl}/wiki/search`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ repository, selector: { commitSha: "1".repeat(40) }, locale: "en", query: "cache" })
      });
      assert.equal(searched.status, 200, await searched.clone().text());
      assert.equal(record(record(await searched.json()).release).commitSha, "1".repeat(40));

      const asked = await fetch(`${baseUrl}/wiki/ask`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ repository, selector: { branch: "main" }, question: "How is the cache invalidated?" })
      });
      assert.equal(asked.status, 200, await asked.clone().text());
      const answer = record(await asked.json());
      assert.match(String(answer.answer), /cache invalidates/i);
      assert.equal(record(answer.release).releaseId, "release-1");
      assert.equal(record(answer.audit).quality, "passed");

      const exported = await fetch(`${baseUrl}/wiki/export?repository=${repository}&releaseId=release-1`, {
        headers: headers()
      });
      assert.equal(exported.status, 200, await exported.clone().text());
      assert.match(exported.headers.get("content-disposition") ?? "", /release-1-en\.wiki\.json/);
      assert.equal(record(record(await exported.json()).bundle).version, 1);
    },
    true
  );
});

function quotaService(defaults: Record<string, number> = {}): ContextQuotaService {
  return new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: {
      defaultModelTaskReservationTokens: 100,
      monthlyModelTokens: 100_000,
      ...defaults
    }
  });
}

async function withServer(
  value: GenerationProjection,
  quota: ContextQuotaService,
  assertion: (baseUrl: string) => Promise<void>,
  wikiQuery = false
): Promise<void> {
  const store = {
    async listGenerations() {
      return [structuredClone(value.generation)];
    },
    async getGeneration(generationId: string) {
      return generationId === value.generation.id ? structuredClone(value) : undefined;
    },
    async listCitationsForRevisions() {
      return new Map();
    },
    async close() {
      return undefined;
    }
  } as unknown as ContextEngineStore;
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    contextStore: store,
    contextQuotaService: quota,
    tenantAdminPrincipalIds: [principalId],
    ...(wikiQuery
      ? {
          contextWikiReleaseQueryStore: wikiQueryStore(value.generation),
          contextWikiContentBundleReader: {
            async get() {
              return {
                version: 1 as const,
                publicSnapshotDigest: "b".repeat(64),
                pages: [
                  {
                    documentPath: "cache.md",
                    bodyMarkdown: "# Cache\n",
                    bodySha256: "c".repeat(64)
                  }
                ]
              };
            }
          },
          contextWikiAuditPolicyVersion: "audit-v2"
        }
      : {})
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assertion(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function wikiQueryStore(generation: GenerationProjection["generation"]): WikiReleaseQueryStore {
  const release: WikiReleaseIdentity = {
    releaseId: generation.id,
    releaseFamilyId: "family-1",
    generationId: generation.id,
    repository,
    ref: "refs/heads/main",
    refSequence: 1,
    commitSha: generation.commitSha,
    publicSnapshotDigest: "b".repeat(64),
    locale: "en",
    scopeKind: "branch",
    scopeKey: "main",
    publishedAt: generation.publishedAt!,
    contentBundleArtifact: {
      version: 1,
      tenantId,
      repository,
      publicSnapshotDigest: "b".repeat(64),
      bundleSha256: "a".repeat(64),
      uri: "gs://wiki/release-1.json",
      key: "wiki/release-1.json",
      contentType: "application/json",
      bytes: 42,
      sha256: "a".repeat(64),
      objectGeneration: "1"
    }
  };
  return {
    async findPublishedWikiRelease(input) {
      return input.releaseId === release.releaseId ? release : undefined;
    },
    async findCurrentPublishedWikiRelease(input) {
      return input.ref === release.ref && input.locale === release.locale ? release : undefined;
    },
    async findNewestPublishedWikiReleaseForCommit(input) {
      return input.commitSha === release.commitSha && input.locale === release.locale ? release : undefined;
    },
    async listPublishedWikiReleases() {
      return [release];
    },
    async latestWikiAuditSummary(input) {
      return input.auditPolicyVersion === "audit-v2"
        ? {
            quality: "passed" as const,
            auditId: "audit-1",
            auditPolicyVersion: "audit-v2",
            auditedAt: "2026-08-08T00:00:00.000Z"
          }
        : undefined;
    }
  };
}

async function search(
  baseUrl: string,
  requestId?: string
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/wiki/search`, {
    method: "POST",
    headers: headers(requestId),
    body: JSON.stringify({ repository, query: "How is the cache invalidated?" })
  });
  return { response, body: record(await response.json()) };
}

function headers(requestId?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-jina-tenant-id": tenantId,
    "x-jina-principal-id": principalId,
    ...(requestId ? { "x-request-id": requestId } : {})
  };
}

function projection(withHierarchy: boolean): GenerationProjection {
  return {
    generation: {
      id: "release-1",
      tenantId,
      repository,
      ref: "main",
      commitSha: "1".repeat(40),
      checkpointId: "checkpoint-1",
      status: "published",
      capabilities: {
        sourceCompleteness: "complete",
        derivedKnowledge: "available",
        hierarchy: withHierarchy ? "available" : "disabled"
      },
      fingerprint: "release-fingerprint",
      createdAt: "2026-07-29T00:00:00.000Z",
      publishedAt: "2026-07-29T00:00:01.000Z"
    },
    manifest: [],
    currentKnowledge: [],
    documents: [
      {
        id: "derived-1",
        generationId: "release-1",
        tenantId,
        repository,
        ref: "main",
        commitSha: "1".repeat(40),
        sourceKind: "knowledge",
        sourceId: "component:acme/widget:cache",
        sourceRevisionId: "revision-1",
        knowledgeKind: "component",
        title: "Widget cache",
        body: "# Widget cache\n\nThe cache invalidates entries after a commit.",
        contextualText: "Widget cache invalidation after commits",
        metadata: {},
        authorityClass: "derived",
        effectiveAclFingerprint: "access",
        sourceFingerprint: "document-fingerprint",
        anchors: []
      }
    ],
    fragments: [
      {
        id: "fragment-1",
        generationId: "release-1",
        documentId: "derived-1",
        ordinal: 0,
        sourceText: "The cache invalidates entries after a commit.",
        contextualText: "Widget cache invalidation after commits",
        startOffset: 0,
        endOffset: 45,
        anchors: [],
        tokenFingerprint: "fragment-fingerprint"
      }
    ],
    exactIndex: [],
    hierarchyNodes: withHierarchy
      ? [
          {
            id: "node-1",
            generationId: "release-1",
            documentId: "derived-1",
            title: "Widget cache",
            summary: "Cache invalidation behavior",
            depth: 0,
            preorderStart: 0,
            preorderEnd: 1,
            anchors: [],
            adapterName: "markdown",
            adapterVersion: "v1"
          }
        ]
      : [],
    structuralRelations: []
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
