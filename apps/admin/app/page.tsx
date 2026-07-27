import Link from "next/link";
import {
  getContextMetrics,
  JinaApiError,
  listAllGenerations,
  listKnowledgeDocuments,
  type AdminIndexGeneration
} from "../lib/jina-api";

export const dynamic = "force-dynamic";

export default async function ContextAdminPage({
  searchParams
}: {
  readonly searchParams: Promise<{ readonly repository?: string }>;
}) {
  const { repository } = await searchParams;
  let generations: readonly AdminIndexGeneration[];
  let documents: Awaited<ReturnType<typeof listKnowledgeDocuments>>;
  let metrics: Awaited<ReturnType<typeof getContextMetrics>>;
  try {
    [generations, metrics, documents] = await Promise.all([
      listAllGenerations(),
      getContextMetrics(),
      listKnowledgeDocuments(repository)
    ]);
  } catch (error) {
    return (
      <div className="error-state">
        <p>Could not load repository context from the Jina API.</p>
        <p>
          <code>{error instanceof JinaApiError ? error.message : "unexpected error"}</code>
        </p>
        <p className="muted">
          Check <code>JINA_API_URL</code> and <code>INTERNAL_API_TOKEN</code>, or start the local stack.
        </p>
      </div>
    );
  }

  const repositories = [...new Set(generations.map((generation) => generation.repository))].sort();
  const visible = repository ? generations.filter((generation) => generation.repository === repository) : generations;
  const pending = Object.values(metrics.outboxDepthByConsumer).reduce((sum, count) => sum + count, 0);
  const currentDocuments = new Map(documents.map((document) => [document.logicalId, document])).size;
  const knowledgeKinds = new Map<string, number>();
  for (const document of documents) knowledgeKinds.set(document.kind, (knowledgeKinds.get(document.kind) ?? 0) + 1);

  return (
    <main>
      <div className="stat-row">
        <Stat label="Published generations" value={metrics.publishedGenerationCount} />
        <Stat label="Repositories" value={repository ? 1 : repositories.length} />
        <Stat label="Current knowledge docs" value={currentDocuments} />
        <Stat label="Pending projections" value={pending} />
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
          <p>No context index generations have been published{repository ? ` for ${repository}` : ""}.</p>
          <p>
            Generations appear after a <code>build-context</code> workflow publishes its required projectors.
          </p>
        </div>
      ) : (
        <table className="context-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Ref</th>
              <th>Commit</th>
              <th>Published</th>
              <th>Status</th>
              <th>Knowledge</th>
              <th>Projectors</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((generation) => (
              <tr key={generation.id}>
                <td>
                  <Link href={`/?repository=${encodeURIComponent(generation.repository)}`}>
                    {generation.repository}
                  </Link>
                </td>
                <td>
                  <code>{shortRef(generation.ref)}</code>
                </td>
                <td>
                  <code>{generation.commitSha.slice(0, 10)}</code>
                </td>
                <td title={generation.publishedAt ?? generation.createdAt}>
                  {formatTimestamp(generation.publishedAt ?? generation.createdAt)}
                </td>
                <td>{generation.status}</td>
                <td>{generation.derivedKnowledge}</td>
                <td className="summary-cell">{Object.keys(generation.projectors).sort().join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="knowledge-admin-section">
        <h2>Agent-derived knowledge</h2>
        <p className="muted">
          {documents.length} immutable revisions across{" "}
          {[...knowledgeKinds.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([kind, count]) => `${kind}: ${count}`)
            .join(", ") || "no document kinds"}
          .
        </p>
        {documents.length > 0 ? (
          <table className="context-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Kind</th>
                <th>Document</th>
                <th>Commit</th>
                <th>Agent / model</th>
                <th>Review</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {documents.slice(0, 100).map((document) => (
                <tr key={document.id}>
                  <td>{document.repository}</td>
                  <td>{document.kind}</td>
                  <td className="summary-cell" title={document.logicalId}>
                    <strong>{document.title}</strong>
                    <br />
                    <span className="muted">{document.summary}</span>
                  </td>
                  <td>
                    <code>{document.commitSha.slice(0, 10)}</code>
                  </td>
                  <td>
                    {document.generatorName}
                    <br />
                    <code>{document.model}</code>
                  </td>
                  <td>{document.reviewStatus}</td>
                  <td>{Math.round(document.confidence * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
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
