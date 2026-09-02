export function routeRepository(repositoryId, bindings) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new TypeError("repositoryId must be a positive integer");
  }

  if (!Array.isArray(bindings)) throw new TypeError("bindings must be an array");
  const active = [];
  for (const binding of bindings) {
    if (binding === null || typeof binding !== "object") continue;
    const fields = Object.getOwnPropertyDescriptors(binding);
    const repositoryIdField = fields.repositoryId?.value;
    const status = fields.status?.value;
    const tenantId = fields.tenantId?.value;
    const billingAccountId = fields.billingAccountId?.value;
    const connectionVersion = fields.connectionVersion?.value;
    if (
      repositoryIdField !== repositoryId ||
      status !== "active" ||
      typeof tenantId !== "string" ||
      tenantId.length === 0 ||
      typeof billingAccountId !== "string" ||
      billingAccountId.length === 0 ||
      !Number.isSafeInteger(connectionVersion) ||
      connectionVersion <= 0
    ) {
      continue;
    }
    active.push({ tenantId, billingAccountId, connectionVersion });
  }
  if (active.length !== 1) return null;

  return Object.freeze({ ...active[0] });
}
