import { ApiError } from "./errors.js";

const GITHUB_API = "https://api.github.com";
const ISSUE_MARKER_RE = /<!--\s*jina:issue\s+({[\s\S]*?})\s*-->/g;

export type GithubRepositoryRef = {
  owner: string;
  name: string;
  fullName: string;
};

export type CheckRunAction = {
  label: string;
  description: string;
  identifier: string;
};

export type GithubCheckRun = {
  id: number;
  name: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  };
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

export function jinaIssueMarker(input: {
  reviewRunId?: string;
  headSha: string;
  stage: "summary" | "static" | "runtime";
  fingerprint?: string;
  blocking?: boolean;
}): string {
  return `<!-- jina:issue ${JSON.stringify({
    reviewRunId: input.reviewRunId,
    headSha: input.headSha,
    stage: input.stage,
    fingerprint: input.fingerprint,
    blocking: input.blocking ?? true,
  })} -->`;
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

export async function listCheckRunsForHead(input: {
  token: string;
  repository: GithubRepositoryRef;
  headSha: string;
  name: string;
}): Promise<GithubCheckRun[]> {
  const response = await githubRest<{ check_runs?: GithubCheckRun[] }>({
    token: input.token,
    method: "GET",
    path: `/repos/${input.repository.fullName}/commits/${input.headSha}/check-runs?check_name=${encodeURIComponent(input.name)}&per_page=100`,
  });
  return response.check_runs ?? [];
}

export async function createJinaCheckRun(input: {
  token: string;
  repository: GithubRepositoryRef;
  headSha: string;
  name: string;
  detailsUrl?: string;
  output: { title: string; summary: string; text?: string };
  actions?: CheckRunAction[];
}): Promise<GithubCheckRun> {
  return githubRest<GithubCheckRun>({
    token: input.token,
    method: "POST",
    path: `/repos/${input.repository.fullName}/check-runs`,
    body: {
      name: input.name,
      head_sha: input.headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      details_url: input.detailsUrl,
      output: checkOutput(input.output),
      actions: input.actions ?? [],
    },
  });
}

export async function updateJinaCheckRun(input: {
  token: string;
  repository: GithubRepositoryRef;
  checkRunId: number;
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure";
  output: { title: string; summary: string; text?: string };
  actions?: CheckRunAction[];
}): Promise<GithubCheckRun> {
  return githubRest<GithubCheckRun>({
    token: input.token,
    method: "PATCH",
    path: `/repos/${input.repository.fullName}/check-runs/${input.checkRunId}`,
    body: {
      status: input.status,
      conclusion: input.status === "completed" ? input.conclusion : undefined,
      completed_at: input.status === "completed" ? new Date().toISOString() : undefined,
      output: checkOutput(input.output),
      actions: input.actions ?? [],
    },
  });
}

export async function listUnresolvedJinaBlockingThreads(input: {
  token: string;
  repository: GithubRepositoryRef;
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
      throw new ApiError(502, "GitHub reviewThreads pagination did not include an end cursor");
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
  repository: GithubRepositoryRef;
  pullRequestNumber: number;
  commentId: number;
  body: string;
}): Promise<void> {
  await githubRest({
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
  repository: GithubRepositoryRef;
  username: string;
}): Promise<string | undefined> {
  const response = await githubRest<{ permission?: string }>({
    token: input.token,
    method: "GET",
    path: `/repos/${input.repository.fullName}/collaborators/${encodeURIComponent(input.username)}/permission`,
  });
  return response.permission;
}

async function githubRest<T = unknown>(input: {
  token: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`${GITHUB_API}${input.path}`, {
    method: input.method,
    headers: githubHeaders(input.token),
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

  if (!response.ok) {
    throw new ApiError(502, `GitHub ${input.method} ${input.path} failed: ${response.status}`, await response.text());
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function githubGraphql<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json().catch(() => undefined)) as { data?: T; errors?: unknown } | undefined;

  if (!response.ok || body?.errors) {
    throw new ApiError(502, `GitHub GraphQL request failed: ${response.status}`, body?.errors ?? body);
  }
  if (!body || body.data === undefined) {
    throw new ApiError(502, "GitHub GraphQL response did not include data");
  }
  return body.data;
}

function githubHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "jina-code-review",
    "x-github-api-version": "2022-11-28",
  };
}

function checkOutput(output: { title: string; summary: string; text?: string }): Record<string, string | undefined> {
  return {
    title: truncate(output.title, 255),
    summary: truncate(output.summary, 4_000),
    text: output.text ? truncate(output.text, 60_000) : undefined,
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 40))}\n\n[Truncated by Jina Simulation]`;
}
