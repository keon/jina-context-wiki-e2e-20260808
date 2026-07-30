export interface ContextFailureDescription {
  readonly failureCode?: string;
  readonly failureReason?: string;
}

/**
 * Formats only the API's public failure contract. Raw Board event payloads,
 * diagnostics, and worker exceptions must never be used as a fallback.
 */
export function contextFailureText(failure: ContextFailureDescription): string | undefined {
  const reason = failure.failureReason?.trim();
  if (!reason) return undefined;
  const code = failure.failureCode?.trim();
  return code ? `${code}: ${reason}` : reason;
}
