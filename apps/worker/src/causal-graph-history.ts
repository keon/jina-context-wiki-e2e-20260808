const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function canonicalCausalGraphCommitTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value.trim())) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}
