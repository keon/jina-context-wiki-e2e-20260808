import { parseSourceChallengeStageResult } from "@jina/daytona";

type SourceChallengeValidation = Parameters<typeof parseSourceChallengeStageResult>[1];

export function parseBoardSourceChallengeStageResult(
  value: unknown,
  expected: Omit<SourceChallengeValidation, "existingSubjectIds"> & {
    readonly researchPlan: {
      readonly assignments: readonly {
        readonly id: string;
      }[];
    };
  }
): ReturnType<typeof parseSourceChallengeStageResult> {
  const { researchPlan, ...validation } = expected;
  return parseSourceChallengeStageResult(canonicalHostOwnedIdentity(value, expected), {
    ...validation,
    existingSubjectIds: researchPlan.assignments.map((assignment) => assignment.id)
  });
}

export async function parseBoardSourceChallengeStageResultWithRepair(
  value: unknown,
  expected: Parameters<typeof parseBoardSourceChallengeStageResult>[1],
  repair: (diagnostic: string, previousResult: unknown) => Promise<unknown>
): Promise<ReturnType<typeof parseBoardSourceChallengeStageResult>> {
  try {
    return parseBoardSourceChallengeStageResult(value, expected);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const corrected = await repair(diagnostic, canonicalHostOwnedIdentity(value, expected));
    try {
      return parseBoardSourceChallengeStageResult(corrected, expected);
    } catch (correctionError) {
      const correctionDiagnostic = correctionError instanceof Error ? correctionError.message : String(correctionError);
      throw new Error(`source_challenge_contract: ${correctionDiagnostic}`, { cause: correctionError });
    }
  }
}

/**
 * Worker and snapshot identity plus `acceptedTaskIds` are redundant echoes of
 * host-owned inputs, not model judgment. Canonicalize them before validation
 * so the bounded repair receives the first substantive diagnostic instead of
 * spending its only pass on identity bookkeeping.
 */
function canonicalHostOwnedIdentity(
  value: unknown,
  expected: Parameters<typeof parseBoardSourceChallengeStageResult>[1]
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  const worker = result.worker;
  return {
    ...result,
    inputDigest: expected.inputDigest,
    publicSnapshotDigest: expected.publicSnapshotDigest,
    ...(worker && typeof worker === "object" && !Array.isArray(worker)
      ? { worker: { ...(worker as Record<string, unknown>), id: expected.workerId } }
      : {}),
    acceptedTaskIds: expected.existingTasks.map((task) => task.id)
  };
}
