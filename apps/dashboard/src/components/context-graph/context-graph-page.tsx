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
import { usePoll } from "../../lib/poll.ts";
import type { ContextGraphResponse } from "../../lib/types.ts";

const EMPTY_GRAPH: VisibleGraph = { nodes: [], edges: [] };

export function ContextGraphPage() {
  const { data, refresh } = usePoll<ContextGraphResponse>("/api/context-graph?include=assertions");
  const graph = data?.latest ?? null;
  const allAssertions = useMemo(() => data?.assertions ?? [], [data]);
  const proposedAssertions = useMemo(
    () => allAssertions.filter((assertion) => assertion.status === "proposed"),
    [allAssertions]
  );
  const graphKey = graph ? contextGraphIdentity(graph) : null;

  const [selected, setSelected] = useState<GraphSelection | null>(null);
  const [hiddenNodeKinds, setHiddenNodeKinds] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenEdgePredicates, setHiddenEdgePredicates] = useState<ReadonlySet<string>>(() => new Set());
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const rendererRef = useRef<PublicRenderer | null>(null);

  const search = useContextSearch(graph, graphKey);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // View-state reset when the graph identity changes (resetContextGraphViewForGraph).
  const lastGraphKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastGraphKey.current === graphKey) return;
    lastGraphKey.current = graphKey;
    setSelected(null);
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
            onSelect={setSelected}
            onReview={reviewAssertion}
          />
        </section>
        <AssertionReview assertions={allAssertions} onReview={reviewAssertion} />
      </div>
    </section>
  );
}
