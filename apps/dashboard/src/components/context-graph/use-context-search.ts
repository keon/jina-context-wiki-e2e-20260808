"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { contextGraphIdentity } from "../../lib/context-graph.ts";
import type { ContextAskState } from "../../lib/context-graph.ts";
import type { ContextGraph } from "../../lib/types.ts";

/** Owns a cited-search request and rejects results invalidated by a newer view. */
export function useContextSearch(graph: ContextGraph | null, graphKey: string | null) {
  const [question, setQuestion] = useState("");
  const [contextState, setContextState] = useState<ContextAskState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const requestSequence = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const questionRef = useRef(question);
  const graphRef = useRef(graph);
  questionRef.current = question;
  graphRef.current = graph;

  const invalidate = useCallback(() => {
    requestSequence.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSearchLoading(false);
  }, []);

  useEffect(() => {
    invalidate();
    setQuestion("");
    setContextState(null);
    setSearchOpen(false);
    setEvidenceExpanded(false);
  }, [graphKey, invalidate]);

  const onQuestionChange = useCallback(
    (value: string) => {
      setQuestion(value);
      if (searchLoading) {
        invalidate();
        setContextState(null);
        setSearchOpen(false);
        setEvidenceExpanded(false);
      }
      if (!value.trim()) {
        setContextState(null);
        setSearchOpen(false);
      }
    },
    [searchLoading, invalidate]
  );

  const onSearchFocus = useCallback(() => {
    if (contextState || searchLoading) setSearchOpen(true);
  }, [contextState, searchLoading]);

  const onSearchEscape = useCallback(() => {
    invalidate();
    setSearchOpen(false);
    setEvidenceExpanded(false);
  }, [invalidate]);

  const onSearchClear = useCallback(() => {
    invalidate();
    setQuestion("");
    setContextState(null);
    setSearchOpen(false);
    setEvidenceExpanded(false);
  }, [invalidate]);

  const onSearchDismiss = useCallback(() => {
    invalidate();
    setSearchOpen(false);
  }, [invalidate]);

  const onSearchSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const currentGraph = graphRef.current;
      const trimmed = questionRef.current.trim();
      if (!currentGraph || !trimmed || searchLoading) return;

      invalidate();
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
        if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") return;
        finish({ error: error instanceof Error ? error.message : String(error) });
      }
    },
    [searchLoading, invalidate]
  );

  return {
    question,
    contextState,
    searchOpen,
    searchLoading,
    evidenceExpanded,
    setEvidenceExpanded,
    onQuestionChange,
    onSearchFocus,
    onSearchEscape,
    onSearchClear,
    onSearchDismiss,
    onSearchSubmit
  };
}
