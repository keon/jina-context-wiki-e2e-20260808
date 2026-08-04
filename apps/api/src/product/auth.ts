import { randomBytes } from "node:crypto";
import { createClerkClient } from "@clerk/backend";

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { dashboardOriginAllowed, type AppConfig } from "./config.js";
import { ApiError } from "./errors.js";
import {
  consumeOauthState,
  deleteSession,
  getSession,
  hasInstallationForAccounts,
  knownProjects,
  saveOauthState,
  saveSession,
  syncTenantMemberships,
  syncClerkTenantMemberships,
  updateSessionIfCurrent,
  upsertGithubUserIdentity,
  type ViewerOrgMembership,
} from "./store.js";

type GithubUser = {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
};

type GithubOrg = {
  id: number;
  login: string;
  avatar_url?: string;
};

type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    login: string;
  };
  html_url?: string;
};

type GithubTeam = {
  id: number;
  name: string;
  slug: string;
  html_url?: string;
  organization?: GithubOrg;
};

export type DashboardProject = {
  id: string;
  github_repo_id?: number;
  full_name: string;
  owner: string;
  name: string;
  private?: boolean;
  html_url?: string;
  source: "github" | "observed";
};

export type DashboardTeam = {
  id: string;
  github_team_id: number;
  name: string;
  slug: string;
  html_url?: string;
  organization: {
    id?: number;
    login: string;
    avatar_url?: string;
  };
  project_full_names: string[];
};

type DashboardUser = {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
};

export type DashboardSession = {
  id: string;
  /** Stable Jina user id. Absent only on pre-transition or in-memory test sessions. */
  userId?: string;
  accessToken?: string;
  user: DashboardUser;
  organizations: Array<{
    id: number;
    login: string;
    avatar_url?: string;
  }>;
  projects: DashboardProject[];
  teams: DashboardTeam[];
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
  clerkUserId?: string;
  clerkOrganizationId?: string;
};

type OAuthTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GithubSessionAccess = {
  user: GithubUser;
  organizations: GithubOrg[];
  repositories: GithubRepo[];
  teams: DashboardTeam[];
  // Per-list fetch success flags so refreshes never overwrite a good cached list with
  // an empty array after a transient GitHub failure.
  fetched: {
    organizations: boolean;
    repositories: boolean;
    teams: boolean;
  };
};

const SESSION_ACCESS_REFRESH_INTERVAL_MS = 5 * 60_000;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_USER_AGENT = "jina-code-review";
const sessionAccessRefreshes = new Map<string, Promise<DashboardSession | undefined>>();

// Shared SameSite/Secure attributes applied to every auth cookie (also reused by the OpenRouter
// OAuth route, which shares the same cookie hardening).
export function cookieSecurity(config: AppConfig): { sameSite: AppConfig["auth"]["cookieSameSite"]; secure: boolean } {
  return { sameSite: config.auth.cookieSameSite, secure: config.auth.cookieSecure };
}

// Sessions and OAuth login state are persisted in Postgres (see store.ts) so they
// survive restarts and are shared across Cloud Run instances.

function dashboardAuthEnabled(config: AppConfig): boolean {
  return config.auth.mode !== "disabled";
}

export async function githubLogin(c: Context, config: AppConfig): Promise<Response> {
  ensureGithubAuth(config);
  const state = randomToken(24);
  const callbackUrl = callbackUrlFor(c, config, "/auth/github/callback");
  await saveOauthState(state, safeReturnUrl(config, c.req.query("return_to")), Date.now() + 10 * 60 * 1_000);

  setCookie(c, config.auth.oauthStateCookieName, state, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/auth/github",
    ...cookieSecurity(config),
  });

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", config.auth.githubClientId ?? "");
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizeUrl.searchParams.set("scope", config.auth.githubScopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("allow_signup", "false");

  return c.redirect(authorizeUrl.toString());
}

export async function githubCallback(c: Context, config: AppConfig): Promise<Response> {
  ensureGithubAuth(config);
  const expectedState = getCookie(c, config.auth.oauthStateCookieName);
  const state = c.req.query("state");
  const code = c.req.query("code");

  deleteCookie(c, config.auth.oauthStateCookieName, {
    path: "/auth/github",
    ...cookieSecurity(config),
  });

  if (!expectedState || !state || expectedState !== state) {
    throw new ApiError(401, "GitHub OAuth state mismatch");
  }
  if (!code) {
    throw new ApiError(400, "GitHub OAuth callback is missing code");
  }

  const accessToken = await exchangeCodeForToken(config, code, callbackUrlFor(c, config, "/auth/github/callback"));
  const session = await createGithubSession(config, accessToken);
  const returnTo = await consumeReturnTo(config, state);

  setCookie(c, config.auth.sessionCookieName, session.id, {
    httpOnly: true,
    maxAge: config.auth.sessionTtlSeconds,
    path: "/",
    ...cookieSecurity(config),
  });

  return c.redirect(returnTo);
}

export async function logout(c: Context, config: AppConfig): Promise<Response> {
  if (config.auth.mode === "clerk") {
    const session = await currentSession(c, config);
    if (session) await deleteSession(session.id).catch(() => {});
    return c.json({ ok: true });
  }
  const sessionId = getCookie(c, config.auth.sessionCookieName);
  if (sessionId) {
    await deleteSession(sessionId).catch(() => {});
  }

  deleteCookie(c, config.auth.sessionCookieName, {
    path: "/",
    ...cookieSecurity(config),
  });

  return c.json({ ok: true });
}

export async function me(c: Context, config: AppConfig): Promise<Response> {
  const session = await currentSession(c, config);
  return c.json(await dashboardViewer(config, session));
}

/**
 * Refresh GitHub-derived access explicitly after the dashboard has rendered.
 * Authentication and normal API reads use the persisted ACL snapshot only, so
 * GitHub latency is never part of the first-load or polling request path.
 */
export async function refreshMe(c: Context, config: AppConfig): Promise<Response> {
  const session = await currentSession(c, config);
  const refreshed = session ? await refreshSessionAccess(session) : undefined;
  return c.json(await dashboardViewer(config, refreshed));
}

async function dashboardViewer(config: AppConfig, session: DashboardSession | undefined) {
  const accountIds = session ? [session.user.id, ...session.organizations.map((org) => org.id)] : [];
  const installed = await hasInstallationForAccounts(accountIds).catch(() => false);

  return {
    auth: {
      mode: config.auth.mode,
      enabled: dashboardAuthEnabled(config),
    },
    github_app: {
      install_url: config.githubAppInstallUrl,
      installed,
    },
    authenticated: Boolean(session),
    user: session
      ? {
          ...session.user,
          ...(session.userId ? { internal_id: session.userId } : {}),
        }
      : undefined,
    organizations: session?.organizations ?? [],
    teams: session?.teams ?? [],
    projects: await visibleProjects(session).catch(() => session?.projects ?? []),
  };
}

export async function requireDashboardSession(c: Context, config: AppConfig): Promise<DashboardSession | undefined> {
  if (!dashboardAuthEnabled(config)) {
    return undefined;
  }

  const session = await currentSession(c, config);
  if (!session) {
    throw new ApiError(401, "dashboard authentication required");
  }

  return session;
}

export async function visibleProjects(session: DashboardSession | undefined): Promise<DashboardProject[]> {
  const observedProjects = (await knownProjects()).map((project) => ({
    id: project.full_name,
    github_repo_id: project.github_repo_id,
    full_name: project.full_name,
    owner: project.owner,
    name: project.name,
    private: project.private,
    source: "observed" as const,
  }));

  if (!session) {
    return observedProjects.sort(compareProjects);
  }

  const allowed = accessibleProjectNames(session);
  const byName = new Map<string, DashboardProject>();

  for (const project of session.projects) {
    byName.set(project.full_name.toLowerCase(), project);
  }

  for (const project of observedProjects) {
    if (allowed.has(project.full_name.toLowerCase())) {
      byName.set(project.full_name.toLowerCase(), {
        ...project,
        ...byName.get(project.full_name.toLowerCase()),
      });
    }
  }

  return [...byName.values()].sort(compareProjects);
}

export function teamAllowsProject(team: DashboardTeam, projectFullName: string): boolean {
  // Authorize strictly against the team's actual repository list. The previous
  // org-prefix fallback over-granted access to every repo in the org, including
  // repos the team cannot see.
  const normalized = projectFullName.toLowerCase();
  return team.project_full_names.some((name) => name.toLowerCase() === normalized);
}

async function currentSession(c: Context, config: AppConfig): Promise<DashboardSession | undefined> {
  if (!dashboardAuthEnabled(config)) {
    return undefined;
  }

  if (config.auth.mode === "clerk") {
    return currentClerkSession(c, config);
  }

  const sessionId = getCookie(c, config.auth.sessionCookieName);
  if (!sessionId) {
    return undefined;
  }

  let session: DashboardSession | undefined;
  try {
    session = await getSession(sessionId);
  } catch {
    return undefined;
  }
  if (!session || session.expiresAt <= Date.now()) {
    await deleteSession(sessionId).catch(() => {});
    return undefined;
  }

  return session;
}

async function currentClerkSession(c: Context, config: AppConfig): Promise<DashboardSession | undefined> {
  const clerk = createClerkClient({
    secretKey: config.auth.clerkSecretKey,
    publishableKey: config.auth.clerkPublishableKey,
  });
  const state = await clerk.authenticateRequest(c.req.raw, {
    publishableKey: config.auth.clerkPublishableKey,
    acceptsToken: "session_token",
    authorizedParties: config.dashboardAllowedOrigins === "*" ? undefined : config.dashboardAllowedOrigins,
  });
  if (!state.isAuthenticated) return undefined;
  const auth = state.toAuth();
  if (!auth?.userId || !auth.sessionId) return undefined;

  const cacheId = `clerk:${auth.sessionId}`;
  const cached = await getSession(cacheId).catch(() => undefined);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    !sessionAccessStale(cached) &&
    cached.clerkOrganizationId === (auth.orgId ?? undefined)
  ) {
    return cached;
  }

  const user = await clerk.users.getUser(auth.userId);
  const githubAccount = user.externalAccounts.find((account) => account.provider === "oauth_github");
  const githubUserId = Number(githubAccount?.externalId);
  const githubLogin = githubAccount?.username?.trim();
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0 || !githubLogin) {
    throw new ApiError(403, "Connect GitHub to your Clerk profile before using Jina");
  }

  const oauth = await clerk.users.getUserOauthAccessToken(auth.userId, "github");
  const githubAccessToken = oauth.data[0]?.token;
  if (!githubAccessToken) {
    throw new ApiError(403, "Reconnect GitHub in your Clerk profile before using Jina");
  }
  const access = await loadGithubSessionAccess(githubAccessToken);
  const identity = await upsertGithubUserIdentity({
    githubUserId,
    githubLogin,
    displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || githubLogin,
    avatarUrl: user.imageUrl,
  });
  if (!identity) throw new ApiError(503, "Jina identity storage is unavailable");

  const memberships = await clerk.users.getOrganizationMembershipList({ userId: auth.userId, limit: 500 });
  await syncClerkTenantMemberships({
    githubUserId,
    githubLogin,
    userId: identity.userId,
    memberships: memberships.data.map((membership) => ({
      organizationId: membership.organization.id,
      name: membership.organization.name,
      role: membership.role === "org:admin" ? "admin" : "member",
    })),
  });

  const now = new Date().toISOString();
  const session: DashboardSession = {
    id: cacheId,
    userId: identity.userId,
    accessToken: githubAccessToken,
    user: {
      id: githubUserId,
      login: githubLogin,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || githubLogin,
      avatar_url: user.imageUrl,
      html_url: `https://github.com/${encodeURIComponent(githubLogin)}`,
    },
    organizations: access.organizations.map(githubOrgForSession),
    projects: access.repositories.map(githubRepoForSession),
    teams: access.teams,
    expiresAt: Date.now() + config.auth.sessionTtlSeconds * 1_000,
    createdAt: cached?.createdAt ?? now,
    updatedAt: now,
    clerkUserId: auth.userId,
    clerkOrganizationId: auth.orgId ?? undefined,
  };
  await saveSession(session);
  return session;
}

async function createGithubSession(config: AppConfig, accessToken: string): Promise<DashboardSession> {
  const access = await loadGithubSessionAccess(accessToken);
  const identity = await upsertGithubUserIdentity({
    githubUserId: access.user.id,
    githubLogin: access.user.login,
    displayName: access.user.name,
    avatarUrl: access.user.avatar_url,
  });
  const now = new Date().toISOString();
  const session: DashboardSession = {
    id: randomToken(32),
    userId: identity?.userId,
    accessToken,
    user: githubUserForSession(access.user),
    organizations: access.organizations.map(githubOrgForSession),
    projects: access.repositories.map(githubRepoForSession),
    teams: access.teams,
    expiresAt: Date.now() + config.auth.sessionTtlSeconds * 1_000,
    createdAt: now,
    updatedAt: now,
  };

  await saveSession(session);

  // Persist tenant membership from the viewer's OWN token (GitHub org memberships + their personal
  // tenant), so org tenants are first-class. A sync failure must never break login — stale membership
  // beats a broken login — so it is logged and swallowed.
  await syncViewerTenantMemberships(accessToken, session.user, session.userId).catch((error) => {
    console.warn("tenant_membership_sync_failed", {
      user: session.user.login,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return session;
}

type GithubOrgMembership = {
  role?: string;
  state?: string;
  organization?: { id?: number; login?: string };
};

/**
 * Fetch the viewer's ACTIVE org memberships from their own token (GET /user/memberships/orgs), paginated
 * (100/page, capped). Each active membership yields { organizationId, login, role } where role is 'admin'
 * for org owners/admins and 'member' otherwise. Only active memberships are requested, so pending
 * invitations never grant access.
 */
async function fetchActiveOrgMemberships(accessToken: string): Promise<ViewerOrgMembership[]> {
  const memberships: ViewerOrgMembership[] = [];
  const PER_PAGE = 100;
  const MAX_PAGES = 10;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await githubJson<GithubOrgMembership[]>(
      accessToken,
      `/user/memberships/orgs?state=active&per_page=${PER_PAGE}&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    for (const entry of batch) {
      const id = entry.organization?.id;
      const login = entry.organization?.login;
      if (typeof id !== "number" || typeof login !== "string") {
        continue;
      }
      memberships.push({ organizationId: id, login, role: entry.role === "admin" ? "admin" : "member" });
    }
    if (batch.length < PER_PAGE) {
      break;
    }
  }
  return memberships;
}

/** Sync the viewer's tenant membership rows from their fetched org memberships + personal tenant. */
async function syncViewerTenantMemberships(
  accessToken: string,
  user: DashboardUser,
  userId?: string,
): Promise<void> {
  const memberships = await fetchActiveOrgMemberships(accessToken);
  await syncTenantMemberships(user.id, user.login, memberships, userId);
}

async function refreshSessionAccess(session: DashboardSession): Promise<DashboardSession | undefined> {
  const accessToken = session.accessToken;
  if (!accessToken || !sessionAccessStale(session)) {
    return session;
  }

  const existing = sessionAccessRefreshes.get(session.id);
  if (existing) {
    return existing;
  }

  const refresh = refreshSessionAccessOnce(session, accessToken).finally(() => {
    if (sessionAccessRefreshes.get(session.id) === refresh) {
      sessionAccessRefreshes.delete(session.id);
    }
  });
  sessionAccessRefreshes.set(session.id, refresh);
  return refresh;
}

async function refreshSessionAccessOnce(
  session: DashboardSession,
  accessToken: string,
): Promise<DashboardSession | undefined> {
  try {
    const access = await loadGithubSessionAccess(accessToken);
    const identity = await upsertGithubUserIdentity({
      githubUserId: access.user.id,
      githubLogin: access.user.login,
      displayName: access.user.name,
      avatarUrl: access.user.avatar_url,
    });
    const refreshed: DashboardSession = {
      ...session,
      userId: identity?.userId ?? session.userId,
      user: githubUserForSession(access.user),
      // Only replace a list when its fetch fully succeeded; otherwise keep the previously
      // cached value so a transient GitHub failure can't strip the user's access.
      organizations: access.fetched.organizations
        ? access.organizations.map(githubOrgForSession)
        : session.organizations,
      projects: access.fetched.repositories ? access.repositories.map(githubRepoForSession) : session.projects,
      teams: access.fetched.teams ? access.teams : session.teams,
      updatedAt: new Date().toISOString(),
    };
    const saved = await updateSessionIfCurrent(refreshed, session.updatedAt);
    if (!saved) {
      return getSession(session.id).catch(() => undefined);
    }
    // Re-sync tenant memberships on the periodic refresh (not only at login), so a long-lived session
    // self-heals: org tenants a user belongs to appear in their switcher within one refresh interval,
    // without requiring a re-login. A sync failure must never break the request — swallow + log, as at
    // login (stale membership beats a broken dashboard).
    await syncViewerTenantMemberships(accessToken, refreshed.user, refreshed.userId).catch((error) => {
      console.warn("tenant_membership_sync_failed", {
        phase: "refresh",
        user: refreshed.user.login,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return refreshed;
  } catch (error) {
    console.warn("dashboard_session_refresh_failed", {
      user: session.user.login,
      error: error instanceof Error ? error.message : String(error),
    });
    return getSession(session.id).catch(() => undefined);
  }
}

function sessionAccessStale(session: DashboardSession): boolean {
  const updatedAt = new Date(session.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) {
    return true;
  }
  return Date.now() - updatedAt >= SESSION_ACCESS_REFRESH_INTERVAL_MS;
}

async function loadGithubSessionAccess(accessToken: string): Promise<GithubSessionAccess> {
  // /user must succeed (it identifies the session). The list fetches are tracked
  // individually so a partial outage degrades gracefully instead of clobbering data.
  const user = await githubJson<GithubUser>(accessToken, "/user");
  const [organizations, repositories, teamsRaw] = await Promise.all([
    fetchList(githubJson<GithubOrg[]>(accessToken, "/user/orgs?per_page=100")),
    fetchList(
      githubJson<GithubRepo[]>(
        accessToken,
        "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      ),
    ),
    fetchList(githubJson<GithubTeam[]>(accessToken, "/user/teams?per_page=100")),
  ]);

  let teams: DashboardTeam[] = [];
  let teamsOk = teamsRaw.ok;
  if (teamsRaw.ok) {
    try {
      teams = await teamsForSession(accessToken, teamsRaw.value);
    } catch {
      teamsOk = false;
    }
  }

  return {
    user,
    organizations: organizations.value,
    repositories: repositories.value,
    teams,
    fetched: {
      organizations: organizations.ok,
      repositories: repositories.ok,
      teams: teamsOk,
    },
  };
}

type FetchResult<T> = { ok: boolean; value: T };

// Resolve a list fetch into a success/failure flag instead of throwing, so a partial
// GitHub outage degrades gracefully (the caller keeps the previously cached list).
async function fetchList<T>(promise: Promise<T[]>): Promise<FetchResult<T[]>> {
  try {
    return { ok: true, value: await promise };
  } catch {
    return { ok: false, value: [] };
  }
}

function githubUserForSession(user: GithubUser): DashboardUser {
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatar_url: user.avatar_url,
    html_url: user.html_url,
  };
}

function githubOrgForSession(org: GithubOrg): DashboardSession["organizations"][number] {
  return {
    id: org.id,
    login: org.login,
    avatar_url: org.avatar_url,
  };
}

function githubRepoForSession(repo: GithubRepo): DashboardProject {
  return {
    id: repo.full_name,
    github_repo_id: repo.id,
    full_name: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    private: repo.private,
    html_url: repo.html_url,
    source: "github",
  };
}

async function teamsForSession(accessToken: string, teams: GithubTeam[]): Promise<DashboardTeam[]> {
  const dashboardTeams = await Promise.all(
    teams.map(async (team) => {
      const orgLogin = team.organization?.login;
      const repos =
        orgLogin && team.slug
          ? await githubJson<GithubRepo[]>(accessToken, `/orgs/${orgLogin}/teams/${team.slug}/repos?per_page=100`).catch(
              () => [],
            )
          : [];

      return {
        id: `${orgLogin ?? "unknown"}/${team.slug}`,
        github_team_id: team.id,
        name: team.name,
        slug: team.slug,
        html_url: team.html_url,
        organization: {
          id: team.organization?.id,
          login: orgLogin ?? "unknown",
          avatar_url: team.organization?.avatar_url,
        },
        project_full_names: repos.map((repo) => repo.full_name),
      };
    }),
  );

  return dashboardTeams.sort((a, b) => a.id.localeCompare(b.id));
}

export function sessionAccessibleNames(session: DashboardSession | undefined): string[] | null {
  if (!session) {
    return null;
  }
  return [...accessibleProjectNames(session)];
}

function accessibleProjectNames(session: DashboardSession): Set<string> {
  const names = new Set<string>();
  for (const project of session.projects) {
    names.add(project.full_name.toLowerCase());
  }
  for (const team of session.teams) {
    for (const projectName of team.project_full_names) {
      names.add(projectName.toLowerCase());
    }
  }

  return names;
}

async function exchangeCodeForToken(config: AppConfig, code: string, redirectUri: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": GITHUB_USER_AGENT,
    },
    body: JSON.stringify({
      client_id: config.auth.githubClientId,
      client_secret: config.auth.githubClientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new ApiError(502, `GitHub OAuth token exchange failed: ${response.status}`);
  }

  const token = (await response.json()) as OAuthTokenResponse;
  if (!token.access_token) {
    throw new ApiError(401, token.error_description || token.error || "GitHub OAuth did not return an access token");
  }

  return token.access_token;
}

async function githubJson<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": GITHUB_USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub GET ${path} failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
}

function ensureGithubAuth(config: AppConfig): void {
  if (config.auth.mode !== "github") {
    throw new ApiError(404, "GitHub dashboard authentication is not configured");
  }
}

// The OAuth redirect_uri MUST be stable and attacker-uncontrollable: it is sent to
// the provider and echoed during token exchange. Derive it from the configured canonical API
// base URL rather than client-supplied Host / X-Forwarded-* headers (which an attacker
// can spoof to redirect the code to their own host). Fall back to the request origin only
// when API_BASE_URL is unconfigured (local dev), where forwarded headers are not in play.
// `path` is the provider-specific callback path (shared by GitHub login and OpenRouter OAuth).
export function callbackUrlFor(c: Context, config: AppConfig, path: string): string {
  if (config.auth?.mode === "clerk" && path.startsWith("/v1/dashboard/")) {
    return new URL(`/api${path}`, config.dashboardUrl).toString();
  }
  if (config.apiBaseUrl) {
    return new URL(path, config.apiBaseUrl).toString();
  }

  // FINDING 6b: in production the Host / X-Forwarded-* fallback is attacker-controllable and would
  // let a spoofed Host redirect the OAuth code to another origin. Refuse to derive the callback from
  // request headers when API_BASE_URL is unset in production; dev keeps the request-origin fallback.
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(500, "API_BASE_URL must be configured in production to build OAuth callback URLs");
  }

  const requestUrl = new URL(c.req.url);
  const proto = requestUrl.protocol.replace(/:$/, "");
  const host = c.req.header("host") || requestUrl.host;

  return `${proto}://${host}${path}`;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function safeReturnUrl(config: AppConfig, value: string | undefined): string {
  if (!value) {
    return config.dashboardUrl;
  }

  if (value.startsWith("/") && !value.startsWith("//")) {
    return new URL(value, config.dashboardUrl).toString();
  }

  try {
    const url = new URL(value);
    if (dashboardOriginAllowed(config.dashboardAllowedOrigins, url.origin)) {
      return url.toString();
    }
  } catch {
    return config.dashboardUrl;
  }

  return config.dashboardUrl;
}

async function consumeReturnTo(config: AppConfig, state: string): Promise<string> {
  const returnTo = await consumeOauthState(state);
  return returnTo ?? config.dashboardUrl;
}

function compareProjects(a: DashboardProject, b: DashboardProject): number {
  return a.full_name.localeCompare(b.full_name);
}
