import type {
  AdminGraphBuild,
  AdminGraphSummary,
  AdminGraphWorkflow,
  AdminGithubConnection,
  AdminOperations,
  AdminOperationsTenant
} from "./jina-api";

export interface GraphFilters {
  readonly query?: string;
  readonly tenantId?: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly generated?: string;
}

export interface TenantSummary {
  readonly tenantId: string;
  readonly name: string;
  readonly kind?: "personal" | "team";
  readonly githubConnections: readonly AdminGithubConnection[];
  readonly repositoryCount: number;
  readonly graphCount: number;
  readonly lastActivity?: string;
  readonly status: "active" | "inactive";
}

export interface PipelineMetricSeries {
  readonly labels: readonly string[];
  readonly succeeded: readonly number[];
  readonly failed: readonly number[];
  readonly p95DurationMinutes: readonly number[];
  readonly generations: number;
  readonly successRate: number;
  readonly p95DurationMs: number;
  readonly queueDepth: number;
}

export function filterGraphs(
  graphs: readonly AdminGraphSummary[],
  filters: GraphFilters,
  now = new Date()
): readonly AdminGraphSummary[] {
  const query = filters.query?.trim().toLowerCase();
  const cutoff = dateCutoff(filters.generated, now);
  return graphs.filter((graph) => {
    if (
      query &&
      ![graph.repository, graph.tenantId, graph.ref, graph.commitSha, graph.summary].some((value) =>
        value.toLowerCase().includes(query)
      )
    )
      return false;
    if (filters.tenantId && graph.tenantId !== filters.tenantId) return false;
    if (filters.repository && graph.repository !== filters.repository) return false;
    if (filters.ref && graph.ref !== filters.ref) return false;
    return !cutoff || new Date(graph.generatedAt).getTime() >= cutoff.getTime();
  });
}

export function allWorkflows(operations: AdminOperations): readonly AdminGraphWorkflow[] {
  return operations.tenants
    .flatMap((tenant) => tenant.workflows)
    .sort((left, right) => right.build.createdAt.localeCompare(left.build.createdAt));
}

export function tenantSummaries(
  graphs: readonly AdminGraphSummary[],
  operations?: AdminOperations,
  now = new Date()
): readonly TenantSummary[] {
  const grouped = new Map<string, AdminGraphSummary[]>();
  for (const graph of graphs) {
    const current = grouped.get(graph.tenantId) ?? [];
    current.push(graph);
    grouped.set(graph.tenantId, current);
  }
  for (const tenant of operations?.tenants ?? []) {
    if (!grouped.has(tenant.tenantId)) grouped.set(tenant.tenantId, []);
  }
  return [...grouped.entries()]
    .map(([tenantId, tenantGraphs]) => {
      const operationsTenant = operations?.tenants.find((candidate) => candidate.tenantId === tenantId);
      const workflows = operationsTenant?.workflows ?? [];
      const repositories = new Set([
        ...tenantGraphs.map((graph) => graph.repository),
        ...workflows.map(({ build }) => build.repository)
      ]);
      const lastActivity = [
        ...tenantGraphs.map((graph) => graph.generatedAt),
        ...workflows.map(({ build }) => build.updatedAt)
      ]
        .sort()
        .at(-1);
      const githubConnections = operationsTenant?.githubConnections ?? legacyGithubConnections(workflows);
      return {
        tenantId,
        name: operationsTenant?.name?.trim() || tenantName(tenantId, tenantGraphs, workflows),
        ...(operationsTenant?.kind ? { kind: operationsTenant.kind } : {}),
        githubConnections,
        repositoryCount: operationsTenant?.repositoryCount ?? repositories.size,
        graphCount: tenantGraphs.length,
        ...(lastActivity ? { lastActivity } : {}),
        status:
          lastActivity && now.getTime() - new Date(lastActivity).getTime() <= 30 * 24 * 60 * 60 * 1_000
            ? ("active" as const)
            : ("inactive" as const)
      };
    })
    .sort((left, right) => (right.lastActivity ?? "").localeCompare(left.lastActivity ?? ""));
}

export function buildStatus(status: string): "Succeeded" | "Running" | "Failed" | "Cancelled" | "Queued" {
  if (status === "done") return "Succeeded";
  if (status === "failed") return "Failed";
  if (status === "superseded" || status === "canceled" || status === "cancelled") return "Cancelled";
  if (status === "queued" || status === "triage") return "Queued";
  return "Running";
}

export function buildTrigger(build: AdminGraphBuild): "Webhook" | "Manual" | "Scheduled" | "API" {
  const source = [
    build.metadata.githubEventName,
    build.metadata.eventName,
    build.metadata.trigger,
    build.metadata.source
  ]
    .find((value): value is string => typeof value === "string")
    ?.toLowerCase();
  if (source?.includes("schedule")) return "Scheduled";
  if (source?.includes("webhook") || source?.includes("push") || source?.includes("github")) return "Webhook";
  if (source?.includes("manual") || build.requestKey.startsWith("admin-")) return "Manual";
  return "API";
}

export function buildDurationMs(build: AdminGraphBuild, now = new Date()): number {
  const started = new Date(build.createdAt).getTime();
  const ended = ["done", "failed", "superseded", "canceled", "cancelled"].includes(build.status)
    ? new Date(build.updatedAt).getTime()
    : now.getTime();
  return Math.max(0, ended - started);
}

export function pipelineMetricSeries(
  operations: AdminOperations,
  range: "1h" | "6h" | "24h" | "7d",
  tenantId?: string
): PipelineMetricSeries {
  const hours = range === "1h" ? 1 : range === "6h" ? 6 : range === "24h" ? 24 : 24 * 7;
  const bucketCount = range === "7d" ? 28 : range === "24h" ? 24 : 12;
  const end = new Date(operations.observedAt);
  const endMs = Number.isNaN(end.getTime()) ? Date.now() : end.getTime();
  const startMs = endMs - hours * 60 * 60 * 1_000;
  const bucketMs = (endMs - startMs) / bucketCount;
  const tenants = tenantId ? operations.tenants.filter((tenant) => tenant.tenantId === tenantId) : operations.tenants;
  const builds = tenants.flatMap((tenant) => tenant.workflows.map(({ build }) => build));
  const started = builds.filter((build) => {
    const timestamp = new Date(build.createdAt).getTime();
    return timestamp >= startMs && timestamp <= endMs;
  });
  const terminal = builds.filter((build) => {
    if (!["Succeeded", "Failed"].includes(buildStatus(build.status))) return false;
    const timestamp = new Date(build.updatedAt).getTime();
    return timestamp >= startMs && timestamp <= endMs;
  });
  const succeeded = Array.from({ length: bucketCount }, () => 0);
  const failed = Array.from({ length: bucketCount }, () => 0);
  const durations = Array.from({ length: bucketCount }, () => [] as number[]);
  for (const build of terminal) {
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((new Date(build.updatedAt).getTime() - startMs) / bucketMs))
    );
    const status = buildStatus(build.status);
    if (status === "Succeeded") succeeded[index] = (succeeded[index] ?? 0) + 1;
    if (status === "Failed") failed[index] = (failed[index] ?? 0) + 1;
    if (status === "Succeeded" || status === "Failed") durations[index]?.push(buildDurationMs(build, end));
  }
  const successful = terminal.filter((build) => buildStatus(build.status) === "Succeeded");
  const terminalDurations = terminal.map((build) => buildDurationMs(build, end));
  return {
    labels: Array.from({ length: bucketCount }, (_, index) =>
      new Intl.DateTimeFormat("en-US", {
        ...(range === "7d" ? { weekday: "short" as const } : { hour: "numeric" as const }),
        timeZone: "UTC"
      }).format(new Date(startMs + (index + 1) * bucketMs))
    ),
    succeeded,
    failed,
    p95DurationMinutes: durations.map((values) => percentile(values, 0.95) / 60_000),
    generations: started.length,
    successRate: terminal.length === 0 ? 0 : successful.length / terminal.length,
    p95DurationMs: percentile(terminalDurations, 0.95),
    queueDepth: operations.queueDepth
  };
}

export function aggregateBacklog(tenants: readonly AdminOperationsTenant[]): {
  readonly outboxDepth: number;
  readonly unparsedBlobCount: number;
  readonly oldestOutboxAgeSeconds: number;
} {
  return tenants.reduce(
    (total, tenant) => ({
      outboxDepth: total.outboxDepth + Object.values(tenant.metrics.outboxDepth).reduce((sum, value) => sum + value, 0),
      unparsedBlobCount: total.unparsedBlobCount + tenant.metrics.unparsedBlobCount,
      oldestOutboxAgeSeconds: Math.max(total.oldestOutboxAgeSeconds, tenant.metrics.oldestOutboxAgeSeconds)
    }),
    { outboxDepth: 0, unparsedBlobCount: 0, oldestOutboxAgeSeconds: 0 }
  );
}

function tenantName(
  tenantId: string,
  graphs: readonly AdminGraphSummary[],
  workflows: readonly AdminGraphWorkflow[]
): string {
  const owners = [...graphs.map((graph) => graph.repository), ...workflows.map(({ build }) => build.repository)]
    .map((repository) => repository.split("/")[0])
    .filter((owner): owner is string => Boolean(owner));
  if (owners.length === 0) return tenantId;
  const counts = new Map<string, number>();
  for (const owner of owners) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? tenantId;
}

function legacyGithubConnections(workflows: readonly AdminGraphWorkflow[]): readonly AdminGithubConnection[] {
  for (const { build } of [...workflows].sort((left, right) =>
    right.build.updatedAt.localeCompare(left.build.updatedAt)
  )) {
    const value = build.metadata.githubInstallationId;
    const installationId =
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? String(value)
        : typeof value === "string" && /^\d+$/.test(value)
          ? value
          : undefined;
    if (installationId) {
      return [{
        installationId,
        login: `GitHub installation ${installationId}`,
        type: "Organization",
        repositoryCount: 0
      }];
    }
  }
  return [];
}

function dateCutoff(value: string | undefined, now: Date): Date | undefined {
  const duration =
    value === "hour"
      ? 60 * 60 * 1_000
      : value === "day"
        ? 24 * 60 * 60 * 1_000
        : value === "week"
          ? 7 * 24 * 60 * 60 * 1_000
          : undefined;
  return duration ? new Date(now.getTime() - duration) : undefined;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}
