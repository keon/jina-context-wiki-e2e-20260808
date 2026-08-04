"use client";

import { useDashboard } from "../providers";
import { EmptyState, List, Panel, Row, Toolbar } from "../components/ui";
import { formatRelative, shortSha } from "../lib/presentation";
import { buildReviewWork, reviewWorkStatusSummary } from "../lib/review-work";
import { runHref, runTitle } from "../lib/runs";
import type { ReviewRun } from "../lib/types";

export default function ReviewsPage() {
  const { data } = useDashboard();
  const runs = data?.review_runs ?? [];

  return (
    <>
      <h1 className="sr-only">Reviews</h1>
      <Toolbar />
      <Panel title="Reviews" count={runs.length}>
        {runs.length === 0 ? (
          <EmptyState>No reviews recorded yet.</EmptyState>
        ) : (
          <List>
            {runs.map((run) => (
              <ReviewRow key={run.review_run_id} run={run} />
            ))}
          </List>
        )}
      </Panel>
    </>
  );
}

function ReviewRow({ run }: { run: ReviewRun }) {
  const work = buildReviewWork(run);
  const branch = run.pull_request.head_ref ? `${run.pull_request.head_ref} @ ${shortSha(run.pull_request.head_sha)}` : shortSha(run.pull_request.head_sha);
  const meta = [run.repository.full_name, branch, reviewWorkStatusSummary(work), run.status].filter(Boolean).join(" · ");
  return (
    <Row
      href={runHref(run)}
      title={runTitle(run)}
      meta={meta || "—"}
      trailing={formatRelative(run.updated_at)}
    />
  );
}
