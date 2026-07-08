export type GateStatus = "pending" | "passed" | "failed" | "waived";

export interface GateResultDraft {
  readonly gateSlug: string;
  readonly status: GateStatus;
  readonly evidenceArtifactId?: string;
}
