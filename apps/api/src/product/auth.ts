import { createClerkClient } from "@clerk/backend";

import type { Context } from "hono";

import type { AppConfig } from "./config.js";
import { ApiError } from "./errors.js";
import {
  getSession,
  hasInstallationForAccounts,
  knownProjects,
  linkClerkUserIdentity,
  resolveClerkUserIdentity,
  saveSession,
  syncClerkTenantMemberships,
  updateSessionIfCurrent,
  upsertGithubUserIdentity,
} from "./store.js";

interface GithubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

interface GithubOrg {
  id: number;
  login: string;
  avatar_url?: string;
}

interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    login: string;
  };
  html_url?: string;
}

interface GithubTeam {
  id: number;
  name: string;
  slug: string;
  html_url?: string;
  organization?: GithubOrg;
}

export interface DashboardProject {
  id: string;
  github_repo_id?: number;
  full_name: string;
  owner: string;
  name: string;
  private?: boolean;
  html_url?: string;
  source: "github" | "observed";
}

export interface DashboardTeam {
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
}

interface DashboardUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

export interface DashboardSession {
  id: string;
  userId: string;
  accessToken: string;
  user: DashboardUser;
  organizations: {
    id: number;
    login: string;
    avatar_url?: string;
  }[];
  projects: DashboardProject[];
  teams: DashboardTeam[];
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
  clerkUserId: string;
  clerkOrganizationId?: string;
}

interface GithubSessionAccess {
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
}

const SESSION_ACCESS_REFRESH_INTERVAL_MS = 5 * 60_000;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_USER_AGENT = "jina-code-review";
const sessionAccessRefreshes = new Map<string, Promise<DashboardSession | undefined>>();

// Shared SameSite/Secure attributes applied to every auth cookie (also reused by the OpenRouter
// OAuth route, which shares the same cookie hardening).
export function cookieSecurity(config: AppConfig): { sameSite: AppConfig["auth"]["cookieSameSite"]; secure: boolean } {
  return { sameSite: config.auth.cookieSameSite, secure: config.auth.cookieSecure };
}

// Clerk session projections are persisted in Postgres so they survive restarts
// and are shared across Cloud Run instances.

function dashboardAuthEnabled(config: AppConfig): boolean {
  return config.auth.mode !== "disabled";
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

async function visibleProjects(session: DashboardSession | undefined): Promise<DashboardProject[]> {
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

async function currentSession(c: Context, config: AppConfig): Promise<DashboardSession | undefined> {
  if (!dashboardAuthEnabled(config)) {
    return undefined;
  }
  return currentClerkSession(c, config);
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
  const accountGithubUserId = Number(githubAccount?.externalId);
  const accountGithubLogin = githubAccount?.username?.trim();
  const hasGithubAccount =
    Number.isSafeInteger(accountGithubUserId) && accountGithubUserId > 0 && Boolean(accountGithubLogin);
  const prelinked = await resolveClerkUserIdentity(auth.userId, user.externalId).catch(() => {
    throw new ApiError(403, "This Clerk account conflicts with an existing Jina account");
  });
  if (user.externalId && !prelinked) {
    throw new ApiError(403, "This Clerk account is linked to an unknown Jina account");
  }
  if (prelinked && hasGithubAccount && prelinked.githubUserId !== accountGithubUserId) {
    throw new ApiError(403, "This Clerk account is linked to a different GitHub account");
  }
  const resolved = hasGithubAccount
    ? await upsertGithubUserIdentity({
        githubUserId: accountGithubUserId,
        githubLogin: accountGithubLogin!,
      }).then((identity) => {
        if (prelinked && identity && prelinked.userId !== identity.userId) {
          throw new ApiError(403, "This Clerk account is linked to a different Jina account");
        }
        return identity
          ? { userId: identity.userId, githubUserId: accountGithubUserId, githubLogin: accountGithubLogin! }
          : undefined;
      })
    : prelinked;
  if (!resolved) {
    throw new ApiError(403, "Connect GitHub to your Clerk profile before using Jina");
  }
  const { githubUserId, githubLogin, userId } = resolved;

  if (user.externalId && user.externalId !== userId) {
    throw new ApiError(403, "This Clerk account is linked to a different Jina account");
  }
  const primaryEmail = user.primaryEmailAddressId
    ? user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress
    : user.emailAddresses[0]?.emailAddress;
  const clerkIdentity = await linkClerkUserIdentity({
    clerkUserId: auth.userId,
    userId,
    providerLogin: primaryEmail,
  });
  if (!clerkIdentity) throw new ApiError(503, "Jina identity storage is unavailable");
  if (clerkIdentity.status === "conflict") {
    throw new ApiError(403, "This Clerk account is already linked to a different Jina account");
  }
  if (!user.externalId) {
    await clerk.users.updateUser(auth.userId, { externalId: userId }).catch((error: unknown) => {
      console.warn("clerk_external_id_sync_failed", {
        clerk_user_id: auth.userId,
        jina_user_id: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  let githubAccessToken: string | undefined;
  let organizations: DashboardSession["organizations"] | undefined;
  let projects: DashboardSession["projects"] | undefined;
  let teams: DashboardSession["teams"] | undefined;
  if (hasGithubAccount) {
    const oauth = await clerk.users.getUserOauthAccessToken(auth.userId, "github");
    githubAccessToken = oauth.data[0]?.token;
    if (githubAccessToken) {
      const access = await loadGithubSessionAccess(githubAccessToken).catch((error: unknown) => {
        console.warn("clerk_github_access_refresh_failed", {
          clerk_user_id: auth.userId,
          github_user_id: githubUserId,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      });
      if (access) {
        organizations = access.organizations.map(githubOrgForSession);
        projects = access.repositories.map(githubRepoForSession);
        teams = access.teams;
      }
    }
  }

  if (!githubAccessToken || !organizations || !projects || !teams) {
    throw new ApiError(403, "Connect GitHub to your Clerk profile before using Jina");
  }

  const memberships = await clerk.users.getOrganizationMembershipList({ userId: auth.userId, limit: 500 });
  const membershipSync = await syncClerkTenantMemberships({
    clerkUserId: auth.userId,
    githubUserId,
    githubLogin,
    userId,
    memberships: memberships.data.map((membership) => ({
      organizationId: membership.organization.id,
      name: membership.organization.name,
      role: membership.role === "org:admin" ? "admin" : "member",
    })),
  });
  if (membershipSync.ignoredOrganizations.length > 0) {
    console.info("clerk_unlinked_organizations_ignored", {
      clerk_user_id: auth.userId,
      organization_ids: membershipSync.ignoredOrganizations.map((organization) => organization.organizationId),
    });
  }

  const now = new Date().toISOString();
  const session: DashboardSession = {
    id: cacheId,
    userId,
    accessToken: githubAccessToken,
    user: {
      id: githubUserId,
      login: githubLogin,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || githubLogin,
      avatar_url: user.imageUrl,
      html_url: `https://github.com/${encodeURIComponent(githubLogin)}`,
    },
    organizations,
    projects,
    teams,
    expiresAt: Date.now() + config.auth.sessionTtlSeconds * 1_000,
    createdAt: cached?.createdAt ?? now,
    updatedAt: now,
    clerkUserId: auth.userId,
    clerkOrganizationId: auth.orgId ?? undefined,
  };
  await saveSession(session);
  return session;
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

interface FetchResult<T> { ok: boolean; value: T }

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

// OpenRouter OAuth runs only for Clerk sessions. Its callback returns through the
// dashboard proxy, whose configured canonical origin is independent of request headers.
export function callbackUrlFor(config: AppConfig, path: string): string {
  if (config.auth.mode !== "clerk" || !path.startsWith("/dashboard/")) {
    throw new ApiError(500, "dashboard OAuth requires Clerk authentication");
  }
  return new URL(`/api${path}`, config.dashboardUrl).toString();
}

function compareProjects(a: DashboardProject, b: DashboardProject): number {
  return a.full_name.localeCompare(b.full_name);
}
