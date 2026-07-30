export interface BoundedPlanRepairRequest {
  readonly diagnostic: string;
  readonly invalidPlan: string;
}

/**
 * Gives one host-rejected model candidate exactly one correction call.
 *
 * The parser remains authoritative and is invoked identically for the first
 * candidate and its replacement. A second rejection is terminal; this helper
 * never loops or retries the repair callback.
 */
export async function parsePlanWithSingleRepair<T>(input: {
  readonly candidate: unknown;
  readonly parse: (candidate: unknown) => T;
  readonly repair: (request: BoundedPlanRepairRequest) => Promise<unknown>;
}): Promise<T> {
  try {
    return input.parse(input.candidate);
  } catch (error) {
    const repaired = await input.repair({
      diagnostic: error instanceof Error ? error.message : String(error),
      invalidPlan: JSON.stringify(input.candidate ?? {})
    });
    return input.parse(repaired);
  }
}
