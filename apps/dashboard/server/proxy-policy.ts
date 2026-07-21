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
      pathname === "/api/ontology" ||
      pathname === "/api/ontology/assertions");
  const allowedLocalDemo =
    !hasInternalApiToken && method === "POST" && pathname === "/api/dev/webhooks/github";
  const allowedOntologyQuery =
    method === "POST" && (pathname === "/api/ontology/ask" || pathname === "/api/ontology/commands");

  return allowedRead || allowedLocalDemo || allowedOntologyQuery;
}
