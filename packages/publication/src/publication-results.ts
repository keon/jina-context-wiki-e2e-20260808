export type PublicationStatus = "published" | "updated" | "failed" | "superseded";

export interface PublicationRecord {
  readonly key: string;
  readonly headSha: string;
  readonly target: string;
  readonly status: PublicationStatus;
}

export interface UpsertPublicationResult {
  readonly records: readonly PublicationRecord[];
  readonly action: "created" | "updated";
}

/** Idempotent by publication key: a retry updates the existing record instead of duplicating it. */
export function upsertPublication(
  records: readonly PublicationRecord[],
  record: Omit<PublicationRecord, "status">
): UpsertPublicationResult {
  const existing = records.find((candidate) => candidate.key === record.key);
  if (existing) {
    return {
      records: records.map((candidate) =>
        candidate.key === record.key ? { ...candidate, ...record, status: "updated" } : candidate
      ),
      action: "updated"
    };
  }

  return { records: [...records, { ...record, status: "published" }], action: "created" };
}
