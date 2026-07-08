import { isReviewTrigger, type GitHubWebhookEvent } from "@jina/github";

export interface WebhookRouteResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly pullRequestNumber?: number;
  readonly headSha?: string;
}

export function handleGitHubWebhook(event: GitHubWebhookEvent): WebhookRouteResult {
  if (!isReviewTrigger(event)) {
    return { accepted: false, reason: "event does not start a review workflow" };
  }

  return {
    accepted: true,
    reason: "review workflow requested",
    pullRequestNumber: event.pullRequestNumber,
    headSha: event.headSha
  };
}
