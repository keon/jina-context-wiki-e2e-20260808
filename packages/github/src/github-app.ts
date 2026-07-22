import { createSign } from "node:crypto";

export interface GitHubInstallationAccessToken {
  readonly token: string;
  readonly expiresAt?: string;
  readonly permissions: Readonly<Record<string, string>>;
}

export interface GitHubInstallationTokenOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

/** Mint a repository-scoped token for one installation of the configured GitHub App. */
export async function createGitHubInstallationAccessToken(
  installationId: number,
  options: GitHubInstallationTokenOptions = {}
): Promise<GitHubInstallationAccessToken> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("GitHub installation id must be a positive integer");
  }
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
      "user-agent": "jina-context-graph-worker",
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "unreadable response")).slice(0, 300);
    throw new Error(`GitHub installation token request failed with ${response.status}: ${detail}`);
  }
  const body = (await response.json()) as {
    readonly token?: unknown;
    readonly expires_at?: unknown;
    readonly permissions?: unknown;
  };
  if (typeof body.token !== "string" || !body.token.trim()) {
    throw new Error("GitHub installation token response did not include a token");
  }
  const permissions =
    body.permissions && typeof body.permissions === "object" && !Array.isArray(body.permissions)
      ? Object.fromEntries(
          Object.entries(body.permissions).filter((entry): entry is [string, string] => typeof entry[1] === "string")
        )
      : {};
  return {
    token: body.token,
    ...(typeof body.expires_at === "string" && body.expires_at.trim() ? { expiresAt: body.expires_at } : {}),
    permissions
  };
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
