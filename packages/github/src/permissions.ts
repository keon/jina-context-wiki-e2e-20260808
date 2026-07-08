export type GitHubPermission = "contents:read" | "pull_requests:read" | "pull_requests:write" | "issues:write";

export interface GitHubInstallationAccess {
  readonly installationId: string;
  readonly permissions: readonly GitHubPermission[];
}

export function canPublishReview(access: GitHubInstallationAccess): boolean {
  return access.permissions.includes("pull_requests:write") && access.permissions.includes("issues:write");
}
