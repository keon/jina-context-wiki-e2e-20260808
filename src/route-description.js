import { types } from "node:util";

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
  if (route === null) return false;
  if (typeof route !== "object" || types.isProxy(route) || !Object.isFrozen(route)) {
    throw new TypeError("route must be a valid immutable routing snapshot");
  }
  const fields = Object.getOwnPropertyDescriptors(route);
  const names = ["tenantId", "billingAccountId", "connectionVersion"];
  if (
    Reflect.ownKeys(fields).length !== names.length ||
    !names.every((name) => {
      const field = fields[name];
      return field && Object.prototype.hasOwnProperty.call(field, "value") && field.enumerable && !field.writable && !field.configurable;
    })
  ) {
    throw new TypeError("route must be a valid immutable routing snapshot");
  }
  const snapshot = Object.fromEntries(names.map((name) => [name, fields[name].value]));
  describeRepositoryRoute(snapshot);
  return snapshot.connectionVersion === expectedVersion;
}
