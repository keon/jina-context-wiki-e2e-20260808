/**
 * Pure presentation helpers for the "Connect Codex" modal (capy-style device-code UX).
 * Kept free of React/DOM so they can be unit-tested with `node --test`.
 *
 * The browser device handshake itself lives in codex-device-flow.ts — this module only
 * covers the small presentation state machines the modal re-skins around it: how long the
 * copy confirmation lingers, the connected-state label, and which recovery affordance an
 * error offers.
 */

/** How long the transient "Copied" confirmation stays visible after a copy, in ms. */
export const COPY_CONFIRM_MS = 2000;

/**
 * Label for the connected state. `formattedDate` is the already-formatted connect date
 * (null when the API didn't report one). Pure — the caller formats the date.
 */
export function connectedLabel(formattedDate: string | null): string {
  return formattedDate ? `Codex connected ${formattedDate}` : "Codex connected";
}

/**
 * Whether the modal is showing a settled connection rather than a flow in progress.
 *
 * The name predates the dialog rebuild: closing is now always available, because
 * the device flow is persisted per tenant and resumes on reopen — only the
 * explicit "Cancel sign-in" abandons it. What this still decides is which body
 * the modal renders, connected or connecting.
 */
export function codexModalCanDismiss(configured: boolean, reconnectRequired: boolean): boolean {
  return configured && !reconnectRequired;
}

/** A save is successful only when the API's authoritative read-back says the credential is usable. */
export function codexConnectionAccepted(configured: boolean, reconnectRequired: boolean): boolean {
  return configured && !reconnectRequired;
}

/**
 * Recovery affordance for a failed handshake. An expired code can't be retried as-is — the
 * user must mint a fresh one — so it reads as "regenerate"; every other failure is a plain
 * retry. Both actions restart the handshake; this only picks the button label + intent.
 */
export function handshakeErrorAction(reason: string): { kind: "regenerate" | "retry"; label: string } {
  return reason === "expired"
    ? { kind: "regenerate", label: "Generate a new code" }
    : { kind: "retry", label: "Try again" };
}
