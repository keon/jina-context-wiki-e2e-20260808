"use client";

import { useEffect, useRef } from "react";
import type { FormEvent } from "react";
import { clampConfidence } from "../../lib/format.ts";
import {
  contextDateLabel,
  contextIssueTraceItem,
  contextMatchConfidence,
  contextPathLabel,
  contextPrimaryCitations
} from "../../lib/context-graph.ts";
import type { ContextAskState, GraphSelection, VisibleGraph } from "../../lib/context-graph.ts";
import { FullEvidenceBody } from "./cited-evidence.tsx";

/**
 * The cited-search hero: question form plus the results popover with the
 * primary answer, causal traces, citations and expandable full evidence.
 */

export interface CitedSearchProps {
  readonly graph: VisibleGraph | null;
  readonly question: string;
  readonly contextState: ContextAskState | null;
  readonly searchOpen: boolean;
  readonly searchLoading: boolean;
  readonly evidenceExpanded: boolean;
  readonly graphMatches: readonly GraphSelection[];
  readonly onQuestionChange: (value: string) => void;
  readonly onFocus: () => void;
  readonly onEscape: () => void;
  readonly onClear: () => void;
  readonly onDismiss: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onEvidenceToggle: (open: boolean) => void;
}

export function CitedSearch({
  graph,
  question,
  contextState,
  searchOpen,
  searchLoading,
  evidenceExpanded,
  graphMatches,
  onQuestionChange,
  onFocus,
  onEscape,
  onClear,
  onDismiss,
  onSubmit,
  onEvidenceToggle
}: CitedSearchProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsHidden = !searchOpen || (!contextState && !searchLoading);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const shell = shellRef.current;
      if (!shell || shell.contains(event.target as Node) || !searchOpen) return;
      if (evidenceExpanded) return;
      onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [searchOpen, evidenceExpanded, onDismiss]);

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      const results = resultsRef.current;
      if (!evidenceExpanded || !searchOpen || !results || results.hidden || results.contains(event.target as Node))
        return;
      if (results.scrollHeight <= results.clientHeight) return;
      event.preventDefault();
      event.stopPropagation();
      results.scrollTop += event.deltaY;
    };
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => document.removeEventListener("wheel", onWheel, { capture: true });
  }, [searchOpen, evidenceExpanded]);

  return (
    <section className="context-graph-search-hero">
      <div
        className={question.trim() ? "context-search-shell has-query" : "context-search-shell"}
        id="context-search-shell"
        ref={shellRef}
      >
        <form className="context-search" id="context-query" onSubmit={onSubmit}>
          <span className="context-search-icon" aria-hidden="true">
            ⌕
          </span>
          <label className="sr-only" htmlFor="context-question">
            Search this repository with citations
          </label>
          <input
            id="context-question"
            name="question"
            placeholder="Ask anything about this repository…"
            aria-label="Search this repository with citations"
            aria-controls="context-search-results"
            aria-expanded={!resultsHidden}
            autoComplete="off"
            required
            value={question}
            ref={inputRef}
            onChange={(event) => onQuestionChange(event.target.value)}
            onFocus={onFocus}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              onEscape();
            }}
          />
          <button
            type="button"
            className="context-search-clear"
            id="context-search-clear"
            aria-label="Clear cited search"
            onClick={() => {
              onClear();
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
          <button
            type="submit"
            className="context-search-submit"
            id="context-search-submit"
            aria-label="Search with citations"
            title="Search with citations"
            disabled={searchLoading}
          >
            {searchLoading ? "…" : "↵"}
          </button>
        </form>
        <div className="context-search-results" id="context-search-results" hidden={resultsHidden} ref={resultsRef}>
          <section className="context-results" id="context-results" aria-live="polite">
            {searchLoading ? (
              <p className="empty-detail">Searching repository evidence…</p>
            ) : contextState ? (
              contextState.error ? (
                <p className="empty-detail">{contextState.error}</p>
              ) : (
                <>
                  <ContextPrimary state={contextState} graphMatches={graphMatches} graph={graph} />
                  <details
                    className="context-full-evidence"
                    open={evidenceExpanded}
                    onToggle={(event) => onEvidenceToggle(event.currentTarget.open)}
                  >
                    <summary>View full evidence</summary>
                    <FullEvidenceBody state={contextState} />
                  </details>
                </>
              )
            ) : null}
          </section>
        </div>
      </div>
    </section>
  );
}

function ContextPrimary({
  state,
  graphMatches,
  graph
}: {
  readonly state: ContextAskState;
  readonly graphMatches: readonly GraphSelection[];
  readonly graph: VisibleGraph | null;
}) {
  const item = contextIssueTraceItem(state);
  const trace = item?.data;
  const issue = trace?.issue;
  const cause = trace?.introducedBy?.[0];
  const resolution = trace?.resolutions?.[0];
  const title = issue
    ? issue.number
      ? `Issue #${issue.number}${issue.title ? ` · ${issue.title}` : ""}`
      : issue.title || issue.displayId || "Repository answer"
    : "Cited repository answer";
  const confidence = contextMatchConfidence(graphMatches, graph);
  const changes = cause?.changes ?? [];
  const resolutionCommit = resolution?.commits?.[0];
  return (
    <article className="context-result-primary">
      <div className="context-result-heading">
        <span className="context-result-spark">✦</span>
        <strong>{title}</strong>
        <span className="context-result-confidence">
          {confidence === undefined ? "Cited answer" : `${Math.round(clampConfidence(confidence) * 100)}% confidence`}
        </span>
      </div>
      <p className="context-result-answer">{state.answer || "No cited answer was returned."}</p>
      {issue && cause ? (
        <div className="context-causal-trace">
          <span className="context-causal-step">
            {contextDateLabel(cause.committedAt) + (cause.sha ? ` · ${cause.sha.slice(0, 8)}` : "")}
          </span>
          <span className="context-causal-arrow" />
          <span className="context-causal-step">{contextPathLabel(changes[0]?.path)}</span>
          <span className="context-causal-arrow" />
          <span className="context-causal-step">Issue #{issue.number || issue.displayId || "observed"}</span>
        </div>
      ) : null}
      {resolution ? (
        <p className="context-result-resolution">
          {`Resolved by PR #${resolution.pullRequestNumber}${resolution.title ? ` · ${resolution.title}` : ""}` +
            (resolutionCommit?.committedAt ? ` · ${contextDateLabel(resolutionCommit.committedAt)}` : "")}
        </p>
      ) : null}
      <footer className="context-result-footer">
        {contextPrimaryCitations(state, item, trace).map((citation) => (
          <span className="context-citation-chip" key={citation}>
            {citation}
          </span>
        ))}
        <span className="context-graph-match-count">
          {graphMatches.length + (graphMatches.length === 1 ? " graph match" : " graph matches")}
        </span>
      </footer>
    </article>
  );
}
