import type { Metadata } from "next";
import Link from "next/link";
import { ErrorPanel, formatRelativeTime, PageHeader, shortRef, shortTenant, Status } from "../components/ui";
import { filterGraphs } from "../lib/admin-data";
import { listAllGraphs } from "../lib/jina-api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Graphs"
};

interface GraphSearchParams {
  readonly q?: string;
  readonly tenant?: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly generated?: string;
}

export default async function AllGraphsPage({ searchParams }: { readonly searchParams: Promise<GraphSearchParams> }) {
  const filters = await searchParams;
  let graphs;
  try {
    graphs = await listAllGraphs();
  } catch (error) {
    return (
      <main>
        <PageHeader title="Graphs" description="Every current graph across all tenants and repositories." />
        <ErrorPanel error={error} message="Could not load graphs from the Jina API." />
      </main>
    );
  }

  const visible = filterGraphs(graphs, {
    ...(filters.q ? { query: filters.q } : {}),
    ...(filters.tenant ? { tenantId: filters.tenant } : {}),
    ...(filters.repository ? { repository: filters.repository } : {}),
    ...(filters.ref ? { ref: filters.ref } : {}),
    ...(filters.generated ? { generated: filters.generated } : {})
  });
  const tenants = unique(graphs.map((graph) => graph.tenantId));
  const repositories = unique(graphs.map((graph) => graph.repository));
  const refs = unique(graphs.map((graph) => graph.ref));
  const now = new Date();

  return (
    <main>
      <PageHeader
        title="Graphs"
        description="Every current graph across all tenants and repositories."
        action={
          <Link href="/build" className="primary-button">
            <span aria-hidden="true">＋</span> Build graph
          </Link>
        }
      />

      <form className="filters" method="get">
        <label className="search-field">
          <SearchIcon />
          <span className="sr-only">Search graphs</span>
          <input name="q" defaultValue={filters.q} placeholder="Search graphs" />
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
          <span className="sr-only">Filter by ref</span>
          <select name="ref" defaultValue={filters.ref ?? ""}>
            <option value="">Ref: All</option>
            {refs.map((ref) => (
              <option key={ref} value={ref}>
                {shortRef(ref)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by generation date</span>
          <select name="generated" defaultValue={filters.generated ?? ""}>
            <option value="">Generated: Any time</option>
            <option value="hour">Last hour</option>
            <option value="day">Last 24 hours</option>
            <option value="week">Last 7 days</option>
          </select>
        </label>
        <button type="submit" className="filter-button">
          Apply
        </button>
        {hasFilters(filters) ? (
          <Link href="/" className="reset-link">
            Reset
          </Link>
        ) : null}
      </form>

      {visible.length === 0 ? (
        <div className="empty-state">
          <p>No graphs match these filters.</p>
          <Link href="/">Clear all filters</Link>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Tenant</th>
                <th>Ref</th>
                <th>Status</th>
                <th>Updated</th>
                <th className="numeric">Nodes</th>
                <th className="numeric">Edges</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((graph) => (
                <tr key={`${graph.tenantId}:${graph.id}`}>
                  <td>
                    <Link
                      href={`/graphs/${encodeURIComponent(graph.id)}?tenantId=${encodeURIComponent(graph.tenantId)}`}
                    >
                      {graph.repository}
                    </Link>
                  </td>
                  <td title={graph.tenantId}>
                    <code>{shortTenant(graph.tenantId)}</code>
                  </td>
                  <td>
                    <code>{shortRef(graph.ref)}</code>
                  </td>
                  <td>
                    <Status tone="success">Ready</Status>
                  </td>
                  <td title={graph.generatedAt}>{formatRelativeTime(graph.generatedAt, now)}</td>
                  <td className="numeric">{graph.nodeCount.toLocaleString("en-US")}</td>
                  <td className="numeric">{graph.edgeCount.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-footer">
            {visible.length.toLocaleString("en-US")} of {graphs.length.toLocaleString("en-US")} graphs
          </div>
        </div>
      )}
    </main>
  );
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function hasFilters(filters: GraphSearchParams): boolean {
  return Boolean(filters.q || filters.tenant || filters.repository || filters.ref || filters.generated);
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </svg>
  );
}
