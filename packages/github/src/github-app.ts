import { createSign } from "node:crypto";

export interface GitHubInstallationAccessToken {
  readonly token: string;
  readonly expiresAt?: string;
  readonly permissions: Readonly<Record<string, string>>;
}

export interface GitHubInstallationTokenOptions {
  readonly repository: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

const WORKER_INSTALLATION_PERMISSIONS = Object.freeze({
  contents: "read",
  issues: "read",
  pull_requests: "read",
  metadata: "read"
});

/** Mint a repository-scoped token for one installation of the configured GitHub App. */
export async function createGitHubInstallationAccessToken(
  installationId: number,
  options: GitHubInstallationTokenOptions
): Promise<GitHubInstallationAccessToken> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("GitHub installation id must be a positive integer");
  }
  const repository = requiredRepository(options.repository);
  const [, repositoryName] = repository.split("/");
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const appId = requiredSetting(env.GITHUB_APP_ID, "GITHUB_APP_ID");
  const privateKey = normalizePrivateKey(requiredSetting(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"));
  const apiUrl = (env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/$/, "");
  const appJwt = createGitHubAppJwt(appId, privateKey);
  const response = await fetchImpl(`${apiUrl}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt}`,
      "content-type": "application/json",
      "user-agent": "jina-context-engine-worker",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({
      repositories: [repositoryName],
      permissions: WORKER_INSTALLATION_PERMISSIONS
    })
  });
  if (!response.ok) {
    throw new Error(`GitHub installation token request failed with ${response.status}`);
  }
  const body = (await response.json()) as {
    readonly token?: unknown;
    readonly expires_at?: unknown;
    readonly permissions?: unknown;
    readonly repository_selection?: unknown;
    readonly repositories?: unknown;
  };
  if (body.repository_selection !== "selected") {
    throw new Error("GitHub installation token response was not repository-selection limited");
  }
  if (!Array.isArray(body.repositories) || body.repositories.length !== 1) {
    throw new Error("GitHub installation token response must contain exactly one repository");
  }
  const scopedRepository: unknown = body.repositories[0];
  if (
    !scopedRepository ||
    typeof scopedRepository !== "object" ||
    Array.isArray(scopedRepository) ||
    typeof (scopedRepository as { readonly full_name?: unknown }).full_name !== "string" ||
    (scopedRepository as { readonly full_name: string }).full_name.toLowerCase() !== repository
  ) {
    throw new Error("GitHub installation token response repository did not match the requested repository");
  }
  const permissions = exactStringRecord(body.permissions);
  if (
    JSON.stringify(Object.entries(permissions).sort()) !==
    JSON.stringify(Object.entries(WORKER_INSTALLATION_PERMISSIONS).sort())
  ) {
    throw new Error("GitHub installation token response did not contain the exact read-only permissions");
  }
  if (typeof body.token !== "string" || !body.token.trim()) {
    throw new Error("GitHub installation token response did not include a token");
  }
  return {
    token: body.token,
    ...(typeof body.expires_at === "string" && body.expires_at.trim() ? { expiresAt: body.expires_at } : {}),
    permissions
  };
}

function exactStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return {};
  return Object.fromEntries(entries);
}

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function requiredSetting(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function requiredRepository(value: string): string {
  const repository = value?.trim().toLowerCase();
  if (!repository || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error("GitHub repository must be owner/name");
  }
  return repository;
}
