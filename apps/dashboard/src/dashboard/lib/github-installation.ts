import type { SelectedTenant } from "./tenants";
import { isTenantWritable } from "./tenants";
import { apiUrl } from "./api";

const ONBOARDING_STATE_PREFIX = "jina:v1:onboarding:";

export interface GithubInstallationCallback {
  installationId: number;
  tenantId: string;
  returnTo?: "onboarding";
}

export interface GithubConnection {
  installationId: number;
  login: string;
  type: string;
  repositoryCount: number;
  status: "active" | "suspended" | "deleted";
}

/** Route GitHub's setup redirect back to the Jina tenant selected at install time. */
export function githubInstallationUrl(
  baseUrl: string | undefined,
  selected: SelectedTenant | null,
  returnTo?: "onboarding",
): string | undefined {
  if (!baseUrl) return undefined;
  if (!selected || !isTenantWritable(selected)) return baseUrl;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set(
      "state",
      returnTo === "onboarding" ? `${ONBOARDING_STATE_PREFIX}${selected.tenantId}` : selected.tenantId,
    );
    return url.toString();
  } catch {
    return baseUrl;
  }
}

/** Parse only the routing values GitHub returns; the API re-authorizes both. */
export function parseGithubInstallationCallback(search: string): GithubInstallationCallback | undefined {
  const params = new URLSearchParams(search);
  const installationId = Number(params.get("installation_id"));
  const state = params.get("state")?.trim() ?? "";
  const markedForOnboarding = state.startsWith(ONBOARDING_STATE_PREFIX);
  const tenantId = markedForOnboarding ? state.slice(ONBOARDING_STATE_PREFIX.length).trim() : state;
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || !tenantId) return undefined;
  return {
    installationId,
    tenantId,
    ...(markedForOnboarding ? { returnTo: "onboarding" as const } : {}),
  };
}

/**
 * Claim an installation for a Jina tenant. GitHub's installation webhook can
 * arrive just after the browser callback, so a conflict receives a short,
 * bounded retry before the failure is shown to the user.
 */
export async function connectGithubInstallation(
  tenantId: string,
  installationId: number,
  request: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
): Promise<Response> {
  const url = apiUrl(`/dashboard/tenants/${encodeURIComponent(tenantId)}/github/installations`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installation_id: installationId }),
    });
    if (response.status !== 409 || attempt === 3) return response;
    await wait(500 * 2 ** attempt);
  }
  throw new Error("Could not connect the GitHub installation");
}

export function normalizeGithubConnections(raw: unknown): GithubConnection[] {
  const list =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { installations?: unknown }).installations
      : undefined;
  if (!Array.isArray(list)) throw new TypeError("Invalid GitHub installations response");
  return list.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Invalid GitHub installation");
    }
    const value = entry as Record<string, unknown>;
    const installationId = value.installation_id;
    const login = typeof value.login === "string" ? value.login.trim() : "";
    const repositoryCount = value.repository_count;
    const status = value.status;
    if (
      !Number.isSafeInteger(installationId) ||
      Number(installationId) <= 0 ||
      !login ||
      typeof value.type !== "string" ||
      !Number.isSafeInteger(repositoryCount) ||
      Number(repositoryCount) < 0 ||
      (status !== "active" && status !== "suspended" && status !== "deleted")
    ) {
      throw new TypeError("Invalid GitHub installation");
    }
    return {
      installationId: Number(installationId),
      login,
      type: value.type,
      repositoryCount: Number(repositoryCount),
      status,
    };
  });
}
