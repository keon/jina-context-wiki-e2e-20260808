import { createIssueComment, listIssueComments, updateIssueComment, type GitHubRepository } from "../shared/github.js";
import { postReviewEvent, reviewRunUrl, type ReviewStagePayload, type ReviewStageResult } from "./workflow.js";
import { errorMessage } from "../shared/utils.js";
import { logger } from "../shared/logger.js";

type ReviewProgressStatus = "Queued" | "In progress" | "Completed" | "Skipped" | "Blocked";
type ReviewFindingsStatus = "Pending" | "Issues found" | "No issues found" | "Unavailable" | "Insufficient credits";

type ReviewProgressNotice = {
  kind: "provider_failure";
  category: "quota" | "authentication" | "model" | "availability";
  provider: "codex" | "byok";
  quotaReason?: "exhausted" | "rate_limit";
};

export type ReviewProgressCommentState = {
  v: 1;
  reviewRunId: string;
  headSha: string;
  status: ReviewProgressStatus;
  findings: ReviewFindingsStatus;
  notice?: ReviewProgressNotice;
};

export type ReviewProgressUpdate = {
  reviewRunId: string;
  headSha: string;
  status?: ReviewProgressStatus;
  findings?: ReviewFindingsStatus;
  notice?: ReviewProgressNotice;
};

const SUMMARY_MARKER_PREFIX = "jina:review-summary";
const PROGRESS_STATE_MARKER = "jina:review-progress";
const PROGRESS_STATE_RE = /<!--\s*jina:review-progress\s+({[\s\S]*?})\s*-->/;

export function reviewProgressCommentMarker(headSha: string, reviewRunId: string): string {
  return `<!-- ${SUMMARY_MARKER_PREFIX}:${headSha}:${reviewRunId} -->`;
}

export function initialReviewProgressState(reviewRunId: string, headSha: string): ReviewProgressCommentState {
  return {
    v: 1,
    reviewRunId,
    headSha,
    status: "Queued",
    findings: "Pending"
  };
}

export function parseReviewProgressCommentState(body: string | undefined): ReviewProgressCommentState | undefined {
  const match = body?.match(PROGRESS_STATE_RE);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const state = parsed as Record<string, unknown>;
    const reviewRunId = typeof state.reviewRunId === "string" ? state.reviewRunId : undefined;
    const headSha = typeof state.headSha === "string" ? state.headSha : undefined;
    const status = reviewProgressStatus(state.status);
    const findings = reviewFindingsStatus(state.findings);
    const notice = reviewProgressNotice(state.notice);
    if (!reviewRunId || !headSha || !status || !findings) {
      return undefined;
    }

    return {
      v: 1,
      reviewRunId,
      headSha,
      status,
      findings,
      ...(notice ? { notice } : {})
    };
  } catch {
    return undefined;
  }
}

export function mergeReviewProgressState(
  existing: ReviewProgressCommentState | undefined,
  update: ReviewProgressUpdate
): ReviewProgressCommentState {
  const current = existing?.reviewRunId === update.reviewRunId ? existing : undefined;
  const terminalDowngrade =
    current && isTerminalStatus(current.status) && (!update.status || !isTerminalStatus(update.status));
  return {
    ...(current ?? initialReviewProgressState(update.reviewRunId, update.headSha)),
    reviewRunId: update.reviewRunId,
    headSha: update.headSha,
    status: terminalDowngrade ? current.status : (update.status ?? current?.status ?? "Queued"),
    findings: terminalDowngrade ? current.findings : (update.findings ?? current?.findings ?? "Pending"),
    ...((update.notice ?? current?.notice) ? { notice: update.notice ?? current?.notice } : {})
  };
}

export function renderReviewProgressComment(state: ReviewProgressCommentState): string {
  const lines = [
    reviewProgressCommentMarker(state.headSha, state.reviewRunId),
    renderProgressStateMarker(state),
    "## Jina Review",
    "",
    statusMessage(state),
    ""
  ];
  const dashboardUrl = isTerminalStatus(state.status) ? reviewRunUrl(state.reviewRunId) : undefined;
  if (dashboardUrl) {
    lines.push(`Review: ${dashboardUrl}`, "");
  }
  if (state.notice) {
    lines.push(...providerFailureNotice(state.notice), "");
  }
  lines.push("| Item | Status |", "| --- | --- |", `| Review | ${state.status} |`, `| Findings | ${state.findings} |`);
  return lines.join("\n").trim();
}

export function reviewProgressUpdateForStageResults(input: {
  reviewRunId: string;
  headSha: string;
  stageResults: ReviewStageResult[];
  failed: boolean;
  superseded: boolean;
}): ReviewProgressUpdate {
  return {
    reviewRunId: input.reviewRunId,
    headSha: input.headSha,
    status: reviewStatusForStageResults(input),
    findings: findingsStatusForStageResults(input.stageResults, input.failed, input.superseded)
  };
}

async function upsertReviewProgressComment(input: {
  token: string;
  repository: GitHubRepository;
  pullRequestNumber: number;
  update: ReviewProgressUpdate;
  createIfMissing?: boolean;
}): Promise<{ id: number; html_url?: string; reused: boolean; state: ReviewProgressCommentState } | undefined> {
  const marker = reviewProgressCommentMarker(input.update.headSha, input.update.reviewRunId);
  const comments = await listIssueComments({
    token: input.token,
    repository: input.repository,
    issueNumber: input.pullRequestNumber
  });
  const existing = comments.find((comment) => {
    const state = parseReviewProgressCommentState(comment.body);
    return Boolean(
      comment.body?.includes(marker) &&
      state?.headSha === input.update.headSha &&
      state.reviewRunId === input.update.reviewRunId
    );
  });
  if (!existing && input.createIfMissing === false) {
    return undefined;
  }

  const state = mergeReviewProgressState(parseReviewProgressCommentState(existing?.body), input.update);
  const body = renderReviewProgressComment(state);

  if (existing) {
    const updated = await updateIssueComment({
      token: input.token,
      repository: input.repository,
      commentId: existing.id,
      body
    });
    return { id: updated.id, html_url: updated.html_url, reused: true, state };
  }

  const created = await createIssueComment({
    token: input.token,
    repository: input.repository,
    issueNumber: input.pullRequestNumber,
    body
  });
  return { id: created.id, html_url: created.html_url, reused: false, state };
}

export async function safeUpsertReviewProgressComment(input: {
  token: string;
  payload: ReviewStagePayload;
  triggerRunId: string;
  update: Omit<ReviewProgressUpdate, "reviewRunId" | "headSha">;
  status: string;
  createIfMissing?: boolean;
}): Promise<{ id: number; html_url?: string; reused: boolean; state: ReviewProgressCommentState } | undefined> {
  try {
    const comment = await upsertReviewProgressComment({
      token: input.token,
      repository: input.payload.repository,
      pullRequestNumber: input.payload.pull_request_number,
      update: {
        reviewRunId: input.payload.review_run_id,
        headSha: input.payload.head_sha,
        ...input.update
      },
      createIfMissing: input.createIfMissing
    });
    if (!comment) {
      logger.info("github_review_progress_comment_publish_skipped", {
        review_run_id: input.payload.review_run_id,
        trigger_run_id: input.triggerRunId,
        repository: input.payload.repository.fullName,
        pull_request_number: input.payload.pull_request_number,
        head_sha: input.payload.head_sha,
        attempted_status: input.status,
        reason: "progress comment does not exist and createIfMissing is false"
      });
      return undefined;
    }
    await postReviewEvent({
      reviewRunId: input.payload.review_run_id,
      triggerRunId: input.triggerRunId,
      status: input.status,
      payload: {
        repository: input.payload.repository.fullName,
        pull_request_number: input.payload.pull_request_number,
        head_sha: input.payload.head_sha,
        github_comment_id: comment.id,
        github_comment_url: comment.html_url,
        reused_existing_comment: comment.reused,
        progress_status: comment.state.status,
        progress_findings: comment.state.findings
      }
    });
    logger.info("github_review_progress_comment_published", {
      review_run_id: input.payload.review_run_id,
      trigger_run_id: input.triggerRunId,
      repository: input.payload.repository.fullName,
      pull_request_number: input.payload.pull_request_number,
      head_sha: input.payload.head_sha,
      event_status: input.status,
      publication_action: comment.reused ? "updated" : "created",
      github_comment_id: comment.id,
      github_comment_url: comment.html_url,
      progress_status: comment.state.status,
      progress_findings: comment.state.findings
    });
    return comment;
  } catch (error) {
    const message = errorMessage(error);
    logger.warn("review_progress_comment_update_failed", {
      review_run_id: input.payload.review_run_id,
      trigger_run_id: input.triggerRunId,
      repository: input.payload.repository.fullName,
      pull_request_number: input.payload.pull_request_number,
      head_sha: input.payload.head_sha,
      status: input.status,
      error: message
    });
    await postReviewEvent({
      reviewRunId: input.payload.review_run_id,
      triggerRunId: input.triggerRunId,
      status: "github_review_progress_comment_update_failed",
      payload: {
        repository: input.payload.repository.fullName,
        pull_request_number: input.payload.pull_request_number,
        head_sha: input.payload.head_sha,
        attempted_status: input.status,
        error: message
      }
    });
    return undefined;
  }
}

function reviewStatusForStageResults(input: {
  stageResults: ReviewStageResult[];
  failed: boolean;
  superseded: boolean;
}): ReviewProgressStatus {
  if (input.failed) {
    return "Blocked";
  }
  if (input.superseded) {
    return "Skipped";
  }
  if (input.stageResults.length === 0) {
    return "Skipped";
  }
  return "Completed";
}

function findingsStatusForStageResults(
  stageResults: ReviewStageResult[],
  failed: boolean,
  superseded: boolean
): ReviewFindingsStatus {
  if (failed || superseded) {
    return "Unavailable";
  }

  const reviewResults = stageResults.filter((result) => result.stage === "runtime");
  const knownCounts = reviewResults
    .map((result) => result.findings?.length)
    .filter((count): count is number => typeof count === "number");
  if (knownCounts.some((count) => count > 0)) {
    return "Issues found";
  }
  if (knownCounts.length > 0) {
    return "No issues found";
  }
  return "Unavailable";
}

function renderProgressStateMarker(state: ReviewProgressCommentState): string {
  return `<!-- ${PROGRESS_STATE_MARKER} ${JSON.stringify(state)} -->`;
}

function statusMessage(state: ReviewProgressCommentState): string {
  if (state.status === "Blocked") {
    return "Jina was blocked while reviewing this PR.";
  }
  if (state.status === "Skipped") {
    return "Jina skipped this review.";
  }
  if (state.status === "Completed") {
    return "Jina has completed this review.";
  }
  return "Jina is working on this PR.";
}

function reviewProgressStatus(value: unknown): ReviewProgressStatus | undefined {
  return value === "Queued" ||
    value === "In progress" ||
    value === "Completed" ||
    value === "Skipped" ||
    value === "Blocked"
    ? value
    : undefined;
}

function reviewFindingsStatus(value: unknown): ReviewFindingsStatus | undefined {
  return value === "Pending" ||
    value === "Issues found" ||
    value === "No issues found" ||
    value === "Unavailable" ||
    value === "Insufficient credits"
    ? value
    : undefined;
}

function reviewProgressNotice(value: unknown): ReviewProgressNotice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const notice = value as Record<string, unknown>;
  if (
    notice.kind !== "provider_failure" ||
    (notice.category !== "quota" &&
      notice.category !== "authentication" &&
      notice.category !== "model" &&
      notice.category !== "availability")
  ) {
    return undefined;
  }
  if (notice.provider !== "codex" && notice.provider !== "byok") {
    return undefined;
  }
  const quotaReason =
    notice.quotaReason === "exhausted" || notice.quotaReason === "rate_limit" ? notice.quotaReason : undefined;
  return {
    kind: notice.kind,
    category: notice.category,
    provider: notice.provider,
    ...(quotaReason ? { quotaReason } : {})
  };
}

function providerFailureNotice(notice: ReviewProgressNotice): string[] {
  const provider = notice.provider === "codex" ? "Codex" : "The selected model provider";
  const reason = {
    quota:
      notice.provider === "codex"
        ? notice.quotaReason === "exhausted"
          ? "Codex has no remaining credits or usage allowance."
          : notice.quotaReason === "rate_limit"
            ? "Codex hit a request rate limit."
            : "Codex hit a usage or rate limit."
        : `${provider} has no available quota, credits, or rate-limit capacity.`,
    authentication: `${provider} rejected its credentials.`,
    model: `The selected model is unavailable or unsupported by ${notice.provider === "codex" ? "Codex" : "its provider"}.`,
    availability: `${provider} is currently unavailable.`
  }[notice.category];
  const action = {
    quota:
      notice.provider === "codex"
        ? "Wait for the limit to reset, choose another provider, or enable managed fallback."
        : notice.provider === "byok"
          ? "Add credits, raise the provider limit, or wait for its rate limit to reset, then retry."
          : "Add credits, raise the provider limit, or wait for its rate limit to reset, then retry.",
    authentication:
      notice.provider === "codex" ? "Reconnect Codex, then retry." : "Update the provider API key, then retry.",
    model: "Choose a supported model, then retry.",
    availability: "Retry later, choose another provider, or enable managed fallback."
  }[notice.category];
  return [
    "### Model provider action required",
    "",
    `${reason} Managed fallback is disabled, so Jina stopped without running the review.`,
    "",
    `${action} [Update model settings](${modelSettingsUrl()}).`
  ];
}

function modelSettingsUrl(): string {
  const configuredUrl = process.env.DASHBOARD_URL?.trim() || "https://app.usejina.com";
  try {
    const base = configuredUrl.endsWith("/") ? configuredUrl : `${configuredUrl}/`;
    return new URL("models", base).toString();
  } catch {
    return "https://app.usejina.com/models";
  }
}

function isTerminalStatus(status: ReviewProgressStatus): boolean {
  return status === "Completed" || status === "Skipped" || status === "Blocked";
}
