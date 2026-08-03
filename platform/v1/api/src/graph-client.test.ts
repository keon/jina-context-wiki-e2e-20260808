import assert from "node:assert/strict";
import test from "node:test";

import { GraphApiClient, shouldRelayGithubContext } from "./graph-client.js";
import { ApiError } from "./errors.js";

const CONFIG = {
  apiUrl: "https://graph.example",
  accessToken: "token",
  timeoutMs: 1_000,
};
const INTERNAL_CONFIG = { ...CONFIG, internalToken: "internal-token" };
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CONTEXT = {
  tenantId: TENANT_ID,
  installationId: 42,
  repositories: [{ name: "omxyz/a", defaultBranch: "main" }],
};

type Stub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function recording(handler: Stub): {
  fetchImpl: typeof fetch;
  urls: string[];
  bodies: unknown[];
} {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    return handler(input, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, bodies };
}

function generation(overrides: Record<string, unknown> = {}) {
  return {
    id: "ig_1",
    repository: "omxyz/a",
    ref: "main",
    commitSha: "a".repeat(40),
    status: "published",
    derivedKnowledge: "available",
    createdAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T01:00:00.000Z",
    ...overrides,
  };
}

test("listing returns the newest published default-branch generation per repository", async () => {
  const { fetchImpl, urls } = recording(async () =>
    Response.json({
      generations: [
        generation({ id: "ig_old", publishedAt: "2026-01-01T00:00:00.000Z" }),
        generation({ id: "ig_new", publishedAt: "2026-01-02T00:00:00.000Z" }),
        // Another ref, an unpublished head, and another tenant's repository must
        // never become this repository's current graph.
        generation({ id: "ig_branch", ref: "release" }),
        generation({
          id: "ig_building",
          status: "building",
          publishedAt: "2026-01-03T00:00:00.000Z",
        }),
        generation({ id: "ig_other", repository: "omxyz/elsewhere" }),
      ],
    }),
  );
  const client = new GraphApiClient(CONFIG, fetchImpl);

  const result = await client.listGraphs(CONTEXT);

  assert.deepEqual(
    result.graphs.map((graph) => graph.id),
    ["ig_new"],
  );
  assert.equal(result.graphs[0]?.versionLabel, "main@aaaaaaa");
  assert.deepEqual(result.graphVersions.map((graph) => graph.id).sort(), [
    "ig_branch",
    "ig_building",
    "ig_new",
    "ig_old",
  ]);
  assert.deepEqual(result.repositories, [
    {
      name: "omxyz/a",
      defaultBranch: "main",
      graphId: "ig_new",
      indexing: false,
    },
  ]);
  // The tenant principal already carries authorization, so nothing synchronizes ACLs.
  assert.deepEqual(urls, [
    "https://graph.example/context/generations?limit=200",
  ]);
});

test("listing follows every generation cursor page", async () => {
  const { fetchImpl, urls } = recording(async (input) =>
    String(input).includes("cursor=")
      ? Response.json({
          generations: [
            generation({
              id: "ig_page2",
              publishedAt: "2026-02-01T00:00:00.000Z",
            }),
          ],
        })
      : Response.json({
          generations: [generation({ id: "ig_page1" })],
          nextCursor: "next-page",
        }),
  );
  const client = new GraphApiClient(CONFIG, fetchImpl);

  const result = await client.listGraphs(CONTEXT);

  assert.deepEqual(urls, [
    "https://graph.example/context/generations?limit=200",
    "https://graph.example/context/generations?limit=200&cursor=next-page",
  ]);
  assert.deepEqual(
    result.graphs.map((graph) => graph.id),
    ["ig_page2"],
  );
});

test("a generation assembles a code plane and a knowledge plane", async () => {
  const { fetchImpl, urls } = recording(async (input) => {
    const url = String(input);
    if (url.includes("/context/generations/ig_1"))
      return Response.json({ generation: generation() });
    if (url.includes("/context/structure")) {
      return Response.json({
        relations: [
          {
            id: "sr_1",
            kind: "defines",
            from: "src/server.ts",
            to: "src/server.ts#createApiServer",
            anchors: [
              {
                sourceType: "blob",
                sourceId: "b1",
                pathOrUrl: "src/server.ts",
              },
            ],
            metadata: { symbol: { name: "createApiServer", kind: "function" } },
          },
        ],
      });
    }
    if (url.includes("/context/documents/kr_1")) {
      return Response.json({
        document: {
          citations: [
            {
              revisionId: "kr_1",
              ordinal: 1,
              claim: "assembled here",
              anchor: {
                sourceType: "blob",
                sourceId: "b1",
                pathOrUrl: "src/server.ts",
              },
            },
          ],
        },
      });
    }
    if (url.includes("/context/documents")) {
      return Response.json({
        documents: [
          {
            id: "kr_1",
            logicalId: "repository:omxyz/a:architecture",
            kind: "architecture",
            title: "Architecture",
            summary: "How it fits together",
            confidence: 0.9,
            reviewStatus: "reviewed",
            commitSha: "a".repeat(40),
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  const client = new GraphApiClient(CONFIG, fetchImpl);

  const detail = await client.getGraph(CONTEXT, "ig_1");

  assert.equal(detail.id, "ig_1");
  assert.deepEqual(
    detail.nodes.map((node) => [node.id, node.kind]),
    [
      ["src/server.ts", "File"],
      ["src/server.ts#createApiServer", "Symbol:function"],
      ["kr_1", "architecture"],
    ],
  );
  assert.deepEqual(
    detail.edges.map((edge) => [edge.predicate, edge.plane]),
    [
      ["defines", "code"],
      ["cites", "knowledge"],
    ],
  );
  assert.equal(detail.nodeCount, 3);
  assert.equal(detail.edgeCount, 2);
  assert.ok(
    urls.includes(
      "https://graph.example/context/structure?repository=omxyz%2Fa&ref=main",
    ),
  );
});

test("a generation outside the selected tenant repositories is not found", async () => {
  const { fetchImpl } = recording(async () =>
    Response.json({
      generation: generation({ repository: "omxyz/elsewhere" }),
    }),
  );
  const client = new GraphApiClient(CONFIG, fetchImpl);

  await assert.rejects(
    () => client.getGraph(CONTEXT, "ig_1"),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
});

test("a question is sent as a repository-scoped context query", async () => {
  const { fetchImpl, urls, bodies } = recording(async () =>
    Response.json({
      answer: "It is created in src/server.ts.",
      generation: {
        id: "ig_served",
        ref: "main",
        commitSha: "b".repeat(40),
        derivedKnowledge: "available",
      },
      citations: [
        {
          id: "cite_1",
          title: "entrypoint",
          excerpt: "createApiServer assembles the routes",
          sourceKind: "code",
          anchors: [
            { sourceType: "blob", sourceId: "b1", pathOrUrl: "src/server.ts" },
          ],
        },
      ],
      coverage: { status: "partial", missing: ["dense retrieval"] },
    }),
  );
  const client = new GraphApiClient(CONFIG, fetchImpl);

  const result = await client.queryGraph(CONTEXT, {
    graphId: "ig_ignored",
    repository: "omxyz/a",
    query: "Where is the server created?",
  });

  // The engine routes retrieval and resolves the generation itself, so no graph
  // id is sent upstream and the answer reports what actually served it.
  assert.deepEqual(urls, ["https://graph.example/context/query"]);
  assert.deepEqual(bodies, [
    {
      repository: "omxyz/a",
      question: "Where is the server created?",
      ref: "main",
    },
  ]);
  assert.equal(result.graphId, "ig_served");
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.claims, [
    {
      text: "createApiServer assembles the routes",
      citations: [
        {
          kind: "code",
          id: "cite_1",
          repository: "omxyz/a",
          path: "src/server.ts",
        },
      ],
    },
  ]);
  assert.deepEqual(result.notes, ["Coverage gap: dense retrieval"]);
});

test("a question about a repository outside the tenant set never reaches the engine", async () => {
  const { fetchImpl, urls } = recording(async () => Response.json({}));
  const client = new GraphApiClient(CONFIG, fetchImpl);

  await assert.rejects(
    () =>
      client.queryGraph(CONTEXT, {
        graphId: "ig_1",
        repository: "omxyz/elsewhere",
        query: "anything",
      }),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  assert.deepEqual(urls, []);
});

test("a dashboard index builds the repository's default branch", async () => {
  const { fetchImpl, urls, bodies } = recording(async () =>
    Response.json({
      build: {
        id: "cb_1",
        status: "active",
        repository: "omxyz/a",
        ref: "main",
        refSequence: 3,
        commitSha: "c".repeat(40),
      },
    }),
  );
  const client = new GraphApiClient(CONFIG, fetchImpl);

  const result = await client.buildDashboardGraph(CONTEXT, {
    repository: "omxyz/a",
    requestKey: "dashboard-key",
    metadata: { source: "jina-v1-dashboard" },
  });

  assert.deepEqual(urls, ["https://graph.example/context/build"]);
  assert.deepEqual(bodies, [
    {
      repository: "omxyz/a",
      ref: "main",
      githubInstallationId: 42,
      requestKey: "dashboard-key",
    },
  ]);
  assert.deepEqual(result.task, {
    id: "cb_1",
    status: "active",
    metadata: {
      repository: "omxyz/a",
      ref: "main",
      refSequence: 3,
      commitSha: "c".repeat(40),
    },
  });
});

test("recent Context builds are tenant-scoped again before reaching the dashboard", async () => {
  const { fetchImpl, urls } = recording(async () =>
    Response.json({
      builds: [
        {
          id: "cb_failed",
          repository: "omxyz/a",
          ref: "main",
          status: "failed",
          failureCode: "worker_execution",
          failureReason: "The selected model provider could not complete the stage.",
          stages: [],
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:01:00.000Z",
        },
        {
          id: "cb_other",
          repository: "omxyz/elsewhere",
          ref: "main",
          status: "failed",
          stages: [],
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:01:00.000Z",
        },
      ],
    }),
  );
  const client = new GraphApiClient(CONFIG, fetchImpl);

  const result = await client.listContextBuilds(CONTEXT);

  assert.deepEqual(urls, ["https://graph.example/context/builds"]);
  assert.deepEqual(result.map((build) => build.id), ["cb_failed"]);
});

test("Context build progress preserves the exact V2 stage, checkpoint, and budget contract", async () => {
  const progress = {
    buildId: "cb_active",
    repository: "omxyz/a",
    ref: "main",
    status: "active",
    derivationBudgetSeconds: 5_400,
    derivationDeadlineAt: "2026-07-31T13:30:00.000Z",
    derivationTokenBudget: 12_000_000,
    consumedModelTokens: 7_500_000,
    stages: [
      {
        id: "task_1",
        type: "context_page_write",
        title: "Write architecture",
        status: "in_progress",
        attempt: 2,
        updatedAt: "2026-07-31T12:01:00.000Z",
      },
    ],
    pages: [
      {
        documentPath: "architecture",
        title: "Architecture",
        bytes: 1_024,
        validationStatus: "valid",
        diagnostics: [],
        checkpointSequence: 3,
        updatedAt: "2026-07-31T12:02:00.000Z",
      },
    ],
    updatedAt: "2026-07-31T12:02:00.000Z",
  };
  const { fetchImpl, urls } = recording(async () => Response.json(progress));
  const client = new GraphApiClient(CONFIG, fetchImpl);

  assert.deepEqual(await client.contextBuildProgress(CONTEXT, "cb_active"), progress);
  assert.deepEqual(urls, ["https://graph.example/context/builds/cb_active/progress"]);
});

test("Context build cancellation uses the internal tenant-admin endpoint with a fixed safe reason", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const response = {
    accepted: true as const,
    buildId: "cb_active",
    status: "canceled",
    canceled: true,
    changed: true,
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { url: String(input), init };
    return Response.json(response);
  }) as typeof fetch;
  const client = new GraphApiClient(INTERNAL_CONFIG, fetchImpl);

  assert.deepEqual(await client.cancelContextBuild(CONTEXT, "cb_active"), response);
  assert.equal(request?.url, "https://graph.example/internal/context/builds/cb_active/cancel");
  assert.equal(request?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    reason: "Canceled from the Jina dashboard.",
  });
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer internal-token");
  assert.equal(headers.get("x-jina-tenant-id"), TENANT_ID);
  assert.equal(headers.get("x-jina-principal-id"), `tenant:${TENANT_ID}`);
});

test("Context build cancellation fails closed without an internal credential", async () => {
  const { fetchImpl, urls } = recording(async () => Response.json({}));
  const client = new GraphApiClient(CONFIG, fetchImpl);

  await assert.rejects(
    () => client.cancelContextBuild(CONTEXT, "cb_active"),
    (error: unknown) => error instanceof ApiError && error.status === 503,
  );
  assert.deepEqual(urls, []);
});

test("a build outside the selected tenant repositories is refused before any request", async () => {
  const { fetchImpl, urls } = recording(async () => Response.json({}));
  const client = new GraphApiClient(CONFIG, fetchImpl);

  await assert.rejects(
    () =>
      client.buildDashboardGraph(CONTEXT, {
        repository: "omxyz/elsewhere",
        requestKey: "k",
        metadata: {},
      }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  assert.deepEqual(urls, []);
});

test("availability probes the repository scope and accepts only a usable Context release", async () => {
  const building = recording(async () =>
    Response.json({
      releases: [
        {
          id: "release-building",
          repository: "omxyz/a",
          ref: "main",
          commitSha: "a".repeat(40),
          createdAt: "2026-01-01T00:00:00.000Z",
          contextStatus: "unavailable",
        },
      ],
    }),
  );
  assert.equal(
    await new GraphApiClient(CONFIG, building.fetchImpl).hasRepositoryGraph(
      CONTEXT,
      "omxyz/a",
    ),
    false,
  );
  assert.deepEqual(building.urls, [
    "https://graph.example/context/releases?repository=omxyz%2Fa",
  ]);

  const published = recording(async () =>
    Response.json({
      releases: [
        {
          id: "release-published",
          repository: "omxyz/a",
          ref: "main",
          commitSha: "a".repeat(40),
          createdAt: "2026-01-01T00:00:00.000Z",
          publishedAt: "2026-01-01T01:00:00.000Z",
          contextStatus: "available",
        },
      ],
    }),
  );
  assert.equal(
    await new GraphApiClient(CONFIG, published.fetchImpl).hasRepositoryGraph(
      CONTEXT,
      "omxyz/a",
    ),
    true,
  );
});

test("availability reports an absent or unauthorized repository as unavailable", async () => {
  const { fetchImpl } = recording(async () =>
    Response.json({ error: "not found" }, { status: 404 }),
  );
  const client = new GraphApiClient(CONFIG, fetchImpl);

  assert.equal(await client.hasRepositoryGraph(CONTEXT, "omxyz/a"), false);
  // A repository the tenant does not hold never reaches the engine at all.
  assert.equal(
    await client.hasRepositoryGraph(CONTEXT, "omxyz/elsewhere"),
    false,
  );
});

test("V1 relays the exact signed GitHub delivery to the Context-only V2 endpoint", async () => {
  let forwarded: { url: string; init?: RequestInit } | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    forwarded = { url: String(input), init };
    return Response.json({ accepted: true }, { status: 202 });
  }) as typeof fetch;
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-123",
    "x-hub-signature-256": "sha256=signed",
  });
  const body = '{"action":"opened"}';

  await new GraphApiClient(CONFIG, fetchImpl).relayGithubContext(headers, body);

  assert.equal(forwarded?.url, "https://graph.example/context/webhooks/github");
  assert.equal(forwarded?.init?.body, body);
  const sent = new Headers(forwarded?.init?.headers);
  assert.equal(sent.get("authorization"), null);
  assert.equal(sent.get("x-github-event"), "pull_request");
  assert.equal(sent.get("x-github-delivery"), "delivery-123");
  assert.equal(sent.get("x-hub-signature-256"), "sha256=signed");
});

test("V1 relays only new commits, pull requests, and issues to Context", async () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["push", { ref: "refs/heads/main", after: "1".repeat(40), deleted: false }, true],
    ["push", { ref: "refs/tags/v1", after: "1".repeat(40), deleted: false }, false],
    ["push", { ref: "refs/heads/main", after: "0".repeat(40), deleted: true }, false],
    ["pull_request", { action: "opened" }, true],
    ["pull_request", { action: "synchronize" }, true],
    ["pull_request", { action: "closed" }, false],
    ["issues", { action: "opened", issue: { number: 1 } }, true],
    ["issues", { action: "opened", issue: { number: 1, pull_request: {} } }, false],
    ["issues", { action: "edited", issue: { number: 1 } }, false],
    ["issue_comment", { action: "created" }, false],
    ["pull_request_review", { action: "submitted" }, false],
    ["pull_request_review_thread", { action: "resolved" }, false],
    ["check_suite", { action: "completed" }, false],
  ];

  for (const [event, payload, expected] of cases) {
    assert.equal(shouldRelayGithubContext(event, JSON.stringify(payload)), expected, event);
  }
  assert.equal(shouldRelayGithubContext("push", "not-json"), false);
});

test("an irrelevant GitHub event does not call V2", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ accepted: true }, { status: 202 });
  }) as typeof fetch;
  const headers = new Headers({ "x-github-event": "pull_request_review" });

  await new GraphApiClient(CONFIG, fetchImpl).relayGithubContext(
    headers,
    JSON.stringify({ action: "submitted" }),
  );

  assert.equal(calls, 0);
});

test("review access returns a direct V2 MCP credential bound to the tenant and repository", async () => {
  let sentHeaders: Headers | undefined;
  const { fetchImpl, urls, bodies } = recording(async (_input, init) => {
    sentHeaders = new Headers(init?.headers);
    return Response.json({
      repository: "omxyz/a",
      mcpPath: "/mcp",
      secret: "jina_atk_secret",
      token: { expiresAt: "2026-08-01T00:00:00.000Z" },
    }, { status: 201 });
  });
  const access = await new GraphApiClient(INTERNAL_CONFIG, fetchImpl).createReviewMcpAccess(
    CONTEXT,
    { repository: "omxyz/a", reviewRunId: "run-123" },
  );

  assert.deepEqual(urls, ["https://graph.example/internal/context/review-access"]);
  assert.deepEqual(bodies, [{ repository: "omxyz/a", reviewRunId: "run-123" }]);
  assert.equal(sentHeaders?.get("authorization"), "Bearer internal-token");
  assert.equal(sentHeaders?.get("x-jina-tenant-id"), TENANT_ID);
  assert.deepEqual(access, {
    mcpUrl: "https://graph.example/mcp",
    accessToken: "jina_atk_secret",
    expiresAt: "2026-08-01T00:00:00.000Z",
  });
});

test("dashboard Context maps the current V2 release catalog and reads the exact release", async () => {
  const { fetchImpl, urls } = recording(async (input) => {
    const url = String(input);
    if (url.endsWith("/context/releases")) {
      return Response.json({
        releases: [{
          id: "release-1",
          repository: "omxyz/a",
          ref: "pull/2/head",
          commitSha: "b".repeat(40),
          createdAt: "2026-07-31T00:00:00.000Z",
          publishedAt: "2026-07-31T00:10:00.000Z",
          contextStatus: "available",
        }],
      });
    }
    if (url.includes("/context/list?")) {
      return Response.json({
        documents: [{
          id: "document-1",
          logicalId: "topic:omxyz/a:architecture/overview",
          revisionId: "revision-1",
          title: "Architecture",
          summary: "How the system fits together.",
          citations: [],
        }],
      });
    }
    if (url.includes("/context/read?")) {
      return Response.json({
        release: {
          id: "release-1",
          repository: "omxyz/a",
          ref: "main",
          commitSha: "b".repeat(40),
          createdAt: "2026-07-31T00:00:00.000Z",
          publishedAt: "2026-07-31T00:10:00.000Z",
          contextStatus: "available",
        },
        document: {
          id: "document-1",
          logicalId: "topic:omxyz/a:architecture/overview",
          revisionId: "revision-1",
          title: "Architecture",
          summary: "How the system fits together.",
          bodyMarkdown: "# Architecture\n\nSystem details.",
          citations: [{
            claim: "The API owns admission.",
            anchor: {
              sourceType: "blob",
              sourceId: "src/server.ts",
              repository: "omxyz/a",
              commitSha: "b".repeat(40),
              pathOrUrl: "src/server.ts",
              startLine: 10,
              endLine: 20,
            },
          }],
        },
      });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  const client = new GraphApiClient(CONFIG, fetchImpl);
  const documents = await client.listDocuments(CONTEXT);
  assert.deepEqual(documents, [{
    id: "document-1",
    releaseId: "release-1",
    logicalId: "topic:omxyz/a:architecture/overview",
    repository: "omxyz/a",
    ref: "pull/2/head",
    kind: "topic",
    title: "Architecture",
    summary: "How the system fits together.",
    reviewStatus: "published",
    commitSha: "b".repeat(40),
    createdAt: "2026-07-31T00:10:00.000Z",
  }]);

  const document = await client.getDocument(CONTEXT, {
    repository: "omxyz/a",
    releaseId: "release-1",
    documentId: "document-1",
  });
  assert.match(document.bodyMarkdown, /System details/);
  assert.deepEqual(document.citations[0], {
    sourceType: "blob",
    sourceId: "src/server.ts",
    repository: "omxyz/a",
    commitSha: "b".repeat(40),
    path: "src/server.ts",
    startLine: 10,
    endLine: 20,
  });
  assert.ok(urls.some((url) => url.includes("releaseId=release-1")));
});

test("a board overview is loaded under the original tenant identity", async () => {
  let seenHeaders: Headers | undefined;
  const { fetchImpl, urls } = recording(async (_input, init) => {
    seenHeaders = new Headers(init?.headers);
    return Response.json({ generations: [] });
  });
  const client = new GraphApiClient(CONFIG, fetchImpl);

  await client.getWorkOverview(CONTEXT);

  assert.deepEqual(urls, ["https://graph.example/overview"]);
  assert.equal(seenHeaders?.get("authorization"), "Bearer token");
  assert.equal(seenHeaders?.get("x-jina-tenant-id"), TENANT_ID);
  assert.equal(seenHeaders?.get("x-jina-principal-id"), `tenant:${TENANT_ID}`);
});

test("an upstream work overview aborts when its caller disconnects", async () => {
  const controller = new AbortController();
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (init?.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  const client = new GraphApiClient(CONFIG, fetchImpl);

  await assert.rejects(
    () => client.getWorkOverview(CONTEXT, controller.signal),
    (error: unknown) => error instanceof ApiError && error.status === 504,
  );
});

test("every entry point fails closed when the engine is not configured", async () => {
  const client = new GraphApiClient(undefined);

  await assert.rejects(
    () => client.listGraphs(CONTEXT),
    (error: unknown) => error instanceof ApiError && error.status === 503,
  );
  assert.equal(client.configured, false);
});

const DELEGATING_CONFIG = {
  apiUrl: "https://graph.example",
  accessToken: "token",
  timeoutMs: 1_000,
  internalToken: "graph-internal",
  delegatedTokenTtlMinutes: 15,
};

/** Answers a mint with a distinct secret each time, and records every call. */
function mintingGraph(handler: Stub): {
  fetchImpl: typeof fetch;
  urls: string[];
  minted: string[];
} {
  const urls: string[] = [];
  const minted: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url.endsWith("/internal/context/tokens")) {
      const secret = `jina_atk_${"a".repeat(42)}${minted.length}`;
      minted.push(secret);
      return Response.json(
        { secret, token: { id: `atk_${minted.length}` } },
        { status: 201 },
      );
    }
    return handler(input, init);
  }) as typeof fetch;
  return { fetchImpl, urls, minted };
}

test("reads present a delegated token that names the tenant, not the shared credential", async () => {
  let seen: Headers | undefined;
  const { fetchImpl, urls, minted } = mintingGraph(async (_input, init) => {
    seen = new Headers(init?.headers);
    return Response.json({ generations: [] });
  });
  const client = new GraphApiClient(DELEGATING_CONFIG, fetchImpl);

  await client.listGraphs(CONTEXT);

  // Minted once, for this tenant, as this tenant's principal.
  assert.equal(urls[0], "https://graph.example/internal/context/tokens");
  assert.equal(minted.length, 1);
  // And presented instead of the shared credential. This is the whole fix: the
  // static token is bound server-side to one tenant and principal, so the
  // principal this client forwards never matched it.
  assert.equal(seen?.get("authorization"), `Bearer ${minted[0]}`);
  assert.notEqual(seen?.get("authorization"), "Bearer token");
  // The identity headers stay, and now agree with the token's own row.
  assert.equal(seen?.get("x-jina-tenant-id"), TENANT_ID);
  assert.equal(seen?.get("x-jina-principal-id"), `tenant:${TENANT_ID}`);
});

test("a delegated token is cached per tenant and minted once for concurrent misses", async () => {
  const { fetchImpl, urls, minted } = mintingGraph(async () =>
    Response.json({ generations: [] }),
  );
  const client = new GraphApiClient(DELEGATING_CONFIG, fetchImpl);

  await Promise.all([
    client.listGraphs(CONTEXT),
    client.listGraphs(CONTEXT),
    client.listGraphs(CONTEXT),
  ]);
  await client.listGraphs(CONTEXT);

  assert.equal(minted.length, 1);
  assert.equal(
    urls.filter((url) => url.endsWith("/internal/context/tokens")).length,
    1,
  );

  // A second tenant gets its own token rather than reusing the first.
  const other = {
    ...CONTEXT,
    tenantId: "22222222-2222-4222-8222-222222222222",
  };
  await client.listGraphs(other);
  assert.equal(minted.length, 2);
});

test("a delegated token is renewed before it expires, and the old one revoked", async () => {
  let clock = 1_000_000;
  const { fetchImpl, urls, minted } = mintingGraph(async () =>
    Response.json({ generations: [] }),
  );
  const client = new GraphApiClient(DELEGATING_CONFIG, fetchImpl, () => clock);

  await client.listGraphs(CONTEXT);
  assert.equal(minted.length, 1);

  // Still inside the lifetime: no new mint.
  clock += 10 * 60_000;
  await client.listGraphs(CONTEXT);
  assert.equal(minted.length, 1);

  // Past the renewal margin: a new token, and the previous one revoked rather
  // than left to accumulate.
  clock += 5 * 60_000;
  await client.listGraphs(CONTEXT);
  assert.equal(minted.length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    urls.some(
      (url) =>
        url === "https://graph.example/internal/context/tokens/atk_1/revoke",
    ),
  );
});

test("a revoked delegated token is dropped and re-minted once rather than failing the request", async () => {
  let rejectFirstSecret = false;
  const { fetchImpl, minted } = mintingGraph(async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    if (rejectFirstSecret && authorization === `Bearer ${minted[0]}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    }
    return Response.json({ generations: [] });
  });
  const client = new GraphApiClient(DELEGATING_CONFIG, fetchImpl);

  await client.listGraphs(CONTEXT);
  assert.equal(minted.length, 1);

  // Revoked out from under us: the answer is indistinguishable from an unknown
  // token, so the client forgets it and mints once more.
  rejectFirstSecret = true;
  await client.listGraphs(CONTEXT);
  assert.equal(minted.length, 2);
});

test("without an internal credential the static token is still used, unchanged", async () => {
  let seen: Headers | undefined;
  const { fetchImpl, urls } = mintingGraph(async (_input, init) => {
    seen = new Headers(init?.headers);
    return Response.json({ generations: [] });
  });
  const client = new GraphApiClient(CONFIG, fetchImpl);

  await client.listGraphs(CONTEXT);

  assert.equal(seen?.get("authorization"), "Bearer token");
  assert.equal(
    urls.some((url) => url.endsWith("/internal/context/tokens")),
    false,
  );
});

test("a graph service that cannot mint falls back to the static token rather than failing", async () => {
  let seen: Headers | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // What an older graph service answers: the route is not reachable.
    if (url.endsWith("/internal/context/tokens"))
      return new Response("{}", { status: 404 });
    seen = new Headers(init?.headers);
    return Response.json({ generations: [] });
  }) as typeof fetch;
  const client = new GraphApiClient(DELEGATING_CONFIG, fetchImpl);

  await client.listGraphs(CONTEXT);

  // Deployable in either order: behaviour is exactly today's until both sides
  // are in place, and no request fails because minting is unavailable.
  assert.equal(seen?.get("authorization"), "Bearer token");
});

test("a delegated token carries context:build, so graph builds are not refused", async () => {
  let mintBody: Record<string, unknown> | undefined;
  let buildAuth: string | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/internal/context/tokens")) {
      mintBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(
        { secret: "jina_atk_build", token: { id: "atk_b" } },
        { status: 201 },
      );
    }
    buildAuth = new Headers(init?.headers).get("authorization") ?? undefined;
    return Response.json({ build: { id: "cb_1" } }, { status: 202 });
  }) as typeof fetch;
  const client = new GraphApiClient(DELEGATING_CONFIG, fetchImpl);

  await client.buildDashboardGraph(CONTEXT, {
    repository: "omxyz/a",
    requestKey: "rk_1",
    metadata: {},
  });

  // /context/build demands `context:build`. Minting read-and-query only would
  // have made every dashboard index and review rebuild a 502.
  assert.deepEqual(mintBody?.scopes, [
    "context:read",
    "context:query",
    "context:build",
  ]);
  assert.equal(buildAuth, "Bearer jina_atk_build");
});

test("the board plane keeps the service credential, because a scoped token cannot reach it", async () => {
  let overviewAuth: string | undefined;
  const { fetchImpl, urls } = mintingGraph(async (_input, init) => {
    overviewAuth = new Headers(init?.headers).get("authorization") ?? undefined;
    return Response.json({
      board: { tasks: [], dependencies: [], outbox: [] },
      events: [],
    });
  });
  const client = new GraphApiClient(DELEGATING_CONFIG, fetchImpl);

  await client.getWorkOverview(CONTEXT);

  // /overview is internal-only on the graph service: a delegated token is
  // refused there with 403, so this route must not use one.
  assert.equal(overviewAuth, "Bearer graph-internal");
  assert.equal(
    urls.some((url) => url.endsWith("/internal/context/tokens")),
    false,
  );
});

test("a mint that consumes the whole timeout still leaves the request its own deadline", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/internal/context/tokens")) {
      // Longer than the configured timeout: minting gives up and the caller
      // falls back. A shared deadline would have left nothing for the request.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return new Response("{}", { status: 504 });
    }
    assert.equal(
      init?.signal?.aborted,
      false,
      "the request must not inherit an already-aborted signal",
    );
    return Response.json({ generations: [] });
  }) as typeof fetch;
  const client = new GraphApiClient(
    { ...DELEGATING_CONFIG, timeoutMs: 50 },
    fetchImpl,
  );

  // Succeeds on the static credential rather than returning 504.
  const result = await client.listGraphs(CONTEXT);
  assert.deepEqual(result.graphs, []);
});

test("a 401 arriving late still gets a retry with a live signal", async () => {
  let attempts = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/internal/context/tokens")) {
      return Response.json(
        { secret: `jina_atk_${attempts}`, token: { id: `atk_${attempts}` } },
        { status: 201 },
      );
    }
    attempts += 1;
    if (attempts === 1) {
      // Burns most of the budget, then rejects — the case that used to strand
      // the retry on an expired controller.
      await new Promise((resolve) => setTimeout(resolve, 45));
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    }
    assert.equal(
      init?.signal?.aborted,
      false,
      "the retry must carry its own deadline",
    );
    return Response.json({ generations: [] });
  }) as typeof fetch;
  const client = new GraphApiClient(
    { ...DELEGATING_CONFIG, timeoutMs: 50 },
    fetchImpl,
  );

  const result = await client.listGraphs(CONTEXT);
  assert.deepEqual(result.graphs, []);
  assert.equal(attempts, 2);
});
