"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { formatTime } from "../../lib/format.ts";
import { visibleCount } from "../../lib/context-graph.ts";
import type { GraphSelection, VisibleGraph } from "../../lib/context-graph.ts";
import type { PublicRenderer } from "../../lib/context-graph-renderer.ts";
import type { ContextGraph } from "../../lib/types.ts";

/**
 * The renderer host card: #context-graph plus its label layer, minimap,
 * runtime-status pill, empty state, floating summary stats and plane key.
 * The WebGL/canvas renderer is created lazily on the client (it touches
 * window and WebGL, so it must never run during SSR) and drives the label
 * layer, minimap and status pill imperatively — React never renders children
 * into those elements.
 */

export interface GraphViewportProps {
  readonly graph: ContextGraph | null;
  readonly graphKey: string | null;
  readonly visibleGraph: VisibleGraph;
  readonly rendererLabels: Readonly<Record<string, string>>;
  readonly hiddenNodeKinds: ReadonlySet<string>;
  readonly hiddenEdgePredicates: ReadonlySet<string>;
  readonly selection: GraphSelection | null;
  readonly searchMatches: readonly GraphSelection[];
  readonly onSelect: (selection: GraphSelection | null) => void;
  readonly onZoomChange: (percent: number) => void;
  readonly rendererRef: RefObject<PublicRenderer | null>;
}

export function GraphViewport({
  graph,
  graphKey,
  visibleGraph,
  rendererLabels,
  hiddenNodeKinds,
  hiddenEdgePredicates,
  selection,
  searchMatches,
  onSelect,
  onZoomChange,
  rendererRef
}: GraphViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererUnavailable, setRendererUnavailable] = useState(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  const hasGraph = Boolean(graph);

  // Start downloading the renderer as soon as the page mounts, in parallel
  // with the graph request. WebGL is still instantiated only when graph data
  // exists, avoiding unnecessary GPU work for an empty repository.
  useEffect(() => {
    if (rendererRef.current || rendererUnavailable) return;
    let cancelled = false;
    void import("../../lib/context-graph-renderer.ts")
      .then((module) => {
        if (cancelled || !hasGraph || rendererRef.current) return;
        const container = containerRef.current;
        const labels = labelLayerRef.current;
        const minimap = minimapRef.current;
        const status = statusRef.current;
        if (!container || !labels || !minimap || !status) return;
        rendererRef.current = module.createContextGraphRenderer({
          container,
          labels,
          minimap,
          status,
          onSelect: (next) => onSelectRef.current(next),
          onZoomChange: (percent) => onZoomChangeRef.current(percent)
        });
        setRendererReady(true);
      })
      .catch(() => {
        if (!cancelled) setRendererUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hasGraph, rendererRef, rendererUnavailable]);

  useEffect(
    () => () => {
      rendererRef.current?.destroy();
      rendererRef.current = null;
    },
    [rendererRef]
  );

  useEffect(() => {
    if (!rendererUnavailable) return;
    const status = statusRef.current;
    if (status) {
      status.textContent = "GPU renderer unavailable";
      status.classList.remove("active");
    }
  }, [rendererUnavailable]);

  // Push the filtered graph, selection and search matches into the renderer
  // whenever they change (setData short-circuits on an unchanged key).
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (!graph || !graphKey) {
      renderer.setData({ key: "empty", layoutKey: "empty", nodes: [], edges: [], labels: {} });
      renderer.setSearchMatches([]);
      return;
    }
    const rendererKey =
      `${graphKey}|nodes:${Array.from(hiddenNodeKinds).sort().join(",")}` +
      `|edges:${Array.from(hiddenEdgePredicates).sort().join(",")}`;
    renderer.setData({
      key: rendererKey,
      layoutKey: graphKey,
      nodes: visibleGraph.nodes,
      edges: visibleGraph.edges,
      labels: rendererLabels
    });
    renderer.setSelection(selection ? { ...selection } : null);
    renderer.setSearchMatches(searchMatches.map((match) => ({ ...match })));
  }, [
    rendererReady,
    rendererRef,
    graph,
    graphKey,
    visibleGraph,
    rendererLabels,
    hiddenNodeKinds,
    hiddenEdgePredicates,
    selection,
    searchMatches
  ]);

  const emptyState = !graph
    ? { hidden: false, message: "Run an contextGraph build to create the first graph." }
    : rendererUnavailable
      ? { hidden: false, message: "The interactive graph could not start. Use Table view or reload this page." }
      : {
          hidden: Boolean(visibleGraph.nodes.length),
          message: "All node types are hidden. Use Filters to bring them back."
        };

  return (
    <section className="context-graph-card">
      <div className="graph-wrap">
        <div
          id="context-graph"
          role="application"
          aria-label="Repository contextGraph graph"
          ref={containerRef}
          onClick={(event) => {
            if (event.target !== event.currentTarget || !selection) return;
            onSelect(null);
          }}
        >
          <div className="context-graph-label-layer" id="context-graph-label-layer" ref={labelLayerRef} />
        </div>
        <div className="graph-empty-state" id="context-graph-empty" hidden={emptyState.hidden}>
          {emptyState.message}
        </div>
        <canvas
          className="context-graph-minimap"
          id="context-graph-minimap"
          aria-label="Graph overview"
          ref={minimapRef}
        />
        <span className="graph-runtime-status" id="graph-runtime-status" ref={statusRef} suppressHydrationWarning>
          Loading GPU renderer…
        </span>
        <section className="context-graph-summary" id="context-graph-summary" hidden>
          {graph ? (
            <>
              <SummaryStat label="Repository" value={graph.repository} />
              <SummaryStat label="Nodes" value={visibleCount(visibleGraph.nodes.length, graph.nodes.length)} />
              <SummaryStat label="Edges" value={visibleCount(visibleGraph.edges.length, graph.edges.length)} />
              <SummaryStat label="Commit" value={graph.commitSha.slice(0, 12)} />
              <SummaryStat label="Generated" value={formatTime(graph.generatedAt)} />
              <SummaryStat label="Executor" value={`${graph.generator.executor} · ${graph.generator.model}`} />
            </>
          ) : (
            <SummaryStat label="Status" value="No graph yet" />
          )}
        </section>
        <div className="plane-key">
          <span>Code</span>
          <span className="knowledge">Knowledge</span>
        </div>
      </div>
    </section>
  );
}

function SummaryStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <article className="context-graph-stat">
      <span className="label">{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
