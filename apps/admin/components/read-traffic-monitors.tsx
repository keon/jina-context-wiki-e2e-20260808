import { READ_TRAFFIC_P95_TARGET_MS, summarizeReadTraffic } from "../lib/read-traffic";
import type { AdminReadTrafficMetric } from "../lib/jina-api";
import { formatDuration, shortTenant, Status } from "./ui";

export interface TenantReadTrafficMetric extends AdminReadTrafficMetric {
  readonly tenantId: string;
}

export function ReadTrafficMonitors({ metrics }: { readonly metrics: readonly TenantReadTrafficMetric[] }) {
  const summary = summarizeReadTraffic(metrics);
  const hasTraffic = summary.totalRequests > 0;
  const maximumRequests = Math.max(1, ...metrics.map((metric) => metric.requests));

  return (
    <section className="read-traffic" aria-labelledby="read-traffic-heading">
      <div className="read-traffic-heading">
        <div>
          <h2 id="read-traffic-heading">Read traffic</h2>
          <p>Context-graph retrieval activity across the selected tenants.</p>
        </div>
        <span className="read-traffic-window">Rolling 24 hours</span>
      </div>

      <div className="metric-summary read-traffic-summary">
        <Metric label="Reads" value={summary.totalRequests.toLocaleString("en-US")} detail="requests served" />
        <Metric
          label="Average latency"
          value={hasTraffic ? formatDuration(summary.averageLatencyMs) : "—"}
          detail={
            hasTraffic
              ? `${summary.activeTemplates.toLocaleString("en-US")} active ${summary.activeTemplates === 1 ? "template" : "templates"}`
              : "no active templates"
          }
        />
        <Metric
          label="Highest p95"
          value={hasTraffic ? formatDuration(summary.highestP95LatencyMs) : "—"}
          detail={
            !hasTraffic
              ? "no reads recorded"
              : summary.metricsOverTarget === 0
                ? `within ${READ_TRAFFIC_P95_TARGET_MS}ms target`
                : `${summary.metricsOverTarget} ${summary.metricsOverTarget === 1 ? "metric" : "metrics"} over target`
          }
          tone={hasTraffic ? (summary.metricsOverTarget > 0 ? "warning" : "success") : undefined}
        />
        <Metric
          label="Truncated"
          value={hasTraffic ? formatPercent(summary.truncationRate) : "—"}
          detail={hasTraffic ? "responses at their limit" : "no reads recorded"}
        />
      </div>

      {metrics.length === 0 ? (
        <div className="read-traffic-empty">No context-graph reads were recorded in the last 24 hours.</div>
      ) : (
        <div className="table-wrap read-traffic-table-wrap">
          <table className="data-table read-traffic-table">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Template</th>
                <th>Volume</th>
                <th className="numeric">Reads</th>
                <th className="numeric">Average</th>
                <th className="numeric">p95</th>
                <th className="numeric">Truncated</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {[...metrics]
                .sort(
                  (left, right) =>
                    right.requests - left.requests ||
                    left.tenantId.localeCompare(right.tenantId) ||
                    left.template.localeCompare(right.template)
                )
                .map((metric) => {
                  const overTarget = metric.p95LatencyMs > READ_TRAFFIC_P95_TARGET_MS;
                  return (
                    <tr key={`${metric.tenantId}:${metric.template}`}>
                      <td title={metric.tenantId}>
                        <code>{shortTenant(metric.tenantId)}</code>
                      </td>
                      <td>
                        <code>{formatTemplate(metric.template)}</code>
                      </td>
                      <td className="read-volume">
                        <progress
                          aria-label={`${formatTemplate(metric.template)} reads for ${shortTenant(metric.tenantId)}`}
                          max={maximumRequests}
                          value={metric.requests}
                        />
                      </td>
                      <td className="numeric">{metric.requests.toLocaleString("en-US")}</td>
                      <td className="numeric">{formatDuration(metric.averageLatencyMs)}</td>
                      <td className="numeric">{formatDuration(metric.p95LatencyMs)}</td>
                      <td className="numeric">{formatPercent(metric.truncationRate)}</td>
                      <td>
                        <Status tone={overTarget ? "warning" : "success"}>
                          {overTarget ? "Over target" : "Healthy"}
                        </Status>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  detail,
  tone
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone?: "success" | "warning" | undefined;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{tone ? <Status tone={tone}>{detail}</Status> : detail}</small>
    </div>
  );
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.01 ? 1 : 0)}%`;
}

function formatTemplate(template: string): string {
  return template.replaceAll("_", " ");
}
