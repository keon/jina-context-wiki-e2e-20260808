export function routeRepository(repositoryId, bindings) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new TypeError("repositoryId must be a positive integer");
  }

  const active = bindings.filter(
    (binding) => binding.repositoryId === repositoryId && binding.status === "active",
  );
  if (active.length !== 1) return null;

  return {
    tenantId: active[0].tenantId,
    billingAccountId: active[0].billingAccountId,
    connectionVersion: active[0].connectionVersion,
  };
}
