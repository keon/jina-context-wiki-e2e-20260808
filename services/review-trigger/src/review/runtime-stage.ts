import { logger } from "@trigger.dev/sdk";

import type { ReviewFinding } from "./codex-review.js";
import { createReviewSession, runDaytonaRuntimeReview, type DaytonaReviewSession } from "../daytona/review-session.js";
import {
  createInstallationAccessTokenDetails,
  createPullRequestReview,
  createReviewComment,
  listPullRequestReviews,
  listReviewComments,
  probeRepositoryAccess,
} from "../shared/github.js";
import { ProviderConfigurationError, resolveProviderKeys } from "./provider-keys.js";
import { runtimeReviewArtifactLogSummary, runtimeReviewLogSummary, summarizeFindingsForLog } from "./log.js";
import { postInternal } from "../shared/api.js";
import type { RuntimeModelCallSummary, RuntimeReviewFinding, RuntimeReviewResult } from "../runtime-review/index.js";
import type { UsageRecord } from "../daytona/openrouter-proxy.js";
import { buildRuntimeReviewRequest, runtimeReviewMarkers } from "../runtime-review/github.js";
import { errorMessage } from "../shared/utils.js";
import { safeUpsertReviewProgressComment } from "./progress-comment.js";
import {
  contextGraphMcpEnabled,
  createContextGraphMcpAccess,
  type ContextGraphMcpAccess,
} from "../shared/jina-graph.js";
import {
  currentReviewSuperseded,
  elapsedMs,
  failedRepositoryAccess,
  failedStageResult,
  githubPullRequestsWritable,
  manualReviewSupersession,
  postReviewEvent,
  preview,
  stageResult,
  supersededStageResult,
  type ReviewStagePayload,
  type ReviewStageResult,
  type ReviewSuperseded,
  type UsageRecordsFallback,
} from "./workflow.js";

type RuntimePublishResult = {
  publicationStatus?: "published" | "skipped" | "failed";
  publicationReason?: string;
  githubReviewUrl?: string;
  superseded?: ReviewSuperseded;
  inlineCommentCount?: number;
  fileCommentCount?: number;
  skippedFileCommentCount?: number;
  dedupedFileCommentCount?: number;
};

/** Degraded-run waiver ruling: when EVERY model call in a runtime review failed
 *  (attempted > 0, succeeded === 0 -- e.g. the recurring OpenRouter 402 credit
 *  outage), the run published a fallback review that validated nothing. Such a run
 *  still publishes the degraded review (visibility) and still posts its usage rows
 *  (402 rows are reconciliation data), but the stage returns FAILED so the parent
 *  completes the run 'failed' and billing waives infra + AI per outcome gating.
 *  Returns the stage error string for a degraded run, or undefined when the run is
 *  billable: partial success (succeeded > 0) and zero-attempt runs (summary-only /
 *  harness paths with no proxy and no captured model calls) keep completed. */
export function degradedRunStageError(summary: RuntimeModelCallSummary | undefined): string | undefined {
  const attempted = summary?.attempted ?? 0;
  const succeeded = summary?.succeeded ?? 0;
  if (attempted > 0 && succeeded === 0) {
    return `all ${attempted} model call(s) failed — review degraded; run not billed`;
  }
  return undefined;
}

/** True when a native Codex harness credential is permanently unusable and the
 *  author must reconnect it. Keep this narrow: a managed/BYOK gateway failure or
 *  a transient Codex error must never produce a personal-account warning. */
export function codexHarnessReconnectRequired(
  keySource: "user" | "managed" | "harness" | undefined,
  error: string | undefined,
): boolean {
  if (keySource !== "harness" || !error) {
    return false;
  }
  // Codex includes the submitted prompt later in some command failures, so only
  // inspect the diagnostic prefix and require a Codex-auth-specific signature.
  return /codex_login::auth::manager: failed to refresh token:[^\n]*(?:because you have since logged out or signed in to another account|invalid_grant|refresh token was already used)|auth error code:\s*token_expired|provided authentication token is expired\. please try signing in again/i.test(
    error.slice(0, 8_000),
  );
}

export type ProviderFailureCategory = "quota" | "authentication" | "model" | "availability";
export type ProviderQuotaReason = "exhausted" | "rate_limit";

export function providerQuotaReason(error: string | undefined): ProviderQuotaReason | undefined {
  if (!error) return undefined;
  const diagnostic = error.slice(0, 12_000);
  if (
    /0 weighted tokens left|usage limit resets|insufficient[_ ]quota|credit(?:s)? (?:balance|exhausted)|quota exceeded|out of (?:credits|quota)/i.test(
      diagnostic,
    )
  ) {
    return "exhausted";
  }
  return /rate.?limit|too many requests/i.test(diagnostic) ? "rate_limit" : undefined;
}

/** Classify actionable provider failures without treating repository or publication failures as model failures. */
export function providerFailureCategory(error: string | undefined): ProviderFailureCategory | undefined {
  if (!error) return undefined;
  const diagnostic = error.slice(0, 12_000);
  if (/quota|rate.?limit|too many requests|insufficient[_ ]quota|credit(?:s)? (?:balance|exhausted)|usage limit/i.test(diagnostic)) {
    return "quota";
  }
  if (/unauthorized|invalid[_ ](?:api[_ ]?)?key|authentication|invalid_grant|token_expired|refresh token|logged out/i.test(diagnostic)) {
    return "authentication";
  }
  if (/model .*(?:not found|unavailable|unsupported)|unknown model|invalid model/i.test(diagnostic)) {
    return "model";
  }
  if (/openai|openrouter|codex|provider|upstream|service unavailable|bad gateway|gateway timeout/i.test(diagnostic)) {
    return "availability";
  }
  return undefined;
}

export async function runReviewRuntimeStage(
  payload: ReviewStagePayload,
  triggerRunId: string,
): Promise<ReviewStageResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let session: DaytonaReviewSession | undefined;
  let jinaWaitStartedAtMs: number | undefined;
  let jinaCompleted = false;

  await postReviewEvent({
    reviewRunId: payload.review_run_id,
    triggerRunId,
    status: "runtime_review_started",
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
    const repoAccess = await probeRepositoryAccess({ token, repository: payload.repository }).catch(failedRepositoryAccess);
    await postReviewEvent({
      reviewRunId: payload.review_run_id,
      triggerRunId,
      status: repoAccess.ok ? "github_installation_repo_access_ready" : "github_installation_repo_access_failed",
      payload: {
        repository: payload.repository.fullName,
        installation_id: payload.installation_id,
        repo_access_ok: repoAccess.ok,
        repo_access_status: repoAccess.status,
        repo_access_message: repoAccess.message,
      },
    });

    const earlySuperseded = await currentReviewSuperseded({
      token,
      repository: payload.repository,
      pullRequestNumber: payload.pull_request_number,
      headSha: payload.head_sha,
      manual: manualReviewSupersession(payload),
    });
    if (earlySuperseded) {
      await postRuntimeSupersededEvent({
        payload,
        triggerRunId,
        status: "runtime_review_skipped",
        superseded: earlySuperseded,
      });
      logger.info("review_runtime_skipped", {
        ...runtimeLogIdentity(payload, triggerRunId),
        jina_completed: false,
        publication_status: "not_attempted",
        publication_reason: earlySuperseded.reason,
        ...earlySuperseded,
      });
      const result = supersededStageResult({ stage: "runtime", startedAt, startedAtMs, superseded: earlySuperseded });
      result.jinaCompleted = false;
      result.publicationStatus = "not_attempted";
      result.publicationReason = earlySuperseded.reason;
      return result;
    }

    let contextGraphMcp: ContextGraphMcpAccess | undefined;
    if (repoAccess.ok) {
      try {
        contextGraphMcp = await createContextGraphMcpAccess({
          repository: payload.repository.fullName,
          githubRepositoryId: payload.repository.githubRepoId,
          installationId: payload.installation_id,
          pullRequestNumber: payload.pull_request_number,
          reviewRunId: payload.review_run_id,
          headSha: payload.head_sha,
          ...(payload.head_ref ? { headRef: payload.head_ref } : {}),
          baseRef: payload.base_ref,
        });
        if (contextGraphMcp) {
          await postReviewEvent({
            reviewRunId: payload.review_run_id,
            triggerRunId,
            status: "context_graph_mcp_access_ready",
            payload: { repository: payload.repository.fullName, expires_at: contextGraphMcp.expiresAt },
          });
        } else {
          await postReviewEvent({
            reviewRunId: payload.review_run_id,
            triggerRunId,
            status: "context_graph_mcp_not_attached",
            payload: {
              repository: payload.repository.fullName,
              reason: contextGraphMcpEnabled() ? "repository_graph_unavailable" : "disabled",
            },
          });
        }
      } catch (error) {
        await postReviewEvent({
          reviewRunId: payload.review_run_id,
          triggerRunId,
          status: "context_graph_mcp_access_unavailable",
          payload: { repository: payload.repository.fullName, error: errorMessage(error) },
        }).catch(() => undefined);
      }
    }

    let providerKeys = await resolveProviderKeys(payload.installation_id, payload.review_run_id);
    session = await createReviewSession({
      token,
      providerKeys,
      reviewRunId: payload.review_run_id,
      modelSettings: payload.model_settings,
      contextGraphMcp,
    });
    jinaWaitStartedAtMs = Date.now();
    logger.info("review_runtime_jina_wait_started", {
      ...runtimeLogIdentity(payload, triggerRunId),
      runner: "daytona",
      key_source: providerKeys.source ?? "managed",
    });
    const runtimeInput = {
      repository: payload.repository,
      token,
      pullRequestNumber: payload.pull_request_number,
      title: payload.title,
      author: payload.author,
      headSha: payload.head_sha,
      baseRef: payload.base_ref,
      headRef: payload.head_ref,
      historyMarkdown: "",
      reviewInstructions: payload.review_instructions,
    };
    let runtimeStage = await runDaytonaRuntimeReview(session, runtimeInput);
    let result = runtimeStage.result;
    const providerFailure = providerKeys.source === "managed" ? undefined : providerFailureCategory(result.error);
    const failedProviderUsage = providerFailure
      ? await postRuntimeUsage({
          reviewRunId: payload.review_run_id,
          triggerRunId,
          sandboxId: runtimeStage.sandboxId,
          keySource: providerKeys.source ?? "managed",
          usageRecords: result.usage_records,
        })
      : undefined;
    if (providerFailure && payload.model_settings?.review_fallback_policy === "managed") {
      await postReviewEvent({
        reviewRunId: payload.review_run_id,
        triggerRunId,
        status: "review_provider_fallback_started",
        payload: {
          failed_key_source: providerKeys.source,
          category: providerFailure,
          fallback: "managed",
          consumes_organization_credits: true,
        },
      });
      await session.dispose();
      session = await createReviewSession({
        token,
        providerKeys: { source: "managed" },
        reviewRunId: payload.review_run_id,
        modelSettings: payload.model_settings,
        contextGraphMcp,
      });
      providerKeys = { source: "managed" };
      runtimeStage = await runDaytonaRuntimeReview(session, runtimeInput);
      result = runtimeStage.result;
    } else if (providerFailure) {
      jinaCompleted = true;
      const message = `Selected provider failed (${providerFailure}); managed fallback is disabled. ${result.error ?? ""}`.trim();
      await postReviewEvent({
        reviewRunId: payload.review_run_id,
        triggerRunId,
        status: "review_provider_failed",
        payload: {
          key_source: providerKeys.source,
          category: providerFailure,
          ...(providerFailure === "quota"
            ? { quota_reason: providerQuotaReason(result.error) }
            : {}),
          fallback_policy: "fail_notify",
          error: result.error,
          notification_required: true,
        },
      });
      await safeUpsertReviewProgressComment({
        token,
        payload,
        triggerRunId,
        status: "github_review_provider_failure_notified",
        update: {
          status: "Blocked",
          findings: "Unavailable",
          notice: {
            kind: "provider_failure",
            category: providerFailure,
            provider: providerKeys.source === "harness" ? "codex" : "byok",
            ...(providerFailure === "quota"
              ? { quotaReason: providerQuotaReason(result.error) }
              : {}),
          },
        },
      });
      const outcome = stageResult({
        stage: "runtime",
        status: "failed",
        error: message,
        startedAt,
        startedAtMs,
        jinaCompleted: true,
        publicationStatus: "not_attempted",
        publicationReason: "provider failure",
      });
      if (failedProviderUsage) outcome.usage_records_fallback = failedProviderUsage;
      return outcome;
    }
    jinaCompleted = true;
    logger.info("review_runtime_jina_wait_completed", {
      ...runtimeLogIdentity(payload, triggerRunId),
      runner: "daytona",
      daytona_sandbox_id: runtimeStage.sandboxId,
      jina_completed: true,
      jina_wait_duration_ms: elapsedMs(jinaWaitStartedAtMs),
      ...runtimeReviewLogSummary(result),
    });
    const reviewRequest = buildRuntimeReviewRequest({
      result,
      headSha: payload.head_sha,
      reviewRunId: payload.review_run_id,
      fallbackFilePath: result.changedFiles[0],
      issueMarkers: true,
      publishFileComments: true,
    });

    await postReviewEvent({
      reviewRunId: payload.review_run_id,
      triggerRunId,
      status: "runtime_review_completed",
      payload: {
        runner: "daytona",
        daytona_sandbox_id: runtimeStage.sandboxId,
        repository: payload.repository.fullName,
        pull_request_number: payload.pull_request_number,
        head_sha: payload.head_sha,
        status: result.status,
        summary: result.summary,
        findings_count: result.findings.length,
        comments_count: result.commentsCount ?? result.comments?.length ?? 0,
        publishable_findings_count: reviewRequest.publishableFindings.length,
        inline_comment_count: reviewRequest.comments.length,
        file_comment_count: reviewRequest.fileComments.length,
        unanchored_findings_count: reviewRequest.unanchoredFindings.length,
        low_confidence_findings_held_back: reviewRequest.lowConfidenceFindings.length,
        areas_count: result.areas.length,
        tasks_count: result.areas.reduce((sum, area) => sum + area.tasks.length, 0),
        blocked_count: result.areas.reduce((sum, area) => sum + area.blocked.length, 0),
        changed_files: result.changedFiles,
        diff_stat: result.diffStat,
        runtime_review: runtimeReviewEventPayload(result, reviewRequest),
        mcps_enabled: contextGraphMcp
          ? [{
              server: "jina_context",
              tools: ["search_context", "list_context", "read_context", "diff_context"],
            }]
          : [],
        mcp_usage_events: result.model_call_summary?.mcpUsageEvents ?? [],
        findings: reviewRequest.publishableFindings.map(runtimeFindingForPersistence),
        markdown_preview: preview(result.markdown),
        error: result.error,
        key_source: providerKeys.source ?? "managed",
        codex_harness_reconnect_required: codexHarnessReconnectRequired(providerKeys.source, result.error),
        codex_harness_connected_at_ms: providerKeys.codexHarnessConnectedAtMs,
        duration_ms: elapsedMs(startedAtMs),
      },
    });
    logger.info("review_runtime_completed", {
      review_run_id: payload.review_run_id,
      repository: payload.repository.fullName,
      pull_request_number: payload.pull_request_number,
      head_sha: payload.head_sha,
      ...runtimeReviewLogSummary(result, reviewRequest),
      file_comment_count: reviewRequest.fileComments.length,
    });
    logger.info("review_runtime_findings", {
      review_run_id: payload.review_run_id,
      repository: payload.repository.fullName,
      pull_request_number: payload.pull_request_number,
      head_sha: payload.head_sha,
      ...summarizeFindingsForLog(result.findings, reviewRequest),
    });
    logger.info("review_runtime_artifacts", {
      ...runtimeLogIdentity(payload, triggerRunId),
      daytona_sandbox_id: runtimeStage.sandboxId,
      ...runtimeReviewArtifactLogSummary(result),
    });

    // Post captured usage AFTER the review event has persisted the review content.
    // Usage delivery is resilient, not fatal: postRuntimeUsage retries in-stage,
    // and on final failure returns the records as a fallback (instead of throwing)
    // so the whole expensive stage is not retried and an already-published review
    // is never marked 'failed'. The fallback is attached to the returned stage
    // result; the parent forwards it in the completion payload for (replay-safe)
    // server-side persistence. key_source is posted from here, the authoritative
    // source: it reflects the key actually resolved for this run.
    //
    // Harness runs (source: "harness") run native Codex on the author's ChatGPT
    // subscription with no capture proxy, so result.usage_records is empty and
    // postRuntimeUsage short-circuits (nothing is posted). key_source is therefore
    // never reconciled server-side for harness runs -- acceptable for v1 since
    // those runs are billed infra-only, not per-usage-row.
    const usageFallback = await postRuntimeUsage({
      reviewRunId: payload.review_run_id,
      triggerRunId,
      sandboxId: runtimeStage.sandboxId,
      keySource: providerKeys.source ?? "managed",
      usageRecords: result.usage_records,
    });
    // Attach the usage fallback (if any) to whichever stage result is returned
    // from here on. A successful post yields no fallback, avoiding double delivery.
    const withUsageFallback = (stageOutcome: ReviewStageResult): ReviewStageResult => {
      if (usageFallback) {
        stageOutcome.usage_records_fallback = usageFallback;
      }
      return stageOutcome;
    };

    if (!githubPullRequestsWritable(access.permissions)) {
      const reason = "installation token lacks pull_requests:write";
      await postReviewEvent({
        reviewRunId: payload.review_run_id,
        triggerRunId,
        status: "github_runtime_review_publish_skipped",
        payload: {
          repository: payload.repository.fullName,
          pull_request_number: payload.pull_request_number,
          head_sha: payload.head_sha,
          reason,
          pull_requests_permission: access.permissions.pull_requests ?? "none",
        },
      });
      logger.info("github_runtime_review_publish_skipped", {
        ...runtimeLogIdentity(payload, triggerRunId),
        jina_completed: true,
        publication_status: "skipped",
        publication_reason: reason,
        pull_requests_permission: access.permissions.pull_requests ?? "none",
        ...publicationPlanLog(result, reviewRequest),
      });
      return withUsageFallback(stageResult({
        stage: "runtime",
        status: "skipped",
        skippedReason: reason,
        jinaCompleted: true,
        publicationStatus: "skipped",
        publicationReason: reason,
        startedAt,
        startedAtMs,
        findings: reviewRequest.publishableFindings.map(runtimeFindingForPersistence),
      }));
    }

    const superseded = await currentReviewSuperseded({
      token,
      repository: payload.repository,
      pullRequestNumber: payload.pull_request_number,
      headSha: payload.head_sha,
      manual: manualReviewSupersession(payload),
    });
    if (superseded) {
      await postRuntimeSupersededEvent({
        payload,
        triggerRunId,
        status: "github_runtime_review_publish_skipped",
        superseded,
      });
      logger.info("github_runtime_review_publish_skipped", {
        ...runtimeLogIdentity(payload, triggerRunId),
        jina_completed: true,
        publication_status: "skipped",
        publication_reason: superseded.reason,
        ...superseded,
      });
      const outcome = supersededStageResult({ stage: "runtime", startedAt, startedAtMs, superseded });
      outcome.jinaCompleted = true;
      outcome.publicationStatus = "skipped";
      outcome.publicationReason = superseded.reason;
      return withUsageFallback(outcome);
    }

    let publish: RuntimePublishResult = {};
    const publishStartedAtMs = Date.now();
    logger.info("github_runtime_review_publish_started", {
      ...runtimeLogIdentity(payload, triggerRunId),
      jina_completed: true,
      publication_status: "attempting",
      ...publicationPlanLog(result, reviewRequest),
    });
    try {
      publish = await publishRuntimeReview({
        token,
        payload,
        result,
        reviewRequest,
        triggerRunId,
      });
    } catch (error) {
      const message = errorMessage(error);
      logger.warn("runtime_review_publish_failed", {
        review_run_id: payload.review_run_id,
        repository: payload.repository.fullName,
        pull_request_number: payload.pull_request_number,
        head_sha: payload.head_sha,
        trigger_run_id: triggerRunId,
        jina_completed: true,
        publication_status: "failed",
        publication_reason: message,
        publish_duration_ms: elapsedMs(publishStartedAtMs),
        total_duration_ms: elapsedMs(startedAtMs),
        ...publicationPlanLog(result, reviewRequest),
        error: message,
      });
      await postReviewEvent({
        reviewRunId: payload.review_run_id,
        triggerRunId,
        status: "github_runtime_review_publish_failed",
        payload: {
          repository: payload.repository.fullName,
          pull_request_number: payload.pull_request_number,
          head_sha: payload.head_sha,
          error: message,
          planned_inline_comment_count: reviewRequest.comments.length,
          planned_file_comment_count: reviewRequest.fileComments.length,
          publishable_findings_count: reviewRequest.publishableFindings.length,
        },
      });
      publish = { publicationStatus: "failed", publicationReason: message };
    }
    if (publish.superseded) {
      const outcome = supersededStageResult({ stage: "runtime", startedAt, startedAtMs, superseded: publish.superseded });
      outcome.jinaCompleted = true;
      outcome.publicationStatus = publish.publicationStatus ?? "skipped";
      outcome.publicationReason = publish.publicationStatus === "published"
        ? `review published; remaining publication skipped: ${publish.superseded.reason}`
        : publish.superseded.reason;
      outcome.githubReviewUrl = publish.githubReviewUrl;
      logger.info(
        publish.publicationStatus === "published"
          ? "github_runtime_review_published_remaining_publish_skipped"
          : "github_runtime_review_publish_skipped",
        {
          ...runtimeLogIdentity(payload, triggerRunId),
          jina_completed: true,
          publication_status: outcome.publicationStatus,
          publication_reason: outcome.publicationReason,
          github_review_url: outcome.githubReviewUrl,
          ...publish.superseded,
        },
      );
      return withUsageFallback(outcome);
    }

    // Degraded-run waiver: the review has already been published to the PR and
    // usage rows already posted above. If EVERY model call failed, return a FAILED
    // stage result (never throw -- a thrown error would let Trigger retry the whole
    // expensive stage, burning more credits) so the parent completes the run
    // 'failed' and billing waives it. Partial/zero-attempt runs stay 'success'.
    const degradedError = degradedRunStageError(result.model_call_summary);
    const stageOutcome = stageResult({
      stage: "runtime",
      status: degradedError ? "failed" : "success",
      error: degradedError,
      startedAt,
      startedAtMs,
      githubReviewUrl: publish.githubReviewUrl,
      jinaCompleted: true,
      publicationStatus: publish.publicationStatus ?? "failed",
      publicationReason: publish.publicationReason,
      findings: reviewRequest.publishableFindings.map(runtimeFindingForPersistence),
    });
    logger.info("review_runtime_finished", {
      ...runtimeLogIdentity(payload, triggerRunId),
      stage_status: stageOutcome.status,
      jina_completed: true,
      publication_status: stageOutcome.publicationStatus,
      publication_reason: stageOutcome.publicationReason,
      github_review_url: stageOutcome.githubReviewUrl,
      duration_ms: stageOutcome.durationMs,
    });
    return withUsageFallback(stageOutcome);
  } catch (error) {
    const failed = failedStageResult({ stage: "runtime", startedAtMs, error });
    await postReviewEvent({
      reviewRunId: payload.review_run_id,
      triggerRunId,
      status: "runtime_review_failed",
      payload: {
        runner: "daytona",
        repository: payload.repository.fullName,
        pull_request_number: payload.pull_request_number,
        head_sha: payload.head_sha,
        error: failed.error,
        duration_ms: failed.durationMs,
      },
    });
    logger.warn(jinaWaitStartedAtMs && !jinaCompleted ? "review_runtime_jina_wait_failed" : "review_runtime_failed", {
      ...runtimeLogIdentity(payload, triggerRunId),
      jina_completed: jinaCompleted,
      publication_status: "not_attempted",
      jina_wait_duration_ms: jinaWaitStartedAtMs ? elapsedMs(jinaWaitStartedAtMs) : undefined,
      duration_ms: failed.durationMs,
      error: failed.error,
    });
    if (error instanceof ProviderConfigurationError) {
      return failed;
    }
    throw error;
  } finally {
    if (session) {
      await session.dispose();
    }
  }
}

/** In-stage retry backoff (ms) between usage-post attempts: after the 1st failure
 *  wait 1s, after the 2nd wait 3s, then give up and fall back. */
const USAGE_POST_BACKOFF_MS = [1_000, 3_000];
const USAGE_POST_ATTEMPTS = 3;

export type PostRuntimeUsageDeps = {
  post?: (path: string, body: unknown) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  backoffMs?: number[];
};

/** Deliver captured usage to the usage endpoint, resiliently. Retries up to
 *  {@link USAGE_POST_ATTEMPTS} attempts with short backoff; on final failure it
 *  does NOT throw (which would fail the attempt and retry the whole expensive
 *  stage, possibly marking an already-published review 'failed'). Instead it logs
 *  a warning and returns the records as a fallback for the caller to attach to the
 *  stage result. A successful post returns undefined (no fallback -- avoids double
 *  delivery). Server-side dedupe by (review_run_id, dedupe_key) keeps replays and
 *  the fallback path idempotent. */
export async function postRuntimeUsage(
  input: {
    reviewRunId: string;
    triggerRunId: string;
    sandboxId: string;
    keySource: "user" | "managed" | "harness";
    usageRecords?: UsageRecord[];
  },
  deps: PostRuntimeUsageDeps = {},
): Promise<UsageRecordsFallback | undefined> {
  const usageRecords = input.usageRecords ?? [];
  if (usageRecords.length === 0) {
    return undefined;
  }
  const post = deps.post ?? postInternal;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = deps.attempts ?? USAGE_POST_ATTEMPTS;
  const backoffMs = deps.backoffMs ?? USAGE_POST_BACKOFF_MS;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await post(`/internal/reviews/${input.reviewRunId}/usage`, {
        trigger_run_id: input.triggerRunId,
        stage: "runtime",
        sandbox_id: input.sandboxId,
        key_source: input.keySource,
        usage_records: usageRecords,
      });
      return undefined;
    } catch (error) {
      if (attempt >= attempts) {
        logger.warn("runtime_review_usage_post_failed_fallback", {
          review_run_id: input.reviewRunId,
          sandbox_id: input.sandboxId,
          usage_record_count: usageRecords.length,
          attempts,
          error: errorMessage(error),
        });
        return {
          stage: "runtime",
          sandbox_id: input.sandboxId,
          key_source: input.keySource,
          usage_records: usageRecords,
        };
      }
      await sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 1_000);
    }
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postRuntimeSupersededEvent(input: {
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

async function publishRuntimeReview(input: {
  token: string;
  payload: ReviewStagePayload;
  result: RuntimeReviewResult;
  reviewRequest: ReturnType<typeof buildRuntimeReviewRequest>;
  triggerRunId: string;
}): Promise<RuntimePublishResult> {
  const publishStartedAtMs = Date.now();
  const markers = runtimeReviewMarkers(input.payload.head_sha, input.payload.review_run_id);
  const existingReviews = await listPullRequestReviews({
    token: input.token,
    repository: input.payload.repository,
    pullRequestNumber: input.payload.pull_request_number,
  });
  const existingReview = existingReviews.find((review) => markers.some((marker) => review.body?.includes(marker)));

  let githubReviewUrl = existingReview?.html_url;
  let inlineCommentCount = 0;
  if (!existingReview) {
    const superseded = await publishSuperseded(input);
    if (superseded) {
      return { superseded, publicationStatus: "skipped", publicationReason: superseded.reason };
    }
    const githubReview = await createPullRequestReview({
      token: input.token,
      repository: input.payload.repository,
      pullRequestNumber: input.payload.pull_request_number,
      body: input.reviewRequest.body,
      comments: input.reviewRequest.comments,
    });
    githubReviewUrl = githubReview.html_url;
    inlineCommentCount = input.reviewRequest.comments.length;
  }

  let existingComments: Awaited<ReturnType<typeof listReviewComments>> = [];
  let canPublishFileComments = true;
  let fileCommentCount = 0;
  let skippedFileCommentCount = 0;
  let dedupedFileCommentCount = 0;
  let fileCommentDedupeUnavailable = false;
  try {
    existingComments = await listReviewComments({
      token: input.token,
      repository: input.payload.repository,
      pullRequestNumber: input.payload.pull_request_number,
    });
  } catch (error) {
    canPublishFileComments = false;
    fileCommentDedupeUnavailable = true;
    skippedFileCommentCount = input.reviewRequest.fileComments.length;
    await postReviewEvent({
      reviewRunId: input.payload.review_run_id,
      triggerRunId: input.triggerRunId,
      status: "github_runtime_file_comment_dedupe_unavailable",
      payload: {
        repository: input.payload.repository.fullName,
        pull_request_number: input.payload.pull_request_number,
        head_sha: input.payload.head_sha,
        skipped_file_comment_count: input.reviewRequest.fileComments.length,
        error: errorMessage(error),
      },
    });
  }
  if (canPublishFileComments) {
    const superseded = await publishSuperseded(input);
    if (superseded) {
      return {
        githubReviewUrl,
        superseded,
        publicationStatus: existingReview ? "skipped" : "published",
        publicationReason: superseded.reason,
      };
    }
    for (const comment of input.reviewRequest.fileComments) {
      if (
        existingComments.some((existing) =>
          existing.body?.includes(`"reviewRunId":"${input.payload.review_run_id}"`) &&
          existing.body?.includes(`"headSha":"${input.payload.head_sha}"`) &&
          existing.body.includes(`"stage":"runtime"`) &&
          (!comment.fingerprint || existing.body.includes(`"fingerprint":"${comment.fingerprint}"`)),
        )
      ) {
        dedupedFileCommentCount += 1;
        continue;
      }
      await createReviewComment({
        token: input.token,
        repository: input.payload.repository,
        pullRequestNumber: input.payload.pull_request_number,
        commitId: input.result.commit || input.payload.head_sha,
        path: comment.path,
        body: comment.body,
      });
      fileCommentCount += 1;
    }
  }

  await postReviewEvent({
    reviewRunId: input.payload.review_run_id,
    triggerRunId: input.triggerRunId,
    status: existingReview ? "github_runtime_review_publish_skipped" : "github_runtime_review_published",
    payload: {
      repository: input.payload.repository.fullName,
      pull_request_number: input.payload.pull_request_number,
      head_sha: input.payload.head_sha,
      reason: existingReview ? "runtime review already published for this review run" : undefined,
      jina_completed: true,
      publication_status: existingReview ? "skipped" : "published",
      publish_duration_ms: elapsedMs(publishStartedAtMs),
      github_review_id: existingReview?.id,
      github_review_url: githubReviewUrl,
      inline_comment_count: inlineCommentCount,
      planned_inline_comment_count: input.reviewRequest.comments.length,
      file_comment_count: fileCommentCount,
      planned_file_comment_count: input.reviewRequest.fileComments.length,
      skipped_file_comment_count: skippedFileCommentCount,
      deduped_file_comment_count: dedupedFileCommentCount,
      file_comment_dedupe_unavailable: fileCommentDedupeUnavailable,
      unanchored_findings_count: input.reviewRequest.unanchoredFindings.length,
      publishable_findings_count: input.reviewRequest.publishableFindings.length,
    },
  });

  const publicationStatus = existingReview ? "skipped" : "published";
  const publicationReason = existingReview ? "runtime review already published for this review run" : undefined;
  logger.info(existingReview ? "github_runtime_review_publish_skipped" : "github_runtime_review_published", {
    ...runtimeLogIdentity(input.payload, input.triggerRunId),
    jina_completed: true,
    publication_status: publicationStatus,
    publication_reason: publicationReason,
    github_review_id: existingReview?.id,
    github_review_url: githubReviewUrl,
    publish_duration_ms: elapsedMs(publishStartedAtMs),
    inline_comment_count: inlineCommentCount,
    planned_inline_comment_count: input.reviewRequest.comments.length,
    file_comment_count: fileCommentCount,
    planned_file_comment_count: input.reviewRequest.fileComments.length,
    skipped_file_comment_count: skippedFileCommentCount,
    deduped_file_comment_count: dedupedFileCommentCount,
    file_comment_dedupe_unavailable: fileCommentDedupeUnavailable,
    ...publicationPlanLog(input.result, input.reviewRequest),
  });

  return {
    publicationStatus,
    publicationReason,
    githubReviewUrl,
    inlineCommentCount,
    fileCommentCount,
    skippedFileCommentCount,
    dedupedFileCommentCount,
  };
}

async function publishSuperseded(input: {
  token: string;
  payload: ReviewStagePayload;
  triggerRunId: string;
}): Promise<ReviewSuperseded | undefined> {
  const superseded = await currentReviewSuperseded({
    token: input.token,
    repository: input.payload.repository,
    pullRequestNumber: input.payload.pull_request_number,
    headSha: input.payload.head_sha,
    manual: manualReviewSupersession(input.payload),
  });
  if (!superseded) {
    return undefined;
  }
  await postRuntimeSupersededEvent({
    payload: input.payload,
    triggerRunId: input.triggerRunId,
    status: "github_runtime_review_publish_skipped",
    superseded,
  });
  return superseded;
}

function runtimeReviewEventPayload(
  result: RuntimeReviewResult,
  reviewRequest: ReturnType<typeof buildRuntimeReviewRequest>,
): Record<string, unknown> {
  const tasks = result.areas.flatMap((area) =>
    area.tasks.map((task) => ({
      ...task,
      areaId: area.areaId,
      areaTitle: area.title,
    })),
  );
  const blocked = result.areas.flatMap((area) =>
    area.blocked.map((item) => ({
      ...item,
      areaId: area.areaId,
      areaTitle: area.title,
    })),
  );
  const nonIssues = result.areas.flatMap((area) =>
    area.nonIssues.map((item) => ({
      ...item,
      areaId: area.areaId,
      areaTitle: area.title,
    })),
  );

  return {
    schemaVersion: result.schemaVersion,
    status: result.status,
    summary: result.summary,
    // Persist only our work product, not raw inputs. `context` carried the full diff patch
    // (up to 12MB), CodeGraph dump, raw PR-thread bodies, and transient sandbox paths -- none
    // of which any consumer reads. The dashboard's only needs (commit/changedFiles/diffStat)
    // are already emitted top-level below.
    intent: result.intent,
    plan: result.plan,
    investigations: result.investigations ?? result.areas,
    finalReview: result.finalReview,
    readiness: result.readiness,
    publication: result.publication,
    jinaConfiguration: result.jinaConfiguration,
    commit: result.commit,
    changedFiles: result.changedFiles,
    diffStat: result.diffStat,
    areas: result.areas,
    tasks,
    findings: result.findings,
    comments: result.comments ?? [],
    blocked,
    nonIssues,
    areasCount: result.areas.length,
    tasksCount: tasks.length,
    findingsCount: result.findings.length,
    commentsCount: result.commentsCount ?? result.comments?.length ?? 0,
    publishableFindingsCount: reviewRequest.publishableFindings.length,
    inlineCommentCount: reviewRequest.comments.length,
    fileCommentCount: reviewRequest.fileComments.length,
    unanchoredFindingsCount: reviewRequest.unanchoredFindings.length,
    lowConfidenceFindingsHeldBack: reviewRequest.lowConfidenceFindings.length,
    blockedCount: blocked.length,
    nonIssuesCount: nonIssues.length,
    error: result.error,
  };
}

function runtimeLogIdentity(payload: ReviewStagePayload, triggerRunId: string): Record<string, unknown> {
  return {
    review_run_id: payload.review_run_id,
    trigger_run_id: triggerRunId,
    parent_trigger_run_id: payload.parent_trigger_run_id,
    repository: payload.repository.fullName,
    pull_request_number: payload.pull_request_number,
    head_sha: payload.head_sha,
  };
}

function publicationPlanLog(
  result: RuntimeReviewResult,
  reviewRequest: ReturnType<typeof buildRuntimeReviewRequest>,
): Record<string, unknown> {
  return {
    merge_score: result.readiness?.score ?? result.finalReview?.readiness.score,
    merge_recommendation: result.readiness?.recommendation ?? result.finalReview?.readiness.recommendation,
    summarized_issue_count: result.publication?.issues.length ?? 0,
    summarized_area_count: result.publication?.areaSummaries.length ?? 0,
    raw_finding_count: result.findings.length,
    publishable_findings_count: reviewRequest.publishableFindings.length,
    planned_inline_comment_count: reviewRequest.comments.length,
    planned_file_comment_count: reviewRequest.fileComments.length,
    unanchored_findings_count: reviewRequest.unanchoredFindings.length,
  };
}

function runtimeFindingForPersistence(finding: RuntimeReviewFinding): ReviewFinding {
  return {
    fingerprint: `runtime:${finding.fingerprint}`,
    file_path: finding.file_path,
    line_number: finding.line_number,
    severity: finding.risk,
    category: finding.category,
    body: findingBody([
      finding.title,
      finding.likelihood ? `Likelihood: ${finding.likelihood}` : undefined,
      finding.body,
      finding.root_cause ? `Root cause: ${finding.root_cause}` : undefined,
      finding.why_it_matters ? `Impact: ${finding.why_it_matters}` : undefined,
      finding.reproduction_or_trace ? `Reproduction or trace: ${finding.reproduction_or_trace}` : undefined,
      finding.suggested_fix ? `Suggested fix: ${finding.suggested_fix}` : undefined,
      finding.evidence.length > 0 ? `Evidence: ${finding.evidence.join("; ")}` : undefined,
      finding.audit_trail.length > 0 ? `Audit trail: ${finding.audit_trail.join("; ")}` : undefined,
    ]),
  };
}

function findingBody(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}
