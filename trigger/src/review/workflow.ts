import { logger, runs } from "@trigger.dev/sdk";

import { postInternal } from "../shared/api.js";
import { getPullRequestState, type GitHubRepository, type PullRequestState, type RepositoryAccessProbe } from "../shared/github.js";
import { errorMessage } from "../shared/utils.js";

export type ReviewPayload = {
  delivery_id: string;
  review_idempotency_key?: string;
  source_event: "pull_request" | "issue_comment" | "pull_request_review_comment" | "manual";
  action: string;
  github_installation_id: number;
  repository: {
    github_repo_id: number;
    owner?: string;
    owner_id?: number;
    owner_type?: string;
    name?: string;
    full_name?: string;
    default_branch?: string;
    private?: boolean;
  };
  pull_request: {
    number: number;
    title?: string;
    html_url?: string;
    draft?: boolean;
    head_sha: string;
    base_sha?: string;
    head_ref?: string;
    base_ref?: string;
    author?: string;
  };
  requested_by?: { login: string; comment_id: number };
  /** Orders accepted @usejina comments so only the newest one is worked. */
  manual_command_tag?: string;
  /** Remaining Markdown in an authorized @usejina comment. */
  review_instructions?: string;
  trigger: "webhook" | "manual" | "scheduled" | "policy";
};

/** Per-tenant, per-stage model selection resolved at dispatch. `null`/absent
 *  means the platform default for that stage. */
type ReviewModelSettings = {
  planner_model?: string | null;
  investigation_model?: string | null;
  review_model?: string | null;
  context_model?: string | null;
  planner_effort?: "low" | "medium" | "high" | null;
  investigation_effort?: "low" | "medium" | "high" | null;
  review_effort?: "low" | "medium" | "high" | null;
  context_effort?: "low" | "medium" | "high" | null;
  review_fallback_policy?: "fail_notify" | "managed";
  context_fallback_policy?: "fail_notify" | "managed";
};

export type PrepareReviewResponse = {
  ok: boolean;
  review_run_id: string;
  message?: string;
  model_settings?: ReviewModelSettings;
};

export type ReviewStageName = "summary" | "runtime";

export type ReviewStagePayload = {
  review_run_id: string;
  parent_trigger_run_id: string;
  repository: GitHubRepository & {
    githubRepoId: number;
    defaultBranch?: string;
    private?: boolean;
  };
  pull_request_number: number;
  title?: string;
  author?: string;
  base_ref: string;
  head_ref?: string;
  head_sha: string;
  installation_id: number;
  manual_command_tag?: string;
  review_instructions?: string;
  /** Resolved per-tenant models threaded from /internal/reviews/prepare. */
  model_settings?: ReviewModelSettings;
};

export type ReviewSuperseded = {
  reason: string;
  expected_head_sha: string;
  current_head_sha?: string;
  current_state?: string;
  current_merged?: boolean;
  requested_comment_id?: number;
  newer_comment_id?: number;
};

export type ManualReviewSupersession = {
  scopeTag: string;
  commandTag: string;
};

type ManualReviewRun = {
  tags: string[];
  createdAt: Date | string;
};

const MANUAL_COMMAND_TAG_PATTERN = /^manual-command:(\d+):(issue_comment|pull_request_review_comment):(\d+)$/;

type ReviewFindingPayload = {
  fingerprint: string;
  file_path?: string;
  line_number?: number;
  severity: string;
  category: string;
  body: string;
};

/** Usage records that could not be delivered to the usage endpoint after
 *  in-stage retries. Carried on the stage result so the parent task can attach
 *  them to the completion payload for server-side (replay-safe) persistence,
 *  rather than failing the stage and retrying the whole expensive review. */
export type UsageRecordsFallback = {
  stage: "runtime";
  sandbox_id: string;
  // "harness" runs (native Codex on the author's subscription) produce no usage
  // records, so this fallback is never constructed for them; the type still
  // admits "harness" for symmetry with the resolved key source.
  key_source: "user" | "managed" | "harness";
  usage_records: unknown[];
};

export type ReviewStageResult = {
  stage: ReviewStageName;
  status: "success" | "skipped" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error?: string;
  skippedReason?: string;
  superseded?: ReviewSuperseded;
  githubCommentUrl?: string;
  githubReviewUrl?: string;
  /** Whether the runtime stage received Jina's final artifact before returning. */
  jinaCompleted?: boolean;
  /** GitHub publication is separate from Jina execution and must be observable independently. */
  publicationStatus?: "not_attempted" | "published" | "skipped" | "failed";
  publicationReason?: string;
  findings?: ReviewFindingPayload[];
  usage_records_fallback?: UsageRecordsFallback;
};

export function stageResult(input: Omit<ReviewStageResult, "completedAt" | "durationMs"> & {
  startedAtMs: number;
}): ReviewStageResult {
  return {
    ...input,
    completedAt: new Date().toISOString(),
    durationMs: elapsedMs(input.startedAtMs),
  };
}

export function failedStageResult(input: {
  stage: ReviewStageName;
  startedAtMs: number;
  error: unknown;
}): ReviewStageResult {
  return stageResult({
    stage: input.stage,
    status: "failed",
    startedAt: new Date(input.startedAtMs).toISOString(),
    startedAtMs: input.startedAtMs,
    error: errorMessage(input.error),
  });
}

export async function postReviewEvent(input: {
  reviewRunId: string;
  triggerRunId: string;
  status: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await postInternal(`/internal/reviews/${input.reviewRunId}/events`, {
    trigger_run_id: input.triggerRunId,
    status: input.status,
    payload: input.payload,
  }).catch((error: unknown) => {
    logger.warn("review_stage_event_publish_failed", {
      review_run_id: input.reviewRunId,
      status: input.status,
      error: errorMessage(error),
    });
  });
}

export function isFinalAttempt(ctx: { attempt: { number: number }; run: { maxAttempts?: number } }, maxAttempts = 3): boolean {
  return ctx.attempt.number >= (ctx.run.maxAttempts ?? maxAttempts);
}

export function githubPullRequestsWritable(permissions: Record<string, string>): boolean {
  return permissions.pull_requests === "write";
}

export function failedRepositoryAccess(error: unknown): RepositoryAccessProbe {
  return {
    ok: false,
    status: 0,
    message: `repo access probe failed: ${errorMessage(error)}`,
  };
}

export function supersededDetails(current: PullRequestState, expectedHeadSha: string): ReviewSuperseded | undefined {
  const state = current.state?.toLowerCase();
  const currentHeadSha = current.head?.sha;
  if (state && state !== "open") {
    return {
      reason: current.merged ? "the pull request was merged" : `the pull request is ${state}`,
      expected_head_sha: expectedHeadSha,
      current_head_sha: currentHeadSha,
      current_state: current.state,
      current_merged: current.merged,
    };
  }

  if (currentHeadSha && currentHeadSha !== expectedHeadSha) {
    return {
      reason: `the pull request head changed from ${shortSha(expectedHeadSha)} to ${shortSha(currentHeadSha)}`,
      expected_head_sha: expectedHeadSha,
      current_head_sha: currentHeadSha,
      current_state: current.state,
      current_merged: current.merged,
    };
  }

  return undefined;
}

export async function currentReviewSuperseded(input: {
  token: string;
  repository: GitHubRepository;
  pullRequestNumber: number;
  headSha: string;
  manual?: ManualReviewSupersession;
}): Promise<ReviewSuperseded | undefined> {
  if (input.manual) {
    const manualSuperseded = await newerManualReviewSuperseded({
      ...input.manual,
      headSha: input.headSha,
    });
    if (manualSuperseded) return manualSuperseded;
  }
  try {
    const current = await getPullRequestState({
      token: input.token,
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
    });
    return supersededDetails(current, input.headSha);
  } catch (error) {
    logger.warn("pull_request_current_state_failed", {
      repository: input.repository.fullName,
      pull_request_number: input.pullRequestNumber,
      head_sha: input.headSha,
      error: errorMessage(error),
    });
    return undefined;
  }
}

export function manualReviewScopeTag(installationId: number, repositoryId: number, pullRequestNumber: number): string {
  return `manual-pr:${installationId}:${repositoryId}:${pullRequestNumber}`;
}

export function manualReviewSupersession(payload: ReviewStagePayload): ManualReviewSupersession | undefined {
  return payload.manual_command_tag ? {
    scopeTag: manualReviewScopeTag(
      payload.installation_id,
      payload.repository.githubRepoId,
      payload.pull_request_number,
    ),
    commandTag: payload.manual_command_tag,
  } : undefined;
}

export async function newerManualReviewSuperseded(input: ManualReviewSupersession & {
  headSha: string;
}): Promise<ReviewSuperseded | undefined> {
  const page = await runs.list({ tag: input.scopeTag, taskIdentifier: "review", limit: 100 });
  return newerManualReviewDetails({
    runs: page.data,
    currentCommandTag: input.commandTag,
    headSha: input.headSha,
  });
}

export function newerManualReviewDetails(input: {
  runs: ManualReviewRun[];
  currentCommandTag: string;
  headSha: string;
}): ReviewSuperseded | undefined {
  const current = manualCommandOrder(input.currentCommandTag, input.runs);
  if (!current) return undefined;
  const newest = input.runs
    .flatMap((run) => run.tags.flatMap((tag) => {
      const order = manualCommandOrder(tag, [run]);
      return order ? [order] : [];
    }))
    .sort(compareManualCommands)
    .at(-1);
  if (!newest || compareManualCommands(newest, current) <= 0) return undefined;
  return {
    reason: `a newer @usejina comment (${newest.commentId}) superseded comment ${current.commentId}`,
    expected_head_sha: input.headSha,
    requested_comment_id: current.commentId,
    newer_comment_id: newest.commentId,
  };
}

type ManualCommandOrder = {
  tag: string;
  requestedAtMs: number;
  runCreatedAtMs: number;
  event: string;
  commentId: number;
};

function manualCommandOrder(tag: string, matchingRuns: ManualReviewRun[]): ManualCommandOrder | undefined {
  const match = MANUAL_COMMAND_TAG_PATTERN.exec(tag);
  if (!match) return undefined;
  const requestedAtMs = Number(match[1]);
  const event = match[2]!;
  const commentId = Number(match[3]);
  if (!Number.isSafeInteger(requestedAtMs) || !Number.isSafeInteger(commentId)) return undefined;
  const runCreatedAtMs = matchingRuns
    .filter((run) => run.tags.includes(tag))
    .reduce((latest, run) => {
      const createdAtMs = run.createdAt instanceof Date ? run.createdAt.getTime() : Date.parse(run.createdAt);
      return Math.max(latest, Number.isFinite(createdAtMs) ? createdAtMs : 0);
    }, 0);
  return { tag, requestedAtMs, runCreatedAtMs, event, commentId };
}

function compareManualCommands(left: ManualCommandOrder, right: ManualCommandOrder): number {
  const requestedAt = left.requestedAtMs - right.requestedAtMs;
  if (requestedAt) return requestedAt;
  if (left.event === right.event && left.commentId !== right.commentId) {
    return left.commentId - right.commentId;
  }
  return left.runCreatedAtMs - right.runCreatedAtMs || left.tag.localeCompare(right.tag);
}

export function supersededStageResult(input: {
  stage: ReviewStageName;
  startedAt: string;
  startedAtMs: number;
  superseded: ReviewSuperseded;
}): ReviewStageResult {
  return stageResult({
    stage: input.stage,
    status: "skipped",
    startedAt: input.startedAt,
    startedAtMs: input.startedAtMs,
    skippedReason: input.superseded.reason,
    superseded: input.superseded,
  });
}

export function isSupersededStageResult(result: ReviewStageResult): boolean {
  return (
    result.status === "skipped" &&
    (Boolean(result.superseded) || isSupersededReason(result.skippedReason))
  );
}

export function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

export function preview(value: string, maxLength = 2_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function reviewRunUrl(reviewRunId: string | undefined): string | undefined {
  const configuredUrl = process.env.DASHBOARD_URL?.trim();
  if (!configuredUrl || !reviewRunId) {
    return undefined;
  }

  try {
    const base = configuredUrl.endsWith("/") ? configuredUrl : `${configuredUrl}/`;
    return new URL(`reviews/${encodeURIComponent(reviewRunId)}`, base).toString();
  } catch {
    return undefined;
  }
}

export function stageTags(payload: ReviewStagePayload, stage: ReviewStageName): string[] {
  return [
    `repo:${payload.repository.fullName}`,
    `pr:${payload.pull_request_number}`,
    `review_run:${payload.review_run_id}`,
    `parent_run:${payload.parent_trigger_run_id}`,
    `stage:${stage}`,
  ];
}

function shortSha(value: string | undefined): string {
  return value ? value.slice(0, 12) : "unknown";
}

function isSupersededReason(reason: string | undefined): boolean {
  return (
    Boolean(reason?.includes("pull request head changed")) ||
    reason === "the pull request was merged" ||
    Boolean(reason?.startsWith("the pull request is "))
  );
}
