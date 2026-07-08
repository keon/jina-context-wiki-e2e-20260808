export interface PullRequestComment {
  readonly pullRequestNumber: number;
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface GitHubPublicationGateway {
  upsertComment(comment: PullRequestComment): Promise<void>;
}
