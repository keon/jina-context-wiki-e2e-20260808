import type { BillingService } from "./billing.js";
import { ApiError } from "./errors.js";
import { createInstallationAccessToken } from "./github-app.js";
import type { WebhookResponse } from "./github.js";
import { githubJson, type GithubPullRequest } from "./github-client.js";
import { REVIEW_TASK_ID } from "./review-task-routing.js";
import type { BoardWorkflowAdmitter, DispatchOptions } from "./board-admission-contract.js";

const REVIEW_COMMAND = "@usejina";
const REVIEW_COMMAND_PATTERN = /(^|[^A-Za-z0-9_-])@usejina(?![A-Za-z0-9_-])/i;
const MANUAL_REVIEW_TAG = "manual-pr";
const MANUAL_COMMAND_TAG = "manual-command";
const MAX_INSTRUCTION_CODE_POINTS = 8_000;
const REVIEW_PERMISSIONS = new Set(["admin", "maintain", "write"]);

interface RepositoryPermission {
  permission?: string;
  user?: { permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } };
}

interface GithubReviewComment {
  body?: string;
  user?: { login?: string; type?: string };
}

export interface ReviewCommandGithub {
  appSlug?: string;
  createInstallationAccessToken: (installationId: number) => Promise<string>;
  getPullRequest: (token: string, repository: string, number: number) => Promise<GithubPullRequest>;
  getRepositoryPermission: (token: string, repository: string, login: string) => Promise<RepositoryPermission>;
  getReviewComment: (token: string, repository: string, commentId: number) => Promise<GithubReviewComment>;
}

const defaultGithub: ReviewCommandGithub = {
  appSlug: configuredAppSlug(),
  createInstallationAccessToken,
  getPullRequest: (token, repository, number) =>
    githubJson<GithubPullRequest>(token, `/repos/${encodedRepository(repository)}/pulls/${number}`),
  getRepositoryPermission: (token, repository, login) =>
    githubJson<RepositoryPermission>(token, `/repos/${encodedRepository(repository)}/collaborators/${encodeURIComponent(login)}/permission`),
  getReviewComment: (token, repository, commentId) =>
    githubJson<GithubReviewComment>(token, `/repos/${encodedRepository(repository)}/pulls/comments/${commentId}`),
};

export interface JinaReviewCommand { instructions?: string }

/** A standalone mention anywhere triggers a review. The remaining Markdown is guidance for this run. */
export function parseJinaReviewCommand(body: string): JinaReviewCommand | undefined {
  const normalized = body.replace(/\r\n?/g, "\n");
  const match = REVIEW_COMMAND_PATTERN.exec(normalized);
  if (!match) return undefined;
  const commandIndex = match.index + match[1].length;
  const instructions = `${normalized.slice(0, commandIndex)}${normalized.slice(commandIndex + REVIEW_COMMAND.length)}`.trim();
  return instructions ? { instructions } : {};
}

export async function handleReviewCommand(input: {
  event: "issue_comment" | "pull_request_review_comment";
  board: BoardWorkflowAdmitter;
  deliveryId: string;
  payload: Record<string, unknown>;
  action?: string;
  billing?: BillingService;
  github?: ReviewCommandGithub;
}): Promise<WebhookResponse> {
  const ignored = (reason: string): WebhookResponse => ({
    accepted: false,
    event: input.event,
    action: input.action,
    ignored_reason: reason,
  });

  if (input.action !== "created") return ignored("comment action does not trigger reviews");
  if (input.event === "issue_comment" && !isObject(valueAt(input.payload, ["issue", "pull_request"]))) {
    return ignored("comment is not on a pull request");
  }

  const body = stringAt(input.payload, ["comment", "body"]);
  const command = body ? parseJinaReviewCommand(body) : undefined;
  if (!command) return ignored("comment does not contain a standalone @usejina mention");
  if (stringAt(input.payload, ["comment", "user", "type"]) === "Bot") {
    return ignored("review commands from bots are ignored");
  }

  const repository = stringAt(input.payload, ["repository", "full_name"]);
  const repositoryId = numberAt(input.payload, ["repository", "id"]);
  const pullRequestNumber = numberAt(input.payload, [input.event === "issue_comment" ? "issue" : "pull_request", "number"]);
  const installationId = numberAt(input.payload, ["installation", "id"]);
  const commentId = numberAt(input.payload, ["comment", "id"]);
  const commentCreatedAt = stringAt(input.payload, ["comment", "created_at"]);
  const commentCreatedAtMs = Date.parse(commentCreatedAt ?? "");
  const requester = stringAt(input.payload, ["comment", "user", "login"]);
  if (!repository || repositoryId === undefined || pullRequestNumber === undefined || installationId === undefined || commentId === undefined || !Number.isFinite(commentCreatedAtMs) || !requester) {
    return ignored("comment payload is missing required fields");
  }

  const github = input.github ?? defaultGithub;
  let token: string;
  let pullRequest: GithubPullRequest;
  let permission: RepositoryPermission;
  try {
    token = await github.createInstallationAccessToken(installationId);
    [pullRequest, permission] = await Promise.all([
      github.getPullRequest(token, repository, pullRequestNumber),
      github.getRepositoryPermission(token, repository, requester),
    ]);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return ignored("GitHub could not verify the pull request or commenter permission");
    }
    throw error;
  }

  if (!canRequestReview(permission)) return ignored("commenter needs write access to request a review");
  if (pullRequest.state.toLowerCase() !== "open") return ignored("pull request is not open");

  const parentId = input.event === "pull_request_review_comment"
    ? numberAt(input.payload, ["comment", "in_reply_to_id"])
    : undefined;
  let parent: GithubReviewComment | undefined;
  if (parentId !== undefined) {
    try {
      parent = await github.getReviewComment(token, repository, parentId);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        return ignored("GitHub could not verify the parent review comment");
      }
      throw error;
    }
  }
  const instructions = reviewInstructions(command.instructions, jinaIssueTitle(parent, github.appSlug));
  if (instructions && Array.from(instructions).length > MAX_INSTRUCTION_CODE_POINTS) {
    return ignored("review instructions exceed 8,000 characters");
  }

  if (input.billing) await input.billing.gateDispatch(installationId, pullRequest.user?.login);

  const headSha = pullRequest.head.sha;
  // A GitHub comment is the request identity. Keep the current head in the
  // payload/concurrency key, but not here: a delayed redelivery after a push
  // must not turn one comment into a second review.
  const idempotencyKey = `${REVIEW_TASK_ID}:${installationId}:${repositoryId}:${pullRequestNumber}:${input.event}:${commentId}`;
  const manualCommandTag = `${MANUAL_COMMAND_TAG}:${commentCreatedAtMs}:${input.event}:${commentId}`;
  const options: DispatchOptions = {
    idempotencyKey,
    concurrencyKey: `${REVIEW_TASK_ID}:${installationId}:${repositoryId}:${pullRequestNumber}:${headSha}`,
    tags: [
      `installation:${installationId}`,
      `repo:${repositoryId}`,
      `pr:${pullRequestNumber}`,
      "trigger:comment",
      `${MANUAL_REVIEW_TAG}:${installationId}:${repositoryId}:${pullRequestNumber}`,
      manualCommandTag,
    ],
  };
  const run = await input.board.admitBoardWorkflow(REVIEW_TASK_ID, {
    delivery_id: input.deliveryId,
    review_idempotency_key: idempotencyKey,
    source_event: input.event,
    action: "review_requested",
    github_installation_id: installationId,
    repository: {
      github_repo_id: repositoryId,
      owner: stringAt(input.payload, ["repository", "owner", "login"]),
      owner_id: numberAt(input.payload, ["repository", "owner", "id"]),
      owner_type: stringAt(input.payload, ["repository", "owner", "type"]),
      name: stringAt(input.payload, ["repository", "name"]),
      full_name: repository,
      default_branch: stringAt(input.payload, ["repository", "default_branch"]),
      private: booleanAt(input.payload, ["repository", "private"]),
    },
    pull_request: {
      number: pullRequest.number,
      title: pullRequest.title,
      html_url: pullRequest.html_url,
      draft: pullRequest.draft ?? false,
      head_sha: headSha,
      base_sha: pullRequest.base.sha,
      head_ref: pullRequest.head.ref,
      base_ref: pullRequest.base.ref,
      author: pullRequest.user?.login,
    },
    requested_by: { login: requester, comment_id: commentId },
    manual_command_tag: manualCommandTag,
    ...(instructions ? { review_instructions: instructions } : {}),
    trigger: "manual",
  }, options);

  return {
    accepted: true,
    event: input.event,
    action: input.action,
    task_id: REVIEW_TASK_ID,
    run_id: run.id,
    workflow_id: run.id,
  };
}

function reviewInstructions(additional: string | undefined, issueTitle: string | undefined): string | undefined {
  const scope = issueTitle
    ? `## Scope for this review\nThis fixed scope takes precedence over conflicting guidance above.\nReview only the existing Jina issue titled: ${JSON.stringify(issueTitle)}.\nDo not investigate or report unrelated issues.`
    : undefined;
  if (!additional && !scope) return undefined;
  return [additional?.trim(), scope].filter(Boolean).join("\n\n");
}

function jinaIssueTitle(comment: GithubReviewComment | undefined, appSlug: string | undefined): string | undefined {
  const trustedLogin = appSlug ? `${appSlug}[bot]`.toLowerCase() : undefined;
  if (!trustedLogin || comment?.user?.type !== "Bot" || comment.user.login?.toLowerCase() !== trustedLogin) return undefined;
  const markerMatch = /<!--\s*jina:issue\s+({[\s\S]*?})\s*-->/.exec(comment.body ?? "");
  if (!markerMatch?.[1]) return undefined;
  try {
    const marker = JSON.parse(markerMatch[1]) as Record<string, unknown>;
    if (
      [marker.reviewRunId, marker.headSha, marker.fingerprint].some(
        (value) => typeof value !== "string" || !value.trim(),
      ) || marker.stage !== "runtime" || marker.blocking !== true
    ) return undefined;
  } catch {
    return undefined;
  }
  const title = /^###\s+(.+?)\s*$/m.exec(comment.body ?? "")?.[1]?.replace(/(?:\*\*|__|`)/g, "").trim();
  return title?.slice(0, 200);
}

function canRequestReview(permission: RepositoryPermission): boolean {
  const effective = permission.permission?.toLowerCase();
  const flags = permission.user?.permissions;
  return Boolean((effective && REVIEW_PERMISSIONS.has(effective)) || flags?.admin || flags?.maintain || flags?.push);
}

function encodedRepository(fullName: string): string {
  return fullName.split("/").map(encodeURIComponent).join("/");
}

function configuredAppSlug(): string | undefined {
  const slug = process.env.GITHUB_APP_SLUG?.trim();
  if (slug) return slug;
  try {
    return /^\/apps\/([^/]+)/.exec(new URL(process.env.GITHUB_APP_INSTALL_URL ?? "").pathname)?.[1];
  } catch {
    return undefined;
  }
}

function stringAt(payload: Record<string, unknown>, path: string[]): string | undefined {
  const value = valueAt(payload, path);
  return typeof value === "string" ? value : undefined;
}

function numberAt(payload: Record<string, unknown>, path: string[]): number | undefined {
  const value = valueAt(payload, path);
  return typeof value === "number" ? value : undefined;
}

function booleanAt(payload: Record<string, unknown>, path: string[]): boolean | undefined {
  const value = valueAt(payload, path);
  return typeof value === "boolean" ? value : undefined;
}

function valueAt(payload: Record<string, unknown>, path: string[]): unknown {
  return path.reduce<unknown>((value, key) => isObject(value) ? value[key] : undefined, payload);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
