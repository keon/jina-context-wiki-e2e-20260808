"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssertionReview } from "./assertion-review.tsx";
import { CitedSearch } from "./cited-search.tsx";
import { GraphControls } from "./graph-controls.tsx";
import { GraphInspector } from "./graph-inspector.tsx";
import { GraphViewport } from "./graph-viewport.tsx";
import { useContextSearch } from "./use-context-search.ts";
import {
  contextGraphIdentity,
  contextGraphMatches,
  filterContextGraph,
  friendlyNodeLabels,
  selectionIsVisible
} from "../../lib/context-graph.ts";
import type { GraphSelection, VisibleGraph } from "../../lib/context-graph.ts";
import type { PublicRenderer } from "../../lib/context-graph-renderer.ts";
import { ADVANCED_GRAPH_NODE_KINDS, defaultHiddenGraphNodeKinds } from "@jina/graph-renderer/node-filters";
import { usePoll } from "../../lib/poll.ts";
import type { ContextGraphAssertion, ContextGraphResponse } from "../../lib/types.ts";

const EMPTY_GRAPH: VisibleGraph = { nodes: [], edges: [] };
const CONTEXT_GRAPH_POLL_INTERVAL_MS = 15_000;
const CONTEXT_GRAPH_READ_PATH =
  "/api/context-graph?view=dashboard&include=assertions&assertionStatus=proposed&assertionLimit=50";

export function ContextGraphPage() {
  const { data, refresh } = usePoll<ContextGraphResponse>(CONTEXT_GRAPH_READ_PATH, CONTEXT_GRAPH_POLL_INTERVAL_MS);
  const graph = data?.latest ?? null;
  const allAssertions = useMemo(() => data?.assertions ?? [], [data]);
  const [expandedProposedAssertions, setExpandedProposedAssertions] = useState<readonly ContextGraphAssertion[] | null>(
    null
  );
  const proposedAssertions = useMemo(
    () => (expandedProposedAssertions ?? allAssertions).filter((assertion) => assertion.status === "proposed"),
    [allAssertions, expandedProposedAssertions]
  );
  const graphKey = graph ? contextGraphIdentity(graph) : null;

  useEffect(() => {
    setExpandedProposedAssertions(null);
  }, [allAssertions]);

  const [selected, setSelected] = useState<GraphSelection | null>(null);
  const [hiddenNodeKinds, setHiddenNodeKinds] = useState<ReadonlySet<string>>(() => new Set(ADVANCED_GRAPH_NODE_KINDS));
  const [hiddenEdgePredicates, setHiddenEdgePredicates] = useState<ReadonlySet<string>>(() => new Set());
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const rendererRef = useRef<PublicRenderer | null>(null);

  const search = useContextSearch(graph, graphKey);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const loadAllProposedAssertions = useCallback(async () => {
    const currentGraph = graphRef.current;
    if (!currentGraph) return;
    const response = await fetch(
      `/api/context-graph/assertions?repository=${encodeURIComponent(currentGraph.repository)}&status=proposed&limit=500`,
      { headers: { accept: "application/json" } }
    );
    if (!response.ok) throw new Error(`Assertion queue request failed with ${response.status}`);
    const payload = (await response.json()) as { readonly assertions?: readonly ContextGraphAssertion[] };
    setExpandedProposedAssertions(payload.assertions ?? []);
  }, []);
  // View-state reset when the graph identity changes (resetContextGraphViewForGraph).
  const lastGraphKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastGraphKey.current === graphKey) return;
    lastGraphKey.current = graphKey;
    setExpandedProposedAssertions(null);
    setSelected(null);
    setHiddenNodeKinds(defaultHiddenGraphNodeKinds(graphRef.current?.nodes.map((node) => node.kind) ?? []));
    setHiddenEdgePredicates(new Set());
    setFilterMenuOpen(false);
  }, [graphKey]);

  const rendererLabels = useMemo(() => (graph ? friendlyNodeLabels(graph) : {}), [graph]);
  const visibleGraph = useMemo(
    () => (graph ? filterContextGraph(graph, hiddenNodeKinds, hiddenEdgePredicates) : EMPTY_GRAPH),
    [graph, hiddenNodeKinds, hiddenEdgePredicates]
  );
  const selection = selected && selectionIsVisible(selected, visibleGraph) ? selected : null;
  const searchMatches = useMemo(
    () => contextGraphMatches(search.contextState, graph ? visibleGraph : null),
    [search.contextState, graph, visibleGraph]
  );
  const resultMatches = useMemo(() => contextGraphMatches(search.contextState, graph), [search.contextState, graph]);

  const onToggleFilter = useCallback((group: "node" | "edge", type: string) => {
    const update = (previous: ReadonlySet<string>): ReadonlySet<string> => {
      const next = new Set(previous);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    };
    if (group === "node") setHiddenNodeKinds(update);
    else setHiddenEdgePredicates(update);
  }, []);

  const onShowAll = useCallback(() => {
    setHiddenNodeKinds(new Set());
    setHiddenEdgePredicates(new Set());
  }, []);

  const onRemoveAll = useCallback(() => {
    const currentGraph = graphRef.current;
    if (!currentGraph) return;
    setHiddenNodeKinds(new Set(currentGraph.nodes.map((node) => node.kind)));
    setHiddenEdgePredicates(new Set(currentGraph.edges.map((edge) => edge.predicate)));
  }, []);

  const onShowAllNodes = useCallback(() => {
    setHiddenNodeKinds(new Set());
  }, []);

  const onHideAllNodes = useCallback(() => {
    const currentGraph = graphRef.current;
    if (!currentGraph) return;
    setHiddenNodeKinds(new Set(currentGraph.nodes.map((node) => node.kind)));
  }, []);

  const reviewAssertion = useCallback(
    async (assertionId: string, decision: string, rejectionCode?: string, reason?: string) => {
      const body: Record<string, unknown> = { type: "review_assertion", assertionId, decision };
      if (rejectionCode) body.rejectionCode = rejectionCode;
      if (reason) body.reason = reason;
      const response = await fetch("/api/context-graph/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error("Assertion review failed");
      setExpandedProposedAssertions(null);
      await refresh();
    },
    [refresh]
  );

  const hasSelectionClass = Boolean(graph) && (Boolean(selection) || proposedAssertions.length > 0);

  return (
    <section id="context-graph-page">
      <div className="context-graph-shell">
        <header className="context-graph-toolbar">
          <div className="context-graph-toolbar-meta">
            <button type="button" className="repository-button" id="context-graph-title">
              {graph ? `${graph.repository} @ ${graph.ref}` : "Repository graph"}
            </button>
            <div className="graph-controls" id="graph-controls" aria-label="Graph visibility controls">
              {graph ? (
                <GraphControls
                  graph={graph}
                  hiddenNodeKinds={hiddenNodeKinds}
                  hiddenEdgePredicates={hiddenEdgePredicates}
                  filterMenuOpen={filterMenuOpen}
                  zoomPercent={zoomPercent}
                  onFilterMenuToggle={setFilterMenuOpen}
                  onToggleFilter={onToggleFilter}
                  onShowAll={onShowAll}
                  onRemoveAll={onRemoveAll}
                  onShowAllNodes={onShowAllNodes}
                  onHideAllNodes={onHideAllNodes}
                  onResetLayout={() => rendererRef.current?.reset()}
                  onFit={() => rendererRef.current?.fit()}
                  onZoomBy={(factor) => rendererRef.current?.zoomBy(factor)}
                />
              ) : null}
            </div>
          </div>
          <CitedSearch
            graph={graph}
            question={search.question}
            contextState={search.contextState}
            searchOpen={search.searchOpen}
            searchLoading={search.searchLoading}
            evidenceExpanded={search.evidenceExpanded}
            graphMatches={resultMatches}
            onQuestionChange={search.onQuestionChange}
            onFocus={search.onSearchFocus}
            onEscape={search.onSearchEscape}
            onClear={search.onSearchClear}
            onDismiss={search.onSearchDismiss}
            onSubmit={(event) => {
              void search.onSearchSubmit(event);
            }}
            onEvidenceToggle={search.setEvidenceExpanded}
          />
        </header>
        <section
          className={hasSelectionClass ? "context-graph-workspace has-selection" : "context-graph-workspace"}
          id="context-graph-workspace"
        >
          <GraphViewport
            graph={graph}
            graphKey={graphKey}
            visibleGraph={visibleGraph}
            rendererLabels={rendererLabels}
            hiddenNodeKinds={hiddenNodeKinds}
            hiddenEdgePredicates={hiddenEdgePredicates}
            selection={selection}
            searchMatches={searchMatches}
            onSelect={setSelected}
            onZoomChange={setZoomPercent}
            rendererRef={rendererRef}
          />
          <GraphInspector
            graph={graph}
            visibleGraph={visibleGraph}
            selection={selection}
            proposedAssertions={proposedAssertions}
            canLoadMoreProposedAssertions={expandedProposedAssertions === null && proposedAssertions.length >= 50}
            onSelect={setSelected}
            onReview={reviewAssertion}
            onLoadMoreProposedAssertions={loadAllProposedAssertions}
          />
        </section>
        <AssertionReview
          key={graphKey ?? "no-graph"}
          repository={graph?.repository ?? null}
          onReview={reviewAssertion}
        />
      </div>
    </section>
  );
}
