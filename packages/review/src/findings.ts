export type FindingSeverity = "low" | "medium" | "high" | "critical";

export interface FindingDraft {
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly confidence: number;
}

