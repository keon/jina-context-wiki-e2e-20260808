export type QualityGateStatus = "pending" | "passed" | "failed" | "waived";

export interface QualityGateResultDraft {
  readonly gateSlug: string;
  readonly status: QualityGateStatus;
  readonly evidenceArtifactId?: string;
}

