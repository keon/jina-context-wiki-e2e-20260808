import { apiUrl } from "../v1/lib/api.ts";

/** Any tenant-scoped v1 dashboard route. */
export function tenantDashboardApiUrl(tenantId: string, path: string): string {
  const suffix = path.replace(/^\/+/, "");
  return apiUrl(`/v1/dashboard/tenants/${encodeURIComponent(tenantId)}/${suffix}`);
}

/** Tenant-scoped v1 API route used by the GitHub-authenticated operations pages. */
export function operationsApiUrl(tenantId: string, path: string): string {
  return tenantDashboardApiUrl(tenantId, `operations/${path}`);
}
