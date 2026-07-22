import Link from "next/link";
import { notFound } from "next/navigation";
import { getGraph, JinaApiError } from "../../../lib/jina-api";
import { GraphView } from "../../../components/graph-view";

export const dynamic = "force-dynamic";

export default async function GraphDetailPage({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  let graph;
  try {
    graph = await getGraph(decodeURIComponent(id));
  } catch (error) {
    return (
      <div className="error-state">
        <p>Could not load this graph from the Jina API.</p>
        <p>
          <code>{error instanceof JinaApiError ? error.message : "unexpected error"}</code>
        </p>
        <p>
          <Link href="/">Back to all graphs</Link>
        </p>
      </div>
    );
  }
  if (!graph) notFound();

  return (
    <main>
      <p>
        <Link href="/">← All graphs</Link>
      </p>
      <div className="detail-header">
        <h2>{graph.repository}</h2>
        <span className="muted">{graph.summary}</span>
      </div>
      <div className="meta-grid">
        <Meta label="Graph ID" value={graph.id} mono />
        <Meta label="Ref" value={graph.ref} mono />
        <Meta label="Commit" value={graph.commitSha} mono />
        <Meta label="Generated" value={graph.generatedAt} />
        <Meta
          label="Generator"
          value={`${graph.generator.executor}${graph.generator.model ? ` · ${graph.generator.model}` : ""}`}
        />
        <Meta label="Size" value={`${graph.nodes.length} nodes · ${graph.edges.length} edges`} />
      </div>
      <GraphView nodes={graph.nodes} edges={graph.edges} />
    </main>
  );
}

function Meta({ label, value, mono }: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div>{mono ? <code>{value}</code> : value}</div>
    </div>
  );
}
