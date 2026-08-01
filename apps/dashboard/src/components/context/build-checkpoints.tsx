"use client";

import { contextFailureText } from "../../lib/context-failures.ts";
import { formatTime, humanize, shortId } from "../../lib/format.ts";
import { usePoll } from "../../lib/poll.ts";
import type { ContextBuildProgressResponse, ContextBuildSummary, ContextRelease } from "../../lib/types.ts";

export function BuildCheckpoints({
  build,
  release
}: {
  readonly build: ContextBuildSummary;
  readonly release?: ContextRelease;
}) {
  const progress = usePoll<ContextBuildProgressResponse>(
    `/api/context/builds/${encodeURIComponent(build.id)}/progress`,
    5_000
  );
  const currentProgress = progress.data?.buildId === build.id ? progress.data : undefined;
  const pages = currentProgress?.pages ?? [];
  const stages = currentProgress?.stages ?? build.stages;
  const status = currentProgress?.status ?? build.status;
  const publishedRelease =
    status === "completed" && release && build.commitSha === release.commitSha ? release : undefined;
  const invalidPages = pages.filter((page) => page.validationStatus === "invalid").length;
  const buildFailure = contextFailureText(currentProgress ?? build);
  const tokenBudget = currentProgress?.derivationTokenBudget ?? build.derivationTokenBudget;
  const consumedTokens = currentProgress?.consumedModelTokens ?? build.consumedModelTokens;
  const activeReservedTokens = currentProgress?.activeModelReservedTokens ?? build.activeModelReservedTokens;
  const remainingTokens = currentProgress?.remainingModelTokens ?? build.remainingModelTokens;
  const deadline = currentProgress?.derivationDeadlineAt ?? build.derivationDeadlineAt;
  return (
    <section className="context-operations-panel" aria-label="Context build checkpoints">
      <header className="context-panel-heading">
        <div>
          <span className="context-eyebrow">Build checkpoints</span>
          <h2>{build.ref}</h2>
        </div>
        <span className={`context-status ${status}`}>{humanize(status)}</span>
      </header>
      <p className="context-structure-note">
        Build <code title={build.id}>{shortId(build.id)}</code>
        {build.commitSha ? (
          <>
            {" "}
            at <code>{build.commitSha.slice(0, 12)}</code>
          </>
        ) : null}
        {" · "}
        updated {formatTime(currentProgress?.updatedAt ?? build.updatedAt)}
        {tokenBudget !== undefined && consumedTokens !== undefined
          ? ` · ${compactNumber(consumedTokens)} / ${compactNumber(tokenBudget)} model tokens`
          : ""}
        {activeReservedTokens ? ` · ${compactNumber(activeReservedTokens)} actively reserved` : ""}
        {remainingTokens !== undefined ? ` · ${compactNumber(remainingTokens)} remaining` : ""}
        {deadline ? ` · deadline ${formatTime(deadline)}` : ""}
      </p>
      <p className={`context-alert ${status === "failed" || invalidPages > 0 ? "danger" : ""}`}>
        {status === "failed" && buildFailure
          ? `Build failed — ${buildFailure}`
          : publishedRelease
            ? `Published atomically as release ${publishedRelease.id}.`
            : `${pages.filter((page) => page.validationStatus === "valid").length} verified checkpoint${
                pages.filter((page) => page.validationStatus === "valid").length === 1 ? "" : "s"
              }; checkpoint pages are private and unpublished.`}
        {invalidPages > 0 ? ` ${invalidPages} page${invalidPages === 1 ? "" : "s"} failed validation.` : ""}
      </p>
      <div className="context-projector-table">
        {stages.map((stage) => {
          const stageFailure = stage.status === "failed" ? contextFailureText(stage) : undefined;
          return (
            <div className="context-projector-row" key={stage.id}>
              <div className="context-stage-details">
                <strong title={stage.type}>{stage.title}</strong>
                {stage.modelTotalTokens !== undefined ? (
                  <span className="muted">
                    {compactNumber(stage.modelTotalTokens)} tokens ({compactNumber(stage.modelInputTokens ?? 0)} in /{" "}
                    {compactNumber(stage.modelOutputTokens ?? 0)} out)
                  </span>
                ) : null}
                {stage.lastRetryFailureReason ? (
                  <span className="context-failure-reason">
                    Previous attempt: {stage.lastRetryFailureReason}
                    {stage.lastRetryAt ? ` · ${formatTime(stage.lastRetryAt)}` : ""}
                  </span>
                ) : null}
                {stageFailure ? <span className="context-failure-reason">{stageFailure}</span> : null}
              </div>
              <span className={`context-status ${stage.status}`}>
                {humanize(stage.status)}
                {stage.attempt > 1 ? ` · attempt ${stage.attempt}` : ""}
              </span>
            </div>
          );
        })}
        {pages.map((page) => (
          <div className="context-projector-row" key={page.documentPath}>
            <strong>{page.title}</strong>
            <span className={`context-status ${page.validationStatus}`}>
              {humanize(page.validationStatus)} · checkpoint {page.checkpointSequence}
            </span>
          </div>
        ))}
        {stages.length === 0 && pages.length === 0 ? (
          <p className="context-panel-empty">The build has been admitted and is waiting for its first checkpoint.</p>
        ) : null}
      </div>
    </section>
  );
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
