import Link from "next/link";
import { notFound } from "next/navigation";
import { GraphView } from "../../../components/graph-view";
import { ErrorPanel, formatTimestamp, PageHeader, shortRef } from "../../../components/ui";
import { getGraph } from "../../../lib/jina-api";

export const dynamic = "force-dynamic";

export default async function GraphDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{ readonly tenantId?: string }>;
}) {
  const { id } = await params;
  const { tenantId } = await searchParams;
  let graph;
  try {
    graph = await getGraph(decodeURIComponent(id), tenantId);
  } catch (error) {
    return (
      <main>
        <PageHeader title="Graph" description="Inspect one generated repository graph." />
        <ErrorPanel error={error} message="Could not load this graph from the Jina API." />
      </main>
    );
  }
  if (!graph) notFound();

  return (
    <main>
      <p className="back-link">
        <Link href="/">← All graphs</Link>
      </p>
      <PageHeader title={graph.repository} description={graph.summary} />
      <div className="meta-grid">
        <Meta label="Graph ID" value={graph.id} mono />
        <Meta label="Tenant" value={graph.tenantId} mono />
        <Meta label="Ref" value={shortRef(graph.ref)} mono />
        <Meta label="Commit" value={graph.commitSha} mono />
        <Meta label="Generated" value={formatTimestamp(graph.generatedAt)} />
        <Meta
          label="Generator"
          value={`${graph.generator.executor}${graph.generator.model ? ` · ${graph.generator.model}` : ""}`}
        />
        <Meta label="Size" value={`${graph.nodes.length} nodes · ${graph.edges.length} edges`} />
      </div>
      <GraphView tenantId={graph.tenantId} graphId={graph.id} nodes={graph.nodes} edges={graph.edges} />
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
