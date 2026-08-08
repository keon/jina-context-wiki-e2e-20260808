import type {
  InstallationResult,
  ReviewRun,
  ReviewRunDetailResponse,
} from "./types";

const directApiBaseUrl = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL);

export function apiUrl(path: string, params?: URLSearchParams): string {
  const url = directApiBaseUrl
    ? new URL(`${directApiBaseUrl}${path}`, window.location.origin)
    : new URL(`/api${path}`, window.location.origin);
  if (params) {
    url.search = params.toString();
  }
  return url.toString();
}

function normalizeApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must use http(s)");
  }
  return parsed.origin;
}

export function loginUrl(): string {
  const params = new URLSearchParams({ return_to: window.location.href });
  return apiUrl("/auth/github/login", params);
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

export function reviewRunsPath(tenantId?: string | null): string {
  return tenantId
    ? `/dashboard/tenants/${encodeURIComponent(tenantId)}/review-runs`
    : "/dashboard/local/review-runs";
}

export function reviewRunPath(reviewRunId: string, tenantId?: string | null): string {
  return `${reviewRunsPath(tenantId)}/${encodeURIComponent(reviewRunId)}`;
}

export async function getReviewRun(
  reviewRunId: string,
  tenantId: string | null,
  signal?: AbortSignal,
): Promise<ReviewRun | null> {
  // The API tags these GETs with an ETag and `cache-control: no-cache`, so the default cache mode
  // revalidates on every read and an unchanged run answers 304 from the browser cache.
  const response = await fetch(apiUrl(reviewRunPath(reviewRunId, tenantId)), {
    credentials: "include",
    signal: signal ?? null,
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

export function parseInstallationResult(search: string): InstallationResult | null {
  const params = new URLSearchParams(search);
  const action = params.get("setup_action");
  if (action !== "install" && action !== "update") {
    return null;
  }
  return { action, installationId: params.get("installation_id") ?? undefined };
}
