import { shortSha } from "./presentation";
import type { ReviewRun } from "./types";

export function runHref(run: ReviewRun): string {
  return `/reviews/${encodeURIComponent(run.review_run_id)}`;
}

/** Human label for a run: PR title when present, otherwise the short SHA. */
export function runTitle(run: ReviewRun): string {
  const title = run.pull_request.title?.trim();
  if (title) {
    return run.pull_request.number ? `#${run.pull_request.number} ${title}` : title;
  }
  return shortSha(run.pull_request.head_sha);
}
