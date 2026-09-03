export function describeRepositoryRoute(route) {
  if (route === null) return "unassigned";
  if (typeof route !== "object") throw new TypeError("route must be an object or null");

  const { tenantId, billingAccountId, connectionVersion } = route;
  if (
    typeof tenantId !== "string" ||
    tenantId.length === 0 ||
    typeof billingAccountId !== "string" ||
    billingAccountId.length === 0 ||
    !Number.isSafeInteger(connectionVersion) ||
    connectionVersion <= 0
  ) {
    throw new TypeError("route must be a valid immutable routing snapshot");
  }

  return `${tenantId}@v${connectionVersion}`;
}
