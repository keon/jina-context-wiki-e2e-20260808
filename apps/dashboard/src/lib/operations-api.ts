import { apiUrl } from "../dashboard/lib/api.ts";

/** Any tenant-scoped customer dashboard route. */
export function tenantDashboardApiUrl(tenantId: string, path: string): string {
  const suffix = path.replace(/^\/+/, "");
  return apiUrl(`/dashboard/tenants/${encodeURIComponent(tenantId)}/${suffix}`);
}

/** Tenant-scoped API route used by authenticated operations pages. */
export function operationsApiUrl(tenantId: string, path: string): string {
  return tenantDashboardApiUrl(tenantId, `operations/${path}`);
}
