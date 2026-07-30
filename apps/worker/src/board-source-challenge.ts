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
