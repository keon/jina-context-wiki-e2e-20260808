export type GitHubWebhookEvent =
  | { readonly type: "pull_request.opened"; readonly pullRequestNumber: number; readonly headSha: string }
  | { readonly type: "pull_request.synchronize"; readonly pullRequestNumber: number; readonly headSha: string }
  | { readonly type: "pull_request.closed"; readonly pullRequestNumber: number; readonly merged: boolean };

export type GitHubReviewTriggerEvent = Extract<
  GitHubWebhookEvent,
  { readonly type: "pull_request.opened" | "pull_request.synchronize" }
>;

export function isReviewTrigger(event: GitHubWebhookEvent): event is GitHubReviewTriggerEvent {
  return event.type === "pull_request.opened" || event.type === "pull_request.synchronize";
}
