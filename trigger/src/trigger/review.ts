import { batch, logger, tags, task } from "@trigger.dev/sdk";

import { InternalApiError, postInternal } from "../shared/api.js";
import { createInstallationAccessToken, parseRepository, type GitHubRepository } from "../shared/github.js";
import {
  reviewProgressUpdateForStageResults,
  safeUpsertReviewProgressComment,
} from "../review/progress-comment.js";
import {
  currentReviewSuperseded,
  isFinalAttempt,
  isSupersededStageResult,
  manualReviewScopeTag,
  newerManualReviewSuperseded,
  postReviewEvent,
  type PrepareReviewResponse,
  type ReviewPayload,
  type ReviewStageName,
  type ReviewStagePayload,
  type ReviewStageResult,
  type ReviewSuperseded,
  type UsageRecordsFallback,
  supersededStageResult,
} from "../review/workflow.js";
import { errorMessage } from "../shared/utils.js";
import { reviewRuntime } from "./review-runtime.js";
import { reviewSummary } from "./review-summary.js";

type ChildRunResult = {
  ok: boolean;
  taskIdentifier?: string;
  output?: unknown;
  error?: unknown;
};

type ReviewCompletion = {
  status: "completed" | "completed_superseded" | "failed";
  error?: string;
  superseded?: ReviewSuperseded;
};

type CompleteReviewResponse = {
  updated?: boolean;
};

export const review = task({
  id: "review",
  queue: {
    concurrencyLimit: 1,
  },
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    randomize: true,
  },
  machine: {
    preset: "small-1x",
  },
  maxDuration: 3_600,
  run: async (payload: ReviewPayload, { ctx }) => {
    logger.info("review started", {
      runId: ctx.run.id,
      deliveryId: payload.delivery_id,
      repo: payload.repository.full_name,
      pr: payload.pull_request.number,
      headSha: payload.pull_request.head_sha,
    });

    let reviewRunId: string | undefined;
    const repositoryFullName = payload.repository.full_name ?? "<missing>";
    const headSha = payload.pull_request.head_sha;
    let reviewCompletionPersisted = false;
    let githubToken: string | undefined;
    let stagePayload: ReviewStagePayload | undefined;
    // Stage results collected before any failure, so the catch-path failure
    // /complete can still carry usage that already failed its direct post. Stays
    // undefined until batch.triggerAndWait returns; the failure completion then
    // omits the fallback field when nothing was collected.
    let collectedStageResults: ReviewStageResult[] | undefined;

    const repository = parseRepository(payload.repository.full_name);
    const baseRef = payload.pull_request.base_ref ?? payload.repository.default_branch ?? "main";
    const manualSupersession = payload.manual_command_tag ? {
      scopeTag: manualReviewScopeTag(
        payload.github_installation_id,
        payload.repository.github_repo_id,
        payload.pull_request.number,
      ),
      commandTag: payload.manual_command_tag,
    } : undefined;

    try {
      if (manualSupersession) {
        const superseded = await newerManualReviewSuperseded({
          ...manualSupersession,
          headSha,
        });
        if (superseded) {
          logger.info("review_superseded_before_prepare", {
            repository: repository.fullName,
            pull_request_number: payload.pull_request.number,
            head_sha: headSha,
            waited_for_child_stages: false,
            jina_completed: false,
            publication_status: "not_attempted",
            publication_reason: superseded.reason,
            ...superseded,
          });
          return {
            status: "completed_superseded",
            repository: repository.fullName,
            pull_request_number: payload.pull_request.number,
            superseded,
          };
        }
      }

      let prepared: PrepareReviewResponse;
      try {
        prepared = await postInternal<PrepareReviewResponse>("/internal/reviews/prepare", {
          trigger_run_id: ctx.run.id,
          idempotency_key: payload.review_idempotency_key ?? reviewIdempotencyKey(payload),
          workflow: "review",
          payload,
        });
      } catch (error) {
        // A prepare-time 402 is a deterministic billing block, not a retryable
        // infrastructure failure. The API has already terminally completed the run
        // server-side before sending the 402, so no /complete call is made (nor
        // needed). Return a clean blocked outcome instead of throwing -- throwing
        // would let Trigger retry the deterministic 402 up to maxAttempts and then
        // surface the run as 'failed' with no blocked classification.
        if (isInsufficientCreditsError(error)) {
          return await completeBlockedInsufficientCredits({
            payload,
            triggerRunId: ctx.run.id,
            reviewRunId: insufficientCreditsReviewRunId(error),
            repository,
            baseRef,
            headSha,
          });
        }
        throw error;
      }
      reviewRunId = prepared.review_run_id;

      stagePayload = {
        review_run_id: reviewRunId,
        parent_trigger_run_id: ctx.run.id,
        repository: {
          owner: repository.owner,
          name: repository.name,
          fullName: repository.fullName,
          githubRepoId: payload.repository.github_repo_id,
          defaultBranch: payload.repository.default_branch,
          private: payload.repository.private,
        },
        pull_request_number: payload.pull_request.number,
        title: payload.pull_request.title,
        author: payload.pull_request.author,
        base_ref: baseRef,
        head_ref: payload.pull_request.head_ref,
        head_sha: headSha,
        installation_id: payload.github_installation_id,
        manual_command_tag: payload.manual_command_tag,
        review_instructions: payload.review_instructions,
        // Tolerate absence: the API adds model_settings; older responses omit it
        // and the worker falls back to platform defaults.
        model_settings: prepared.model_settings,
      };

      await tags
        .add([
          `repo:${repository.fullName}`,
          `pr:${payload.pull_request.number}`,
          `review_run:${reviewRunId}`,
          "kind:review",
          `trigger:${payload.trigger}`,
        ])
        .catch(() => undefined);

      githubToken = await createInstallationAccessToken(payload.github_installation_id);
      await safeUpsertReviewProgressComment({
        token: githubToken,
        payload: stagePayload,
        triggerRunId: ctx.run.id,
        status: "github_review_progress_queued",
        update: {
          status: "Queued",
          findings: "Pending",
        },
      });

      const earlySuperseded = await currentReviewSuperseded({
        token: githubToken,
        repository,
        pullRequestNumber: payload.pull_request.number,
        headSha,
        manual: manualSupersession,
      });
      if (earlySuperseded) {
        const stageResults = supersededStageResults(earlySuperseded);
        await safeUpsertReviewProgressComment({
          token: githubToken,
          payload: stagePayload,
          triggerRunId: ctx.run.id,
          status: "github_review_progress_finalized",
          update: {
            status: "Skipped",
            findings: "Unavailable",
          },
        });
        await postReviewEvent({
          reviewRunId,
          triggerRunId: ctx.run.id,
          status: "review_superseded",
          payload: {
            workflow: "review",
            repository: repository.fullName,
            pull_request_number: payload.pull_request.number,
            ...earlySuperseded,
          },
        });

        await postInternal(`/internal/reviews/${reviewRunId}/complete`, {
          trigger_run_id: ctx.run.id,
          payload: {
            workflow: "review",
            status: "completed_superseded",
            repository: repository.fullName,
            pull_request_number: payload.pull_request.number,
            head_sha: headSha,
            stage_results: stageResults,
            superseded: earlySuperseded,
          },
        });
        reviewCompletionPersisted = true;

        logger.info("review_superseded", {
          review_run_id: reviewRunId,
          repository: repository.fullName,
          pull_request_number: payload.pull_request.number,
          head_sha: headSha,
          waited_for_child_stages: false,
          jina_completed: false,
          publication_status: "not_attempted",
          publication_reason: earlySuperseded.reason,
          ...earlySuperseded,
        });

        return {
          status: "completed_superseded",
          review_run_id: reviewRunId,
          repository: repository.fullName,
          pull_request_number: payload.pull_request.number,
          stage_results: stageResults,
          superseded: earlySuperseded,
        };
      }

      await safeUpsertReviewProgressComment({
        token: githubToken,
        payload: stagePayload,
        triggerRunId: ctx.run.id,
        status: "github_review_progress_in_progress",
        update: {
          status: "In progress",
          findings: "Pending",
        },
      });

      const childWaitStartedAtMs = Date.now();
      logger.info("review_waiting_for_jina", {
        review_run_id: reviewRunId,
        trigger_run_id: ctx.run.id,
        repository: repository.fullName,
        pull_request_number: payload.pull_request.number,
        head_sha: headSha,
        child_stages: ["summary", "runtime"],
      });
      const childRuns = await batch.triggerAndWait<typeof reviewSummary | typeof reviewRuntime>([
        {
          id: "review-summary",
          payload: stagePayload,
          options: childOptions(reviewRunId, headSha, "summary", payload),
        },
        {
          id: "review-runtime",
          payload: stagePayload,
          options: childOptions(reviewRunId, headSha, "runtime", payload),
        },
      ]);

      const childStages: ReviewStageName[] = ["summary", "runtime"];
      const stageResults = childRuns.runs.map((run, index) =>
        normalizeChildResult(run as ChildRunResult, childStages[index] ?? "runtime"),
      );
      collectedStageResults = stageResults;
      const runtimeStageResult = stageResults.find((result) => result.stage === "runtime");
      logger.info("review_jina_stages_finished", {
        review_run_id: reviewRunId,
        trigger_run_id: ctx.run.id,
        repository: repository.fullName,
        pull_request_number: payload.pull_request.number,
        head_sha: headSha,
        waited_for_child_stages: true,
        child_wait_duration_ms: Date.now() - childWaitStartedAtMs,
        jina_completed: runtimeStageResult?.jinaCompleted ?? false,
        publication_status: runtimeStageResult?.publicationStatus ?? "unknown",
        publication_reason: runtimeStageResult?.publicationReason,
        github_review_url: runtimeStageResult?.githubReviewUrl,
        stage_results: stageResults.map(stageLifecycleLog),
      });
      const completion = reviewCompletionForStageResults(stageResults);
      const progressUpdate = reviewProgressUpdateForStageResults({
        reviewRunId,
        headSha,
        stageResults,
        failed: completion.status === "failed",
        superseded: completion.status === "completed_superseded",
      });
      await safeUpsertReviewProgressComment({
        token: githubToken,
        payload: stagePayload,
        triggerRunId: ctx.run.id,
        status: "github_review_progress_finalized",
        update: {
          status: progressUpdate.status,
          findings: progressUpdate.findings,
        },
      });

      await postInternal(`/internal/reviews/${reviewRunId}/complete`, {
        trigger_run_id: ctx.run.id,
        payload: {
          workflow: "review",
          status: completion.status,
          repository: repository.fullName,
          pull_request_number: payload.pull_request.number,
          head_sha: headSha,
          stage_results: stageResults,
          findings: reviewFindingsForCompletion(stageResults),
          usage_records_fallback: usageRecordsFallbackForCompletion(stageResults),
          error: completion.error,
          superseded: completion.superseded,
        },
      });
      reviewCompletionPersisted = true;

      logger.info("review completed", {
        review_run_id: reviewRunId,
        repository: repository.fullName,
        pull_request_number: payload.pull_request.number,
        head_sha: headSha,
        status: completion.status,
        failed_stage_count: stageResults.filter((result) => result.status === "failed").length,
        waited_for_child_stages: true,
        jina_completed: runtimeStageResult?.jinaCompleted ?? false,
        publication_status: runtimeStageResult?.publicationStatus ?? "unknown",
        publication_reason: runtimeStageResult?.publicationReason,
        github_review_url: runtimeStageResult?.githubReviewUrl,
      });

      return {
        status: completion.status,
        review_run_id: reviewRunId,
        repository: repository.fullName,
        pull_request_number: payload.pull_request.number,
        stage_results: stageResults,
        error: completion.error,
        superseded: completion.superseded,
      };
    } catch (error) {
      const message = errorMessage(error);
      logger.warn("review failed", {
        review_run_id: reviewRunId,
        repository: repositoryFullName,
        pull_request_number: payload.pull_request.number,
        head_sha: headSha,
        final_attempt: isFinalAttempt(ctx),
        waited_for_child_stages: collectedStageResults !== undefined,
        jina_completed: collectedStageResults?.find((result) => result.stage === "runtime")?.jinaCompleted ?? false,
        publication_status:
          collectedStageResults?.find((result) => result.stage === "runtime")?.publicationStatus ?? "unknown",
        error: message,
      });

      const failedReviewRunId = failedReviewCompletionRunId({
        reviewRunId,
        finalAttempt: isFinalAttempt(ctx),
        reviewCompletionPersisted,
      });
      if (failedReviewRunId) {
        // Usage that already failed its direct post rides on the collected stage
        // results; include it so this failure /complete does not drop it. Omitted
        // when the error struck before any stage results were collected.
        const usageRecordsFallback = failedCompletionUsageRecordsFallback(collectedStageResults);
        const failedCompletion = await postInternal<CompleteReviewResponse>(
          `/internal/reviews/${failedReviewRunId}/complete`,
          {
            trigger_run_id: ctx.run.id,
            payload: {
              workflow: "review",
              status: "failed",
              repository: repositoryFullName,
              pull_request_number: payload.pull_request.number,
              head_sha: headSha,
              error: message,
              ...(usageRecordsFallback ? { usage_records_fallback: usageRecordsFallback } : {}),
            },
          },
        ).catch((completeError: unknown) => {
          logger.warn("review_failed_complete_update_failed", {
            review_run_id: failedReviewRunId,
            error: errorMessage(completeError),
          });
          return undefined;
        });
        if (failedCompletion?.updated && githubToken && stagePayload) {
          await safeUpsertReviewProgressComment({
            token: githubToken,
            payload: stagePayload,
            triggerRunId: ctx.run.id,
            status: "github_review_progress_failed",
            update: {
              status: "Blocked",
              findings: "Unavailable",
            },
          });
        }
      } else if (reviewRunId && reviewCompletionPersisted) {
        logger.warn("review_error_after_completion_preserving_status", {
          review_run_id: reviewRunId,
          repository: repositoryFullName,
          pull_request_number: payload.pull_request.number,
          head_sha: headSha,
          error: message,
        });
      }

      throw error;
    }
  },
});

function childOptions(
  reviewRunId: string,
  headSha: string,
  stage: ReviewStageName,
  payload: ReviewPayload,
): {
  idempotencyKey: string;
  tags: string[];
  ttl: string;
} {
  return {
    idempotencyKey: `review:${reviewRunId}:${headSha}:${stage}`,
    tags: [
      `review_run:${reviewRunId}`,
      `stage:${stage}`,
      `repo:${payload.repository.github_repo_id}`,
      `pr:${payload.pull_request.number}`,
    ],
    ttl: "2h",
  };
}

function stageLifecycleLog(result: ReviewStageResult): Record<string, unknown> {
  return {
    stage: result.stage,
    status: result.status,
    duration_ms: result.durationMs,
    error: result.error,
    skipped_reason: result.skippedReason,
    jina_completed: result.jinaCompleted,
    publication_status: result.publicationStatus,
    publication_reason: result.publicationReason,
    github_review_url: result.githubReviewUrl,
  };
}

function reviewIdempotencyKey(payload: ReviewPayload): string {
  return `review:${payload.github_installation_id}:${payload.repository.github_repo_id}:${payload.pull_request.number}:${payload.pull_request.head_sha}:code_review`;
}

export function failedReviewCompletionRunId(input: {
  reviewRunId: string | undefined;
  finalAttempt: boolean;
  reviewCompletionPersisted: boolean;
}): string | undefined {
  return input.reviewRunId && input.finalAttempt && !input.reviewCompletionPersisted ? input.reviewRunId : undefined;
}

export function reviewCompletionForStageResults(stageResults: ReviewStageResult[]): ReviewCompletion {
  const summaryCount = stageResults.filter((result) => result.stage === "summary").length;
  const runtimeCount = stageResults.filter((result) => result.stage === "runtime").length;
  if (stageResults.length !== 2 || summaryCount !== 1 || runtimeCount !== 1) {
    return {
      status: "failed",
      error: `invalid child results: expected one summary and one runtime; received ${summaryCount} summary and ${runtimeCount} runtime`,
    };
  }

  const failed = stageResults.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    return {
      status: "failed",
      error: failed.map((result) => `${result.stage}: ${result.error ?? "failed"}`).join("\n"),
    };
  }

  // The runtime stage is the review users see. Do not discard a completed
  // runtime review just because the auxiliary summary observed a transient
  // head change while both stages were running concurrently.
  if (stageResults.some((result) => result.stage === "runtime" && result.status === "success")) {
    return { status: "completed" };
  }

  if (stageResults.some((result) => isSupersededStageResult(result))) {
    return {
      status: "completed_superseded",
      superseded: stageResults.find((result) => result.superseded)?.superseded,
    };
  }

  return { status: "completed" };
}

export function reviewFindingsForCompletion(stageResults: ReviewStageResult[]) {
  return stageResults.flatMap((result) => result.findings ?? []);
}

/** Collect any usage-record fallbacks stages could not deliver to the usage
 *  endpoint, so the completion payload carries them for server-side persistence. */
export function usageRecordsFallbackForCompletion(stageResults: ReviewStageResult[]): UsageRecordsFallback[] {
  return stageResults
    .map((result) => result.usage_records_fallback)
    .filter((fallback): fallback is UsageRecordsFallback => Boolean(fallback));
}

/** Usage-record fallbacks to attach to a catch-path failure /complete payload.
 *  The catch block may have collected stage results before the error (a stage's
 *  usage that already failed its direct post lives on those results); include
 *  them so the failed completion still carries the fallback for server-side
 *  persistence. Returns undefined -- so the field is omitted, as today -- when no
 *  stage results were collected or none produced a fallback. */
export function failedCompletionUsageRecordsFallback(
  stageResults: ReviewStageResult[] | undefined,
): UsageRecordsFallback[] | undefined {
  if (!stageResults) {
    return undefined;
  }
  const fallback = usageRecordsFallbackForCompletion(stageResults);
  return fallback.length > 0 ? fallback : undefined;
}

/** True for the deterministic prepare-time billing block (HTTP 402), which must
 *  be classified as blocked rather than retried as an infrastructure failure. */
export function isInsufficientCreditsError(error: unknown): error is InternalApiError {
  return error instanceof InternalApiError && error.status === 402;
}

export function insufficientCreditsReviewRunId(error: unknown): string | undefined {
  if (!isInsufficientCreditsError(error) || !isRecord(error.response)) {
    return undefined;
  }
  const details = isRecord(error.response.details) ? error.response.details : undefined;
  return stringOrUndefined(details?.review_run_id) ?? stringOrUndefined(error.response.review_run_id);
}

/** Record a clean blocked outcome for a prepare-time insufficient-credits (402).
 *  The API already terminally completed the run server-side, so this makes no
 *  /complete call; it best-effort updates the PR progress comment and returns a
 *  blocked result so Trigger records a successful task with a blocked outcome. */
async function completeBlockedInsufficientCredits(input: {
  payload: ReviewPayload;
  triggerRunId: string;
  reviewRunId?: string;
  repository: GitHubRepository;
  baseRef: string;
  headSha: string;
}): Promise<{
  status: "blocked_insufficient_credits";
  review_run_id?: string;
  repository: string;
  pull_request_number: number;
}> {
  const repositoryFullName = input.repository.fullName;
  logger.info("review_blocked_insufficient_credits", {
    review_run_id: input.reviewRunId,
    repository: repositoryFullName,
    pull_request_number: input.payload.pull_request.number,
    head_sha: input.headSha,
  });

  try {
    if (!input.reviewRunId) {
      logger.warn("review_blocked_missing_review_run_id", {
        repository: repositoryFullName,
        pull_request_number: input.payload.pull_request.number,
        head_sha: input.headSha,
      });
      return {
        status: "blocked_insufficient_credits",
        repository: repositoryFullName,
        pull_request_number: input.payload.pull_request.number,
      };
    }

    const token = await createInstallationAccessToken(input.payload.github_installation_id);
    const blockedStagePayload: ReviewStagePayload = {
      review_run_id: input.reviewRunId,
      parent_trigger_run_id: input.triggerRunId,
      repository: {
        owner: input.repository.owner,
        name: input.repository.name,
        fullName: input.repository.fullName,
        githubRepoId: input.payload.repository.github_repo_id,
        defaultBranch: input.payload.repository.default_branch,
        private: input.payload.repository.private,
      },
      pull_request_number: input.payload.pull_request.number,
      title: input.payload.pull_request.title,
      author: input.payload.pull_request.author,
      base_ref: input.baseRef,
      head_ref: input.payload.pull_request.head_ref,
      head_sha: input.headSha,
      installation_id: input.payload.github_installation_id,
    };
    await safeUpsertReviewProgressComment({
      token,
      payload: blockedStagePayload,
      triggerRunId: input.triggerRunId,
      status: "github_review_progress_blocked_insufficient_credits",
      update: {
        status: "Blocked",
        findings: "Insufficient credits",
      },
    });
  } catch (error) {
    logger.warn("review_blocked_progress_comment_failed", {
      repository: repositoryFullName,
      pull_request_number: input.payload.pull_request.number,
      head_sha: input.headSha,
      error: errorMessage(error),
    });
  }

  return {
    status: "blocked_insufficient_credits",
    review_run_id: input.reviewRunId,
    repository: repositoryFullName,
    pull_request_number: input.payload.pull_request.number,
  };
}

export function normalizeChildResult(run: ChildRunResult, expectedStage: ReviewStageName): ReviewStageResult {
  const taskStage = stageFromTaskIdentifier(run.taskIdentifier);
  if (run.ok && run.output) {
    if (taskStage !== expectedStage) {
      return invalidChildResult(expectedStage, `expected ${expectedStage} child, received ${taskStage ?? "unknown"} task`);
    }
    if (!isReviewStageResult(run.output, expectedStage)) {
      return invalidChildResult(expectedStage, `invalid ${expectedStage} child output`);
    }
    return run.output;
  }
  if (taskStage && taskStage !== expectedStage) {
    return invalidChildResult(expectedStage, `expected ${expectedStage} child, received ${taskStage} task`);
  }

  const now = new Date().toISOString();
  return {
    stage: expectedStage,
    status: "failed",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    error: run.error ? errorMessage(run.error) : "child task failed without an output",
  };
}

function invalidChildResult(stage: ReviewStageName, error: string): ReviewStageResult {
  const now = new Date().toISOString();
  return { stage, status: "failed", startedAt: now, completedAt: now, durationMs: 0, error };
}

function isReviewStageResult(value: unknown, stage: ReviewStageName): value is ReviewStageResult {
  if (
    !isRecord(value) ||
    value.stage !== stage ||
    (value.status !== "success" && value.status !== "skipped" && value.status !== "failed")
  ) {
    return false;
  }
  if (
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    !isNonNegativeNumber(value.durationMs)
  ) {
    return false;
  }
  for (const field of ["error", "skippedReason", "githubCommentUrl", "githubReviewUrl"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  const findings = value.findings;
  if (findings !== undefined && (!Array.isArray(findings) || !findings.every(isReviewFinding))) {
    return false;
  }
  if (value.superseded !== undefined && !isReviewSuperseded(value.superseded)) return false;
  if (value.usage_records_fallback !== undefined && !isUsageRecordsFallback(value.usage_records_fallback)) return false;
  const error = nonEmptyString(value.error);
  const skippedReason = nonEmptyString(value.skippedReason);
  if (
    (value.status === "success" && (value.error !== undefined || value.skippedReason !== undefined || value.superseded !== undefined)) ||
    (value.status === "failed" && (!error || value.skippedReason !== undefined || value.superseded !== undefined)) ||
    (value.status === "skipped" && (value.error !== undefined || (!skippedReason && value.superseded === undefined)))
  ) {
    return false;
  }
  return true;
}

function isReviewFinding(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!["fingerprint", "severity", "category", "body"].every((field) => nonEmptyString(value[field]))) return false;
  return (value.file_path === undefined || typeof value.file_path === "string") &&
    (value.line_number === undefined || isNonNegativeInteger(value.line_number));
}

function isReviewSuperseded(value: unknown): boolean {
  if (!isRecord(value) || typeof value.reason !== "string" || typeof value.expected_head_sha !== "string") return false;
  return (value.current_head_sha === undefined || typeof value.current_head_sha === "string") &&
    (value.current_state === undefined || typeof value.current_state === "string") &&
    (value.current_merged === undefined || typeof value.current_merged === "boolean") &&
    (value.requested_comment_id === undefined || isNonNegativeInteger(value.requested_comment_id)) &&
    (value.newer_comment_id === undefined || isNonNegativeInteger(value.newer_comment_id));
}

function isUsageRecordsFallback(value: unknown): boolean {
  return isRecord(value) && value.stage === "runtime" && typeof value.sandbox_id === "string" &&
    (value.key_source === "user" || value.key_source === "managed" || value.key_source === "harness") &&
    Array.isArray(value.usage_records);
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stageFromTaskIdentifier(value: string | undefined): ReviewStageName | undefined {
  if (value === "review-summary") {
    return "summary";
  }
  if (value === "review-runtime") {
    return "runtime";
  }
  return undefined;
}

function supersededStageResults(superseded: ReviewSuperseded): ReviewStageResult[] {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const stages: ReviewStageName[] = ["summary", "runtime"];
  return stages.map((stage) => supersededStageResult({ stage, startedAt, startedAtMs, superseded }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
