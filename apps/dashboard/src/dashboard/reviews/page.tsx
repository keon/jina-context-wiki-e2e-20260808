"use client";

import { useMemo } from "react";
import { useDashboard } from "../providers";
import { EmptyState, List, Panel, Row, Toolbar } from "../components/ui";
import { formatRelative, shortSha } from "../lib/presentation";
import { buildReviewWork, reviewWorkStatusSummary } from "../lib/review-work";
import { runHref, runTitle } from "../lib/runs";
import type { ReviewRun } from "../lib/types";

const NO_RUNS: readonly ReviewRun[] = [];

interface ReviewRowModel {
  readonly run: ReviewRun;
  readonly statusSummary: string | undefined;
}

export default function ReviewsPage() {
  const { data, loading, error } = useDashboard();
  const runs = data?.review_runs ?? NO_RUNS;

  // `buildReviewWork` is a deep normalization of every review event. Run it once per
  // run whenever the feed actually changes instead of on every poll-driven re-render.
  const rows = useMemo<readonly ReviewRowModel[]>(
    () => runs.map((run) => ({ run, statusSummary: reviewWorkStatusSummary(buildReviewWork(run)) })),
    [runs],
  );

  return (
    <>
      <h1 className="sr-only">Reviews</h1>
      <Toolbar />
      <Panel title="Reviews" count={data ? runs.length : undefined}>
        {/* A failed refresh keeps the last good feed visible, so surface the error
            alongside it rather than replacing the list. */}
        {error && rows.length > 0 ? <div className="notice notice--bad">{error}</div> : null}
        {rows.length > 0 ? (
          <List>
            {rows.map((row) => (
              <ReviewRow key={row.run.review_run_id} run={row.run} statusSummary={row.statusSummary} />
            ))}
          </List>
        ) : error ? (
          <div className="notice notice--bad">Reviews could not be loaded. {error}</div>
        ) : loading || !data ? (
          <div className="notice">Loading reviews...</div>
        ) : (
          <EmptyState>No reviews recorded yet.</EmptyState>
        )}
      </Panel>
    </>
  );
}

function ReviewRow({ run, statusSummary }: { run: ReviewRun; statusSummary: string | undefined }) {
  const branch = run.pull_request.head_ref ? `${run.pull_request.head_ref} @ ${shortSha(run.pull_request.head_sha)}` : shortSha(run.pull_request.head_sha);
  const meta = [run.repository.full_name, branch, statusSummary, run.status].filter(Boolean).join(" · ");
  return (
    <Row
      href={runHref(run)}
      title={runTitle(run)}
      meta={meta || "—"}
      trailing={formatRelative(run.updated_at)}
    />
  );
}
