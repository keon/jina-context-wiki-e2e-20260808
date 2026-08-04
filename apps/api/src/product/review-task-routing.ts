export const REVIEW_TASK_ID = "review";

// Legacy launch allowlist, kept only as the fallback set when the global switch is turned OFF (kill
// switch). In normal operation reviews are enabled for EVERY installed repo (see reviewTaskTriggerControl).
const allowedReviewTriggerRepositories = new Set([
  "omxyz/jina-simulation",
  "omxyz/jina-code-review-smoke-20260612214910",
]);

export const reviewTaskTriggerControl = {
  // PRODUCTIONIZED: reviews are enabled for ALL installed repositories by default. This is the launch
  // state — every customer's PRs auto-review. As a kill switch, set REVIEW_TRIGGER_ALL_REPOS=false to
  // revert to the allowlist (only the repos above trigger) WITHOUT a code deploy.
  enabled: process.env.REVIEW_TRIGGER_ALL_REPOS !== "false",
  allowedRepositories: allowedReviewTriggerRepositories,
};

export function isReviewTaskTriggerAllowed(repositoryFullName: string | undefined): boolean {
  if (reviewTaskTriggerControl.enabled) {
    return true;
  }
  const normalized = repositoryFullName?.trim().toLowerCase();
  return Boolean(normalized && reviewTaskTriggerControl.allowedRepositories.has(normalized));
}
