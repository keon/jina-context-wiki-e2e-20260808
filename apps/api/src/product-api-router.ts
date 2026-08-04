/** Product/review routes absorbed from the original backend. */
export function isProductApiRoute(pathname: string): boolean {
  return (
    pathname === "/webhooks/github" ||
    pathname === "/v1/healthz" ||
    pathname.startsWith("/v1/dashboard/") ||
    pathname.startsWith("/auth/") ||
    pathname === "/internal/reviews/prepare" ||
    pathname.startsWith("/internal/reviews/") ||
    pathname === "/internal/graph/availability" ||
    pathname === "/internal/context/mcp-access" ||
    pathname === "/internal/installations/backfill" ||
    pathname === "/internal/scheduled-review-scan" ||
    pathname === "/internal/integrations/resolve" ||
    pathname === "/internal/context/execution-profile" ||
    pathname === "/internal/billing/retry"
  );
}
