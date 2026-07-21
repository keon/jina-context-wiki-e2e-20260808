import type {
  ContextGraphEdge,
  ContextGraph,
  ContextGraphSummary,
  ContextGraphNode,
  RetrievalCitation
} from "@jina/context-graph";
import type { GraphQueryResult } from "./mcp.js";

export interface PublicGraphSummary {
  readonly id: string;
  readonly repository: string;
  readonly versionLabel: string;
  readonly sourceCommit: string;
  readonly generatedAt: string;
  readonly summary: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface PublicGraph extends PublicGraphSummary {
  readonly nodes: readonly ContextGraphNode[];
  readonly edges: readonly ContextGraphEdge[];
}

export interface PublicGraphQueryResult extends GraphQueryResult {
  readonly graphId: string;
  readonly highlightedNodeIds: readonly string[];
  readonly highlightedEdgeIds: readonly string[];
}

/** Removes tenant, worker, model, and executor metadata from a graph listing. */
export function publicGraphSummary(graph: ContextGraphSummary): PublicGraphSummary {
  return {
    id: graph.id,
    repository: graph.repository,
    versionLabel: publicVersionLabel(graph.ref),
    sourceCommit: graph.commitSha,
    generatedAt: graph.generatedAt,
    summary: graph.summary,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount
  };
}

/** Public read model used by dashboards. rawModelOutput is never included. */
export function publicGraph(graph: ContextGraph): PublicGraph {
  return {
    id: graph.id,
    repository: graph.repository,
    versionLabel: publicVersionLabel(graph.ref),
    sourceCommit: graph.commitSha,
    generatedAt: graph.generatedAt,
    summary: graph.summary,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    nodes: graph.nodes,
    edges: graph.edges
  };
}

export function publicGraphQueryResult(graph: ContextGraph, result: GraphQueryResult): PublicGraphQueryResult {
  const citations = result.claims.flatMap((claim) => claim.citations);
  const citedIds = new Set(citations.map((citation) => citation.id));
  return {
    graphId: graph.id,
    ...result,
    highlightedNodeIds: graph.nodes
      .filter((node) => citationMatches(node.id, node.evidence, citations, citedIds))
      .map((node) => node.id),
    highlightedEdgeIds: graph.edges
      .filter((edge) => citationMatches(edge.id, edge.evidence, citations, citedIds))
      .map((edge) => edge.id)
  };
}

function publicVersionLabel(ref: string): string {
  const pullRequest = /(?:refs\/pull\/|pull\/|pr-?)(\d+)/i.exec(ref)?.[1];
  if (pullRequest) return `PR #${pullRequest}`;
  return ref.replace(/^refs\/heads\//, "") || "Current";
}

function citationMatches(
  id: string,
  evidence: readonly string[],
  citations: readonly RetrievalCitation[],
  citedIds: ReadonlySet<string>
): boolean {
  if (citedIds.has(id)) return true;
  return citations.some((citation) =>
    evidence.some((item) => item.includes(citation.id) || (citation.path ? item.includes(citation.path) : false))
  );
}
