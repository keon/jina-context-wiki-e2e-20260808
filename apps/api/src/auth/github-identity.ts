export interface GitHubIdentity {
  readonly installationId: string;
  readonly repository: string;
  readonly senderLogin: string;
}

export function githubIdentity(installationId: string, repository: string, senderLogin: string): GitHubIdentity {
  return { installationId, repository, senderLogin };
}
