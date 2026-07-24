import { READ_TRAFFIC_P95_TARGET_MS, summarizeReadTraffic } from "../lib/read-traffic";
import type { AdminReadAccessMetric, AdminReadChannelMetric, AdminReadTrafficMetric } from "../lib/jina-api";
import { formatDuration, formatRelativeTime, shortTenant, Status } from "./ui";

export interface TenantReadTrafficMetric extends AdminReadTrafficMetric {
  readonly tenantId: string;
}

export interface TenantReadAccessMetric extends AdminReadAccessMetric {
  readonly tenantId: string;
}

export interface TenantReadChannelMetric extends AdminReadChannelMetric {
  readonly tenantId: string;
}

export function ReadTrafficMonitors({
  metrics,
  accessMetrics,
  accessMetricsTruncated,
  channelMetrics
}: {
  readonly metrics: readonly TenantReadTrafficMetric[];
  readonly accessMetrics: readonly TenantReadAccessMetric[];
  readonly accessMetricsTruncated: boolean;
  readonly channelMetrics: readonly TenantReadChannelMetric[];
}) {
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

      <AccessChannelMonitor
        metrics={accessMetrics}
        channelMetrics={channelMetrics}
        truncated={accessMetricsTruncated}
      />
      <McpTrafficMonitor
        metrics={accessMetrics.filter((metric) => metric.accessChannel === "mcp")}
        channelMetrics={channelMetrics.filter((metric) => metric.accessChannel === "mcp")}
      />
    </section>
  );
}

function AccessChannelMonitor({
  metrics,
  channelMetrics,
  truncated
}: {
  readonly metrics: readonly TenantReadAccessMetric[];
  readonly channelMetrics: readonly TenantReadChannelMetric[];
  readonly truncated: boolean;
}) {
  const channels = (["mcp", "api", "admin", "direct"] as const).map((channel) => {
    const matching = channelMetrics.filter((metric) => metric.accessChannel === channel);
    return {
      channel,
      reads: matching.reduce((sum, metric) => sum + metric.retrievals, 0),
      requests: matching.reduce((sum, metric) => sum + metric.requests, 0),
      actors: matching.reduce((sum, metric) => sum + metric.actors, 0),
      p95LatencyMs: matching.reduce((highest, metric) => Math.max(highest, metric.p95LatencyMs), 0)
    };
  });
  const now = new Date();

  return (
    <section className="read-access" aria-labelledby="read-access-heading">
      <div className="read-traffic-heading">
        <div>
          <h2 id="read-access-heading">Access audit</h2>
          <p>Authenticated actors and bounded calling surfaces behind read traffic.</p>
        </div>
      </div>

      <div className="access-channel-grid">
        {channels.map((channel) => (
          <div className="access-channel-card" key={channel.channel}>
            <span>{formatAccessChannel(channel.channel)}</span>
            <strong>{channel.reads.toLocaleString("en-US")}</strong>
            <small>
              {channel.actors.toLocaleString("en-US")} {channel.actors === 1 ? "actor" : "actors"}
              {channel.reads > 0
                ? ` · ${channel.requests.toLocaleString("en-US")} requests · p95 ${formatDuration(channel.p95LatencyMs)}`
                : ""}
            </small>
          </div>
        ))}
      </div>

      {truncated ? (
        <p className="access-audit-note" role="status">
          Showing the 500 busiest actor/channel/template groups per tenant.
        </p>
      ) : null}

      {metrics.length === 0 ? (
        <div className="read-traffic-empty">No attributed read access was recorded in the last 24 hours.</div>
      ) : (
        <div className="table-wrap read-traffic-table-wrap">
          <table className="data-table read-access-table">
            <thead>
              <tr>
                <th>Actor</th>
                <th>Channel</th>
                <th>Tenant</th>
                <th>Template</th>
                <th className="numeric">Reads</th>
                <th className="numeric">p95</th>
                <th>Last accessed</th>
              </tr>
            </thead>
            <tbody>
              {[...metrics]
                .sort(
                  (left, right) =>
                    right.requests - left.requests ||
                    right.lastAccessedAt.localeCompare(left.lastAccessedAt) ||
                    left.principalId.localeCompare(right.principalId)
                )
                .map((metric) => (
                  <tr key={`${metric.tenantId}:${metric.principalId}:${metric.accessChannel}:${metric.template}`}>
                    <td>
                      <code>{metric.principalId}</code>
                    </td>
                    <td>{formatAccessChannel(metric.accessChannel)}</td>
                    <td title={metric.tenantId}>
                      <code>{shortTenant(metric.tenantId)}</code>
                    </td>
                    <td>
                      <code>{formatTemplate(metric.template)}</code>
                    </td>
                    <td className="numeric">{metric.requests.toLocaleString("en-US")}</td>
                    <td className="numeric">{formatDuration(metric.p95LatencyMs)}</td>
                    <td title={metric.lastAccessedAt}>{formatRelativeTime(metric.lastAccessedAt, now)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function McpTrafficMonitor({
  metrics,
  channelMetrics
}: {
  readonly metrics: readonly TenantReadAccessMetric[];
  readonly channelMetrics: readonly TenantReadChannelMetric[];
}) {
  const summary = summarizeReadTraffic(metrics);
  const actors = channelMetrics.reduce((sum, metric) => sum + metric.actors, 0);
  const requests = channelMetrics.reduce((sum, metric) => sum + metric.requests, 0);
  const retrievals = channelMetrics.reduce((sum, metric) => sum + metric.retrievals, 0);
  const weightedLatency = channelMetrics.reduce((sum, metric) => sum + metric.averageLatencyMs * metric.retrievals, 0);
  const averageLatencyMs = retrievals > 0 ? weightedLatency / retrievals : 0;
  const p95LatencyMs = channelMetrics.reduce((highest, metric) => Math.max(highest, metric.p95LatencyMs), 0);
  const weightedTruncation = channelMetrics.reduce((sum, metric) => sum + metric.truncationRate * metric.retrievals, 0);
  const truncationRate = retrievals > 0 ? weightedTruncation / retrievals : 0;
  const hasTraffic = retrievals > 0;

  return (
    <section className="mcp-traffic" aria-labelledby="mcp-traffic-heading">
      <div className="read-traffic-heading">
        <div>
          <h2 id="mcp-traffic-heading">MCP monitor</h2>
          <p>MCP-only graph retrievals, actors, latency, and truncation.</p>
        </div>
        <span className="read-traffic-window">MCP only</span>
      </div>
      <div className="metric-summary read-traffic-summary">
        <Metric label="MCP requests" value={requests.toLocaleString("en-US")} detail="top-level graph queries" />
        <Metric
          label="MCP retrievals"
          value={retrievals.toLocaleString("en-US")}
          detail={`${actors.toLocaleString("en-US")} active ${actors === 1 ? "actor" : "actors"}`}
        />
        <Metric
          label="Average latency"
          value={hasTraffic ? formatDuration(averageLatencyMs) : "—"}
          detail={hasTraffic ? `highest tenant p95 ${formatDuration(p95LatencyMs)}` : "no MCP reads recorded"}
        />
        <Metric
          label="Truncated"
          value={hasTraffic ? formatPercent(truncationRate) : "—"}
          detail={hasTraffic ? "MCP retrievals at their limit" : "no MCP reads recorded"}
        />
      </div>
      {hasTraffic ? (
        <p className="mcp-monitor-detail">
          <strong>{actors.toLocaleString("en-US")}</strong> active {actors === 1 ? "actor" : "actors"} across{" "}
          <strong>{summary.activeTemplates.toLocaleString("en-US")}</strong>{" "}
          {summary.activeTemplates === 1 ? "template" : "templates"}.
        </p>
      ) : null}
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

function formatAccessChannel(channel: TenantReadAccessMetric["accessChannel"]): string {
  if (channel === "mcp") return "MCP";
  if (channel === "api") return "API";
  if (channel === "admin") return "Admin";
  return "Direct";
}
