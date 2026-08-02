import type { ContextArtifactRef } from "./artifact-store.js";

export interface IssueGraphRelease {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha: string;
  readonly buildId: string;
  readonly contentDigest: string;
  readonly artifact: ContextArtifactRef;
  readonly issueCount: number;
  readonly causalityCount: number;
  readonly historyComplete: boolean;
  readonly publishedAt: string;
}

export interface IssueGraphStore {
  publishIssueGraphRelease(release: IssueGraphRelease): Promise<IssueGraphRelease>;
  currentIssueGraphRelease(tenantId: string, repository: string, ref: string): Promise<IssueGraphRelease | undefined>;
  currentAuthorizedIssueGraphRelease(
    tenantId: string,
    repository: string,
    ref: string,
    principalId: string
  ): Promise<IssueGraphRelease | undefined>;
  listIssueGraphReleases(tenantId: string, repository: string, ref: string): Promise<IssueGraphRelease[]>;
}

export interface BoardIssueGraphPublicationCommit {
  readonly release: IssueGraphRelease;
  readonly lease: {
    readonly taskId: string;
    readonly messageId: string;
    readonly attempt: number;
    readonly leaseId: string;
    readonly writeFenceToken: string;
    readonly leaseExpiresAt: string;
  };
}

/** Production fence: durable Board authority and the current pointer commit together. */
export interface BoardIssueGraphPublicationTransactionPort {
  publishIssueGraphAtomically(input: BoardIssueGraphPublicationCommit): Promise<IssueGraphRelease>;
}
