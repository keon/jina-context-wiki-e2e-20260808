import { randomUUID } from "node:crypto";

import type { DashboardSession } from "./auth.js";
import { sessionAccessibleNames } from "./auth.js";
import { ApiError } from "./errors.js";
import { getInstalledRepositoryForReview } from "./store.js";

// Shared plumbing for user-initiated review triggers: GitHub session/access
// checks, PR-target parsing, PR resolution, and the webhook-shaped trigger payload.

const GITHUB_USER_AGENT = "jina-code-review";

export type PullRequestTarget = {
  owner: string;
  repo: string;
  number: number;
};

export type GithubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: {
    id: number;
    login: string;
    type?: string;
  };
};

export type GithubPullRequest = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  user?: {
    login?: string;
  };
  head: {
    sha: string;
    ref: string;
  };
  base: {
    sha?: string;
    ref?: string;
  };
};

export type TriggerPullRequest = {
  repository: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  html_url: string;
  state?: string;
};

export type GithubSession = DashboardSession & { accessToken: string };

export function requireGithubSession(session: DashboardSession | undefined): GithubSession {
  if (!session?.accessToken) {
    throw new ApiError(401, "GitHub dashboard authentication is required");
  }
  return session as GithubSession;
}

function canAccessRepository(session: DashboardSession, fullName: string): boolean {
  const allowed = sessionAccessibleNames(session);
  return Boolean(allowed?.some((name) => name.toLowerCase() === fullName.toLowerCase()));
}

export function parsePullRequestTarget(body: unknown): PullRequestTarget | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const url = stringValue(record.pull_request_url) ?? stringValue(record.url);
  const fromUrl = url ? parsePullRequestUrl(url) : undefined;
  if (fromUrl) {
    return fromUrl;
  }

  const owner = stringValue(record.owner);
  const repo = stringValue(record.repo) ?? stringValue(record.repository);
  const number = numberValue(record.number) ?? numberValue(record.pull_request_number);
  if (!owner || !repo || !number) {
    return undefined;
  }
  return { owner, repo, number };
}

function parsePullRequestUrl(value: string): PullRequestTarget | undefined {
  const trimmed = value.trim();
  const shorthand = trimmed.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (shorthand) {
    return { owner: shorthand[1]!, repo: shorthand[2]!, number: Number(shorthand[3]) };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.hostname !== "github.com") {
    return undefined;
  }
  const [owner, repo, kind, number] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || kind !== "pull" || !number) {
    return undefined;
  }
  const parsedNumber = Number(number);
  return Number.isInteger(parsedNumber) && parsedNumber > 0 ? { owner, repo, number: parsedNumber } : undefined;
}

export async function githubJson<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": GITHUB_USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new ApiError(response.status === 404 ? 404 : 502, `GitHub GET ${path} failed: ${response.status}`, await response.text());
  }
  return (await response.json()) as T;
}

// Resolve a PR target to its repository, pull request, and installation id,
// enforcing dashboard repo access. Callers apply their own extra validation.
export async function resolvePullRequestForTrigger(
  session: GithubSession,
  target: PullRequestTarget,
): Promise<{ repository: GithubRepository; pullRequest: GithubPullRequest; installationId: number }> {
  const fullName = `${target.owner}/${target.repo}`;
  if (!canAccessRepository(session, fullName)) {
    throw new ApiError(403, "pull request repository is not visible to this dashboard session");
  }

  const [repository, pullRequest] = await Promise.all([
    githubJson<GithubRepository>(session.accessToken, `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`),
    githubJson<GithubPullRequest>(
      session.accessToken,
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.number}`,
    ),
  ]);

  const installation = await getInstalledRepositoryForReview({
    fullName: repository.full_name,
    githubRepoId: repository.id,
  });
  if (!installation) {
    throw new ApiError(409, "GitHub App installation for this repository has not been recorded yet");
  }

  return { repository, pullRequest, installationId: installation.githubInstallationId };
}

// The webhook-shaped payload base shared by manual review triggers.
export function buildReviewTriggerPayload(input: {
  session: GithubSession;
  repository: GithubRepository;
  pullRequest: GithubPullRequest;
  installationId: number;
  action: string;
}) {
  return {
    delivery_id: `manual:${input.session.user.id}:${input.repository.id}:${input.pullRequest.number}:${randomUUID()}`,
    source_event: "manual" as const,
    action: input.action,
    github_installation_id: input.installationId,
    repository: {
      github_repo_id: input.repository.id,
      owner: input.repository.owner.login,
      owner_id: input.repository.owner.id,
      owner_type: input.repository.owner.type,
      name: input.repository.name,
      full_name: input.repository.full_name,
      default_branch: input.repository.default_branch,
      private: input.repository.private,
    },
    pull_request: {
      number: input.pullRequest.number,
      title: input.pullRequest.title,
      html_url: input.pullRequest.html_url,
      draft: input.pullRequest.draft ?? false,
      head_sha: input.pullRequest.head.sha,
      base_sha: input.pullRequest.base.sha,
      head_ref: input.pullRequest.head.ref,
      base_ref: input.pullRequest.base.ref,
      author: input.pullRequest.user?.login,
    },
    trigger: "manual" as const,
  };
}

export function toTriggerPullRequest(repository: GithubRepository, pullRequest: GithubPullRequest): TriggerPullRequest {
  return {
    repository: repository.full_name,
    owner: repository.owner.login,
    repo: repository.name,
    number: pullRequest.number,
    title: pullRequest.title,
    html_url: pullRequest.html_url,
    state: pullRequest.state,
  };
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value);
  }
  return undefined;
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : undefined))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}
