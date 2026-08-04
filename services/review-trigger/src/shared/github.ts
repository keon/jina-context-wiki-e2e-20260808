import { createSign } from "node:crypto";

import { requiredEnv } from "./api.js";

export type GitHubRepository = {
  owner: string;
  name: string;
  fullName: string;
};

export type InstallationAccessToken = {
  token: string;
  permissions: Record<string, string>;
};

export type RepositoryAccessProbe = {
  ok: boolean;
  status: number;
  message?: string;
  full_name?: string;
  private?: boolean;
  default_branch?: string;
};

export type IssueComment = {
  id: number;
  html_url?: string;
  body?: string;
};

export type PullRequestReview = {
  id: number;
  html_url?: string;
  body?: string;
  state?: string;
  commit_id?: string;
};

export type PullRequestReviewCommentInput = {
  path: string;
  body: string;
  line: number;
  side: "RIGHT" | "LEFT";
};

export type PullRequestState = {
  state?: string;
  merged?: boolean;
  draft?: boolean;
  html_url?: string;
  head?: {
    sha?: string;
    ref?: string;
  };
  base?: {
    sha?: string;
    ref?: string;
  };
};

export function parseRepository(fullName: string | undefined): GitHubRepository {
  const [owner, name, extra] = (fullName ?? "").split("/");
  if (!owner || !name || extra) {
    throw new Error(`Invalid GitHub repository name: ${fullName ?? "<missing>"}`);
  }

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
  };
}

export async function createInstallationAccessToken(installationId: number): Promise<string> {
  return (await createInstallationAccessTokenDetails(installationId)).token;
}

export async function createInstallationAccessTokenDetails(installationId: number): Promise<InstallationAccessToken> {
  const jwt = createAppJwt();
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(jwt),
  });

  if (!response.ok) {
    throw new Error(`GitHub installation token request failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { token?: string; permissions?: Record<string, string> };
  if (!body.token) {
    throw new Error("GitHub installation token response did not include a token");
  }

  return {
    token: body.token,
    permissions: body.permissions ?? {},
  };
}

export async function probeRepositoryAccess(input: {
  token: string;
  repository: GitHubRepository;
}): Promise<RepositoryAccessProbe> {
  const response = await fetch(`https://api.github.com/repos/${input.repository.fullName}`, {
    method: "GET",
    headers: githubHeaders(input.token),
  });
  const text = await response.text();
  let body: Record<string, unknown> | undefined;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    body = undefined;
  }

  return {
    ok: response.ok,
    status: response.status,
    message: typeof body?.message === "string" ? body.message : response.ok ? undefined : text.slice(0, 300),
    full_name: typeof body?.full_name === "string" ? body.full_name : undefined,
    private: typeof body?.private === "boolean" ? body.private : undefined,
    default_branch: typeof body?.default_branch === "string" ? body.default_branch : undefined,
  };
}

export async function createIssueComment(input: {
  token: string;
  repository: GitHubRepository;
  issueNumber: number;
  body: string;
}): Promise<IssueComment> {
  return githubJson<IssueComment>({
    token: input.token,
    method: "POST",
    path: `/repos/${input.repository.fullName}/issues/${input.issueNumber}/comments`,
    body: {
      body: truncate(input.body, 60_000),
    },
  });
}

export async function listIssueComments(input: {
  token: string;
  repository: GitHubRepository;
  issueNumber: number;
}): Promise<IssueComment[]> {
  return githubPaginatedJson<IssueComment>({
    token: input.token,
    path: `/repos/${input.repository.fullName}/issues/${input.issueNumber}/comments`,
  });
}

export async function updateIssueComment(input: {
  token: string;
  repository: GitHubRepository;
  commentId: number;
  body: string;
}): Promise<IssueComment> {
  return githubJson<IssueComment>({
    token: input.token,
    method: "PATCH",
    path: `/repos/${input.repository.fullName}/issues/comments/${input.commentId}`,
    body: {
      body: truncate(input.body, 60_000),
    },
  });
}

// A pull request *review* comment (anchored to a file/line in the diff), as
// opposed to a top-level issue comment. Review comments support threads via
// in_reply_to_id, which is what lets a user "reply to the bot" without an @jina
// mention — see the pull_request_review_comment webhook handler in the API.
export type ReviewComment = {
  id: number;
  html_url?: string;
  body?: string;
  path?: string;
  in_reply_to_id?: number;
};

// File-level review comment (subject_type "file"), so it does not need a precise
// diff line — only that `path` is part of the PR's diff at `commitId`.
export async function createReviewComment(input: {
  token: string;
  repository: GitHubRepository;
  pullRequestNumber: number;
  commitId: string;
  path: string;
  body: string;
}): Promise<ReviewComment> {
  return githubJson<ReviewComment>({
    token: input.token,
    method: "POST",
    path: `/repos/${input.repository.fullName}/pulls/${input.pullRequestNumber}/comments`,
    body: {
      body: truncate(input.body, 60_000),
      commit_id: input.commitId,
      path: input.path,
      subject_type: "file",
    },
  });
}

export async function createPullRequestReview(input: {
  token: string;
  repository: GitHubRepository;
  pullRequestNumber: number;
  body: string;
  comments: PullRequestReviewCommentInput[];
}): Promise<PullRequestReview> {
  return githubJson<PullRequestReview>({
    token: input.token,
    method: "POST",
    path: `/repos/${input.repository.fullName}/pulls/${input.pullRequestNumber}/reviews`,
    body: {
      event: "COMMENT",
      body: truncate(input.body, 60_000),
      ...(input.comments.length > 0
        ? {
            comments: input.comments.map((comment) => ({
              path: comment.path,
              body: truncate(comment.body, 16_000),
              line: comment.line,
              side: comment.side,
            })),
          }
        : {}),
    },
  });
}

export async function listReviewComments(input: {
  token: string;
  repository: GitHubRepository;
  pullRequestNumber: number;
}): Promise<ReviewComment[]> {
  return githubPaginatedJson<ReviewComment>({
    token: input.token,
    path: `/repos/${input.repository.fullName}/pulls/${input.pullRequestNumber}/comments`,
  });
}

export async function listPullRequestReviews(input: {
  token: string;
  repository: GitHubRepository;
  pullRequestNumber: number;
}): Promise<PullRequestReview[]> {
  return githubPaginatedJson<PullRequestReview>({
    token: input.token,
    path: `/repos/${input.repository.fullName}/pulls/${input.pullRequestNumber}/reviews`,
  });
}

export async function getPullRequestState(input: {
  token: string;
  repository: GitHubRepository;
  pullRequestNumber: number;
}): Promise<PullRequestState> {
  return githubJson<PullRequestState>({
    token: input.token,
    method: "GET",
    path: `/repos/${input.repository.fullName}/pulls/${input.pullRequestNumber}`,
  });
}

function createAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 540,
      iss: requiredEnv("GITHUB_APP_ID"),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(requiredEnv("GITHUB_APP_PRIVATE_KEY"));

  return `${signingInput}.${base64Url(signature)}`;
}

async function githubJson<T = unknown>(input: {
  token: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`https://api.github.com${input.path}`, {
    method: input.method,
    headers: githubHeaders(input.token),
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

  if (!response.ok) {
    throw new Error(`GitHub ${input.method} ${input.path} failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
}

async function githubPaginatedJson<T>(input: {
  token: string;
  path: string;
}): Promise<T[]> {
  const records: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = input.path.includes("?") ? "&" : "?";
    const batch = await githubJson<T[]>({
      token: input.token,
      method: "GET",
      path: `${input.path}${separator}per_page=100&page=${page}`,
    });
    records.push(...batch);
    if (batch.length < 100) {
      return records;
    }
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    "accept": "application/vnd.github+json",
    "authorization": token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "jina-code-review",
    "x-github-api-version": "2022-11-28",
  };
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 40)}\n\n[Truncated by Jina]`;
}
