type JsonRecord = Record<string, unknown>;

const FORBIDDEN_OPERATIONAL_KEYS =
  /^(?:authorization|clone_url|git_url|ssh_url|svn_url|temp_clone_token|.*(?:^|_)(?:access_token|client_secret|credential|password|private_key|secret|token)(?:_|$).*)$/i;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function actor(value: unknown): JsonRecord | null {
  const source = record(value);
  return source && typeof source.login === "string"
    ? {
        login: source.login,
        ...(typeof source.id === "number" ? { id: source.id } : {}),
        ...(typeof source.type === "string" ? { type: source.type } : {})
      }
    : null;
}

function labels(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [{ name: item }];
    const source = record(item);
    if (!source || typeof source.name !== "string") return [];
    return [
      {
        name: source.name,
        ...(typeof source.color === "string" ? { color: source.color } : {})
      }
    ];
  });
}

function milestone(value: unknown): JsonRecord | null {
  const source = record(value);
  return source && typeof source.title === "string"
    ? {
        title: source.title,
        ...(typeof source.number === "number" ? { number: source.number } : {}),
        ...(typeof source.state === "string" ? { state: source.state } : {})
      }
    : null;
}

function branch(value: unknown): JsonRecord | null {
  const source = record(value);
  const repository = record(source?.repo);
  if (!source) return null;
  return {
    ref: source.ref,
    sha: source.sha,
    repository: repository?.full_name
  };
}

function safeGitHubHtmlUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === ""
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function publicUrl(value: JsonRecord): JsonRecord {
  const htmlUrl = safeGitHubHtmlUrl(value.html_url);
  return htmlUrl ? { html_url: htmlUrl } : {};
}

/**
 * GitHub REST responses contain operational fields that are not repository
 * evidence, including short-lived clone credentials. Persist only the bounded
 * metadata that Context research can cite; never serialize the raw response.
 */
export function sanitizeGitHubRepositoryPayload(value: unknown): JsonRecord {
  const source = record(value) ?? {};
  const owner = actor(source.owner);
  const license = record(source.license);
  return {
    id: source.id,
    full_name: source.full_name,
    name: source.name,
    owner,
    description: source.description,
    private: source.private,
    fork: source.fork,
    visibility: source.visibility,
    archived: source.archived,
    disabled: source.disabled,
    default_branch: source.default_branch,
    language: source.language,
    size: source.size,
    open_issues_count: source.open_issues_count,
    stargazers_count: source.stargazers_count,
    forks_count: source.forks_count,
    topics: Array.isArray(source.topics) ? source.topics.filter((item) => typeof item === "string") : [],
    license:
      license && typeof license.spdx_id === "string"
        ? {
            spdx_id: license.spdx_id,
            ...(typeof license.name === "string" ? { name: license.name } : {})
          }
        : null,
    created_at: source.created_at,
    updated_at: source.updated_at,
    pushed_at: source.pushed_at,
    ...publicUrl(source)
  };
}

export function sanitizeGitHubIssuePayload(value: unknown): JsonRecord {
  const source = record(value) ?? {};
  return {
    number: source.number,
    title: source.title,
    body: source.body,
    state: source.state,
    state_reason: source.state_reason,
    locked: source.locked,
    user: actor(source.user),
    assignee: actor(source.assignee),
    assignees: Array.isArray(source.assignees) ? source.assignees.map(actor).filter(Boolean) : [],
    labels: labels(source.labels),
    milestone: milestone(source.milestone),
    comments: source.comments,
    created_at: source.created_at,
    updated_at: source.updated_at,
    closed_at: source.closed_at,
    closed_by: actor(source.closed_by),
    ...publicUrl(source)
  };
}

export function sanitizeGitHubPullRequestPayload(value: unknown): JsonRecord {
  const source = record(value) ?? {};
  return {
    number: source.number,
    title: source.title,
    body: source.body,
    state: source.state,
    draft: source.draft,
    locked: source.locked,
    merged: source.merged,
    mergeable_state: source.mergeable_state,
    user: actor(source.user),
    assignee: actor(source.assignee),
    assignees: Array.isArray(source.assignees) ? source.assignees.map(actor).filter(Boolean) : [],
    requested_reviewers: Array.isArray(source.requested_reviewers)
      ? source.requested_reviewers.map(actor).filter(Boolean)
      : [],
    labels: labels(source.labels),
    milestone: milestone(source.milestone),
    head: branch(source.head),
    base: branch(source.base),
    merge_commit_sha: source.merge_commit_sha,
    commits: source.commits,
    additions: source.additions,
    deletions: source.deletions,
    changed_files: source.changed_files,
    comments: source.comments,
    review_comments: source.review_comments,
    created_at: source.created_at,
    updated_at: source.updated_at,
    closed_at: source.closed_at,
    merged_at: source.merged_at,
    ...publicUrl(source)
  };
}

export function sanitizeGitHubIssueCommentPayload(value: unknown): JsonRecord {
  const source = record(value) ?? {};
  return {
    id: source.id,
    body: source.body,
    user: actor(source.user),
    created_at: source.created_at,
    updated_at: source.updated_at,
    ...publicUrl(source)
  };
}

export function sanitizeGitHubReviewCommentPayload(value: unknown): JsonRecord {
  const source = record(value) ?? {};
  return {
    id: source.id,
    body: source.body,
    user: actor(source.user),
    path: source.path,
    diff_hunk: source.diff_hunk,
    commit_id: source.commit_id,
    original_commit_id: source.original_commit_id,
    position: source.position,
    original_position: source.original_position,
    line: source.line,
    original_line: source.original_line,
    side: source.side,
    start_line: source.start_line,
    original_start_line: source.original_start_line,
    start_side: source.start_side,
    in_reply_to_id: source.in_reply_to_id,
    subject_type: source.subject_type,
    created_at: source.created_at,
    updated_at: source.updated_at,
    ...publicUrl(source)
  };
}

export function sanitizeGitHubCommitCommentPayload(value: unknown): JsonRecord {
  const source = record(value) ?? {};
  return {
    id: source.id,
    body: source.body,
    user: actor(source.user),
    commit_id: source.commit_id,
    path: source.path,
    line: source.line,
    position: source.position,
    created_at: source.created_at,
    updated_at: source.updated_at,
    ...publicUrl(source)
  };
}

/**
 * Defense in depth for future provider endpoints: allowlists are the primary
 * boundary, and this recursive assertion prevents a newly added payload from
 * silently restoring an operational GitHub credential field.
 */
export function assertNoGitHubOperationalCredentials(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const source = record(candidate);
    if (!source) return;
    for (const [key, nested] of Object.entries(source)) {
      if (FORBIDDEN_OPERATIONAL_KEYS.test(key)) {
        throw new Error(`sanitized GitHub provider payload retained forbidden operational field ${key}`);
      }
      visit(nested);
    }
  };
  visit(value);
}
