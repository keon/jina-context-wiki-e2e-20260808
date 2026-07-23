import type { Metadata } from "next";
import Link from "next/link";
import {
  ErrorPanel,
  formatDuration,
  formatTimestamp,
  PageHeader,
  shortRef,
  shortTenant,
  Status
} from "../../components/ui";
import { allWorkflows, buildDurationMs, buildStatus, buildTrigger } from "../../lib/admin-data";
import { listAdminOperations } from "../../lib/jina-api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Generation history"
};

interface HistorySearchParams {
  readonly q?: string;
  readonly tenant?: string;
  readonly repository?: string;
  readonly status?: string;
  readonly trigger?: string;
  readonly started?: string;
  readonly cursor?: string;
}

export default async function GenerationHistoryPage({
  searchParams
}: {
  readonly searchParams: Promise<HistorySearchParams>;
}) {
  const filters = await searchParams;
  let operations;
  try {
    operations = await listAdminOperations({
      limit: 100,
      ...(filters.cursor ? { cursor: filters.cursor } : {}),
      ...(filters.q ? { query: filters.q } : {}),
      ...(filters.tenant ? { tenantId: filters.tenant } : {}),
      ...(filters.repository ? { repository: filters.repository } : {}),
      ...(filters.status ? { statuses: apiStatuses(filters.status) } : {}),
      ...(filters.trigger ? { trigger: apiTrigger(filters.trigger) } : {}),
      ...(filters.started ? { createdAfter: historyCreatedAfter(filters.started) } : {})
    });
  } catch (error) {
    return (
      <main>
        <PageHeader
          title="Generation history"
          description="Every graph generation attempt across all tenants and repositories."
        />
        <ErrorPanel error={error} message="Could not load graph generation history." />
      </main>
    );
  }
  const workflows = allWorkflows(operations);
  const tenants = unique(workflows.map(({ build }) => build.tenantId));
  const repositories = unique(workflows.map(({ build }) => build.repository));
  const now = new Date(operations.observedAt);

  return (
    <main>
      <PageHeader
        title="Generation history"
        description="Every graph generation attempt across all tenants and repositories."
        action={
          <Link href="/build" className="primary-button">
            <span aria-hidden="true">＋</span> Build graph
          </Link>
        }
      />
      <form className="filters" method="get">
        <label className="search-field">
          <span aria-hidden="true" className="search-glyph">
            ⌕
          </span>
          <span className="sr-only">Search generations</span>
          <input name="q" defaultValue={filters.q} placeholder="Search generations" />
        </label>
        <label>
          <span className="sr-only">Filter by tenant</span>
          <select name="tenant" defaultValue={filters.tenant ?? ""}>
            <option value="">Tenant: All</option>
            {tenants.map((tenant) => (
              <option key={tenant} value={tenant}>
                {shortTenant(tenant)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by repository</span>
          <select name="repository" defaultValue={filters.repository ?? ""}>
            <option value="">Repository: All</option>
            {repositories.map((repository) => (
              <option key={repository} value={repository}>
                {repository}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by status</span>
          <select name="status" defaultValue={filters.status ?? ""}>
            <option value="">Status: Any</option>
            {["Succeeded", "Running", "Queued", "Failed", "Cancelled"].map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by trigger</span>
          <select name="trigger" defaultValue={filters.trigger ?? ""}>
            <option value="">Trigger: All</option>
            {["Webhook", "Manual", "Scheduled", "API"].map((trigger) => (
              <option key={trigger}>{trigger}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by start time</span>
          <select name="started" defaultValue={filters.started ?? ""}>
            <option value="">Started: Any time</option>
            <option value="hour">Last hour</option>
            <option value="day">Last 24 hours</option>
            <option value="week">Last 7 days</option>
          </select>
        </label>
        <button type="submit" className="filter-button">
          Apply
        </button>
        {hasFilters(filters) ? (
          <Link href="/history" className="reset-link">
            Reset
          </Link>
        ) : null}
      </form>

      {workflows.length === 0 ? (
        <div className="empty-state">No generation attempts match these filters.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Repository</th>
                <th>Tenant</th>
                <th>Ref</th>
                <th>Trigger</th>
                <th>Duration</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map(({ build }) => {
                const status = buildStatus(build.status);
                return (
                  <tr key={`${build.tenantId}:${build.id}`} title={`Build ${build.id}`}>
                    <td>{formatTimestamp(build.createdAt)}</td>
                    <td>{build.repository}</td>
                    <td title={build.tenantId}>
                      <code>{shortTenant(build.tenantId)}</code>
                    </td>
                    <td>
                      <code>{shortRef(build.ref)}</code>
                    </td>
                    <td>{buildTrigger(build)}</td>
                    <td>{formatDuration(buildDurationMs(build, now))}</td>
                    <td>
                      <Status tone={statusTone(status)}>{status}</Status>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="table-footer">
            <span>{workflows.length.toLocaleString("en-US")} attempts on this page</span>
            <nav aria-label="Generation history pagination">
              {filters.cursor ? <Link href={historyHref(filters)}>Newest</Link> : null}
              {operations.nextCursor ? (
                <Link href={historyHref(filters, operations.nextCursor)}>Older attempts →</Link>
              ) : null}
            </nav>
          </div>
        </div>
      )}
    </main>
  );
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function statusTone(status: ReturnType<typeof buildStatus>): "success" | "warning" | "danger" | "muted" {
  if (status === "Succeeded") return "success";
  if (status === "Failed") return "danger";
  if (status === "Running" || status === "Queued") return "warning";
  return "muted";
}

function hasFilters(filters: HistorySearchParams): boolean {
  return Boolean(
    filters.q || filters.tenant || filters.repository || filters.status || filters.trigger || filters.started
  );
}

function apiStatuses(status: string): readonly string[] {
  if (status === "Succeeded") return ["done"];
  if (status === "Running") return ["in_progress", "enriching"];
  if (status === "Queued") return ["queued"];
  if (status === "Failed") return ["failed"];
  if (status === "Cancelled") return ["superseded"];
  return [];
}

function apiTrigger(trigger: string): "webhook" | "manual" | "scheduled" | "api" {
  if (trigger === "Webhook") return "webhook";
  if (trigger === "Manual") return "manual";
  if (trigger === "Scheduled") return "scheduled";
  return "api";
}

function historyCreatedAfter(started: string): string {
  const duration =
    started === "hour" ? 60 * 60 * 1_000 : started === "day" ? 24 * 60 * 60 * 1_000 : 7 * 24 * 60 * 60 * 1_000;
  return new Date(Date.now() - duration).toISOString();
}

function historyHref(filters: HistorySearchParams, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.tenant) params.set("tenant", filters.tenant);
  if (filters.repository) params.set("repository", filters.repository);
  if (filters.status) params.set("status", filters.status);
  if (filters.trigger) params.set("trigger", filters.trigger);
  if (filters.started) params.set("started", filters.started);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/history?${query}` : "/history";
}
