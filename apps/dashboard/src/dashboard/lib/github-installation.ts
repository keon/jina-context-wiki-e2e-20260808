import type { SelectedTenant } from "./tenants";
import { isTenantWritable } from "./tenants";

export interface GithubInstallationCallback {
  installationId: number;
  tenantId: string;
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
): string | undefined {
  if (!baseUrl) return undefined;
  if (!selected || !isTenantWritable(selected)) return baseUrl;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("state", selected.tenantId);
    return url.toString();
  } catch {
    return baseUrl;
  }
}

/** Parse only the routing values GitHub returns; the API re-authorizes both. */
export function parseGithubInstallationCallback(search: string): GithubInstallationCallback | undefined {
  const params = new URLSearchParams(search);
  const installationId = Number(params.get("installation_id"));
  const tenantId = params.get("state")?.trim() ?? "";
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || !tenantId) return undefined;
  return { installationId, tenantId };
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
