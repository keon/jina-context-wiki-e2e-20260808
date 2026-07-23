import type { RefObject } from "react";
import { ASSERTION_REJECTION_CODES } from "../../lib/assertions.ts";

export type ReviewAssertionFn = (
  assertionId: string,
  decision: string,
  rejectionCode?: string,
  reason?: string
) => Promise<void>;

/** Shared rejection controls used by both assertion review surfaces. */
export function AssertionRejectionFields({
  codeRef,
  reasonRef
}: {
  readonly codeRef: RefObject<HTMLSelectElement | null>;
  readonly reasonRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="assertion-review-fields">
      <select className="assertion-rejection-code" ref={codeRef} defaultValue="">
        {ASSERTION_REJECTION_CODES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <input className="assertion-rejection-reason" placeholder="Reason for rejection" ref={reasonRef} />
    </div>
  );
}

export function validateRejection(
  codeRef: RefObject<HTMLSelectElement | null>,
  reasonRef: RefObject<HTMLInputElement | null>
): { readonly code: string; readonly reason: string } | null {
  const code = codeRef.current;
  const reason = reasonRef.current;
  if (!code || !reason) return null;
  if (!code.value || !reason.value.trim()) {
    reason.setCustomValidity("Choose a category and provide a reason.");
    reason.reportValidity();
    return null;
  }
  reason.setCustomValidity("");
  return { code: code.value, reason: reason.value.trim() };
}
