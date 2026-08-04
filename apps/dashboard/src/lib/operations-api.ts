import { apiUrl } from "../dashboard/lib/api.ts";

/** Any tenant-scoped customer dashboard route served by the compatibility API. */
export function tenantDashboardApiUrl(tenantId: string, path: string): string {
  const suffix = path.replace(/^\/+/, "");
  return apiUrl(`/dashboard/tenants/${encodeURIComponent(tenantId)}/${suffix}`);
}

/** Tenant-scoped compatibility API route used by authenticated operations pages. */
export function operationsApiUrl(tenantId: string, path: string): string {
  return tenantDashboardApiUrl(tenantId, `operations/${path}`);
}
