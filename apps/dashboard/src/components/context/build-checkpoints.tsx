"use client";

import { contextBuildProgressUrl } from "../../dashboard/lib/context.ts";
import { contextFailureText } from "../../lib/context-failures.ts";
import { formatTime, humanize, shortId } from "../../lib/format.ts";
import { usePoll } from "../../lib/poll.ts";
import type { ContextBuildProgressResponse, ContextBuildSummary, ContextRelease } from "../../lib/types.ts";

export function BuildCheckpoints({
  build,
  tenantId,
  release
}: {
  readonly build: ContextBuildSummary;
  readonly tenantId: string;
  readonly release?: ContextRelease;
}) {
  const progress = usePoll<ContextBuildProgressResponse>(
    contextBuildProgressUrl({ tenantId }, build.id),
    5_000
  );
  const current = progress.data?.buildId === build.id ? progress.data : undefined;
  const pages = current?.pages ?? [];
  const stages = current?.stages ?? build.stages;
  const status = current?.status ?? build.status;
  const verifiedPages = pages.filter((page) => page.validationStatus === "valid").length;
  const invalidPages = pages.filter((page) => page.validationStatus === "invalid").length;
  const failure = contextFailureText(current ?? build);
  const consumedTokens = current?.consumedModelTokens ?? build.consumedModelTokens;
  const tokenBudget = current?.derivationTokenBudget ?? build.derivationTokenBudget;
  const remainingSeconds = current?.remainingExecutionSeconds ?? build.remainingExecutionSeconds;
  const published = status === "completed" && release && build.commitSha === release.commitSha;

  return (
    <details className={`knowledge-build knowledge-build--${status}`} open={status !== "completed" || undefined}>
      <summary>
        <span className={`knowledge-pill knowledge-pill--${status}`}>
          <i aria-hidden="true" />
          {humanize(status)}
        </span>
        <div>
          <strong>{build.buildKind === "causal_graph" ? "Causal graph build" : "Wiki build"}</strong>
          <span>
            {build.repository} / {build.ref} · {shortId(build.id)} · updated{" "}
            {formatTime(current?.updatedAt ?? build.updatedAt)}
          </span>
        </div>
        <div className="knowledge-build__summary">
          {stages.length ? (
            <span>
              {stages.filter((stage) => stage.status === "completed").length}/{stages.length} stages
            </span>
          ) : null}
          {pages.length ? (
            <span>
              {verifiedPages}/{pages.length} pages
            </span>
          ) : null}
          <ChevronIcon />
        </div>
      </summary>

      <div className="knowledge-build__body">
        <div className="knowledge-build__metrics">
          <Metric label="Commit" value={build.commitSha?.slice(0, 12) ?? "Pending"} mono />
          <Metric
            label="Model tokens"
            value={
              consumedTokens === undefined
                ? "Not reported"
                : `${compactNumber(consumedTokens)}${tokenBudget ? ` / ${compactNumber(tokenBudget)}` : ""}`
            }
          />
          <Metric
            label="Execution left"
            value={remainingSeconds === undefined ? "Not reported" : compactDuration(remainingSeconds)}
          />
          <Metric
            label="Checkpoints"
            value={`${verifiedPages} verified${invalidPages ? ` · ${invalidPages} invalid` : ""}`}
          />
        </div>

        {failure ? <p className="knowledge-build__failure">{failure}</p> : null}
        {published ? <p className="knowledge-build__published">Published atomically as release {release.id}.</p> : null}
        {current?.queuedFollowup ? (
          <p className="knowledge-build__followup">
            Next update: {current.queuedFollowup.ref} · {current.queuedFollowup.reason}
          </p>
        ) : null}

        <div className="knowledge-build__rows">
          {stages.map((stage) => {
            const stageFailure = stage.status === "failed" ? contextFailureText(stage) : undefined;
            return (
              <article key={stage.id}>
                <span
                  className={`knowledge-build__stage-icon knowledge-build__stage-icon--${stage.status}`}
                  aria-hidden="true"
                >
                  <StageIcon status={stage.status} />
                </span>
                <div>
                  <strong>{stage.title}</strong>
                  <small>
                    {stage.modelTotalTokens !== undefined ? `${compactNumber(stage.modelTotalTokens)} tokens · ` : ""}
                    attempt {stage.attempt}
                  </small>
                  {stageFailure ? <p>{stageFailure}</p> : null}
                </div>
                <span className={`knowledge-pill knowledge-pill--${stage.status}`}>
                  <i aria-hidden="true" />
                  {humanize(stage.status)}
                </span>
              </article>
            );
          })}
          {pages.map((page) => (
            <article key={page.documentPath}>
              <span
                className={`knowledge-build__stage-icon knowledge-build__stage-icon--${page.validationStatus}`}
                aria-hidden="true"
              >
                <StageIcon status={page.validationStatus} />
              </span>
              <div>
                <strong>{page.title}</strong>
                <small>
                  Checkpoint {page.checkpointSequence} · {formatBytes(page.bytes)}
                </small>
              </div>
              <span className={`knowledge-pill knowledge-pill--${page.validationStatus}`}>
                <i aria-hidden="true" />
                {humanize(page.validationStatus)}
              </span>
            </article>
          ))}
          {stages.length === 0 && pages.length === 0 ? (
            <p className="knowledge-empty-row">The build is waiting for its first checkpoint.</p>
          ) : null}
        </div>
      </div>
    </details>
  );
}

function Metric({
  label,
  value,
  mono = false
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined}>{value}</strong>
    </div>
  );
}

function StageIcon({ status }: { readonly status: string }) {
  if (["completed", "valid", "done"].includes(status)) {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <path
          d="m3.25 8.25 3 3 6.5-6.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (["failed", "invalid"].includes(status)) {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="4.75" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 5v3.1l2 1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m5 6.25 3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function compactDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}
