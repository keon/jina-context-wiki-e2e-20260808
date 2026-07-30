export interface ContextFailureDescription {
  readonly failureCode?: string;
  readonly failureReason?: string;
}

/**
 * Formats the API's bounded public failure fields for compact build surfaces.
 * The API owns redaction; this helper deliberately never falls back to Board
 * event payloads or diagnostics.
 */
export function contextFailureText(failure: ContextFailureDescription): string | undefined {
  const reason = failure.failureReason?.trim();
  if (!reason) return undefined;
  const code = failure.failureCode?.trim();
  return code ? `${code}: ${reason}` : reason;
}
