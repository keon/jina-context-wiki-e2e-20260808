import Link from "next/link";
import { JinaApiError, listAllGraphs, type AdminGraphSummary } from "../lib/jina-api";

export const dynamic = "force-dynamic";

export default async function AllGraphsPage({
  searchParams
}: {
  readonly searchParams: Promise<{ readonly repository?: string }>;
}) {
  const { repository } = await searchParams;
  let graphs: readonly AdminGraphSummary[];
  try {
    graphs = await listAllGraphs();
  } catch (error) {
    return (
      <div className="error-state">
        <p>Could not load graphs from the Jina API.</p>
        <p>
          <code>{error instanceof JinaApiError ? error.message : "unexpected error"}</code>
        </p>
        <p className="muted">
          Check <code>JINA_API_URL</code>, <code>JINA_GLOBAL_ADMIN_TOKEN</code>, and <code>INTERNAL_API_TOKEN</code>, or
          start the local stack with <code>pnpm dev</code>.
        </p>
      </div>
    );
  }

  const repositories = [...new Set(graphs.map((graph) => graph.repository))].sort();
  const visible = repository ? graphs.filter((graph) => graph.repository === repository) : graphs;
  const tenants = new Set(visible.map((graph) => graph.tenantId));
  const totalNodes = visible.reduce((sum, graph) => sum + graph.nodeCount, 0);
  const totalEdges = visible.reduce((sum, graph) => sum + graph.edgeCount, 0);

  return (
    <main>
      <div className="stat-row">
        <Stat label="Graphs" value={visible.length} />
        <Stat label="Tenants" value={tenants.size} />
        <Stat label="Repositories" value={repository ? 1 : repositories.length} />
        <Stat label="Nodes" value={totalNodes} />
        <Stat label="Edges" value={totalEdges} />
      </div>

      {repositories.length > 1 || repository ? (
        <nav className="repo-filter" aria-label="Filter by repository">
          <Link href="/" className={repository ? "" : "active"}>
            All repositories
          </Link>
          {repositories.map((candidate) => (
            <Link
              key={candidate}
              href={`/?repository=${encodeURIComponent(candidate)}`}
              className={candidate === repository ? "active" : ""}
            >
              {candidate}
            </Link>
          ))}
        </nav>
      ) : null}

      {visible.length === 0 ? (
        <div className="empty-state">
          <p>No context graphs have been generated yet{repository ? ` for ${repository}` : ""}.</p>
          <p>
            Graphs appear here as soon as a <code>context-graph</code> build completes.
          </p>
        </div>
      ) : (
        <table className="graph-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Tenant</th>
              <th>Ref</th>
              <th>Commit</th>
              <th>Generated</th>
              <th>Generator</th>
              <th>Nodes</th>
              <th>Edges</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((graph) => (
              <tr key={`${graph.tenantId}:${graph.id}`}>
                <td>
                  <Link href={`/graphs/${encodeURIComponent(graph.id)}?tenantId=${encodeURIComponent(graph.tenantId)}`}>
                    {graph.repository}
                  </Link>
                </td>
                <td>
                  <code>{graph.tenantId}</code>
                </td>
                <td>
                  <code>{shortRef(graph.ref)}</code>
                </td>
                <td>
                  <code>{graph.commitSha.slice(0, 10)}</code>
                </td>
                <td title={graph.generatedAt}>{formatTimestamp(graph.generatedAt)}</td>
                <td>
                  {graph.generator.executor}
                  {graph.generator.model ? (
                    <>
                      {" "}
                      <span className="muted">({graph.generator.model})</span>
                    </>
                  ) : null}
                </td>
                <td>{graph.nodeCount}</td>
                <td>{graph.edgeCount}</td>
                <td className="summary-cell">{graph.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="stat">
      <div className="value">{value.toLocaleString("en-US")}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "") || ref;
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
