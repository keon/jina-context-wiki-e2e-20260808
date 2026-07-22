import type { AdminGraphEdge, AdminGraphNode } from "./jina-api";

export const GRAPH_WIDTH = 1200;
export const GRAPH_HEIGHT = 560;

export interface PositionedGraphNode extends AdminGraphNode {
  readonly x: number;
  readonly y: number;
}

/** Deterministic force-directed layout for the admin graph visualization. */
export function layoutGraph(
  nodes: readonly AdminGraphNode[],
  edges: readonly AdminGraphEdge[]
): readonly PositionedGraphNode[] {
  const count = nodes.length;
  if (count === 0) return [];

  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const radius = Math.min(GRAPH_WIDTH, GRAPH_HEIGHT) * 0.38;
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / count + seededJitter(nodes[i]?.id ?? String(i));
    xs[i] = GRAPH_WIDTH / 2 + radius * Math.cos(angle);
    ys[i] = GRAPH_HEIGHT / 2 + radius * Math.sin(angle);
  }

  const links = edges
    .map((edge) => [index.get(edge.source), index.get(edge.target)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);
  const iterations = count > 400 ? 120 : 300;

  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    const fx = new Float64Array(count);
    const fy = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const dx = (xs[i] ?? 0) - (xs[j] ?? 0);
        const dy = (ys[i] ?? 0) - (ys[j] ?? 0);
        const distanceSquared = Math.max(dx * dx + dy * dy, 64);
        const force = 5200 / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        fx[i] = (fx[i] ?? 0) + (dx / distance) * force;
        fy[i] = (fy[i] ?? 0) + (dy / distance) * force;
        fx[j] = (fx[j] ?? 0) - (dx / distance) * force;
        fy[j] = (fy[j] ?? 0) - (dy / distance) * force;
      }
    }
    for (const [source, target] of links) {
      const dx = (xs[target] ?? 0) - (xs[source] ?? 0);
      const dy = (ys[target] ?? 0) - (ys[source] ?? 0);
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const force = (distance - 120) * 0.02;
      fx[source] = (fx[source] ?? 0) + (dx / distance) * force;
      fy[source] = (fy[source] ?? 0) + (dy / distance) * force;
      fx[target] = (fx[target] ?? 0) - (dx / distance) * force;
      fy[target] = (fy[target] ?? 0) - (dy / distance) * force;
    }
    for (let i = 0; i < count; i += 1) {
      xs[i] = clamp((xs[i] ?? 0) + (fx[i] ?? 0) * cooling, 40, GRAPH_WIDTH - 40);
      ys[i] = clamp((ys[i] ?? 0) + (fy[i] ?? 0) * cooling, 40, GRAPH_HEIGHT - 40);
    }
  }

  return nodes.map((node, i) => ({
    ...node,
    x: round1(xs[i] ?? GRAPH_WIDTH / 2),
    y: round1(ys[i] ?? GRAPH_HEIGHT / 2)
  }));
}

function seededJitter(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000 - 0.5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
