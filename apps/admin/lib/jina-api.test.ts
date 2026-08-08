import assert from "node:assert/strict";
import test from "node:test";
import {
  adminApiHeaders,
  getContextMetrics,
  JinaApiError,
  listAllReleases,
  listContextBuildProgress,
  listContextBuilds,
  listContextDocuments
} from "./jina-api.ts";
import { statusTone } from "./status-tone.ts";

test("admin API requests bind the configured principal and tenant", () => {
  assert.deepEqual(
    adminApiHeaders({
      token: "internal-token",
      tenantId: "tenant-a",
      principalId: "user:admin@example.com"
    }),
    {
      accept: "application/json",
      authorization: "Bearer internal-token",
      "x-jina-principal-id": "user:admin@example.com",
      "x-jina-tenant-id": "tenant-a"
    }
  );
});

test("admin API requests default to the tenant service principal", () => {
  assert.equal(
    adminApiHeaders({ token: "internal-token", tenantId: "tenant-a" })["x-jina-principal-id"],
    "tenant:tenant-a"
  );
});

test("admin API credentials cannot be used without a bound principal", () => {
  assert.throws(() => adminApiHeaders({ token: "internal-token" }), JinaApiError);
  assert.deepEqual(adminApiHeaders({}), { accept: "application/json" });
});

test("admin preserves authoritative current-first release order for each ref", async (context) => {
  const requested: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/wiki/releases")) {
      return Response.json({
        releases: [
          {
            id: "release-current-rollback",
            repository: "acme/repository",
            ref: "main",
            commitSha: "b".repeat(40),
            completeness: "complete",
            contextStatus: "available",
            createdAt: "2026-01-01T00:00:00.000Z"
          },
          {
            id: "release-newer",
            repository: "acme/repository",
            ref: "main",
            commitSha: "a".repeat(40),
            completeness: "complete",
            contextStatus: "available",
            createdAt: "2026-01-02T00:00:00.000Z"
          }
        ]
      });
    }
    return Response.json({
      documents: [
        {
          id: "document-current",
          logicalId: "component:acme/repository:current",
          revisionId: "revision-current",
          kind: "component",
          title: "Current",
          summary: "First page",
          citations: []
        }
      ]
    });
  });

  const releases = await listAllReleases();
  assert.deepEqual(
    releases.map((release) => release.id),
    ["release-current-rollback", "release-newer"]
  );
  const documents = await listContextDocuments(releases, "acme/repository");
  assert.deepEqual(
    documents.map((document) => document.id),
    ["document-current"]
  );
  assert.ok(requested.some((url) => url.includes("repository=acme%2Frepository")));
  assert.ok(requested.some((url) => url.includes("releaseId=release-current-rollback")));
  assert.equal(
    requested.some((url) => url.includes("releaseId=release-newer")),
    false
  );
});

test("admin skips malformed release rows instead of blanking the releases section", async (context) => {
  context.mock.method(console, "warn", () => {});
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({
      releases: [
        null,
        { repository: "acme/repository", ref: "main", createdAt: "2026-01-01T00:00:00.000Z" },
        {
          id: "release-usable",
          repository: "acme/repository",
          ref: "main",
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    })
  );

  const releases = await listAllReleases();
  assert.deepEqual(
    releases.map((release) => release.id),
    ["release-usable"]
  );
  // A row that omitted its state must not be reported as healthy.
  assert.equal(releases[0]?.completeness, "unknown");
  assert.equal(releases[0]?.contextStatus, "unknown");
});

test("admin survives build rows that omit the field the sort dereferences", async (context) => {
  context.mock.method(console, "warn", () => {});
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({
      builds: [
        { id: "build-no-timestamp", repository: "acme/repository", ref: "main", status: "active", stages: [] },
        "not-a-build",
        {
          id: "build-sortable",
          repository: "acme/repository",
          ref: "main",
          refSequence: 2,
          status: "active",
          stages: [{ id: "stage-1", status: "queued" }, null],
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T01:00:00.000Z"
        }
      ]
    })
  );

  const builds = await listContextBuilds();
  assert.deepEqual(
    builds.map((build) => build.id),
    ["build-sortable", "build-no-timestamp"]
  );
  assert.deepEqual(
    builds[0]?.stages.map((stage) => stage.id),
    ["stage-1"]
  );
});

test("admin drops checkpoint progress it cannot bind to a build", async (context) => {
  context.mock.method(console, "warn", () => {});
  context.mock.method(globalThis, "fetch", async () => Response.json({ stages: [], pages: [] }));

  const progress = await listContextBuildProgress([
    {
      id: "build-1",
      repository: "acme/repository",
      ref: "main",
      refSequence: 1,
      status: "active",
      stages: [],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T01:00:00.000Z"
    }
  ]);
  assert.deepEqual(progress, []);
});

test("admin binds checkpoint progress to the exact build, repository, and ref", async (context) => {
  const requested: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/wiki/builds")) {
      return Response.json({
        builds: [
          {
            id: "build-older",
            repository: "acme/repository",
            ref: "main",
            refSequence: 1,
            status: "completed",
            stages: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T01:00:00.000Z"
          },
          {
            id: "build/newer",
            repository: "acme/repository",
            ref: "main",
            refSequence: 2,
            status: "active",
            failureCode: "daytona",
            failureReason: "The isolated execution sandbox did not complete this stage.",
            stages: [
              {
                id: "stage-1",
                type: "context.research",
                title: "Research repository",
                status: "failed",
                attempt: 3,
                failureCode: "daytona",
                failureReason: "The isolated execution sandbox did not complete this stage.",
                updatedAt: "2026-01-02T01:00:00.000Z"
              }
            ],
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T01:00:00.000Z"
          }
        ]
      });
    }
    return Response.json({
      buildId: "build/newer",
      repository: "acme/repository",
      ref: "main",
      status: "active",
      failureCode: "daytona",
      failureReason: "The isolated execution sandbox did not complete this stage.",
      stages: [
        {
          id: "stage-1",
          type: "context.research",
          title: "Research repository",
          status: "failed",
          attempt: 3,
          failureCode: "daytona",
          failureReason: "The isolated execution sandbox did not complete this stage.",
          updatedAt: "2026-01-02T01:00:00.000Z"
        }
      ],
      pages: [],
      updatedAt: "2026-01-02T01:00:00.000Z"
    });
  });

  const builds = await listContextBuilds();
  assert.deepEqual(
    builds.map((build) => build.id),
    ["build/newer", "build-older"]
  );
  const progress = await listContextBuildProgress(builds, 1);
  assert.deepEqual(
    progress.map((item) => item.buildId),
    ["build/newer"]
  );
  assert.equal(progress[0]?.failureCode, "daytona");
  assert.equal(progress[0]?.stages[0]?.failureReason, "The isolated execution sandbox did not complete this stage.");
  assert.ok(requested.some((url) => url.endsWith("/wiki/builds/build%2Fnewer/progress")));
});

test("admin rejects checkpoint progress returned for a different tenant scope", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({
      buildId: "build-1",
      repository: "other/repository",
      ref: "main",
      status: "active",
      stages: [],
      pages: [],
      updatedAt: "2026-01-02T01:00:00.000Z"
    })
  );

  await assert.rejects(
    listContextBuildProgress([
      {
        id: "build-1",
        repository: "acme/repository",
        ref: "main",
        refSequence: 2,
        status: "active",
        stages: [],
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T01:00:00.000Z"
      }
    ]),
    /mismatched progress/
  );
});

test("admin keeps the context page available when individual progress reads fail", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/build-overloaded/progress")) {
      return new Response("busy", { status: 429 });
    }
    if (url.endsWith("/build-invalid/progress")) {
      return new Response("invalid legacy build", { status: 500 });
    }
    return Response.json({
      buildId: "build-healthy",
      repository: "acme/repository",
      ref: "main",
      status: "active",
      stages: [],
      pages: [],
      updatedAt: "2026-01-02T01:00:00.000Z"
    });
  });

  const progress = await listContextBuildProgress([
    {
      id: "build-overloaded",
      repository: "acme/repository",
      ref: "main",
      refSequence: 2,
      status: "active",
      stages: [],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T01:00:00.000Z"
    },
    {
      id: "build-invalid",
      repository: "acme/repository",
      ref: "main",
      refSequence: 2,
      status: "active",
      stages: [],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T01:00:00.000Z"
    },
    {
      id: "build-healthy",
      repository: "acme/repository",
      ref: "main",
      refSequence: 1,
      status: "active",
      stages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z"
    }
  ]);

  assert.deepEqual(
    progress.map((item) => item.buildId),
    ["build-healthy"]
  );
});

test("admin keeps an unreported metrics counter absent and a measured zero at zero", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({
      // A measured zero and an absent counter must not arrive at the page
      // looking the same: only one of them says the system is idle.
      documentCount: 0
    })
  );

  const metrics = await getContextMetrics();
  assert.equal(metrics.documentCount, 0);
  assert.equal(metrics.fragmentCount, undefined);
  assert.equal(metrics.hierarchyNodeCount, undefined);
  assert.equal(metrics.publishedGenerationCount, undefined);
  // Absent, not present-and-undefined: the key is never written at all.
  assert.equal("fragmentCount" in metrics, false);
});

test("admin does not report an unrecognised build status as a completed build", async (context) => {
  context.mock.method(console, "warn", () => {});
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({
      builds: [
        {
          id: "build-blocked",
          repository: "acme/repository",
          ref: "main",
          status: "blocked",
          stages: [],
          updatedAt: "2026-01-02T02:00:00.000Z"
        },
        {
          id: "build-statusless",
          repository: "acme/repository",
          ref: "main",
          stages: [],
          updatedAt: "2026-01-02T01:00:00.000Z"
        }
      ]
    })
  );

  const builds = await listContextBuilds();
  const blocked = builds.find((build) => build.id === "build-blocked");
  const statusless = builds.find((build) => build.id === "build-statusless");
  // A status this app has never seen is shown as the API reported it, and is
  // never coloured as a healthy finished build.
  assert.equal(blocked?.status, "blocked");
  assert.equal(statusTone("blocked"), undefined);
  assert.notEqual(blocked?.status, "completed");
  // Nothing was reported, so nothing is claimed.
  assert.equal(statusless?.status, undefined);
  assert.equal(statusless && "status" in statusless, false);
});

test("admin does not fabricate zero active usage from partial quota telemetry", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ quotas: { active: { builds: 0 }, monthlyModel: { requests: 12 } } })
  );

  const metrics = await getContextMetrics();
  assert.equal(metrics.quotas?.active?.builds, 0);
  // Omitted counters and omitted quota objects both stay absent, so capacity
  // pressure cannot hide behind a reading that looks idle.
  assert.equal(metrics.quotas?.active?.modelTasks, undefined);
  assert.equal(metrics.quotas?.storage, undefined);
  assert.equal(metrics.quotas && "storage" in metrics.quotas, false);
  assert.equal(metrics.quotas?.monthlyModel?.requests, 12);
  assert.equal(metrics.quotas?.monthlyModel?.tokenLimit, undefined);
});

test("admin reports quotas the API omitted entirely as unavailable", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ documentCount: 2 }));

  const metrics = await getContextMetrics();
  assert.equal(metrics.quotas, undefined);
});
