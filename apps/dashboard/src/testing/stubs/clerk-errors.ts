/** Stands in for `@clerk/nextjs/errors`. */
export function isClerkAPIResponseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "clerkError" in error;
}
