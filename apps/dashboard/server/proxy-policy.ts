/**
 * Maps a retired pre-rename dashboard path to its context-graph replacement.
 * Returning the target before the proxy allowlist runs lets old bookmarks and
 * API clients follow a 308 redirect instead of hitting the allowlist's 404.
 */
export function retiredDashboardPathRedirectTarget(pathname: string): string | undefined {
  if (pathname === "/ontology") return "/context-graph";
  if (pathname === "/assets/ontology-graph-client.js") return "/assets/context-graph-client.js";
  if (pathname === "/api/ontology" || pathname.startsWith("/api/ontology/")) {
    return `/api/context-graph${pathname.slice("/api/ontology".length)}`;
  }
  return undefined;
}

export function isAllowedDashboardApiRequest(
  method: string | undefined,
  pathname: string,
  hasInternalApiToken: boolean
): boolean {
  const allowedRead =
    method === "GET" &&
    (pathname === "/api/board" ||
      pathname === "/api/events" ||
      pathname === "/api/task-types" ||
      pathname === "/api/context-graph" ||
      pathname === "/api/context-graph/assertions");
  const allowedLocalDemo = !hasInternalApiToken && method === "POST" && pathname === "/api/dev/webhooks/github";
  const allowedContextGraphQuery =
    method === "POST" && (pathname === "/api/context-graph/ask" || pathname === "/api/context-graph/commands");

  return allowedRead || allowedLocalDemo || allowedContextGraphQuery;
}
