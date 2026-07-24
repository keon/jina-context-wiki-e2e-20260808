/**
 * Parse both Retry-After forms from RFC 9110: delay-seconds and an HTTP date.
 * Returns undefined when the header is absent or malformed.
 */
export function retryAfterDelayMs(
  retryAfter: string | undefined | null,
  maximumWaitMs: number,
  nowMs = Date.now()
): number | undefined {
  const value = retryAfter?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(1, seconds * 1_000), maximumWaitMs);
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.min(Math.max(1, retryAt - nowMs), maximumWaitMs);
}
