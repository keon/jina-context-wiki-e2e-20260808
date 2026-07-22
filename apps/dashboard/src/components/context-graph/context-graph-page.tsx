"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AssertionReview } from "./assertion-review.tsx";
import { CitedSearch } from "./cited-search.tsx";
import { GraphControls } from "./graph-controls.tsx";
import { GraphInspector } from "./graph-inspector.tsx";
import { GraphViewport } from "./graph-viewport.tsx";
import {
  contextGraphIdentity,
  contextGraphMatches,
  filterContextGraph,
  friendlyNodeLabels,
  selectionIsVisible
} from "../../lib/context-graph.ts";
import type { ContextAskState, GraphSelection, VisibleGraph } from "../../lib/context-graph.ts";
import type { PublicRenderer } from "../../lib/context-graph-renderer.ts";
import { ADVANCED_GRAPH_NODE_KINDS, defaultHiddenGraphNodeKinds } from "@jina/graph-renderer/node-filters";
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
  const [hiddenNodeKinds, setHiddenNodeKinds] = useState<ReadonlySet<string>>(() => new Set(ADVANCED_GRAPH_NODE_KINDS));
  const [hiddenEdgePredicates, setHiddenEdgePredicates] = useState<ReadonlySet<string>>(() => new Set());
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const rendererRef = useRef<PublicRenderer | null>(null);

  // Cited-search state.
  const [question, setQuestion] = useState("");
  const [contextState, setContextState] = useState<ContextAskState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const requestSequence = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const questionRef = useRef(question);
  questionRef.current = question;
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const invalidateContextRequest = useCallback(() => {
    requestSequence.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSearchLoading(false);
  }, []);

  // View-state reset when the graph identity changes (resetContextGraphViewForGraph).
  const lastGraphKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastGraphKey.current === graphKey) return;
    lastGraphKey.current = graphKey;
    invalidateContextRequest();
    setSelected(null);
    setHiddenNodeKinds(defaultHiddenGraphNodeKinds(graphRef.current?.nodes.map((node) => node.kind) ?? []));
    setHiddenEdgePredicates(new Set());
    setFilterMenuOpen(false);
    setContextState(null);
    setSearchOpen(false);
    setEvidenceExpanded(false);
    setQuestion("");
  }, [graphKey, invalidateContextRequest]);

  const rendererLabels = useMemo(() => (graph ? friendlyNodeLabels(graph) : {}), [graph]);
  const visibleGraph = useMemo(
    () => (graph ? filterContextGraph(graph, hiddenNodeKinds, hiddenEdgePredicates) : EMPTY_GRAPH),
    [graph, hiddenNodeKinds, hiddenEdgePredicates]
  );
  const selection = selected && selectionIsVisible(selected, visibleGraph) ? selected : null;
  const searchMatches = useMemo(
    () => contextGraphMatches(contextState, graph ? visibleGraph : null),
    [contextState, graph, visibleGraph]
  );
  const resultMatches = useMemo(() => contextGraphMatches(contextState, graph), [contextState, graph]);

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
      await refresh();
    },
    [refresh]
  );

  const onQuestionChange = useCallback(
    (value: string) => {
      setQuestion(value);
      if (searchLoading) {
        invalidateContextRequest();
        setContextState(null);
        setSearchOpen(false);
        setEvidenceExpanded(false);
      }
      if (!value.trim()) {
        setContextState(null);
        setSearchOpen(false);
      }
    },
    [searchLoading, invalidateContextRequest]
  );

  const onSearchFocus = useCallback(() => {
    if (contextState || searchLoading) setSearchOpen(true);
  }, [contextState, searchLoading]);

  const onSearchEscape = useCallback(() => {
    invalidateContextRequest();
    setSearchOpen(false);
    setEvidenceExpanded(false);
  }, [invalidateContextRequest]);

  const onSearchClear = useCallback(() => {
    invalidateContextRequest();
    setQuestion("");
    setContextState(null);
    setSearchOpen(false);
    setEvidenceExpanded(false);
  }, [invalidateContextRequest]);

  const onSearchDismiss = useCallback(() => {
    invalidateContextRequest();
    setSearchOpen(false);
  }, [invalidateContextRequest]);

  const onSearchSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const currentGraph = graphRef.current;
      if (!currentGraph) return;
      const trimmed = questionRef.current.trim();
      if (!trimmed || searchLoading) return;
      invalidateContextRequest();
      setEvidenceExpanded(false);
      const sequence = requestSequence.current;
      const key = contextGraphIdentity(currentGraph);
      const abortController = new AbortController();
      abortRef.current = abortController;
      setSearchOpen(true);
      setSearchLoading(true);
      setContextState(null);
      const finish = (next: ContextAskState) => {
        if (sequence !== requestSequence.current) return;
        abortRef.current = null;
        setSearchLoading(false);
        setSearchOpen(true);
        setContextState(next);
      };
      try {
        const response = await fetch("/api/context-graph/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify({ repository: currentGraph.repository, ref: currentGraph.ref, question: trimmed })
        });
        if (!response.ok) throw new Error(`Context query failed with ${response.status}`);
        const nextContextState = (await response.json()) as ContextAskState;
        // Discard stale responses: a newer request, an edited question, or a
        // different (or missing) graph invalidate this answer.
        const latestGraph = graphRef.current;
        if (
          sequence !== requestSequence.current ||
          questionRef.current.trim() !== trimmed ||
          !latestGraph ||
          contextGraphIdentity(latestGraph) !== key
        )
          return;
        finish(nextContextState);
      } catch (error) {
        const aborted =
          typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
        if (aborted) return;
        finish({ error: error instanceof Error ? error.message : String(error) });
      }
    },
    [searchLoading, invalidateContextRequest]
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
            question={question}
            contextState={contextState}
            searchOpen={searchOpen}
            searchLoading={searchLoading}
            evidenceExpanded={evidenceExpanded}
            graphMatches={resultMatches}
            onQuestionChange={onQuestionChange}
            onFocus={onSearchFocus}
            onEscape={onSearchEscape}
            onClear={onSearchClear}
            onDismiss={onSearchDismiss}
            onSubmit={(event) => {
              void onSearchSubmit(event);
            }}
            onEvidenceToggle={setEvidenceExpanded}
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
