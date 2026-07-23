export interface LayoutNode {
  readonly id: string;
}

export interface LayoutEdge {
  readonly source: string;
  readonly target: string;
}

export type GraphPosition = readonly [number, number];

const GRAPH_SPACE_CENTER = 2048;

export function initializeGraphPositions(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  cachedPositions: ReadonlyMap<string, GraphPosition>
): { readonly positions: Float32Array; readonly reusedPositionCount: number } {
  const positions = new Float32Array(nodes.length * 2);
  const assigned = new Map<string, GraphPosition>();
  const unresolved: number[] = [];

  nodes.forEach((node, index) => {
    const cached = cachedPositions.get(node.id);
    if (cached && Number.isFinite(cached[0]) && Number.isFinite(cached[1])) {
      setPosition(positions, index, cached);
      assigned.set(node.id, cached);
    } else {
      unresolved.push(index);
    }
  });

  const reusedPositionCount = assigned.size;
  if (reusedPositionCount === 0) {
    nodes.forEach((node, index) => setPosition(positions, index, seedPosition(node.id, index, nodes.length)));
    centerPositions(positions);
    return { positions, reusedPositionCount };
  }

  const neighbors = neighborIds(edges);
  let pending = unresolved;
  let addedNeighborPosition = true;
  while (pending.length && addedNeighborPosition) {
    addedNeighborPosition = false;
    const nextPending: number[] = [];
    for (const index of pending) {
      const node = nodes[index];
      if (!node) continue;
      const neighborPositions = (neighbors.get(node.id) ?? []).flatMap((id) => {
        const position = assigned.get(id);
        return position ? [position] : [];
      });
      if (!neighborPositions.length) {
        nextPending.push(index);
        continue;
      }
      const anchor = centroid(neighborPositions);
      const position = offsetFrom(anchor, node.id, 14, 28);
      setPosition(positions, index, position);
      assigned.set(node.id, position);
      addedNeighborPosition = true;
    }
    pending = nextPending;
  }

  const center = centroid([...assigned.values()]);
  pending.forEach((index, pendingIndex) => {
    const node = nodes[index];
    if (!node) return;
    const radius = Math.min(120, 22 + Math.sqrt(pendingIndex + 1) * 14);
    const position = offsetFrom(center, node.id, radius, radius + 12);
    setPosition(positions, index, position);
  });
  return { positions, reusedPositionCount };
}

export function seedPosition(id: string, index: number, total: number): [number, number] {
  const hash = hashString(id);
  const angle = index * 2.399963229728653 + ((hash % 360) * Math.PI) / 180;
  const radius = 12 + Math.sqrt(index + 1) * Math.max(4.5, 120 / Math.sqrt(Math.max(1, total)));
  const jitter = ((hash >>> 8) % 1000) / 1000;
  return [Math.cos(angle) * radius * (0.85 + jitter * 0.3), Math.sin(angle) * radius * (0.85 + (1 - jitter) * 0.3)];
}

export function centerPositions(positions: Float32Array): void {
  const pointCount = positions.length / 2;
  if (!pointCount) return;
  let centerX = 0;
  let centerY = 0;
  for (let index = 0; index < pointCount; index += 1) {
    centerX += positions[index * 2] ?? 0;
    centerY += positions[index * 2 + 1] ?? 0;
  }
  centerX /= pointCount;
  centerY /= pointCount;
  for (let index = 0; index < pointCount; index += 1) {
    positions[index * 2] = (positions[index * 2] ?? 0) - centerX + GRAPH_SPACE_CENTER;
    positions[index * 2 + 1] = (positions[index * 2 + 1] ?? 0) - centerY + GRAPH_SPACE_CENTER;
  }
}

function neighborIds(edges: readonly LayoutEdge[]): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const sourceNeighbors = result.get(edge.source) ?? [];
    sourceNeighbors.push(edge.target);
    result.set(edge.source, sourceNeighbors);
    const targetNeighbors = result.get(edge.target) ?? [];
    targetNeighbors.push(edge.source);
    result.set(edge.target, targetNeighbors);
  }
  return result;
}

function centroid(positions: readonly GraphPosition[]): [number, number] {
  if (!positions.length) return [GRAPH_SPACE_CENTER, GRAPH_SPACE_CENTER];
  let x = 0;
  let y = 0;
  for (const position of positions) {
    x += position[0];
    y += position[1];
  }
  return [x / positions.length, y / positions.length];
}

function offsetFrom(anchor: GraphPosition, id: string, minRadius: number, maxRadius: number): [number, number] {
  const hash = hashString(id);
  const angle = ((hash % 360) * Math.PI) / 180;
  const ratio = ((hash >>> 8) % 1000) / 1000;
  const radius = minRadius + (maxRadius - minRadius) * ratio;
  return [anchor[0] + Math.cos(angle) * radius, anchor[1] + Math.sin(angle) * radius];
}

function setPosition(positions: Float32Array, index: number, position: GraphPosition): void {
  positions[index * 2] = position[0];
  positions[index * 2 + 1] = position[1];
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
