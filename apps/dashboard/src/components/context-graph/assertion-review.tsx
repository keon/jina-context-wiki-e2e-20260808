"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AssertionRejectionFields, validateRejection } from "./assertion-review-controls.tsx";
import type { ReviewAssertionFn } from "./assertion-review-controls.tsx";
import { TraceEvidence } from "./trace.tsx";
import { confidenceLabel, humanize } from "../../lib/format.ts";
import { assertionView } from "../../lib/assertions.ts";
import { uniqueValues } from "../../lib/board.ts";
import type { ContextGraphAssertion } from "../../lib/types.ts";

/** Lazy, collapsible assertion history below the graph workspace. */

export function AssertionReview({
  repository,
  onReview
}: {
  readonly repository: string | null;
  readonly onReview: ReviewAssertionFn;
}) {
  const [open, setOpen] = useState(false);
  const [assertions, setAssertions] = useState<readonly ContextGraphAssertion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadHistory = useCallback(async () => {
    if (!repository || loading) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/context-graph/assertions?repository=${encodeURIComponent(repository)}&limit=500`,
        {
          headers: { accept: "application/json" },
          signal: controller.signal
        }
      );
      if (!response.ok) throw new Error(`Assertion history request failed with ${response.status}`);
      const payload = (await response.json()) as { readonly assertions?: readonly ContextGraphAssertion[] };
      setAssertions((payload.assertions ?? []).filter((assertion) => assertion.status !== "proposed"));
    } catch (loadError) {
      const aborted =
        typeof loadError === "object" && loadError !== null && (loadError as { name?: unknown }).name === "AbortError";
      if (!aborted) setError(loadError instanceof Error ? loadError.message : "Assertion history request failed");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }, [repository, loading]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  if (!repository) return null;
  const reviewAndReload: ReviewAssertionFn = async (assertionId, decision, rejectionCode, reason) => {
    await onReview(assertionId, decision, rejectionCode, reason);
    await loadHistory();
  };
  return (
    <details
      className="assertion-review"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (nextOpen && assertions === null) void loadHistory();
      }}
    >
      <summary>Assertion history{assertions ? ` (${assertions.length})` : ""}</summary>
      {open && loading ? <p className="empty-detail">Loading assertion history…</p> : null}
      {open && error ? (
        <p className="empty-detail">
          {error}{" "}
          <button type="button" className="secondary-button" onClick={() => void loadHistory()}>
            Retry
          </button>
        </p>
      ) : null}
      {open && assertions ? <AssertionHistory assertions={assertions} onReview={reviewAndReload} /> : null}
    </details>
  );
}

function AssertionHistory({
  assertions,
  onReview
}: {
  readonly assertions: readonly ContextGraphAssertion[];
  readonly onReview: ReviewAssertionFn;
}) {
  const pageSize = 25;
  const [predicateFilter, setPredicateFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const predicates = uniqueValues(assertions.map((assertion) => assertion.predicate));
  const kinds = uniqueValues(
    assertions.flatMap((assertion) => {
      const view = assertionView(assertion);
      return [view.subjectKind, view.objectKind];
    })
  );
  const predicateValue = predicates.includes(predicateFilter) ? predicateFilter : "";
  const kindValue = kinds.includes(kindFilter) ? kindFilter : "";
  const visible = assertions.filter((assertion) => {
    const view = assertionView(assertion);
    return (
      (!predicateValue || assertion.predicate === predicateValue) &&
      (!kindValue || view.subjectKind === kindValue || view.objectKind === kindValue)
    );
  });
  const rendered = visible.slice(0, visibleCount);
  const remaining = visible.length - rendered.length;
  return (
    <>
      <div className="assertion-review-toolbar">
        <select
          id="assertion-predicate-filter"
          aria-label="Filter assertions by predicate"
          value={predicateValue}
          onChange={(event) => {
            setPredicateFilter(event.target.value);
            setVisibleCount(pageSize);
          }}
        >
          <option value="">All predicates</option>
          {predicates.map((value) => (
            <option key={value} value={value}>
              {humanize(value)}
            </option>
          ))}
        </select>
        <select
          id="assertion-kind-filter"
          aria-label="Filter assertions by entity kind"
          value={kindValue}
          onChange={(event) => {
            setKindFilter(event.target.value);
            setVisibleCount(pageSize);
          }}
        >
          <option value="">All entity kinds</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {humanize(value)}
            </option>
          ))}
        </select>
      </div>
      <section className="assertion-review-list" id="assertion-review-list" aria-live="polite">
        {visible.length === 0 ? (
          <p className="empty-detail">No assertions match these filters.</p>
        ) : (
          rendered.map((assertion) => (
            <AssertionReviewItem key={assertion.id} assertion={assertion} onReview={onReview} />
          ))
        )}
        {remaining > 0 ? (
          <button
            type="button"
            className="secondary-button"
            aria-controls="assertion-review-list"
            onClick={() => setVisibleCount((count) => count + pageSize)}
          >
            Load more ({remaining} remaining)
          </button>
        ) : null}
      </section>
    </>
  );
}

function AssertionReviewItem({
  assertion,
  onReview
}: {
  readonly assertion: ContextGraphAssertion;
  readonly onReview: ReviewAssertionFn;
}) {
  const codeRef = useRef<HTMLSelectElement | null>(null);
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const [errorTitles, setErrorTitles] = useState<Readonly<Record<string, string>>>({});
  const view = assertionView(assertion);
  const decisions =
    assertion.status === "proposed" ? ["accept", "reject"] : assertion.status === "active" ? ["retract"] : [];
  const decide = async (decision: string) => {
    let rejectionCode: string | undefined;
    let reason: string | undefined;
    if (decision === "reject") {
      const rejection = validateRejection(codeRef, reasonRef);
      if (!rejection) return;
      rejectionCode = rejection.code;
      reason = rejection.reason;
    }
    setPendingDecision(decision);
    try {
      await onReview(assertion.id, decision, rejectionCode, reason);
    } catch (error) {
      setPendingDecision(null);
      setErrorTitles((titles) => ({
        ...titles,
        [decision]: error instanceof Error ? error.message : "Assertion review failed"
      }));
    }
  };
  return (
    <article className="assertion-review-item">
      <header>
        <strong>
          {view.subjectLabel} {assertion.predicate} {view.objectLabel}
        </strong>
        <span className="enabled-state">{assertion.status}</span>
      </header>
      <p>
        Confidence {confidenceLabel(assertion.confidence)} · {view.generator}
      </p>
      <TraceEvidence evidence={Array.isArray(assertion.evidence) ? assertion.evidence : []} />
      <p className="assertion-relations">
        Supports: {view.supportingAssertionIds.join(", ")} · Contradicts: {view.contradictingAssertionIds.join(", ")}
      </p>
      {assertion.status === "proposed" ? <AssertionRejectionFields codeRef={codeRef} reasonRef={reasonRef} /> : null}
      <footer className="assertion-actions">
        {decisions.map((decision) => (
          <button
            key={decision}
            type="button"
            className={decision === "accept" ? "primary-button" : "secondary-button"}
            data-assertion-id={assertion.id}
            data-assertion-decision={decision}
            disabled={pendingDecision === decision}
            title={errorTitles[decision]}
            onClick={() => {
              void decide(decision);
            }}
          >
            {humanize(decision)}
          </button>
        ))}
      </footer>
    </article>
  );
}
