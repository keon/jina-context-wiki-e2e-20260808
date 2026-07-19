export type FindingSeverity = "low" | "medium" | "high" | "critical";

export interface FindingDraft {
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly confidence: number;
}

/** Durable cross-run identity for a finding, deduped by fingerprint across PR epochs. */
export interface FindingThread {
  readonly fingerprint: string;
  readonly firstSeenHeadSha: string;
  readonly lastSeenHeadSha: string;
  readonly findingCount: number;
}

export function upsertFindingThread(
  threads: readonly FindingThread[],
  fingerprint: string,
  headSha: string
): readonly FindingThread[] {
  const existing = threads.find((thread) => thread.fingerprint === fingerprint);
  if (existing) {
    return threads.map((thread) =>
      thread.fingerprint === fingerprint
        ? { ...thread, lastSeenHeadSha: headSha, findingCount: thread.findingCount + 1 }
        : thread
    );
  }

  return [...threads, { fingerprint, firstSeenHeadSha: headSha, lastSeenHeadSha: headSha, findingCount: 1 }];
}
