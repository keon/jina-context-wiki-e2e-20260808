export const REVIEW_TASK_ID = "review";

export const reviewTaskTriggerControl = {
  // Reviews are enabled for every installed repository by default. The setting
  // is a global kill switch, not a repository compatibility allowlist.
  enabled: process.env.REVIEW_TRIGGER_ALL_REPOS !== "false",
};

export function isReviewTaskTriggerAllowed(_repositoryFullName: string | undefined): boolean {
  return reviewTaskTriggerControl.enabled;
}
