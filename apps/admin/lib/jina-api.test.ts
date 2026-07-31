import assert from "node:assert/strict";
import test from "node:test";
import {
  adminApiHeaders,
  JinaApiError,
  listAllReleases,
  listContextBuildProgress,
  listContextBuilds,
  listContextDocuments
} from "./jina-api.ts";

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
    if (url.endsWith("/context/releases")) {
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

test("admin binds checkpoint progress to the exact build, repository, and ref", async (context) => {
  const requested: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/context/builds")) {
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
            status: "failed",
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
      status: "failed",
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
  assert.ok(requested.some((url) => url.endsWith("/context/builds/build%2Fnewer/progress")));
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

test("admin keeps the context page available when one progress read is backpressured", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/build-overloaded/progress")) {
      return new Response("busy", { status: 429 });
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
