import { apiUrl } from "./api";

export type SelectedTenant = { tenantId: string };

export function contextDocumentsUrl(
  selected: SelectedTenant,
  repository?: string,
): string {
  const base = `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/context/documents`;
  return apiUrl(
    repository ? `${base}?repository=${encodeURIComponent(repository)}` : base,
  );
}

export function contextRepositoriesUrl(selected: SelectedTenant): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/context/repositories`,
  );
}

export function contextDocumentUrl(
  selected: SelectedTenant,
  repository: string,
  releaseId: string,
  documentId: string,
): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/context/documents/${encodeURIComponent(documentId)}?repository=${encodeURIComponent(repository)}&releaseId=${encodeURIComponent(releaseId)}`,
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

export function contextBuildCancelUrl(
  selected: SelectedTenant,
  buildId: string,
): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/context/builds/${encodeURIComponent(buildId)}/cancel`,
  );
}

export function contextBuildsUrl(selected: SelectedTenant): string {
  return apiUrl(
    `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/context/builds`,
  );
}

/** A citation rendered for a person: repository, short commit, file and lines. */
export function formatCitation(citation: {
  repository?: string;
  commitSha?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}): string {
  const revision = citation.commitSha
    ? `@${citation.commitSha.slice(0, 8)}`
    : "";
  const lines = citation.startLine
    ? `:${citation.startLine}${citation.endLine && citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}`
    : "";
  const location = citation.path ? ` ${citation.path}${lines}` : "";
  return `${citation.repository ?? ""}${revision}${location}`.trim();
}
