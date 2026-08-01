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
  return parseSourceChallengeStageResult(value, {
    ...validation,
    existingSubjectIds: researchPlan.assignments.map((assignment) => assignment.id)
  });
}

export async function parseBoardSourceChallengeStageResultWithRepair(
  value: unknown,
  expected: Parameters<typeof parseBoardSourceChallengeStageResult>[1],
  repair: (diagnostic: string, previousResult: unknown) => Promise<unknown>
): Promise<ReturnType<typeof parseBoardSourceChallengeStageResult>> {
  const canonical = canonicalAcceptedTaskIds(
    value,
    expected.existingTasks.map((task) => task.id)
  );
  try {
    return parseBoardSourceChallengeStageResult(canonical, expected);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const corrected = canonicalAcceptedTaskIds(
      await repair(diagnostic, canonical),
      expected.existingTasks.map((task) => task.id)
    );
    try {
      return parseBoardSourceChallengeStageResult(corrected, expected);
    } catch (correctionError) {
      const correctionDiagnostic = correctionError instanceof Error ? correctionError.message : String(correctionError);
      throw new Error(`source_challenge_contract: ${correctionDiagnostic}`, { cause: correctionError });
    }
  }
}

/**
 * `acceptedTaskIds` is a redundant acknowledgement of the host-owned catalog,
 * not model judgment. Canonicalize it before validation so a challenger cannot
 * invent or omit catalog identity while every substantive finding remains
 * strictly parsed and evidence-checked.
 */
function canonicalAcceptedTaskIds(value: unknown, acceptedTaskIds: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), acceptedTaskIds: [...acceptedTaskIds] };
}
