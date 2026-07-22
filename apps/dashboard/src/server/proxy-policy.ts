export function isAllowedDashboardApiRequest(
  method: string | undefined,
  pathname: string,
  hasInternalApiToken: boolean
): boolean {
  const allowedRead =
    method === "GET" &&
    (pathname === "/api/board" ||
      pathname === "/api/events" ||
      pathname === "/api/overview" ||
      pathname === "/api/task-types" ||
      pathname === "/api/context-graph" ||
      pathname === "/api/context-graph/assertions");
  const allowedLocalDemo = !hasInternalApiToken && method === "POST" && pathname === "/api/dev/webhooks/github";
  const allowedContextGraphQuery =
    method === "POST" && (pathname === "/api/context-graph/ask" || pathname === "/api/context-graph/commands");

  return allowedRead || allowedLocalDemo || allowedContextGraphQuery;
}
