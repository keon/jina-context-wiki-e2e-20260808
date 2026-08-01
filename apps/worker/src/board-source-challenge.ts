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
  try {
    return parseBoardSourceChallengeStageResult(value, expected);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const corrected = await repair(diagnostic, value);
    try {
      return parseBoardSourceChallengeStageResult(corrected, expected);
    } catch (correctionError) {
      const correctionDiagnostic = correctionError instanceof Error ? correctionError.message : String(correctionError);
      throw new Error(`source_challenge_contract: ${correctionDiagnostic}`, { cause: correctionError });
    }
  }
}
