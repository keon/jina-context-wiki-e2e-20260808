import { createSign } from "node:crypto";

import { requiredEnv } from "./api.js";
import { errorMessage } from "./utils.js";

export type GitHubRepository = {
  owner: string;
  name: string;
  fullName: string;
};

export type CheckRun = {
  id: number;
  html_url?: string;
};

export type JinaIssueMarker = {
  reviewRunId?: string;
  headSha?: string;
  stage?: "summary" | "static" | "runtime" | string;
  fingerprint?: string;
  blocking?: boolean;
};

export type JinaReviewThread = {
  id: string;
  isResolved: boolean;
  path?: string;
  firstCommentDatabaseId?: number;
  firstCommentUrl?: string;
  marker: JinaIssueMarker;
};

export type Deployment = {
  id: number;
};

export type DeploymentState = "in_progress" | "success" | "failure" | "error" | "inactive";

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

type GitHubIssueLike = {
  number?: number;
  title?: string;
  state?: string;
  user?: {
    login?: string;
  };
  html_url?: string;
  pull_request?: unknown;
};

type GraphqlCommentNode = {
  id?: string;
  databaseId?: number;
  url?: string;
  body?: string;
};

type GraphqlReviewThreadNode = {
  id?: string;
  isResolved?: boolean;
  path?: string;
  comments?: {
    nodes?: Array<GraphqlCommentNode | null> | null;
  } | null;
};

const ISSUE_MARKER_RE = /<!--\s*jina:issue\s+({[\s\S]*?})\s*-->/g;

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

export async function createCheckRun(input: {
  token: string;
  repository: GitHubRepository;
  headSha: string;
  name: string;
  detailsUrl?: string;
}): Promise<CheckRun> {
  return githubJson<CheckRun>({
    token: input.token,
    method: "POST",
    path: `/repos/${input.repository.fullName}/check-runs`,
    body: {
      name: input.name,
      head_sha: input.headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      details_url: input.detailsUrl,
    },
  });
}

export async function completeCheckRun(input: {
  token: string;
  repository: GitHubRepository;
  checkRunId: number;
  conclusion: "success" | "failure" | "neutral" | "action_required";
  title: string;
  summary: string;
  text?: string;
}): Promise<void> {
  await githubJson({
    token: input.token,
    method: "PATCH",
    path: `/repos/${input.repository.fullName}/check-runs/${input.checkRunId}`,
    body: {
      status: "completed",
      conclusion: input.conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: input.title,
        summary: truncate(input.summary, 4_000),
        text: input.text ? truncate(input.text, 60_000) : undefined,
      },
    },
  });
}

export async function listUnresolvedJinaBlockingThreads(input: {
  token: string;
  repository: GitHubRepository;
  pullRequestNumber: number;
}): Promise<JinaReviewThread[]> {
  const blockers: JinaReviewThread[] = [];
  let cursor: string | undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await githubGraphql<{
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: Array<GraphqlReviewThreadNode | null> | null;
            pageInfo?: {
              hasNextPage?: boolean;
              endCursor?: string | null;
            } | null;
          } | null;
        } | null;
      } | null;
    }>(
      input.token,
      `query JinaReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              nodes {
                id
                isResolved
                path
                comments(first: 100) {
                  nodes {
                    id
                    databaseId
                    url
                    body
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }`,
      {
        owner: input.repository.owner,
        name: input.repository.name,
        number: input.pullRequestNumber,
        after: cursor,
      },
    );

    const page = data.repository?.pullRequest?.reviewThreads;
    for (const thread of page?.nodes ?? []) {
      if (!thread?.id || thread.isResolved) {
        continue;
      }
      const comments = (thread.comments?.nodes ?? []).filter((comment): comment is GraphqlCommentNode => Boolean(comment));
      const commentWithMarker = comments.find((comment) => {
        const marker = parseJinaIssueMarker(comment.body);
        return marker?.blocking !== false;
      });
      const marker = parseJinaIssueMarker(commentWithMarker?.body);
      if (!marker || marker.blocking === false) {
        continue;
      }
      blockers.push({
        id: thread.id,
        isResolved: Boolean(thread.isResolved),
        path: thread.path,
        firstCommentDatabaseId: comments[0]?.databaseId,
        firstCommentUrl: comments[0]?.url,
        marker,
      });
    }

    hasNextPage = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor ?? undefined;
    if (hasNextPage && !cursor) {
      throw new Error("GitHub reviewThreads pagination did not include an end cursor");
    }
  }

  return blockers;
}

export async function resolveReviewThread(input: { token: string; threadId: string }): Promise<void> {
  await githubGraphql(
    input.token,
    `mutation ResolveReviewThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }`,
    { threadId: input.threadId },
  );
}

export async function replyToReviewComment(input: {
  token: string;
  repository: GitHubRepository;
  pullRequestNumber: number;
  commentId: number;
  body: string;
}): Promise<void> {
  await githubJson({
    token: input.token,
    method: "POST",
    path: `/repos/${input.repository.fullName}/pulls/${input.pullRequestNumber}/comments/${input.commentId}/replies`,
    body: {
      body: truncate(input.body, 16_000),
    },
  });
}

export async function getCollaboratorPermission(input: {
  token: string;
  repository: GitHubRepository;
  username: string;
}): Promise<string | undefined> {
  const response = await githubJson<{ permission?: string }>({
    token: input.token,
    method: "GET",
    path: `/repos/${input.repository.fullName}/collaborators/${encodeURIComponent(input.username)}/permission`,
  });
  return response.permission;
}

export function parseJinaIssueMarker(body: string | undefined): JinaIssueMarker | undefined {
  if (!body) {
    return undefined;
  }

  ISSUE_MARKER_RE.lastIndex = 0;
  const match = ISSUE_MARKER_RE.exec(body);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const marker = parsed as Record<string, unknown>;
    return {
      reviewRunId: typeof marker.reviewRunId === "string" ? marker.reviewRunId : undefined,
      headSha: typeof marker.headSha === "string" ? marker.headSha : undefined,
      stage: typeof marker.stage === "string" ? marker.stage : undefined,
      fingerprint: typeof marker.fingerprint === "string" ? marker.fingerprint : undefined,
      blocking: typeof marker.blocking === "boolean" ? marker.blocking : undefined,
    };
  } catch {
    return undefined;
  }
}

// Creates a GitHub Deployment, which renders in the PR timeline as a
// "deployed to <environment>" event (like the Vercel preview event). This is a
// status surface for the review run, not a real deploy: required_contexts is
// empty so it never waits on other checks, and the environment is transient.
export async function createDeployment(input: {
  token: string;
  repository: GitHubRepository;
  ref: string;
  environment: string;
  description?: string;
}): Promise<Deployment> {
  return githubJson<Deployment>({
    token: input.token,
    method: "POST",
    path: `/repos/${input.repository.fullName}/deployments`,
    body: {
      ref: input.ref,
      environment: input.environment,
      required_contexts: [],
      auto_merge: false,
      transient_environment: true,
      description: input.description ? input.description.slice(0, 140) : undefined,
    },
  });
}

// Posts a status to a deployment, driving the timeline event's state and the
// "View deployment" link (environment_url).
export async function createDeploymentStatus(input: {
  token: string;
  repository: GitHubRepository;
  deploymentId: number;
  state: DeploymentState;
  environmentUrl?: string;
  logUrl?: string;
  description?: string;
}): Promise<void> {
  await githubJson({
    token: input.token,
    method: "POST",
    path: `/repos/${input.repository.fullName}/deployments/${input.deploymentId}/statuses`,
    body: {
      state: input.state,
      environment_url: input.environmentUrl,
      log_url: input.logUrl,
      description: input.description ? input.description.slice(0, 140) : undefined,
    },
  });
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

export async function recentRepositoryHistory(input: {
  token: string;
  repository: GitHubRepository;
}): Promise<string> {
  const [pulls, issues] = await Promise.all([
    githubJson<GitHubIssueLike[]>({
      token: input.token,
      method: "GET",
      path: `/repos/${input.repository.fullName}/pulls?state=all&sort=updated&direction=desc&per_page=8`,
    }).catch((error: unknown) => [`Unable to load recent pull requests: ${errorMessage(error)}`]),
    githubJson<GitHubIssueLike[]>({
      token: input.token,
      method: "GET",
      path: `/repos/${input.repository.fullName}/issues?state=all&sort=updated&direction=desc&per_page=8`,
    })
      .then((items) => items.filter((item) => !item.pull_request))
      .catch((error: unknown) => [`Unable to load recent issues: ${errorMessage(error)}`]),
  ]);

  return [
    "Recent pull requests:",
    ...formatHistoryItems(pulls),
    "",
    "Recent issues:",
    ...formatHistoryItems(issues),
  ].join("\n");
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

async function githubGraphql<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json().catch(() => undefined)) as { data?: T; errors?: unknown } | undefined;

  if (!response.ok || body?.errors) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${JSON.stringify(body?.errors ?? body)}`);
  }
  if (!body || body.data === undefined) {
    throw new Error("GitHub GraphQL response did not include data");
  }
  return body.data;
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

function formatHistoryItems(items: Array<GitHubIssueLike | string>): string[] {
  if (items.length === 0) {
    return ["- None found."];
  }

  return items.map((item) => {
    if (typeof item === "string") {
      return `- ${item}`;
    }

    return `- #${item.number ?? "?"} ${item.state ?? "unknown"}: ${item.title ?? "Untitled"} by ${
      item.user?.login ?? "unknown"
    }`;
  });
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 40)}\n\n[Truncated by Jina Simulation]`;
}
