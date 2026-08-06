import { apiUrl } from "./api";

export interface SelectedTenant { tenantId: string }

export function wikiRepositoriesUrl(selected: SelectedTenant): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/wiki/repositories`,
  );
}

export function wikiBuildUrl(selected: SelectedTenant): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/wiki/build`,
  );
}

export function wikiBuildProgressUrl(
  selected: SelectedTenant,
  buildId: string,
): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/wiki/builds/${encodeURIComponent(buildId)}/progress`,
  );
}
