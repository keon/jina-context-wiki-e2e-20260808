"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { PublicRenderer, RendererSelection } from "@jina/graph-renderer";
import { defaultEnabledGraphNodeKinds, partitionGraphNodeKinds } from "@jina/graph-renderer/node-filters";
import { graphCitationLabel, graphQueryMatches, type AdminGraphQueryResult } from "../lib/graph-query";
import type { AdminGraphEdge, AdminGraphNode } from "../lib/jina-api";

const KIND_COLORS: Readonly<Record<string, string>> = {
  Repository: "#a18ff2",
  File: "#59a8b8",
  Symbol: "#4fb8a1",
  Commit: "#61c485",
  PullRequest: "#73d194",
  Issue: "#e99463",
  Engineer: "#739bd4",
  Team: "#7596c4",
  Document: "#b07ad9",
  Feature: "#9173c7",
  Package: "#5ca6e6",
  Service: "#40bfba",
  Deployment: "#61c485",
  Incident: "#f05a52"
};

const FALLBACK_COLOR = "#949eaf";

export function GraphView({
  graphId,
  nodes,
  edges
}: {
  readonly graphId: string;
  readonly nodes: readonly AdminGraphNode[];
  readonly edges: readonly AdminGraphEdge[];
}) {
  const rendererRef = useRef<PublicRenderer | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererUnavailable, setRendererUnavailable] = useState(false);
  const [selection, setSelection] = useState<RendererSelection>(null);
  const [enabledKinds, setEnabledKinds] = useState<ReadonlySet<string>>(() =>
    defaultEnabledGraphNodeKinds(nodes.map((node) => node.kind))
  );
  const [zoomPercent, setZoomPercent] = useState(100);
  const [question, setQuestion] = useState("");
  const [queryResult, setQueryResult] = useState<AdminGraphQueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const queryControllerRef = useRef<AbortController | null>(null);
  const onSelectionRef = useRef(setSelection);
  onSelectionRef.current = setSelection;

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const byEdgeId = useMemo(() => new Map(edges.map((edge) => [edge.id, edge])), [edges]);
  const labels = useMemo(() => Object.fromEntries(nodes.map((node) => [node.id, node.label])), [nodes]);
  const sourceDataKey = useMemo(
    () => `${nodes.map((node) => node.id).join("|")}::${edges.map((edge) => edge.id).join("|")}`,
    [edges, nodes]
  );
  const kindsInGraph = useMemo(() => [...new Set(nodes.map((node) => node.kind))].sort(), [nodes]);
  const kindGroups = useMemo(() => partitionGraphNodeKinds(kindsInGraph), [kindsInGraph]);
  const visibleNodes = useMemo(() => nodes.filter((node) => enabledKinds.has(node.kind)), [enabledKinds, nodes]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    [edges, visibleNodeIds]
  );
  const visibleEdgeIds = useMemo(() => new Set(visibleEdges.map((edge) => edge.id)), [visibleEdges]);
  const dataKey = useMemo(
    () => `${sourceDataKey}::kinds:${[...enabledKinds].sort().join("|")}`,
    [enabledKinds, sourceDataKey]
  );
  const selectedNode = selection?.kind === "node" ? byId.get(selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? byEdgeId.get(selection.id) : undefined;
  const queryMatches = useMemo(
    () =>
      graphQueryMatches(queryResult, { nodes, edges }).filter((match) =>
        match.kind === "node" ? visibleNodeIds.has(match.id) : visibleEdgeIds.has(match.id)
      ),
    [edges, nodes, queryResult, visibleEdgeIds, visibleNodeIds]
  );

  useEffect(() => {
    if (!nodes.length || rendererRef.current || rendererUnavailable) return;
    let cancelled = false;
    void import("@jina/graph-renderer")
      .then((module) => {
        if (cancelled || rendererRef.current) return;
        const container = containerRef.current;
        const labelLayer = labelLayerRef.current;
        const minimap = minimapRef.current;
        const status = statusRef.current;
        if (!container || !labelLayer || !minimap || !status) return;
        rendererRef.current = module.createContextGraphRenderer({
          container,
          labels: labelLayer,
          minimap,
          status,
          onSelect: (next) => onSelectionRef.current(next),
          onZoomChange: setZoomPercent
        });
        setRendererReady(true);
      })
      .catch(() => setRendererUnavailable(true));
    return () => {
      cancelled = true;
    };
  }, [nodes.length, rendererUnavailable]);

  useEffect(
    () => () => {
      rendererRef.current?.destroy();
      rendererRef.current = null;
      queryControllerRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    if (!rendererUnavailable || !statusRef.current) return;
    statusRef.current.textContent = "Interactive renderer unavailable";
    statusRef.current.classList.remove("active");
  }, [rendererUnavailable]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setData({ key: dataKey, nodes: visibleNodes, edges: visibleEdges, labels });
    renderer.setSelection(selection);
    renderer.setSearchMatches(queryMatches.map((match) => ({ ...match })));
  }, [dataKey, labels, queryMatches, rendererReady, selection, visibleEdges, visibleNodes]);

  useEffect(() => {
    setSelection(null);
    setEnabledKinds(defaultEnabledGraphNodeKinds(kindsInGraph));
    setQuestion("");
    setQueryResult(null);
    setQueryError(null);
  }, [kindsInGraph, sourceDataKey]);

  useEffect(() => {
    if (selection?.kind === "node" && !visibleNodeIds.has(selection.id)) setSelection(null);
    if (selection?.kind === "edge" && !visibleEdgeIds.has(selection.id)) setSelection(null);
  }, [selection, visibleEdgeIds, visibleNodeIds]);

  const toggleKind = (kind: string) => {
    setEnabledKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const submitQuery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuestion = question.trim();
    if (!nextQuestion || queryLoading) return;
    queryControllerRef.current?.abort();
    const controller = new AbortController();
    queryControllerRef.current = controller;
    setQueryLoading(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const response = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: nextQuestion }),
        signal: controller.signal
      });
      const body = (await response.json()) as AdminGraphQueryResult;
      if (!response.ok) throw new Error(body.error || `Graph query returned ${response.status}`);
      if (!controller.signal.aborted) setQueryResult(body);
    } catch (error) {
      if (!controller.signal.aborted) setQueryError(error instanceof Error ? error.message : "Graph query failed");
    } finally {
      if (queryControllerRef.current === controller) queryControllerRef.current = null;
      if (!controller.signal.aborted) setQueryLoading(false);
    }
  };

  const clearQuery = () => {
    queryControllerRef.current?.abort();
    queryControllerRef.current = null;
    setQuestion("");
    setQueryResult(null);
    setQueryError(null);
    setQueryLoading(false);
  };

  if (nodes.length === 0) {
    return <div className="empty-state">This graph has no nodes.</div>;
  }

  return (
    <>
      <section className="admin-graph-query" aria-label="Query this graph">
        <form onSubmit={(event) => void submitQuery(event)}>
          <span aria-hidden="true">⌕</span>
          <label className="sr-only" htmlFor="admin-graph-question">
            Ask this repository graph
          </label>
          <input
            id="admin-graph-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask anything about this repository…"
            maxLength={4_000}
            autoComplete="off"
          />
          {question || queryResult || queryError ? (
            <button type="button" className="query-clear" aria-label="Clear graph query" onClick={clearQuery}>
              ×
            </button>
          ) : null}
          <button type="submit" disabled={!question.trim() || queryLoading}>
            {queryLoading ? "Searching…" : "Ask"}
          </button>
        </form>
        {queryLoading ? <p className="query-status">Searching cited repository evidence…</p> : null}
        {queryError ? <p className="query-error">{queryError}</p> : null}
        {queryResult ? <QueryResultPanel result={queryResult} matchCount={queryMatches.length} /> : null}
      </section>

      <div className="graph-panel admin-graph-panel">
        <div className="admin-graph-toolbar">
          <div className="admin-graph-visibility">
            <div className="graph-legend" aria-label="Visible graph node types">
              {kindsInGraph
                .filter((kind) => enabledKinds.has(kind))
                .map((kind) => (
                  <span key={kind}>
                    <span className="swatch" style={{ background: KIND_COLORS[kind] ?? FALLBACK_COLOR }} />
                    {kind}
                  </span>
                ))}
              {!enabledKinds.size ? <span>No node types visible</span> : null}
            </div>
            <details className="admin-graph-filters">
              <summary>Node types</summary>
              <div className="admin-graph-filter-popover">
                <div className="admin-graph-filter-actions">
                  <button
                    type="button"
                    aria-label="Show all node types"
                    onClick={() => setEnabledKinds(new Set(kindsInGraph))}
                  >
                    All
                  </button>
                  <button type="button" aria-label="Hide all node types" onClick={() => setEnabledKinds(new Set())}>
                    None
                  </button>
                </div>
                <NodeKindButtons kinds={kindGroups.primary} enabledKinds={enabledKinds} onToggle={toggleKind} />
                {kindGroups.advanced.length ? (
                  <details className="admin-graph-filter-advanced">
                    <summary>Advanced · {kindGroups.advanced.length}</summary>
                    <NodeKindButtons kinds={kindGroups.advanced} enabledKinds={enabledKinds} onToggle={toggleKind} />
                  </details>
                ) : null}
              </div>
            </details>
          </div>
          <div className="graph-controls" aria-label="Graph view controls">
            <button type="button" disabled={!rendererReady} onClick={() => rendererRef.current?.reset()}>
              Reset layout
            </button>
            <button type="button" disabled={!rendererReady} onClick={() => rendererRef.current?.fit()}>
              Fit
            </button>
            <span className="graph-zoom-controls">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={!rendererReady}
                onClick={() => rendererRef.current?.zoomBy(0.8)}
              >
                −
              </button>
              <span aria-live="polite">{zoomPercent}%</span>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={!rendererReady}
                onClick={() => rendererRef.current?.zoomBy(1.25)}
              >
                +
              </button>
            </span>
          </div>
        </div>
        <div className="admin-graph-wrap">
          <div
            className="admin-graph-canvas"
            role="application"
            aria-label={`Context graph visualization with ${visibleNodes.length} nodes and ${visibleEdges.length} relationships`}
            ref={containerRef}
          >
            <div className="context-graph-label-layer" ref={labelLayerRef} />
          </div>
          <div className="graph-empty-state" hidden={Boolean(visibleNodes.length) || rendererUnavailable}>
            All node types are hidden. Choose one from Node types to build a focused view.
          </div>
          <div className="graph-empty-state" hidden={!rendererUnavailable}>
            The interactive graph could not start. Reload the page to try again.
          </div>
          <canvas className="context-graph-minimap" aria-label="Graph overview" ref={minimapRef} />
          <span className="graph-runtime-status" ref={statusRef} suppressHydrationWarning>
            Loading interactive renderer…
          </span>
          <div className="plane-key" aria-hidden="true">
            <span>Code</span>
            <span className="knowledge">Knowledge</span>
          </div>
        </div>
      </div>

      <SelectionPanel node={selectedNode} edge={selectedEdge} edges={edges} byId={byId} />
    </>
  );
}

function NodeKindButtons({
  kinds,
  enabledKinds,
  onToggle
}: {
  readonly kinds: readonly string[];
  readonly enabledKinds: ReadonlySet<string>;
  readonly onToggle: (kind: string) => void;
}) {
  return (
    <div className="admin-graph-filter-list">
      {kinds.map((kind) => (
        <button type="button" key={kind} aria-pressed={enabledKinds.has(kind)} onClick={() => onToggle(kind)}>
          <span className="swatch" style={{ background: KIND_COLORS[kind] ?? FALLBACK_COLOR }} />
          {kind}
        </button>
      ))}
    </div>
  );
}

function QueryResultPanel({
  result,
  matchCount
}: {
  readonly result: AdminGraphQueryResult;
  readonly matchCount: number;
}) {
  const claims = result.citedClaims ?? [];
  const citationLabels = Array.from(
    new Set([...(result.citations ?? []), ...claims.flatMap((claim) => claim.citations ?? [])].map(graphCitationLabel))
  );
  return (
    <article className="admin-query-result" aria-live="polite">
      <div className="query-result-heading">
        <span>✦</span>
        <strong>Cited repository answer</strong>
        <span className="muted">
          {matchCount} graph {matchCount === 1 ? "match" : "matches"}
        </span>
      </div>
      <p>{result.answer || "No cited answer was returned."}</p>
      {citationLabels.length ? (
        <div className="query-citations">
          {citationLabels.map((citation) => (
            <code key={citation}>{citation}</code>
          ))}
        </div>
      ) : null}
      {claims.length ? (
        <details>
          <summary>Cited claims</summary>
          <ul>
            {claims.map((claim, index) => (
              <li key={`${index}-${claim.text ?? "claim"}`}>
                <strong>{claim.text || "Claim"}</strong>
                {claim.citations?.length ? (
                  <span className="muted"> — {claim.citations.map(graphCitationLabel).join(" · ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {result.unresolvedAmbiguities?.length || result.coverageGaps?.length ? (
        <details>
          <summary>Coverage notes</summary>
          <ul>
            {(result.unresolvedAmbiguities ?? []).map((item) => (
              <li key={item}>{item}</li>
            ))}
            {(result.coverageGaps ?? []).map((gap, index) => (
              <li key={`${index}-${gap.capability ?? "gap"}`}>{gap.message || gap.capability || "Coverage gap"}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function SelectionPanel({
  node,
  edge,
  edges,
  byId
}: {
  readonly node: AdminGraphNode | undefined;
  readonly edge: AdminGraphEdge | undefined;
  readonly edges: readonly AdminGraphEdge[];
  readonly byId: ReadonlyMap<string, AdminGraphNode>;
}) {
  if (edge) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    return (
      <div className="selection-panel">
        <h3>
          {edge.predicate} <span className="muted">· relationship</span>
        </h3>
        <p>
          <strong>{source?.label ?? edge.source}</strong> → <strong>{target?.label ?? edge.target}</strong>
        </p>
        {edge.why ? <p className="muted">{edge.why}</p> : null}
        <p className="muted">
          {edge.plane} plane{edge.confidence !== undefined ? ` · ${Math.round(edge.confidence * 100)}% confidence` : ""}
        </p>
      </div>
    );
  }

  if (!node) {
    return <p className="muted">Click a node or relationship to inspect its details.</p>;
  }

  return (
    <div className="selection-panel">
      <h3>
        {node.label} <span className="muted">· {node.kind}</span>
      </h3>
      {node.path ? (
        <div>
          <code>{node.path}</code>
        </div>
      ) : null}
      <p className="muted">{node.description}</p>
      <EdgeList edges={edges} nodeId={node.id} byId={byId} />
    </div>
  );
}

function EdgeList({
  edges,
  nodeId,
  byId
}: {
  readonly edges: readonly AdminGraphEdge[];
  readonly nodeId: string;
  readonly byId: ReadonlyMap<string, AdminGraphNode>;
}) {
  const related = edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
  if (related.length === 0) return null;
  return (
    <ul>
      {related.map((edge) => {
        const outbound = edge.source === nodeId;
        const other = byId.get(outbound ? edge.target : edge.source);
        return (
          <li key={edge.id}>
            {outbound ? (
              <>
                {edge.predicate} → <strong>{other?.label ?? "?"}</strong>
              </>
            ) : (
              <>
                <strong>{other?.label ?? "?"}</strong> {edge.predicate} → this
              </>
            )}{" "}
            <span className="muted">
              [{edge.plane}
              {edge.confidence !== undefined ? ` · ${Math.round(edge.confidence * 100)}%` : ""}]
            </span>
            {edge.why ? <span className="muted"> — {edge.why}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
