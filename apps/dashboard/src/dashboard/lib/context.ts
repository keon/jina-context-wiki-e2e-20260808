import { apiUrl } from "./api";

export type SelectedTenant = { tenantId: string };

export function contextRepositoriesUrl(selected: SelectedTenant): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/context/repositories`,
  );
}

export function contextBuildUrl(selected: SelectedTenant): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/context/build`,
  );
}

export function contextBuildProgressUrl(
  selected: SelectedTenant,
  buildId: string,
): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/context/builds/${encodeURIComponent(buildId)}/progress`,
  );
}
