export type RateMode = "included" | "overage";
export type KeySource = "user" | "managed";

export interface BillingPolicy {
  readonly subsidyRate: number;
  readonly infraCreditsPerRun: number;
  readonly overageInfraCreditsPerRun: number;
  readonly overageSubsidyRate: number;
}

export const defaultBillingPolicy: BillingPolicy = {
  subsidyRate: 0.3,
  infraCreditsPerRun: 100,
  overageInfraCreditsPerRun: 150,
  overageSubsidyRate: 0
};

export const CREDITS_PER_USD = 100;

function customerShare(policy: BillingPolicy, rateMode: RateMode): number {
  return rateMode === "included" ? 1 - policy.subsidyRate : 1 - policy.overageSubsidyRate;
}

export function aiCreditsForCost(
  costUsd: number,
  policy: BillingPolicy,
  rateMode: RateMode,
  keySource: KeySource
): number {
  if (keySource === "user") {
    return 0;
  }
  return Math.ceil(costUsd * customerShare(policy, rateMode) * CREDITS_PER_USD);
}

export function infraCreditsForRun(policy: BillingPolicy, rateMode: RateMode): number {
  return rateMode === "included" ? policy.infraCreditsPerRun : policy.overageInfraCreditsPerRun;
}
