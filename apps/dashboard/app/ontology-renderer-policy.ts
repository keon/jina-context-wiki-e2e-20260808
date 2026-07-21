export const CANVAS_NODE_LIMIT = 1_200;
export const CANVAS_EDGE_LIMIT = 3_000;

export type RendererMode = "webgl" | "canvas";

export interface SliceNode {
  readonly id: string;
}

export interface SliceEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export function chooseRendererMode(webglAvailable: boolean): RendererMode {
  return webglAvailable ? "webgl" : "canvas";
}

export function canvasFallbackStatus(
  sourceNodeCount: number,
  sourceEdgeCount: number,
  renderedNodeCount: number,
  renderedEdgeCount: number
): string {
  const truncated = sourceNodeCount > renderedNodeCount || sourceEdgeCount > renderedEdgeCount;
  return truncated
    ? `Canvas fallback · rendering ${renderedNodeCount.toLocaleString()} of ${countLabel(sourceNodeCount, "node")} · ${renderedEdgeCount.toLocaleString()} of ${countLabel(sourceEdgeCount, "edge")}`
    : `Canvas fallback · ${countLabel(sourceNodeCount, "node")} · ${countLabel(sourceEdgeCount, "edge")}`;
}

function countLabel(count: number, label: string): string {
  return `${count.toLocaleString()} ${label}${count === 1 ? "" : "s"}`;
}

export function canvasGraphSlice<Node extends SliceNode, Edge extends SliceEdge>(
  nodes: readonly Node[],
  edges: readonly Edge[],
  nodeLimit = CANVAS_NODE_LIMIT,
  edgeLimit = CANVAS_EDGE_LIMIT
): { readonly nodes: readonly Node[]; readonly edges: readonly Edge[]; readonly truncated: boolean } {
  if (nodes.length <= nodeLimit && edges.length <= edgeLimit) {
    return { nodes, edges, truncated: false };
  }

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const selectedNodes = [...nodes]
    .sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, nodeLimit));
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = edges
    .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    .slice(0, Math.max(0, edgeLimit));
  return { nodes: selectedNodes, edges: selectedEdges, truncated: true };
}
