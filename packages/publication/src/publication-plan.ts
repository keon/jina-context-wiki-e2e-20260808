export type PublicationMode = "pr_review_comment" | "issue_comment" | "check_run" | "summary_comment";

export interface PublicationPlan {
  readonly mode: PublicationMode;
  readonly findingThreadIds: readonly string[];
}

