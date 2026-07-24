/**
 * HTTP route classification is deliberately kept separate from request
 * handling so metrics, authorization, and snapshot loading share one exact
 * grammar without making the server module a second route registry.
 */
const METRICS_ROUTES = new Set([
  "/health",
  "/healthz",
  "/task-types",
  "/webhooks/github",
  "/dev/webhooks/github",
  "/mcp",
  "/board",
  "/events",
  "/v1/graphs",
  "/v1/graph/query",
  "/context-graph",
  "/context-graph/ask",
  "/context-graph/assertions",
  "/context-graph/build",
  "/context-graph/commands",
  "/context-graph/execution-settings",
  "/context-graph/metrics",
  "/context-graph/retrieve",
  "/internal/admin/context-graph",
  "/internal/admin/context-graph/operations",
  "/internal/graph/access/sync",
  "/internal/observability",
  "/internal/context-graph/assertions/cached",
  "/internal/context-graph/assertions/evidence",
  "/internal/context-graph/assertions/execution",
  "/internal/context-graph/assertions/execution/refresh",
  "/internal/context-graph/assertions/save",
  "/internal/context-graph/ingest/blobs",
  "/internal/context-graph/ingest/github",
  "/internal/context-graph/ingest/known",
  "/internal/context-graph/ingest/plan",
  "/internal/context-graph/outbox/drain",
  "/internal/context-graph/project/run",
  "/internal/worker/claim",
  "/internal/worker/complete",
  "/internal/worker/release",
  "/internal/worker/renew"
]);

export function metricsRoute(pathname: string): string {
  if (graphRouteId(pathname, "/v1/graphs/") !== undefined) return "/v1/graphs/:id";
  if (graphRouteId(pathname, "/context-graph/graphs/") !== undefined) return "/context-graph/graphs/:id";
  return METRICS_ROUTES.has(pathname) ? pathname : "(unknown)";
}

/** Returns one safely decoded path segment after `prefix`, if present. */
export function graphRouteId(pathname: string, prefix: string): string | undefined {
  const segment = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
  if (!segment || segment.includes("/")) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function isPublicGraphRoute(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    pathname === "/v1/graphs" ||
    pathname.startsWith("/v1/graphs/") ||
    pathname === "/v1/graph/query"
  );
}

export function isSnapshotExemptInternalRoute(method: string | undefined, pathname: string): boolean {
  if (method !== "POST") return false;
  return (
    pathname.startsWith("/internal/context-graph/") ||
    [
      "/internal/worker/claim",
      "/internal/worker/renew",
      "/internal/worker/release",
      "/internal/worker/complete"
    ].includes(pathname)
  );
}

export function isDirectContextGraphRead(method: string | undefined, pathname: string): boolean {
  if (method === "OPTIONS" || (method === "GET" && ["/health", "/healthz", "/task-types"].includes(pathname)))
    return true;
  if (
    method === "GET" &&
    ["/internal/admin/context-graph", "/internal/admin/context-graph/operations"].includes(pathname)
  )
    return true;
  if (isPublicGraphRoute(pathname)) return true;
  if (
    method === "GET" &&
    [
      "/context-graph",
      "/context-graph/metrics",
      "/context-graph/assertions",
      "/context-graph/execution-settings"
    ].includes(pathname)
  )
    return true;
  return (
    (method === "GET" && pathname.startsWith("/context-graph/graphs/")) ||
    (method === "POST" && ["/context-graph/retrieve", "/context-graph/ask"].includes(pathname))
  );
}
