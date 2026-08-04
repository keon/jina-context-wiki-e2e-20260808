import { logger } from "@trigger.dev/sdk";

import { createReviewSession, runDaytonaReviewContext, type DaytonaReviewSession } from "../daytona/review-session.js";
import { createInstallationAccessTokenDetails } from "../shared/github.js";
import { reviewContextLogSummary } from "./log.js";
import {
  currentReviewSuperseded,
  elapsedMs,
  failedStageResult,
  manualReviewSupersession,
  postReviewEvent,
  preview,
  stageResult,
  supersededStageResult,
  type ReviewStagePayload,
  type ReviewStageResult,
  type ReviewSuperseded,
} from "./workflow.js";

export async function runReviewSummaryStage(
  payload: ReviewStagePayload,
  triggerRunId: string,
): Promise<ReviewStageResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let session: DaytonaReviewSession | undefined;

  await postReviewEvent({
    reviewRunId: payload.review_run_id,
    triggerRunId,
    status: "summary_review_started",
    payload: {
      runner: "daytona",
      repository: payload.repository.fullName,
      pull_request_number: payload.pull_request_number,
      base_ref: payload.base_ref,
      head_sha: payload.head_sha,
      started_at: startedAt,
    },
  });

  try {
    const access = await createInstallationAccessTokenDetails(payload.installation_id);
    const token = access.token;
    const earlySuperseded = await currentReviewSuperseded({
      token,
      repository: payload.repository,
      pullRequestNumber: payload.pull_request_number,
      headSha: payload.head_sha,
      manual: manualReviewSupersession(payload),
    });
    if (earlySuperseded) {
      await postSummarySupersededEvent({
        payload,
        triggerRunId,
        status: "summary_review_skipped",
        superseded: earlySuperseded,
      });
      logger.info("review_summary_skipped", {
        review_run_id: payload.review_run_id,
        trigger_run_id: triggerRunId,
        repository: payload.repository.fullName,
        pull_request_number: payload.pull_request_number,
        head_sha: payload.head_sha,
        ...earlySuperseded,
      });
      return supersededStageResult({ stage: "summary", startedAt, startedAtMs, superseded: earlySuperseded });
    }

    // The summary stage runs a codegraph-only phase (no LLM calls), so it never
    // needs a model-gateway key. Skip resolveProviderKeys entirely -- its
    // fail-closed throw must not be able to kill this non-LLM phase -- and tell
    // createReviewSession the key is optional. A managed OPENROUTER_API_KEY in the
    // env is still passed through harmlessly if present.
    session = await createReviewSession({
      token,
      reviewRunId: payload.review_run_id,
      modelSettings: payload.model_settings,
      requiresModelKey: false,
    });
    const reviewContextStage = await runDaytonaReviewContext(session, {
      repository: payload.repository,
      token,
      pullRequestNumber: payload.pull_request_number,
      title: payload.title,
      author: payload.author,
      headSha: payload.head_sha,
      baseRef: payload.base_ref,
      headRef: payload.head_ref,
      historyMarkdown: "",
    });
    const codegraph = reviewContextStage.result;

    await postReviewEvent({
      reviewRunId: payload.review_run_id,
      triggerRunId,
      status: "summary_review_completed",
      payload: {
        runner: "daytona",
        daytona_sandbox_id: reviewContextStage.sandboxId,
        repository: payload.repository.fullName,
        pull_request_number: payload.pull_request_number,
        head_sha: payload.head_sha,
        changed_files: codegraph.changedFiles,
        diff_stat: codegraph.diffStat,
        codegraph_context: preview(codegraph.codegraphMarkdown),
        commit: codegraph.commit,
        duration_ms: elapsedMs(startedAtMs),
      },
    });
    logger.info("review_summary_completed", {
      review_run_id: payload.review_run_id,
      repository: payload.repository.fullName,
      pull_request_number: payload.pull_request_number,
      head_sha: payload.head_sha,
      ...reviewContextLogSummary(codegraph),
    });

    const publishSuperseded = await currentReviewSuperseded({
      token,
      repository: payload.repository,
      pullRequestNumber: payload.pull_request_number,
      headSha: payload.head_sha,
      manual: manualReviewSupersession(payload),
    });
    if (publishSuperseded) {
      await postSummarySupersededEvent({
        payload,
        triggerRunId,
        status: "github_summary_comment_publish_skipped",
        superseded: publishSuperseded,
      });
      logger.info("review_summary_finished_superseded", {
        review_run_id: payload.review_run_id,
        trigger_run_id: triggerRunId,
        repository: payload.repository.fullName,
        pull_request_number: payload.pull_request_number,
        head_sha: payload.head_sha,
        codegraph_artifact_completed: true,
        ...publishSuperseded,
      });
      return supersededStageResult({ stage: "summary", startedAt, startedAtMs, superseded: publishSuperseded });
    }

    return stageResult({
      stage: "summary",
      status: "success",
      startedAt,
      startedAtMs,
    });
  } catch (error) {
    const failed = failedStageResult({ stage: "summary", startedAtMs, error });
    await postReviewEvent({
      reviewRunId: payload.review_run_id,
      triggerRunId,
      status: "summary_review_failed",
      payload: {
        runner: "daytona",
        repository: payload.repository.fullName,
        pull_request_number: payload.pull_request_number,
        head_sha: payload.head_sha,
        error: failed.error,
        duration_ms: failed.durationMs,
      },
    });
    logger.warn("review_summary_failed", {
      review_run_id: payload.review_run_id,
      trigger_run_id: triggerRunId,
      repository: payload.repository.fullName,
      pull_request_number: payload.pull_request_number,
      head_sha: payload.head_sha,
      error: failed.error,
      duration_ms: failed.durationMs,
    });
    throw error;
  } finally {
    if (session) {
      await session.dispose();
    }
  }
}

async function postSummarySupersededEvent(input: {
  payload: ReviewStagePayload;
  triggerRunId: string;
  status: string;
  superseded: ReviewSuperseded;
}): Promise<void> {
  await postReviewEvent({
    reviewRunId: input.payload.review_run_id,
    triggerRunId: input.triggerRunId,
    status: input.status,
    payload: {
      repository: input.payload.repository.fullName,
      pull_request_number: input.payload.pull_request_number,
      head_sha: input.payload.head_sha,
      ...input.superseded,
    },
  });
}
