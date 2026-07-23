"use client";

import { useRef } from "react";
import { assertionView } from "../../lib/assertions.ts";
import type { ContextGraphAssertion } from "../../lib/types.ts";
import { AssertionRejectionFields, validateRejection } from "./assertion-review-controls.tsx";
import type { ReviewAssertionFn } from "./assertion-review-controls.tsx";

export function AssertionReviewQueue({
  assertions,
  onReview
}: {
  readonly assertions: readonly ContextGraphAssertion[];
  readonly onReview: ReviewAssertionFn;
}) {
  return (
    <>
      <div className="context-graph-item-heading">
        <div className="context-graph-heading-copy">
          <strong>Assertion review</strong>
          <span className="context-graph-item-type">{assertions.length} proposed</span>
        </div>
      </div>
      <div className="assertion-review-list">
        {assertions.map((assertion) => (
          <AssertionQueueCard key={assertion.id} assertion={assertion} onReview={onReview} />
        ))}
      </div>
    </>
  );
}

function AssertionQueueCard({
  assertion,
  onReview
}: {
  readonly assertion: ContextGraphAssertion;
  readonly onReview: ReviewAssertionFn;
}) {
  const codeRef = useRef<HTMLSelectElement | null>(null);
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const view = assertionView(assertion);
  return (
    <article className="assertion-review-card">
      <strong>
        {view.subjectLabel} · {assertion.predicate} · {view.objectLabel}
      </strong>
      <p>
        {assertion.explanation || "This legacy assertion has no explanation and should not be accepted without review."}
      </p>
      <p>Evidence: {(assertion.evidence ?? []).join(", ") || "none"}</p>
      <AssertionRejectionFields codeRef={codeRef} reasonRef={reasonRef} />
      <div className="assertion-review-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            void onReview(assertion.id, "accept").catch(() => undefined);
          }}
        >
          Accept
        </button>
        <button
          type="button"
          className="danger-button"
          onClick={() => {
            const rejection = validateRejection(codeRef, reasonRef);
            if (!rejection) return;
            void onReview(assertion.id, "reject", rejection.code, rejection.reason).catch(() => undefined);
          }}
        >
          Reject
        </button>
      </div>
    </article>
  );
}
