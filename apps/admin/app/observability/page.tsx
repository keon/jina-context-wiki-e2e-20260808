import type { Metadata } from "next";
import Link from "next/link";
import { MetricsChart } from "../../components/metrics-chart";
import { ErrorPanel, formatDuration, PageHeader, shortTenant } from "../../components/ui";
import { pipelineMetricSeries } from "../../lib/admin-data";
import { listAllAdminOperations } from "../../lib/jina-api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Observability"
};

type Range = "1h" | "6h" | "24h" | "7d";

export default async function ObservabilityPage({
  searchParams
}: {
  readonly searchParams: Promise<{ readonly range?: string; readonly tenant?: string }>;
}) {
  const params = await searchParams;
  const range: Range = ["1h", "6h", "24h", "7d"].includes(params.range ?? "") ? (params.range as Range) : "24h";
  const requestedTenant = params.tenant?.trim() || undefined;
  let operations;
  try {
    operations = await listAllAdminOperations({
      activityAfter: rangeStart(range).toISOString(),
      ...(requestedTenant ? { tenantId: requestedTenant } : {})
    });
  } catch (error) {
    return (
      <main>
        <PageHeader title="Observability" description="Graph generation performance across every tenant." />
        <ErrorPanel error={error} message="Could not load graph pipeline metrics." />
      </main>
    );
  }
  const selectedTenant = requestedTenant;
  const metrics = pipelineMetricSeries(operations, range, selectedTenant);

  return (
    <main>
      <PageHeader title="Observability" description="Graph generation performance across every tenant." />
      <div className="telemetry-controls">
        <nav className="segmented-control" aria-label="Metric time range">
          {(["1h", "6h", "24h", "7d"] as const).map((candidate) => (
            <Link
              key={candidate}
              href={observabilityHref(candidate, selectedTenant)}
              className={candidate === range ? "active" : undefined}
            >
              {candidate}
            </Link>
          ))}
        </nav>
        <form method="get">
          <input type="hidden" name="range" value={range} />
          <label>
            <span className="sr-only">Filter metrics by tenant</span>
            <select name="tenant" defaultValue={selectedTenant ?? ""}>
              <option value="">All tenants</option>
              {operations.tenants.map((tenant) => (
                <option key={tenant.tenantId} value={tenant.tenantId}>
                  {shortTenant(tenant.tenantId)}
                </option>
              ))}
            </select>
          </label>
          <button className="filter-button" type="submit">
            Apply
          </button>
        </form>
      </div>

      <div className="metric-summary">
        <Metric label="Generations" value={metrics.generations.toLocaleString("en-US")} />
        <Metric label="Success rate" value={`${(metrics.successRate * 100).toFixed(1)}%`} />
        <Metric label="P95 duration" value={formatDuration(metrics.p95DurationMs)} />
        <Metric label="Queue depth" value={metrics.queueDepth.toLocaleString("en-US")} />
      </div>

      <MetricsChart
        title="Generation throughput"
        unit="runs / interval"
        labels={metrics.labels}
        series={[
          { name: "Succeeded", values: metrics.succeeded, tone: "green" },
          { name: "Failed", values: metrics.failed, tone: "red" }
        ]}
      />
      <MetricsChart
        title="P95 generation duration"
        unit="minutes"
        labels={metrics.labels}
        series={[{ name: "P95", values: metrics.p95DurationMinutes, tone: "blue" }]}
      />
    </main>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function observabilityHref(range: Range, tenantId?: string): string {
  const params = new URLSearchParams({ range });
  if (tenantId) params.set("tenant", tenantId);
  return `/observability?${params.toString()}`;
}

function rangeStart(range: Range, now = new Date()): Date {
  const hours = range === "1h" ? 1 : range === "6h" ? 6 : range === "24h" ? 24 : 24 * 7;
  return new Date(now.getTime() - hours * 60 * 60 * 1_000);
}
