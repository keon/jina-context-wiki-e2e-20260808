"use client";

import { Fragment, useEffect, useRef } from "react";
import type { FormEvent } from "react";
import { DetailGrid } from "../inspector.tsx";
import { ExternalLink, TraceEvidence, TraceFact } from "./trace.tsx";
import { clampConfidence } from "../../lib/format.ts";
import {
  citationLabels,
  contextDateLabel,
  contextIssueTraceItem,
  contextMatchConfidence,
  contextPathLabel,
  contextPrimaryCitations,
  isCausationQuestion,
  issueTraceSections
} from "../../lib/context-graph.ts";
import type {
  CausalPath,
  ContextAskState,
  ContextCallItem,
  ContextCitation,
  ContextItemData,
  GraphSelection,
  TraceCommit,
  TraceIssue,
  TraceResolution,
  VisibleGraph
} from "../../lib/context-graph.ts";

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

function FullEvidenceBody({ state }: { readonly state: ContextAskState }) {
  const notices = <ContextNotices state={state} />;
  const hasNotices = Boolean(
    (state.unresolvedAmbiguities && state.unresolvedAmbiguities.length) ||
    (state.coverageGaps && state.coverageGaps.length)
  );
  const calls = state.calls || [];
  const empty = !hasNotices && !state.answer && calls.length === 0;
  return (
    <div className="context-full-evidence-body">
      {hasNotices ? notices : null}
      {state.answer ? <ContextAnswer state={state} /> : null}
      {calls.map((call, callIndex) => {
        const items = call.items || [];
        return (
          <article className="context-call" key={`${callIndex}-${call.template ?? ""}`}>
            <h3>{(call.template ?? "") + (call.truncated ? " · truncated" : "")}</h3>
            {items.length === 0 ? (
              <p className="empty-detail">
                {call.template === "issue_trace"
                  ? "No matching ingested issue or cited relationship was found for the validated issue description or identifier."
                  : "No cited results."}
              </p>
            ) : null}
            {items.map((item, itemIndex) => (
              <ContextCallItemView item={item} question={state.question} key={itemIndex} />
            ))}
          </article>
        );
      })}
      {empty ? <p className="empty-detail">No additional evidence was returned.</p> : null}
    </div>
  );
}

function ContextCallItemView({
  item,
  question
}: {
  readonly item: ContextCallItem;
  readonly question: string | undefined;
}) {
  if (item.kind === "causal_trace" && item.data && item.data.root) {
    return <CausalTraceView trace={item.data} />;
  }
  if (item.kind === "issue_trace" && item.data && item.data.issue) {
    return <IssueTraceView trace={item.data} citations={item.citations} question={question} />;
  }
  return (
    <div className="context-result">
      <strong>{item.title}</strong>
      {item.data && item.data.excerpt ? <span>{item.data.excerpt}</span> : null}
      <span>{citationLabels(item.citations).join(" · ")}</span>
    </div>
  );
}

function ContextAnswer({ state }: { readonly state: ContextAskState }) {
  const claims = state.citedClaims ?? [];
  return (
    <article className="context-answer">
      <span className="context-answer-label">Answer</span>
      <p className="context-answer-text">{state.answer}</p>
      {state.counterfactual ? <CounterfactualDetails value={state.counterfactual} /> : null}
      {claims.length ? (
        <div className="context-claims">
          <h4>Cited claims</h4>
          {claims.map((claim, index) => (
            <div className="context-claim" key={index}>
              <strong>{claim.text}</strong>
              <span className="context-citations">{citationLabels(claim.citations).join(" · ")}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function CounterfactualDetails({ value }: { readonly value: NonNullable<ContextAskState["counterfactual"]> }) {
  const removed = value.removedPaths || [];
  const remaining = value.remainingPaths || [];
  const why = removed.concat(remaining).filter((path) => path.why);
  const evidence = Array.from(
    new Set(removed.concat(remaining).flatMap((path) => citationLabels(path.citations || [])))
  );
  return (
    <div className="context-claims">
      <h4>Basis: {value.basis || "graph-derived"}</h4>
      <DetailGrid
        fields={[
          [
            "Intervention",
            value.intervention ? `${value.intervention.kind} · ${value.intervention.label}` : "Unresolved"
          ],
          ["Outcome", value.outcome ? `${value.outcome.kind} · ${value.outcome.label}` : "Unresolved"],
          ["Known paths removed", String(removed.length)],
          ["Known paths remaining", String(remaining.length)]
        ]}
      />
      {why.length ? <TraceFact label="Why" value={why.map((path) => path.why).join(" · ")} /> : null}
      <TraceEvidence evidence={evidence} />
    </div>
  );
}

function CausalTraceView({ trace }: { readonly trace: ContextItemData }) {
  const groups: readonly (readonly [string, readonly CausalPath[] | undefined])[] = [
    ["Causes", trace.causes],
    ["Resolutions", trace.resolutions as unknown as readonly CausalPath[] | undefined],
    ["Implementations", trace.implementations],
    ["Affected entities", trace.affectedEntities],
    ["Dependencies", trace.dependencies],
    ["Deployments", trace.deployments],
    ["Documentation", trace.documentation],
    ["Ownership", trace.ownership],
    ["Moved from", trace.movedFrom]
  ];
  return (
    <div className="issue-trace">
      <strong>
        {trace.root?.kind} · {trace.root?.label}
      </strong>
      {groups.map(([label, paths]) =>
        paths && paths.length ? (
          <div className="trace-explanation" key={label}>
            <span className="trace-fact-label">{label}</span>
            {paths.map((path, index) => (
              <p className="trace-fact-value" key={index}>
                {(path.nodes || []).map((node) => node.label).join(" → ") + (path.why ? ` — ${path.why}` : "")}
              </p>
            ))}
          </div>
        ) : null
      )}
    </div>
  );
}

function IssueTraceView({
  trace,
  citations,
  question
}: {
  readonly trace: ContextItemData;
  readonly citations: readonly ContextCitation[] | undefined;
  readonly question: string | undefined;
}) {
  const issue = trace.issue!;
  const sections = issueTraceSections(trace, question);
  const causalQuestion = isCausationQuestion(question);
  if (!sections.length) {
    return (
      <div className="issue-trace">
        <IssueTraceEntity issue={issue} includeTitle />
        <p className="trace-empty">No verified pull request or commit relationship has been asserted.</p>
        <TraceCitations citations={citations} />
      </div>
    );
  }
  return (
    <div className="issue-trace">
      {sections.map((section, index) =>
        section.kind === "cause" ? (
          <CauseTrace issue={issue} commit={section.value} key={index} />
        ) : (
          <ResolutionTrace issue={issue} resolution={section.value} followsCause={causalQuestion} key={index} />
        )
      )}
      <TraceCitations citations={citations} />
    </div>
  );
}

function IssueTraceEntity({ issue, includeTitle }: { readonly issue: TraceIssue; readonly includeTitle?: boolean }) {
  const identity = issue.number ? `Issue #${issue.number}` : issue.title || issue.displayId || "Derived issue";
  const label = includeTitle && issue.number && issue.title ? `${identity} · ${issue.title}` : identity;
  if (issue.url) return <ExternalLink label={label} url={issue.url} />;
  return <span className="trace-node">{label}</span>;
}

function CauseTrace({ issue, commit }: { readonly issue: TraceIssue; readonly commit: TraceCommit }) {
  const pullRequests = commit.pullRequests ?? [];
  return (
    <div className="trace-chain trace-cause">
      <span className="trace-answer-label trace-answer-label-cause">Cause</span>
      <IssueTraceEntity issue={issue} />
      <span className="trace-arrow">was caused by</span>
      {pullRequests.map((pullRequest, index) => (
        <Fragment key={index}>
          <ExternalLink label={`PR #${pullRequest.number} · ${pullRequest.title}`} url={pullRequest.url} />
          <span className="trace-arrow">containing</span>
        </Fragment>
      ))}
      <ExternalLink label={`commit ${(commit.sha ?? "").slice(0, 12)}`} url={commit.url} />
      <div className="trace-explanation">
        <TraceFact label="Why" value={commit.why || "No causal explanation was recorded."} />
        <TraceEvidence evidence={commit.evidence ?? []} />
      </div>
    </div>
  );
}

function ResolutionTrace({
  issue,
  resolution,
  followsCause
}: {
  readonly issue: TraceIssue;
  readonly resolution: TraceResolution;
  readonly followsCause: boolean;
}) {
  const commits = resolution.commits ?? [];
  return (
    <div className="trace-chain">
      <span className="trace-answer-label">{followsCause ? "Later fix" : "Resolution"}</span>
      <IssueTraceEntity issue={issue} />
      <span className="trace-arrow">→</span>
      <ExternalLink label={`PR #${resolution.pullRequestNumber} · ${resolution.title}`} url={resolution.url} />
      {commits.map((commit, index) => {
        const changes = commit.changes ?? [];
        return (
          <Fragment key={index}>
            <span className="trace-arrow">→</span>
            <ExternalLink
              label={(commit.role === "merge" ? "merge " : "commit ") + (commit.sha ?? "").slice(0, 12)}
              url={commit.url}
            />
            {changes.length ? (
              <div className="trace-changes">
                {`${changes.length} changed file${changes.length === 1 ? "" : "s"}: ` +
                  changes.map((change) => change.path).join(", ")}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function TraceCitations({ citations }: { readonly citations: readonly ContextCitation[] | undefined }) {
  const provenance = citations ?? [];
  if (!provenance.length) return null;
  return (
    <div className="trace-changes">
      {"Citations: " +
        provenance
          .map((citation) =>
            citation.path
              ? citation.path + (citation.startLine ? `:${citation.startLine}` : "")
              : `${citation.kind}:${citation.id}`
          )
          .join(" · ")}
    </div>
  );
}

function ContextNotices({ state }: { readonly state: ContextAskState }) {
  const ambiguities = state.unresolvedAmbiguities ?? [];
  const gaps = state.coverageGaps ?? [];
  if (!ambiguities.length && !gaps.length) return null;
  return (
    <div className="context-notices">
      {ambiguities.map((ambiguity, index) => (
        <div className="context-notice" key={`ambiguity-${index}`}>
          <strong>Ambiguity</strong>
          {ambiguity}
        </div>
      ))}
      {gaps.map((gap, index) => (
        <div className="context-notice" key={`gap-${index}`}>
          <strong>Coverage gap · {gap.capability}</strong>
          {gap.message}
        </div>
      ))}
    </div>
  );
}
