import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality for comparing presented credentials against
 * expected secrets. The length guard is required because timingSafeEqual throws
 * on mismatched lengths; the length itself is not secret.
 */
export function constantTimeEquals(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}
