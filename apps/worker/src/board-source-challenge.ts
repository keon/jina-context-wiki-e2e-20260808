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
    return parseBoardSourceChallengeStageResult(await repair(diagnostic, value), expected);
  }
}
