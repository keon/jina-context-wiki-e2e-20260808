import { createSign } from "node:crypto";

import { ApiError } from "./errors.js";

// Mint an installation access token for the GitHub App. We sign a short-lived
// App JWT (RS256) from GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY and exchange it
// for an installation token. The JWT helpers mirror sync-github-webhook.ts,
// which is a standalone script we deliberately don't import from.

const GITHUB_USER_AGENT = "jina-code-review";

export async function createInstallationAccessToken(installationId: number): Promise<string> {
  const jwt = createGithubAppJwt(requiredEnv("GITHUB_APP_ID"), normalizePrivateKey(requiredEnv("GITHUB_APP_PRIVATE_KEY")));

  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": GITHUB_USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new ApiError(502, `GitHub installation token request failed: ${response.status}`, await response.text());
  }

  const body = (await response.json()) as { token?: string };
  if (!body.token) {
    throw new ApiError(502, "GitHub installation token response did not include a token");
  }

  return body.token;
}

export type InstallationRepositoryAccess = {
  name: string;
  defaultBranch: string;
  githubRepoId?: number;
  owner?: string;
  repositoryName?: string;
  private?: boolean;
};

export type GithubAppInstallation = {
  id: number;
  account: {
    id: number;
    login: string;
    type: string;
  };
};

/**
 * Verify that a setup_url installation id belongs to this GitHub App. GitHub
 * explicitly warns that the redirect parameter itself is attacker-controlled.
 */
export async function getInstallationForApp(
  installationId: number,
  fetchImpl: typeof fetch = fetch,
  jwtFactory: () => string = () =>
    createGithubAppJwt(requiredEnv("GITHUB_APP_ID"), normalizePrivateKey(requiredEnv("GITHUB_APP_PRIVATE_KEY"))),
): Promise<GithubAppInstallation | undefined> {
  const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwtFactory()}`,
      "user-agent": GITHUB_USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new ApiError(502, `GitHub App installation request failed: ${response.status}`);
  }
  const installation = (await response.json()) as Record<string, unknown>;
  const account = installation.account;
  if (
    installation.id !== installationId ||
    !account ||
    typeof account !== "object" ||
    Array.isArray(account)
  ) {
    throw new ApiError(502, "GitHub App installation response was invalid");
  }
  const accountRecord = account as Record<string, unknown>;
  if (
    typeof accountRecord.id !== "number" ||
    typeof accountRecord.login !== "string" ||
    typeof accountRecord.type !== "string"
  ) {
    throw new ApiError(502, "GitHub installation account response was invalid");
  }
  return {
    id: installationId,
    account: {
      id: accountRecord.id,
      login: accountRecord.login,
      type: accountRecord.type,
    },
  };
}

/** Verify that the signed-in OAuth user may administer the installation account. */
export async function canUserAdministerInstallation(
  accessToken: string,
  githubUserId: number,
  installation: GithubAppInstallation,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (installation.account.type === "User") {
    return installation.account.id === githubUserId;
  }
  if (installation.account.type !== "Organization") return false;
  const response = await fetchImpl(
    `https://api.github.com/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": GITHUB_USER_AGENT,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  // Organization OAuth App restrictions return 403/404 even when this user
  // installed our GitHub App. The caller may fall back to installer proof from
  // the signed installation webhook; all other failures still fail closed.
  if (response.status === 403 || response.status === 404) return false;
  if (!response.ok) {
    throw new ApiError(502, `GitHub organization membership request failed: ${response.status}`);
  }
  const membership = (await response.json()) as { role?: unknown; state?: unknown };
  return membership.role === "admin" && membership.state === "active";
}

/**
 * Return the exact repository set currently visible to one GitHub App
 * installation. This is the authorization source for tenant graph access: an
 * organization name alone is never enough to grant access to all of its repos.
 */
export async function listInstallationRepositories(
  installationId: number,
  fetchImpl: typeof fetch = fetch,
  tokenFactory: (installationId: number) => Promise<string> = createInstallationAccessToken,
): Promise<InstallationRepositoryAccess[]> {
  const token = await tokenFactory(installationId);
  const repositories = new Map<string, InstallationRepositoryAccess>();

  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchImpl(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": GITHUB_USER_AGENT,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new ApiError(502, `GitHub installation repositories request failed: ${response.status}`);
    }
    const body = (await response.json()) as { repositories?: unknown };
    if (!Array.isArray(body.repositories)) {
      throw new ApiError(502, "GitHub installation repositories response was invalid");
    }
    for (const value of body.repositories) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const repository = value as Record<string, unknown>;
      const name = typeof repository.full_name === "string" ? repository.full_name.trim() : "";
      const defaultBranch = typeof repository.default_branch === "string" ? repository.default_branch.trim() : "";
      if (name && defaultBranch) {
        const [owner, repositoryName] = name.split("/", 2);
        repositories.set(name.toLowerCase(), {
          name,
          defaultBranch,
          ...(typeof repository.id === "number" ? { githubRepoId: repository.id } : {}),
          ...(owner ? { owner } : {}),
          ...(repositoryName ? { repositoryName } : {}),
          ...(typeof repository.private === "boolean" ? { private: repository.private } : {}),
        });
      }
    }
    if (body.repositories.length < 100) {
      return [...repositories.values()].sort((left, right) => left.name.localeCompare(right.name));
    }
  }

  throw new ApiError(502, "GitHub installation repository list exceeded the pagination limit");
}

function createGithubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);

  return `${signingInput}.${base64Url(signature)}`;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ApiError(500, `Missing required environment variable ${name}`);
  }

  return value;
}
