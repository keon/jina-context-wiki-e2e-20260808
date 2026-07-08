export interface ReviewPolicy {
  readonly enabled: boolean;
  readonly advisoryOnly: boolean;
  readonly maxFindings: number;
}

export function canRunReview(policy: ReviewPolicy): boolean {
  return policy.enabled;
}

