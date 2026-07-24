import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStatus, buildTrigger, filterGraphs, pipelineMetricSeries, tenantSummaries } from "./admin-data.ts";
import type { AdminGraphBuild, AdminGraphSummary, AdminOperations } from "./jina-api.ts";

const NOW = new Date("2026-07-23T12:00:00.000Z");

test("graph filters combine tenant, repository, ref, query, and time", () => {
  const graphs = [
    graph("tenant-a", "omxyz/jina", "main", "2026-07-23T11:00:00.000Z"),
    graph("tenant-b", "external/repo", "develop", "2026-07-20T11:00:00.000Z")
  ];
  assert.deepEqual(
    filterGraphs(
      graphs,
      { tenantId: "tenant-a", repository: "omxyz/jina", ref: "main", query: "JINA", generated: "day" },
      NOW
    ).map((value) => value.repository),
    ["omxyz/jina"]
  );
});

test("tenant summaries preserve real tenant IDs and legacy installation coverage", () => {
  const operations = operation([build("done", "2026-07-23T10:00:00.000Z", { githubInstallationId: 140435029 })]);
  const summaries = tenantSummaries(
    [graph("tenant-a", "omxyz/jina", "main", "2026-07-23T11:00:00.000Z")],
    operations,
    NOW
  );
  assert.equal(summaries[0]?.tenantId, "tenant-a");
  assert.equal(summaries[0]?.name, "omxyz");
  assert.deepEqual(summaries[0]?.githubConnections, [
    {
      installationId: "140435029",
      login: "GitHub installation 140435029",
      type: "Organization",
      repositoryCount: 0
    }
  ]);
  assert.equal(summaries[0]?.status, "active");
});

test("tenant summaries prefer authoritative Jina identity and connected repository counts", () => {
  const base = operation([]);
  const operations: AdminOperations = {
    ...base,
    tenants: [
      {
        ...base.tenants[0]!,
        name: "Acme Workspace",
        kind: "team",
        repositoryCount: 12,
        githubConnections: [
          { installationId: "101", login: "acme-inc", type: "Organization", repositoryCount: 7 },
          { installationId: "202", login: "acme-labs", type: "Organization", repositoryCount: 5 }
        ]
      }
    ]
  };
  const summary = tenantSummaries([], operations, NOW)[0];
  assert.equal(summary?.name, "Acme Workspace");
  assert.equal(summary?.kind, "team");
  assert.equal(summary?.repositoryCount, 12);
  assert.deepEqual(
    summary?.githubConnections.map((connection) => connection.login),
    ["acme-inc", "acme-labs"]
  );
  assert.equal(summary?.status, "inactive");
});

test("tenant summaries keep zero-repository tenants inactive despite recent legacy activity", () => {
  const recentBuild = build("done", "2026-07-23T11:00:00.000Z", {});
  const base = operation([recentBuild]);
  const operations: AdminOperations = {
    ...base,
    tenants: [{ ...base.tenants[0]!, repositoryCount: 0 }]
  };

  const summary = tenantSummaries(
    [graph("tenant-a", "omxyz/jina", "main", "2026-07-23T11:30:00.000Z")],
    operations,
    NOW
  )[0];

  assert.equal(summary?.repositoryCount, 0);
  assert.equal(summary?.status, "inactive");
});

test("build labels are stable and metrics use real workflow timestamps", () => {
  const first = build("done", "2026-07-23T10:00:00.000Z", { source: "github webhook" });
  const second = build("failed", "2026-07-23T11:00:00.000Z", {});
  assert.equal(buildStatus(first.status), "Succeeded");
  assert.equal(buildTrigger(first), "Webhook");
  const series = pipelineMetricSeries(operation([first, second]), "24h");
  assert.equal(series.generations, 2);
  assert.equal(series.successRate, 0.5);
  assert.equal(
    series.succeeded.reduce((sum, value) => sum + value, 0),
    1
  );
  assert.equal(
    series.failed.reduce((sum, value) => sum + value, 0),
    1
  );
});

test("throughput uses completion time and queue depth is point-in-time", () => {
  const crossingWindow = {
    ...build("done", "2026-07-20T10:00:00.000Z", {}),
    updatedAt: "2026-07-23T11:00:00.000Z"
  };
  const series = pipelineMetricSeries(operation([crossingWindow], 7), "24h");
  assert.equal(series.generations, 0, "a build started before the window is not a new generation");
  assert.equal(
    series.succeeded.reduce((sum, value) => sum + value, 0),
    1,
    "a build completed inside the window contributes to throughput"
  );
  assert.equal(series.queueDepth, 7, "queue depth is not limited to builds started inside the window");
});

function graph(tenantId: string, repository: string, ref: string, generatedAt: string): AdminGraphSummary {
  return {
    id: `${tenantId}:${repository}:${ref}`,
    tenantId,
    repository,
    ref,
    commitSha: "a".repeat(40),
    generatedAt,
    generator: { executor: "fixture", model: "test" },
    summary: repository,
    nodeCount: 1,
    edgeCount: 2
  };
}

function build(status: string, createdAt: string, metadata: Readonly<Record<string, unknown>>): AdminGraphBuild {
  return {
    id: `${status}:${createdAt}`,
    tenantId: "tenant-a",
    repository: "omxyz/jina",
    ref: "main",
    requestKey: "api-test",
    status,
    metadata,
    createdAt,
    updatedAt: new Date(new Date(createdAt).getTime() + 60_000).toISOString()
  };
}

function operation(builds: readonly AdminGraphBuild[], queueDepth = 0): AdminOperations {
  return {
    observedAt: NOW.toISOString(),
    queueDepth,
    tenants: [
      {
        tenantId: "tenant-a",
        workflows: builds.map((value) => ({ build: value, stages: [] })),
        metrics: {
          outboxDepth: {},
          outboxDepthByConsumer: {},
          oldestOutboxAgeSeconds: 0,
          reconciliationLagSeconds: 0,
          unparsedBlobCount: 0,
          parsedBlobCountLastHour: 0,
          manifestStalenessSeconds: 0,
          searchStalenessSeconds: 0,
          proposedAssertionCount: 0,
          unexplainedAssertionCount: 0,
          pendingErasureEventCount: 0,
          retrievalTemplates: []
        }
      }
    ]
  };
}
