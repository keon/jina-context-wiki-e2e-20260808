export interface BudgetState {
  readonly spent: number;
  readonly limit: number;
}

export function hasBudgetRemaining(budget: BudgetState): boolean {
  return budget.spent < budget.limit;
}

