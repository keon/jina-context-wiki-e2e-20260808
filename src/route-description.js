export function describeRepositoryRoute(route) {
  if (route === null) return "unassigned";
  if (typeof route !== "object") throw new TypeError("route must be an object or null");

  const { tenantId, billingAccountId, connectionVersion } = route;
  if (
    typeof tenantId !== "string" ||
    tenantId.trim().length === 0 ||
    typeof billingAccountId !== "string" ||
    billingAccountId.trim().length === 0 ||
    !Number.isSafeInteger(connectionVersion) ||
    connectionVersion <= 0
  ) {
    throw new TypeError("route must be a valid immutable routing snapshot");
  }

  return `${tenantId}@v${connectionVersion}`;
}

// Validate the same immutable snapshot before answering assignment status.
export function hasAssignedRepositoryRoute(route) {
  describeRepositoryRoute(route);
  return route !== null;
}

// Match a validated immutable routing snapshot against the expected generation.
export function repositoryRouteVersionMatches(route, expectedVersion) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
    throw new TypeError("expectedVersion must be a positive safe integer");
  }
  describeRepositoryRoute(route);
  return route !== null && route.connectionVersion === expectedVersion;
}
