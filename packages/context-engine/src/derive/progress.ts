/**
 * A page a derivation has finished, before the run that wrote it has ended.
 *
 * The file contract finishes pages one at a time onto disk, which makes a
 * partial run meaningful: what exists is complete, not half-written. That is
 * what makes it worth both keeping when a run is stopped and showing while it
 * is still going.
 */
export interface DerivationProgressPage {
  readonly documentPath: string;
  readonly title: string;
  readonly bodyMarkdown: string;
}

/** What a build has written so far, for somebody watching it happen. */
export interface DerivationProgressSnapshot {
  readonly buildId: string;
  readonly pages: readonly {
    readonly documentPath: string;
    readonly title: string;
    readonly bytes: number;
    readonly firstSeenAt: string;
    readonly updatedAt: string;
  }[];
  readonly updatedAt?: string;
}
