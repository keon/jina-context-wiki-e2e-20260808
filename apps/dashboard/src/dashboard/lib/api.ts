import type {
  InstallationResult,
  ReviewRun,
  ReviewRunDetailResponse,
} from "./types";
import { normalizeViewerTenants, type ViewerTenant } from "./tenants";

export function apiUrl(path: string, params?: URLSearchParams): string {
  const url = new URL(`/api${path}`, window.location.origin);
  if (params) {
    url.search = params.toString();
  }
  return url.toString();
}

/**
 * Returns `url` only when it resolves to an http(s) URL, otherwise undefined.
 * Guards against `javascript:`/`data:` injection in hrefs sourced from API data.
 */
export function safeHref(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return url;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function loginUrl(): string {
  const params = new URLSearchParams({ return_to: window.location.href });
  return apiUrl("/auth/github/login", params);
}

export function reviewRunsPath(tenantId?: string | null): string {
  return tenantId
    ? `/v1/dashboard/tenants/${encodeURIComponent(tenantId)}/review-runs`
    : "/v1/dashboard/review-runs";
}

export function reviewRunPath(reviewRunId: string, tenantId?: string | null): string {
  return `${reviewRunsPath(tenantId)}/${encodeURIComponent(reviewRunId)}`;
}

/** Create an empty Jina organization. GitHub installations are connected separately afterward. */
export async function createJinaOrganization(name: string): Promise<ViewerTenant> {
  const response = await fetch(apiUrl("/v1/dashboard/tenants"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    tenant?: unknown;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error || "Could not create organization");
  }
  return normalizeCreatedJinaOrganization(body.tenant);
}

/** Rename a Jina organization without changing its stable tenant identity. */
export async function updateJinaOrganization(tenantId: string, name: string): Promise<ViewerTenant> {
  const response = await fetch(apiUrl(`/v1/dashboard/tenants/${encodeURIComponent(tenantId)}`), {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    tenant?: unknown;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error || "Could not update organization");
  }
  return normalizeJinaOrganization(body.tenant);
}

export function normalizeCreatedJinaOrganization(raw: unknown): ViewerTenant {
  return normalizeJinaOrganization(raw, "Organization response was empty");
}

export function normalizeJinaOrganization(
  raw: unknown,
  emptyMessage = "Organization response was empty",
): ViewerTenant {
  const tenant = normalizeViewerTenants({ tenants: [raw] })[0];
  if (!tenant) {
    throw new Error(emptyMessage);
  }
  return tenant;
}

export async function getReviewRun(
  reviewRunId: string,
  tenantId: string | null,
  signal?: AbortSignal,
): Promise<ReviewRun | null> {
  const response = await fetch(apiUrl(reviewRunPath(reviewRunId, tenantId)), {
    cache: "no-store",
    credentials: "include",
    signal,
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Review run detail returned ${response.status}`);
  }
  const payload = (await response.json()) as ReviewRunDetailResponse;
  return payload.review_run;
}

export async function getScenarioLineageRuns(
  reviewRunId: string,
  lineageKey: string,
  tenantId: string | null,
  signal?: AbortSignal,
): Promise<ReviewRun[]> {
  const path = `${reviewRunPath(reviewRunId, tenantId)}/scenario-lineage/${encodeURIComponent(lineageKey)}`;
  const response = await fetch(apiUrl(path), {
    cache: "no-store",
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Scenario lineage returned ${response.status}`);
  }
  const payload = (await response.json()) as { review_runs?: ReviewRun[] };
  return payload.review_runs ?? [];
}

export async function logout(onLoggedOut: () => void): Promise<void> {
  await fetch(apiUrl("/auth/logout"), { method: "POST", credentials: "include" });
  onLoggedOut();
}

export function parseInstallationResult(search: string): InstallationResult | null {
  const params = new URLSearchParams(search);
  const action = params.get("setup_action");
  if (action !== "install" && action !== "update") {
    return null;
  }
  return { action, installationId: params.get("installation_id") ?? undefined };
}
