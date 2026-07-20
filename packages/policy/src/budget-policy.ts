export interface BudgetLimits {
  readonly perEpoch?: number;
  readonly perPrTotal?: number;
}

export interface BudgetSpend {
  readonly total: number;
  readonly byEpoch: Readonly<Record<string, number>>;
}

export const emptyBudgetSpend: BudgetSpend = { total: 0, byEpoch: {} };

export function recordSpend(spend: BudgetSpend, epoch: number, amount: number): BudgetSpend {
  return {
    total: spend.total + amount,
    byEpoch: { ...spend.byEpoch, [epoch]: (spend.byEpoch[epoch] ?? 0) + amount }
  };
}

export function isBudgetExhausted(limits: BudgetLimits | undefined, spend: BudgetSpend, epoch: number): boolean {
  if (!limits) {
    return false;
  }
  if (limits.perPrTotal !== undefined && spend.total >= limits.perPrTotal) {
    return true;
  }
  return limits.perEpoch !== undefined && (spend.byEpoch[epoch] ?? 0) >= limits.perEpoch;
}
