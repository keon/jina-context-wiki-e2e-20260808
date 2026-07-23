import type { Metadata } from "next";
import Link from "next/link";
import { ErrorPanel, formatRelativeTime, PageHeader, shortTenant, Status } from "../../components/ui";
import { tenantSummaries } from "../../lib/admin-data";
import { listAdminOperations, listAllGraphs } from "../../lib/jina-api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Tenants"
};

export default async function TenantsPage({
  searchParams
}: {
  readonly searchParams: Promise<{ readonly q?: string; readonly status?: string }>;
}) {
  const filters = await searchParams;
  let graphs;
  let operations;
  try {
    [graphs, operations] = await Promise.all([listAllGraphs(), listAdminOperations()]);
  } catch (error) {
    return (
      <main>
        <PageHeader title="Tenants" description="Organizations connected to Jina and their graph coverage." />
        <ErrorPanel error={error} message="Could not load tenant coverage." />
      </main>
    );
  }
  const query = filters.q?.trim().toLowerCase();
  const tenants = tenantSummaries(graphs, operations, new Date(operations.observedAt));
  const visible = tenants.filter((tenant) => {
    if (
      query &&
      ![
        tenant.name,
        tenant.tenantId,
        ...tenant.githubConnections.flatMap((connection) => [connection.login, connection.installationId])
      ].some((value) => value.toLowerCase().includes(query))
    )
      return false;
    return !filters.status || tenant.status === filters.status;
  });
  const installUrl = process.env.JINA_GITHUB_APP_INSTALL_URL?.trim();

  return (
    <main>
      <PageHeader
        title="Tenants"
        description="Organizations connected to Jina and their graph coverage."
        action={
          installUrl ? (
            <a href={installUrl} className="primary-button" rel="noreferrer">
              <span aria-hidden="true">＋</span> Add tenant
            </a>
          ) : undefined
        }
      />
      <form className="filters filters-compact" method="get">
        <label className="search-field">
          <span aria-hidden="true" className="search-glyph">
            ⌕
          </span>
          <span className="sr-only">Search tenants</span>
          <input name="q" defaultValue={filters.q} placeholder="Search tenants" />
        </label>
        <label>
          <span className="sr-only">Filter tenants by status</span>
          <select name="status" defaultValue={filters.status ?? ""}>
            <option value="">Status: Any</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <button type="submit" className="filter-button">
          Apply
        </button>
        {filters.q || filters.status ? (
          <Link href="/tenants" className="reset-link">
            Reset
          </Link>
        ) : null}
      </form>

      {visible.length === 0 ? (
        <div className="empty-state">No tenants match these filters.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Tenant ID</th>
                <th>GitHub connections</th>
                <th className="numeric">Repositories</th>
                <th className="numeric">Graphs</th>
                <th>Last activity</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((tenant) => (
                <tr key={tenant.tenantId}>
                  <td>
                    <Link href={`/?tenant=${encodeURIComponent(tenant.tenantId)}`}>{tenant.name}</Link>
                  </td>
                  <td title={tenant.tenantId}>
                    <code>{shortTenant(tenant.tenantId)}</code>
                  </td>
                  <td
                    title={tenant.githubConnections
                      .map((connection) => `${connection.login} (${connection.installationId})`)
                      .join(", ")}
                  >
                    {tenant.githubConnections.length > 0
                      ? tenant.githubConnections.map((connection) => connection.login).join(", ")
                      : "—"}
                  </td>
                  <td className="numeric">{tenant.repositoryCount.toLocaleString("en-US")}</td>
                  <td className="numeric">{tenant.graphCount.toLocaleString("en-US")}</td>
                  <td>{tenant.lastActivity ? formatRelativeTime(tenant.lastActivity) : "—"}</td>
                  <td>
                    <Status tone={tenant.status === "active" ? "success" : "muted"}>
                      {tenant.status === "active" ? "Active" : "Inactive"}
                    </Status>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-footer">
            {visible.length.toLocaleString("en-US")} of {tenants.length.toLocaleString("en-US")} tenants
          </div>
        </div>
      )}
    </main>
  );
}
