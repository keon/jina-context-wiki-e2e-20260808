import type { Metadata } from "next";
import Link from "next/link";
import { ErrorPanel, formatRelativeTime, PageHeader, Status } from "../../components/ui";
import { aggregateBacklog } from "../../lib/admin-data";
import { listAdminOperations, listServiceHealth } from "../../lib/jina-api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Service health"
};

export default async function ServiceHealthPage() {
  let services;
  let operations;
  try {
    [services, operations] = await Promise.all([listServiceHealth(), listAdminOperations()]);
  } catch (error) {
    return (
      <main>
        <PageHeader
          title="Service health"
          description="Current production status for the systems that build and serve graphs."
        />
        <ErrorPanel error={error} message="Could not load production health." />
      </main>
    );
  }
  const backlog = aggregateBacklog(operations.tenants);
  const pipelineDegraded = backlog.unparsedBlobCount > 0 || backlog.oldestOutboxAgeSeconds > 300;
  const allOperational = services.every((service) => service.status !== "degraded") && !pipelineDegraded;
  const checkedAt = services[0]?.checkedAt ?? operations.observedAt;

  return (
    <main>
      <PageHeader
        title="Service health"
        description="Current production status for the systems that build and serve graphs."
        action={
          <Link href="/health" className="secondary-button">
            ↻ Refresh
          </Link>
        }
      />
      <div className="overall-health">
        <Status tone={allOperational ? "success" : "danger"}>
          {allOperational ? "All configured systems operational" : "Production attention required"}
        </Status>
        <span>Last checked {formatRelativeTime(checkedAt)}</span>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Status</th>
              <th>Detail</th>
              <th>Last activity</th>
              <th>Checked</th>
            </tr>
          </thead>
          <tbody>
            {services.map((service) => (
              <tr key={service.id}>
                <td>{service.name}</td>
                <td>
                  <Status tone={healthTone(service.status)}>{healthLabel(service.status)}</Status>
                </td>
                <td className="muted">{service.detail}</td>
                <td>{service.lastActivity ? formatRelativeTime(service.lastActivity) : "—"}</td>
                <td>{formatRelativeTime(service.checkedAt)}</td>
              </tr>
            ))}
            <tr>
              <td>Graph pipeline</td>
              <td>
                <Status tone={pipelineDegraded ? "danger" : "success"}>
                  {pipelineDegraded ? "Degraded" : "Operational"}
                </Status>
              </td>
              <td className="muted">
                {backlog.outboxDepth.toLocaleString("en-US")} queued events ·{" "}
                {backlog.unparsedBlobCount.toLocaleString("en-US")} unparsed blobs
              </td>
              <td>
                {backlog.oldestOutboxAgeSeconds > 0 ? `${Math.round(backlog.oldestOutboxAgeSeconds)}s lag` : "Now"}
              </td>
              <td>{formatRelativeTime(operations.observedAt)}</td>
            </tr>
          </tbody>
        </table>
        <div className="table-footer">Health checks are read directly from production services.</div>
      </div>
    </main>
  );
}

function healthTone(status: "operational" | "degraded" | "unconfigured"): "success" | "danger" | "muted" {
  if (status === "operational") return "success";
  if (status === "degraded") return "danger";
  return "muted";
}

function healthLabel(status: "operational" | "degraded" | "unconfigured"): string {
  if (status === "operational") return "Operational";
  if (status === "degraded") return "Degraded";
  return "Not configured";
}
