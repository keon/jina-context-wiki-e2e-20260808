import { Graph } from "@cosmos.gl/graph";
import { canvasFallbackStatus, canvasGraphSlice, chooseRendererMode } from "./ontology-renderer-policy.js";

type GraphNode = {
  id: string;
  kind: string;
  label: string;
  description?: string;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  predicate: string;
  plane: "code" | "knowledge" | string;
};

type GraphSelection = { kind: "node" | "edge"; id: string } | null;

type RendererData = {
  key: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  labels: Record<string, string>;
};

type RendererOptions = {
  container: HTMLDivElement;
  labels: HTMLElement;
  minimap: HTMLCanvasElement;
  status: HTMLElement;
  onSelect: (selection: GraphSelection) => void;
  onZoomChange?: (percent: number) => void;
};

type PublicRenderer = {
  setData(data: RendererData): void;
  setSelection(selection: GraphSelection): void;
  setSearchMatches(matches: Exclude<GraphSelection, null>[]): void;
  fit(): void;
  zoomBy(factor: number): void;
  reset(): void;
  setPhysics(enabled: boolean): void;
  destroy(): void;
};

declare global {
  interface Window {
    JinaOntologyGraph?: { create(options: RendererOptions): PublicRenderer };
  }
}

const NODE_COLORS: Record<string, [number, number, number, number]> = {
  Repository: [0.63, 0.56, 0.95, 1],
  File: [0.35, 0.66, 0.72, 0.96],
  Symbol: [0.31, 0.72, 0.63, 0.96],
  Document: [0.69, 0.48, 0.86, 1],
  Feature: [0.57, 0.45, 0.78, 1],
  Commit: [0.38, 0.77, 0.52, 0.98],
  PullRequest: [0.45, 0.82, 0.58, 1],
  Issue: [0.91, 0.58, 0.39, 1],
  Engineer: [0.45, 0.61, 0.83, 0.98],
  Team: [0.46, 0.59, 0.77, 0.98]
};

const DEFAULT_NODE_COLOR: [number, number, number, number] = [0.58, 0.62, 0.69, 0.94];
const CODE_LINK_COLOR: [number, number, number, number] = [0.36, 0.49, 0.73, 0.42];
const KNOWLEDGE_LINK_COLOR: [number, number, number, number] = [0.58, 0.43, 0.73, 0.48];

class OntologyGraphRenderer implements PublicRenderer {
  private readonly options: RendererOptions;
  private readonly graph: Graph;
  private data: RendererData = { key: "empty", nodes: [], edges: [], labels: {} };
  private dataKey = "";
  private selection: GraphSelection = null;
  private searchMatches: Exclude<GraphSelection, null>[] = [];
  private nodeIndex = new Map<string, number>();
  private edgeIndex = new Map<string, number>();
  private degree: number[] = [];
  private labelFrame: number | null = null;
  private fitTimers: number[] = [];
  private hoveredNode: number | null = null;
  private hoveredEdge: number | null = null;
  private physics = true;
  private ready = false;
  private userAdjustedView = false;
  private lastAutoFit = 0;
  private resizeObserver: ResizeObserver;
  private readonly edgeDragStart = (event: PointerEvent) => this.beginEdgeDrag(event);
  private edgeDrag: {
    pointerId: number;
    sourceIndex: number;
    targetIndex: number;
    start: [number, number];
    positions: number[];
  } | null = null;

  constructor(options: RendererOptions, onUnavailable: () => void) {
    this.options = options;
    this.graph = new Graph(options.container, {
      backgroundColor: [0.035, 0.039, 0.039, 0],
      enableSimulation: true,
      fitViewOnInit: true,
      fitViewDelay: 250,
      fitViewPadding: 0.14,
      fitViewDuration: 500,
      enableDrag: true,
      enableZoom: true,
      simulationGravity: 0.08,
      simulationCenter: 0.03,
      simulationRepulsion: 0.76,
      simulationRepulsionTheta: 1.35,
      simulationLinkSpring: 0.68,
      simulationLinkDistance: 5.4,
      simulationLinkDistRandomVariationRange: [0.85, 1.4],
      simulationCollision: 0.7,
      simulationCollisionPadding: 1.7,
      simulationFriction: 0.88,
      simulationDecay: 6500,
      renderLinks: true,
      curvedLinks: false,
      linkDefaultWidth: 0.72,
      linkOpacity: 0.7,
      linkGreyoutOpacity: 0.035,
      linkVisibilityDistanceRange: [90, 900],
      linkVisibilityMinTransparency: 0.1,
      linkColorInterpolateFromEndpoints: false,
      linkDefaultArrows: false,
      hoveredLinkColor: [0.67, 0.61, 1, 1],
      hoveredLinkWidthIncrease: 2.2,
      focusedLinkWidthIncrease: 2.8,
      pointDefaultSize: 4,
      pointSizeScale: 1,
      pointOpacity: 1,
      pointGreyoutColor: [0.24, 0.27, 0.28, 1],
      pointGreyoutOpacity: 0.18,
      renderHoveredPointRing: true,
      hoveredPointRingColor: [0.82, 0.79, 1, 1],
      focusedPointRingColor: [0.64, 0.56, 1, 1],
      outlinedPointRingColor: [0.64, 0.82, 0.76, 0.9],
      hoveredPointCursor: "grab",
      hoveredLinkCursor: "pointer",
      pointSamplingDistance: 115,
      linkSamplingDistance: 150,
      onPointClick: (index) => {
        const node = this.data.nodes[index];
        if (node) this.options.onSelect({ kind: "node", id: node.id });
      },
      onLinkClick: (index) => {
        const edge = this.data.edges[index];
        if (edge) this.options.onSelect({ kind: "edge", id: edge.id });
      },
      onBackgroundClick: () => this.options.onSelect(null),
      onPointMouseOver: (index) => {
        this.hoveredNode = index;
        this.queueLabels();
      },
      onPointMouseOut: () => {
        this.hoveredNode = null;
        this.queueLabels();
      },
      onLinkMouseOver: (index) => {
        this.hoveredEdge = index;
        this.queueLabels();
      },
      onLinkMouseOut: () => {
        this.hoveredEdge = null;
        this.queueLabels();
      },
      onSimulationStart: () => this.setStatus("Organizing topology…", true),
      onSimulationTick: () => {
        const now = Date.now();
        if (!this.userAdjustedView && now - this.lastAutoFit > 450) {
          this.lastAutoFit = now;
          this.graph.fitView(0, 0.14, false);
        }
        this.queueLabels();
      },
      onSimulationEnd: () => {
        this.setStatus(this.data.nodes.length.toLocaleString() + " nodes · settled", false);
        this.graph.fitView(400, 0.14, false);
        this.queueLabels();
        this.drawMinimap();
      },
      onZoom: (_event, userDriven) => {
        if (userDriven) this.stopAutoFit();
        this.options.onZoomChange?.(Math.round(this.graph.getZoomLevel() * 100));
        this.queueLabels();
      },
      onZoomEnd: () => {
        this.queueLabels();
        this.drawMinimap();
      },
      onDragStart: () => this.stopAutoFit(),
      onDrag: () => this.queueLabels(),
      onDragEnd: () => {
        this.queueLabels();
        this.drawMinimap();
      }
    });
    this.resizeObserver = new ResizeObserver(() => {
      this.queueLabels();
      this.drawMinimap();
    });
    this.resizeObserver.observe(options.container);
    options.labels.addEventListener("pointerdown", this.edgeDragStart);
    window.addEventListener("pointermove", this.moveEdgeDrag);
    window.addEventListener("pointerup", this.finishEdgeDrag);
    window.addEventListener("pointercancel", this.finishEdgeDrag);
    void this.graph.ready.then(() => {
      this.ready = true;
      this.setStatus("GPU renderer ready", false);
      const pendingData = this.data;
      const pendingSearchMatches = this.searchMatches;
      this.dataKey = "";
      this.searchMatches = [];
      this.setData(pendingData);
      this.setSearchMatches(pendingSearchMatches);
      this.queueLabels();
    }).catch(() => onUnavailable());
  }

  setData(data: RendererData): void {
    const nextKey = data.key;
    if (!this.ready) {
      this.data = data;
      return;
    }
    if (nextKey === this.dataKey) {
      this.data = data;
      this.setSelection(this.selection);
      return;
    }

    const previousPositions = this.positionsById();
    this.data = data;
    this.userAdjustedView = false;
    this.dataKey = nextKey;
    this.nodeIndex = new Map(data.nodes.map((node, index) => [node.id, index]));
    this.edgeIndex = new Map(data.edges.map((edge, index) => [edge.id, index]));
    this.degree = new Array(data.nodes.length).fill(0);
    const links = new Float32Array(data.edges.length * 2);
    const linkColors = new Float32Array(data.edges.length * 4);
    const linkWidths = new Float32Array(data.edges.length);
    const linkStyles = new Float32Array(data.edges.length);
    data.edges.forEach((edge, index) => {
      const source = this.nodeIndex.get(edge.source) ?? 0;
      const target = this.nodeIndex.get(edge.target) ?? 0;
      links[index * 2] = source;
      links[index * 2 + 1] = target;
      this.degree[source] = (this.degree[source] ?? 0) + 1;
      this.degree[target] = (this.degree[target] ?? 0) + 1;
      const color = edge.plane === "knowledge" ? KNOWLEDGE_LINK_COLOR : CODE_LINK_COLOR;
      linkColors.set(color, index * 4);
      linkWidths[index] = edge.plane === "knowledge" ? 0.9 : 0.65;
      linkStyles[index] = edge.plane === "knowledge" ? 1 : 0;
    });

    const positions = new Float32Array(data.nodes.length * 2);
    const pointColors = new Float32Array(data.nodes.length * 4);
    const pointSizes = new Float32Array(data.nodes.length);
    const pointShapes = new Float32Array(data.nodes.length);
    data.nodes.forEach((node, index) => {
      const previous = previousPositions.get(node.id);
      const seeded = previous ?? seedPosition(node.id, index, data.nodes.length);
      positions[index * 2] = seeded[0];
      positions[index * 2 + 1] = seeded[1];
      pointColors.set(NODE_COLORS[node.kind] ?? DEFAULT_NODE_COLOR, index * 4);
      pointSizes[index] = Math.min(14, 4.4 + Math.sqrt(this.degree[index] ?? 0) * 1.8);
      pointShapes[index] = node.kind === "Repository" ? 5 : node.kind === "Issue" ? 3 : 0;
    });

    this.graph.setPointPositions(positions, true);
    this.graph.setPointColors(pointColors);
    this.graph.setPointSizes(pointSizes);
    this.graph.setPointShapes(pointShapes);
    this.graph.setLinks(links);
    this.graph.setLinkColors(linkColors);
    this.graph.setLinkWidths(linkWidths);
    this.graph.setLinkStyles(linkStyles);
    this.graph.setLinkArrows(new Array(data.edges.length).fill(false));
    this.graph.render(0.9, 0);
    if (this.physics) this.graph.start(0.9);
    this.setStatus(data.nodes.length ? "Organizing topology…" : "No visible nodes", Boolean(data.nodes.length));
    this.setSelection(this.selection);
    this.scheduleFitSequence();
  }

  setSelection(selection: GraphSelection): void {
    const selectionChanged = selection?.kind !== this.selection?.kind || selection?.id !== this.selection?.id;
    this.selection = selection;
    if (!this.ready) return;
    this.applyHighlights(selectionChanged, false);
  }

  setSearchMatches(matches: Exclude<GraphSelection, null>[]): void {
    const previousKey = this.searchMatches.map((match) => match.kind + ":" + match.id).join("|");
    const nextKey = matches.map((match) => match.kind + ":" + match.id).join("|");
    this.searchMatches = matches;
    if (!this.ready) return;
    this.applyHighlights(false, previousKey !== nextKey);
  }

  private applyHighlights(selectionChanged: boolean, searchChanged: boolean): void {
    let highlightedPoints: number[] | undefined;
    let highlightedLinks: number[] | undefined;
    let focusedPointIndex: number | undefined;
    let focusedLinkIndex: number | undefined;
    if (this.searchMatches.length) {
      highlightedPoints = [];
      highlightedLinks = [];
      for (const match of this.searchMatches) {
        if (match.kind === "node") {
          const pointIndex = this.nodeIndex.get(match.id);
          if (pointIndex !== undefined) highlightedPoints.push(pointIndex);
          continue;
        }
        const linkIndex = this.edgeIndex.get(match.id);
        const edge = linkIndex === undefined ? undefined : this.data.edges[linkIndex];
        if (linkIndex !== undefined) highlightedLinks.push(linkIndex);
        const source = edge ? this.nodeIndex.get(edge.source) : undefined;
        const target = edge ? this.nodeIndex.get(edge.target) : undefined;
        if (source !== undefined) highlightedPoints.push(source);
        if (target !== undefined) highlightedPoints.push(target);
      }
      highlightedPoints = Array.from(new Set(highlightedPoints));
      highlightedLinks = Array.from(new Set(highlightedLinks));
    } else if (this.selection?.kind === "node") {
      focusedPointIndex = this.nodeIndex.get(this.selection.id);
      if (focusedPointIndex !== undefined) {
        highlightedPoints = [focusedPointIndex];
        highlightedLinks = [];
        this.data.edges.forEach((edge, index) => {
          if (edge.source !== this.selection?.id && edge.target !== this.selection?.id) return;
          highlightedLinks?.push(index);
          const source = this.nodeIndex.get(edge.source);
          const target = this.nodeIndex.get(edge.target);
          if (source !== undefined) highlightedPoints?.push(source);
          if (target !== undefined) highlightedPoints?.push(target);
        });
        highlightedPoints = Array.from(new Set(highlightedPoints));
      }
    } else if (this.selection?.kind === "edge") {
      focusedLinkIndex = this.edgeIndex.get(this.selection.id);
      if (focusedLinkIndex !== undefined) {
        const edge = this.data.edges[focusedLinkIndex];
        const source = edge ? this.nodeIndex.get(edge.source) : undefined;
        const target = edge ? this.nodeIndex.get(edge.target) : undefined;
        highlightedPoints = [source, target].filter((index): index is number => index !== undefined);
        highlightedLinks = [focusedLinkIndex];
      }
    }
    this.graph.setConfigPartial({
      focusedPointIndex,
      focusedLinkIndex,
      highlightedPointIndices: highlightedPoints,
      outlinedPointIndices: highlightedPoints,
      highlightedLinkIndices: highlightedLinks
    } as unknown as Parameters<Graph["setConfigPartial"]>[0]);
    this.graph.render(undefined, 140);
    if (searchChanged && this.searchMatches.length && highlightedPoints?.length) {
      this.stopAutoFit();
      this.graph.fitViewByPointIndices(highlightedPoints, 360, 0.2, false);
    } else if (selectionChanged && !this.searchMatches.length) {
      this.stopAutoFit();
      if (highlightedPoints?.length) this.graph.fitViewByPointIndices(highlightedPoints, 420, 0.24, false);
      else this.graph.fitView(420, 0.14, false);
    }
    this.queueLabels();
  }

  fit(): void {
    this.stopAutoFit();
    this.graph.fitView(450, 0.14, this.physics);
  }

  zoomBy(factor: number): void {
    this.stopAutoFit();
    this.graph.zoom(Math.max(0.05, Math.min(12, this.graph.getZoomLevel() * factor)), 180, this.physics);
  }

  reset(): void {
    this.userAdjustedView = false;
    const positions = new Float32Array(this.data.nodes.length * 2);
    this.data.nodes.forEach((node, index) => {
      const seeded = seedPosition(node.id, index, this.data.nodes.length);
      positions[index * 2] = seeded[0];
      positions[index * 2 + 1] = seeded[1];
    });
    this.graph.setPinnedPoints([]);
    this.graph.setPointPositions(positions, true);
    this.graph.render(1, 220);
    if (this.physics) this.graph.start(1);
    window.setTimeout(() => this.graph.fitView(450, 0.14, this.physics), 180);
  }

  setPhysics(enabled: boolean): void {
    if (this.physics === enabled) return;
    this.physics = enabled;
    this.graph.setConfigPartial({ enableSimulation: enabled });
    if (enabled) this.graph.start(0.55);
    else this.graph.pause();
    this.setStatus(enabled ? "Physics on" : "Physics paused", enabled);
  }

  destroy(): void {
    if (this.labelFrame !== null) cancelAnimationFrame(this.labelFrame);
    this.fitTimers.forEach((timer) => clearTimeout(timer));
    this.resizeObserver.disconnect();
    this.options.labels.removeEventListener("pointerdown", this.edgeDragStart);
    window.removeEventListener("pointermove", this.moveEdgeDrag);
    window.removeEventListener("pointerup", this.finishEdgeDrag);
    window.removeEventListener("pointercancel", this.finishEdgeDrag);
    this.graph.destroy();
  }

  private positionsById(): Map<string, [number, number]> {
    const positions = this.graph.getPointPositions();
    const result = new Map<string, [number, number]>();
    this.data.nodes.forEach((node, index) => {
      const x = positions[index * 2];
      const y = positions[index * 2 + 1];
      if (Number.isFinite(x) && Number.isFinite(y)) result.set(node.id, [x as number, y as number]);
    });
    return result;
  }

  private queueLabels(): void {
    if (this.labelFrame !== null) return;
    this.labelFrame = requestAnimationFrame(() => {
      this.labelFrame = null;
      this.renderLabels();
    });
  }

  private renderLabels(): void {
    if (!this.ready || !this.data.nodes.length) {
      this.options.labels.replaceChildren();
      return;
    }
    const nodeIndices = new Set<number>();
    const edgeIndices = new Set<number>();
    if (this.hoveredNode !== null) nodeIndices.add(this.hoveredNode);
    if (this.hoveredEdge !== null) edgeIndices.add(this.hoveredEdge);
    if (this.searchMatches.length) {
      for (const match of this.searchMatches) {
        if (match.kind === "node") {
          const index = this.nodeIndex.get(match.id);
          if (index !== undefined) nodeIndices.add(index);
        } else {
          const index = this.edgeIndex.get(match.id);
          if (index !== undefined) edgeIndices.add(index);
        }
      }
    } else if (this.selection?.kind === "node") {
      const selected = this.nodeIndex.get(this.selection.id);
      if (selected !== undefined) nodeIndices.add(selected);
      this.data.edges.forEach((edge, index) => {
        if (edge.source !== this.selection?.id && edge.target !== this.selection?.id) return;
        edgeIndices.add(index);
        const source = this.nodeIndex.get(edge.source);
        const target = this.nodeIndex.get(edge.target);
        if (source !== undefined) nodeIndices.add(source);
        if (target !== undefined) nodeIndices.add(target);
      });
    } else if (this.selection?.kind === "edge") {
      const selected = this.edgeIndex.get(this.selection.id);
      if (selected !== undefined) edgeIndices.add(selected);
    } else {
      const sampled = this.graph.getSampledPoints().indices;
      const sample = (sampled.length ? sampled : this.data.nodes.map((_node, index) => index))
        .sort((left, right) => (this.degree[right] ?? 0) - (this.degree[left] ?? 0));
      const limit = this.graph.getZoomLevel() > 4 ? 12 : 8;
      sample.slice(0, limit).forEach((index) => nodeIndices.add(index));
    }
    for (const edgeIndex of edgeIndices) {
      const edge = this.data.edges[edgeIndex];
      if (!edge) continue;
      const source = this.nodeIndex.get(edge.source);
      const target = this.nodeIndex.get(edge.target);
      if (source !== undefined) nodeIndices.add(source);
      if (target !== undefined) nodeIndices.add(target);
    }

    const positions = this.graph.getPointPositions();
    const nodeFragments: HTMLElement[] = [];
    const edgeFragments: HTMLElement[] = [];
    for (const index of nodeIndices) {
      const node = this.data.nodes[index];
      const x = positions[index * 2];
      const y = positions[index * 2 + 1];
      if (!node || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const screen = this.graph.spaceToScreenPosition([x as number, y as number]);
      if (!inside(this.options.container, screen, 46)) continue;
      const label = document.createElement("button");
      label.type = "button";
      label.className = "cosmos-node-label" + (this.selection?.kind === "node" && this.selection.id === node.id ? " selected" : "");
      label.style.transform = `translate(${screen[0]}px, ${screen[1]}px)`;
      label.dataset.nodeId = node.id;
      label.setAttribute("aria-label", `${node.kind}: ${this.data.labels[node.id] ?? node.label}`);
      const name = document.createElement("span");
      name.textContent = truncate(this.data.labels[node.id] ?? node.label, 38);
      const kind = document.createElement("small");
      kind.textContent = humanize(node.kind);
      label.append(name, kind);
      label.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.onSelect({ kind: "node", id: node.id });
      });
      nodeFragments.push(label);
    }
    for (const index of edgeIndices) {
      const edge = this.data.edges[index];
      if (!edge) continue;
      const sourceIndex = this.nodeIndex.get(edge.source);
      const targetIndex = this.nodeIndex.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) continue;
      const source = this.graph.spaceToScreenPosition([positions[sourceIndex * 2] as number, positions[sourceIndex * 2 + 1] as number]);
      const target = this.graph.spaceToScreenPosition([positions[targetIndex * 2] as number, positions[targetIndex * 2 + 1] as number]);
      const dx = target[0] - source[0];
      const dy = target[1] - source[1];
      const length = Math.max(1, Math.hypot(dx, dy));
      const laneOffset = ((index % 7) - 3) * 10;
      const middle: [number, number] = [
        (source[0] + target[0]) / 2 - dy / length * laneOffset,
        (source[1] + target[1]) / 2 + dx / length * laneOffset
      ];
      if (!inside(this.options.container, middle, 80)) continue;
      const label = document.createElement("button");
      label.type = "button";
      label.className = "cosmos-edge-label" + (this.selection?.kind === "edge" && this.selection.id === edge.id ? " selected" : "");
      label.style.transform = `translate(${middle[0]}px, ${middle[1]}px)`;
      label.dataset.edgeId = edge.id;
      label.dataset.edgeIndex = String(index);
      label.textContent = humanize(edge.predicate);
      label.title = "Click for evidence. Drag to move this relationship and both endpoints.";
      label.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.onSelect({ kind: "edge", id: edge.id });
      });
      edgeFragments.push(label);
    }
    edgeFragments.sort((left, right) => Number(left.classList.contains("selected")) - Number(right.classList.contains("selected")));
    nodeFragments.sort((left, right) => Number(left.classList.contains("selected")) - Number(right.classList.contains("selected")));
    this.options.labels.replaceChildren(...edgeFragments, ...nodeFragments);
  }

  private drawMinimap(): void {
    const canvas = this.options.minimap;
    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, bounds.width, bounds.height);
    const positions = this.graph.getPointPositions();
    const finite: Array<[number, number, number]> = [];
    this.data.nodes.forEach((_node, index) => {
      const x = positions[index * 2];
      const y = positions[index * 2 + 1];
      if (Number.isFinite(x) && Number.isFinite(y)) finite.push([x as number, y as number, index]);
    });
    if (!finite.length) return;
    const xs = finite.map((point) => point[0]);
    const ys = finite.map((point) => point[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const scaleX = (bounds.width - 16) / Math.max(1, maxX - minX);
    const scaleY = (bounds.height - 16) / Math.max(1, maxY - minY);
    const scale = Math.min(scaleX, scaleY);
    for (const point of finite) {
      const node = this.data.nodes[point[2]];
      const color = NODE_COLORS[node?.kind ?? ""] ?? DEFAULT_NODE_COLOR;
      context.fillStyle = `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, .8)`;
      context.beginPath();
      context.arc(8 + (point[0] - minX) * scale, 8 + (point[1] - minY) * scale, 1.35, 0, Math.PI * 2);
      context.fill();
    }
    context.strokeStyle = "rgba(155, 145, 255, .6)";
    context.strokeRect(3.5, 3.5, bounds.width - 7, bounds.height - 7);
  }

  private beginEdgeDrag(event: PointerEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-edge-index]");
    if (!target || event.button !== 0) return;
    const edgeIndex = Number(target.dataset.edgeIndex);
    const edge = this.data.edges[edgeIndex];
    if (!edge) return;
    const sourceIndex = this.nodeIndex.get(edge.source);
    const targetIndex = this.nodeIndex.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    target.setPointerCapture(event.pointerId);
    this.edgeDrag = {
      pointerId: event.pointerId,
      sourceIndex,
      targetIndex,
      start: [event.clientX, event.clientY],
      positions: this.graph.getPointPositions().slice()
    };
    this.graph.setPinnedPoints([sourceIndex, targetIndex]);
  }

  private moveEdgeDrag = (event: PointerEvent): void => {
    const drag = this.edgeDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = this.options.container.getBoundingClientRect();
    const from = this.graph.screenToSpacePosition([drag.start[0] - bounds.left, drag.start[1] - bounds.top]);
    const to = this.graph.screenToSpacePosition([event.clientX - bounds.left, event.clientY - bounds.top]);
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const positions = new Float32Array(drag.positions);
    for (const index of [drag.sourceIndex, drag.targetIndex]) {
      positions[index * 2] = (drag.positions[index * 2] ?? 0) + dx;
      positions[index * 2 + 1] = (drag.positions[index * 2 + 1] ?? 0) + dy;
    }
    this.graph.setPointPositions(positions, true);
    this.graph.render(undefined, 0);
    this.queueLabels();
  };

  private finishEdgeDrag = (event: PointerEvent): void => {
    if (!this.edgeDrag || this.edgeDrag.pointerId !== event.pointerId) return;
    this.edgeDrag = null;
    this.graph.setPinnedPoints([]);
    if (this.physics) this.graph.start(0.3);
    this.queueLabels();
    this.drawMinimap();
  };

  private setStatus(message: string, active: boolean): void {
    this.options.status.textContent = message;
    this.options.status.classList.toggle("active", active);
  }

  private scheduleFitSequence(): void {
    this.fitTimers.forEach((timer) => clearTimeout(timer));
    this.fitTimers = [180, 650, 1450, 2800].map((delay) => window.setTimeout(() => {
      this.graph.fitView(360, 0.14, this.physics);
      this.queueLabels();
    }, delay));
  }

  private stopAutoFit(): void {
    this.userAdjustedView = true;
    this.fitTimers.forEach((timer) => clearTimeout(timer));
    this.fitTimers = [];
  }
}

class CanvasOntologyGraphRenderer implements PublicRenderer {
  private readonly options: RendererOptions;
  private readonly canvas: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver;
  private data: RendererData = { key: "empty", nodes: [], edges: [], labels: {} };
  private sourceNodeCount = 0;
  private sourceEdgeCount = 0;
  private selection: GraphSelection = null;
  private searchMatches: Exclude<GraphSelection, null>[] = [];
  private zoom = 1;

  constructor(options: RendererOptions) {
    this.options = options;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "ontology-canvas-fallback";
    this.canvas.setAttribute("aria-label", "Canvas ontology graph fallback");
    options.container.prepend(this.canvas);
    this.canvas.addEventListener("pointerdown", this.selectAtPointer);
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(options.container);
    this.setStatus();
  }

  setData(data: RendererData): void {
    const selected = canvasGraphSlice(data.nodes, data.edges);
    this.data = { ...data, nodes: [...selected.nodes], edges: [...selected.edges] };
    this.sourceNodeCount = data.nodes.length;
    this.sourceEdgeCount = data.edges.length;
    this.setStatus();
    this.render();
  }

  setSelection(selection: GraphSelection): void {
    this.selection = selection;
    this.render();
  }

  setSearchMatches(matches: Exclude<GraphSelection, null>[]): void {
    this.searchMatches = matches;
    this.render();
  }

  fit(): void {
    this.zoom = 1;
    this.options.onZoomChange?.(100);
    this.render();
  }

  zoomBy(factor: number): void {
    this.zoom = Math.max(0.35, Math.min(4, this.zoom * factor));
    this.options.onZoomChange?.(Math.round(this.zoom * 100));
    this.render();
  }

  reset(): void {
    this.fit();
  }

  setPhysics(_enabled: boolean): void {
    // The deterministic fallback has no simulation; controls remain safe no-ops.
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.selectAtPointer);
    this.canvas.remove();
    this.options.labels.replaceChildren();
  }

  private render(): void {
    const bounds = this.options.container.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const positions = this.positions(width, height);
    const matchedNodes = this.highlightedNodeIds();
    const matchedEdges = new Set(this.searchMatches.filter((match) => match.kind === "edge").map((match) => match.id));

    for (const edge of this.data.edges) {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) continue;
      const selected = this.selection?.kind === "edge" && this.selection.id === edge.id;
      const highlighted = selected || matchedEdges.has(edge.id) || matchedNodes.has(edge.source) || matchedNodes.has(edge.target);
      context.strokeStyle = highlighted
        ? "rgba(177, 165, 255, .9)"
        : edge.plane === "knowledge" ? "rgba(148, 110, 186, .42)" : "rgba(92, 125, 186, .34)";
      context.lineWidth = highlighted ? 1.8 : 0.7;
      context.beginPath();
      context.moveTo(source[0], source[1]);
      context.lineTo(target[0], target[1]);
      context.stroke();
    }
    for (const node of this.data.nodes) {
      const point = positions.get(node.id);
      if (!point) continue;
      const selected = this.selection?.kind === "node" && this.selection.id === node.id;
      const highlighted = selected || matchedNodes.has(node.id);
      const color = NODE_COLORS[node.kind] ?? DEFAULT_NODE_COLOR;
      context.fillStyle = rgba(color, highlighted ? 1 : color[3]);
      context.beginPath();
      context.arc(point[0], point[1], highlighted ? 7 : 4.2, 0, Math.PI * 2);
      context.fill();
      if (highlighted) {
        context.strokeStyle = "rgba(225, 220, 255, .95)";
        context.lineWidth = 1.5;
        context.stroke();
      }
    }
    this.renderLabels(positions);
    this.renderMinimap();
  }

  private positions(width: number, height: number): Map<string, [number, number]> {
    const count = Math.max(1, this.data.nodes.length);
    const radius = Math.max(25, Math.min(width, height) * 0.44 * this.zoom);
    return new Map(this.data.nodes.map((node, index) => {
      const hash = hashString(node.id);
      const angle = index * 2.399963229728653 + (hash % 360) * Math.PI / 180;
      const distance = radius * Math.sqrt((index + 0.5) / count);
      return [node.id, [width / 2 + Math.cos(angle) * distance, height / 2 + Math.sin(angle) * distance]];
    }));
  }

  private highlightedNodeIds(): Set<string> {
    const ids = new Set(this.searchMatches.filter((match) => match.kind === "node").map((match) => match.id));
    if (this.selection?.kind === "node") ids.add(this.selection.id);
    for (const match of this.searchMatches) {
      if (match.kind !== "edge") continue;
      const edge = this.data.edges.find((candidate) => candidate.id === match.id);
      if (edge) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
    }
    return ids;
  }

  private renderLabels(positions: ReadonlyMap<string, [number, number]>): void {
    const highlighted = this.highlightedNodeIds();
    const nodes = highlighted.size
      ? this.data.nodes.filter((node) => highlighted.has(node.id)).slice(0, 12)
      : this.data.nodes.slice(0, 8);
    const labels = nodes.flatMap((node) => {
      const point = positions.get(node.id);
      if (!point) return [];
      const label = document.createElement("button");
      label.type = "button";
      label.className = "cosmos-node-label" + (this.selection?.kind === "node" && this.selection.id === node.id ? " selected" : "");
      label.style.transform = `translate(${point[0]}px, ${point[1]}px)`;
      label.dataset.nodeId = node.id;
      const name = document.createElement("span");
      name.textContent = truncate(this.data.labels[node.id] ?? node.label, 38);
      const kind = document.createElement("small");
      kind.textContent = humanize(node.kind);
      label.append(name, kind);
      label.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.onSelect({ kind: "node", id: node.id });
      });
      return [label];
    });
    this.options.labels.replaceChildren(...labels);
  }

  private renderMinimap(): void {
    const canvas = this.options.minimap;
    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    const count = Math.max(1, this.data.nodes.length);
    for (const [index, node] of this.data.nodes.entries()) {
      const angle = index * 2.399963229728653;
      const distance = Math.min(bounds.width, bounds.height) * 0.42 * Math.sqrt((index + 0.5) / count);
      const color = NODE_COLORS[node.kind] ?? DEFAULT_NODE_COLOR;
      context.fillStyle = rgba(color, 0.75);
      context.fillRect(bounds.width / 2 + Math.cos(angle) * distance, bounds.height / 2 + Math.sin(angle) * distance, 1.5, 1.5);
    }
  }

  private selectAtPointer = (event: PointerEvent): void => {
    if (event.target !== this.canvas) return;
    const bounds = this.canvas.getBoundingClientRect();
    const positions = this.positions(bounds.width, bounds.height);
    let selected: GraphNode | undefined;
    let nearestDistance = 12;
    for (const node of this.data.nodes) {
      const point = positions.get(node.id);
      if (!point) continue;
      const distance = Math.hypot(event.clientX - bounds.left - point[0], event.clientY - bounds.top - point[1]);
      if (distance < nearestDistance) {
        selected = node;
        nearestDistance = distance;
      }
    }
    this.options.onSelect(selected ? { kind: "node", id: selected.id } : null);
  };

  private setStatus(): void {
    this.options.status.textContent = canvasFallbackStatus(
      this.sourceNodeCount,
      this.sourceEdgeCount,
      this.data.nodes.length,
      this.data.edges.length
    );
    this.options.status.classList.remove("active");
  }
}

class AdaptiveOntologyGraphRenderer implements PublicRenderer {
  private renderer: PublicRenderer;
  private data: RendererData = { key: "empty", nodes: [], edges: [], labels: {} };
  private selection: GraphSelection = null;
  private matches: Exclude<GraphSelection, null>[] = [];
  private physics = true;
  private usingCanvas = false;
  private destroyed = false;

  constructor(private readonly options: RendererOptions) {
    this.renderer = this.createRenderer();
  }

  setData(data: RendererData): void {
    this.data = data;
    this.renderer.setData(data);
  }

  setSelection(selection: GraphSelection): void {
    this.selection = selection;
    this.renderer.setSelection(selection);
  }

  setSearchMatches(matches: Exclude<GraphSelection, null>[]): void {
    this.matches = matches;
    this.renderer.setSearchMatches(matches);
  }

  fit(): void { this.renderer.fit(); }
  zoomBy(factor: number): void { this.renderer.zoomBy(factor); }
  reset(): void { this.renderer.reset(); }

  setPhysics(enabled: boolean): void {
    this.physics = enabled;
    this.renderer.setPhysics(enabled);
  }

  destroy(): void {
    this.destroyed = true;
    this.renderer.destroy();
  }

  private createRenderer(): PublicRenderer {
    if (chooseRendererMode(webglAvailable()) === "canvas") {
      this.usingCanvas = true;
      return new CanvasOntologyGraphRenderer(this.options);
    }
    try {
      return new OntologyGraphRenderer(this.options, () => this.fallbackToCanvas());
    } catch {
      this.usingCanvas = true;
      return new CanvasOntologyGraphRenderer(this.options);
    }
  }

  private fallbackToCanvas(): void {
    if (this.destroyed || this.usingCanvas) return;
    this.usingCanvas = true;
    this.renderer.destroy();
    this.renderer = new CanvasOntologyGraphRenderer(this.options);
    this.renderer.setData(this.data);
    this.renderer.setSelection(this.selection);
    this.renderer.setSearchMatches(this.matches);
    this.renderer.setPhysics(this.physics);
  }
}

function webglAvailable(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("renderer") === "canvas") return false;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function rgba(color: readonly [number, number, number, number], alpha: number): string {
  return `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${alpha})`;
}

function seedPosition(id: string, index: number, total: number): [number, number] {
  const hash = hashString(id);
  const angle = index * 2.399963229728653 + (hash % 360) * Math.PI / 180;
  const radius = 12 + Math.sqrt(index + 1) * Math.max(4.5, 120 / Math.sqrt(Math.max(1, total)));
  const jitter = ((hash >>> 8) % 1000) / 1000;
  return [Math.cos(angle) * radius * (0.85 + jitter * 0.3), Math.sin(angle) * radius * (0.85 + (1 - jitter) * 0.3)];
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function inside(container: HTMLElement, point: [number, number], padding: number): boolean {
  return point[0] >= -padding && point[1] >= -padding && point[0] <= container.clientWidth + padding && point[1] <= container.clientHeight + padding;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, Math.max(1, limit - 1)) + "…";
}

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

window.JinaOntologyGraph = {
  create(options: RendererOptions): PublicRenderer {
    return new AdaptiveOntologyGraphRenderer(options);
  }
};

export {};
