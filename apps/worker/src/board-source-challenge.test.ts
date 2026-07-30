import assert from "node:assert/strict";
import test from "node:test";
import { parseSourceChallengeStageResult } from "@jina/daytona";
import {
  parseBoardSourceChallengeStageResult,
  parseBoardSourceChallengeStageResultWithRepair
} from "./board-source-challenge.js";

const researchPlan = {
  assignments: [{ id: "core-id-api-and-wire-format" }]
};

const expected = {
  workerId: "source-challenge-1",
  inputDigest: "a".repeat(64),
  publicSnapshotDigest: "b".repeat(64),
  existingTasks: [{ id: "understand-id-format", question: "How is an ID encoded?" }],
  repositoryPaths: ["id.go"]
};

const challenge = {
  version: 1,
  inputDigest: expected.inputDigest,
  publicSnapshotDigest: expected.publicSnapshotDigest,
  worker: {
    id: expected.workerId,
    summary: "The current task does not test the rollover boundary."
  },
  acceptedTaskIds: ["understand-id-format"],
  addedTasks: [
    {
      id: "challenge-rollover-boundary",
      subjectId: "core-id-api-and-wire-format",
      subjectKind: "feature",
      subjectStatement: "The public ID format has a rollover boundary.",
      intent: "change",
      question: "How should a maintainer preserve uniqueness at the rollover boundary?",
      material: true,
      requiredAnswerParts: ["invariants", "failure_triage", "verification"],
      evidence: [
        {
          source: "code",
          reference: "id.go",
          exactQuote: "NewWithTime",
          reason: "The constructor exposes the timestamp boundary."
        }
      ],
      reason: "The existing task does not cover rollover behavior."
    }
  ],
  omittedSubjects: [],
  summary: "Exercise the existing ID subject at its rollover boundary."
};

test("Board source-challenge parsing accepts the same research subjects as local parsing", () => {
  const local = parseSourceChallengeStageResult(challenge, {
    ...expected,
    existingSubjectIds: researchPlan.assignments.map((assignment) => assignment.id)
  });
  const board = parseBoardSourceChallengeStageResult(challenge, {
    ...expected,
    researchPlan
  });

  assert.deepEqual(board, local);
  assert.equal(board.addedTasks[0]?.material, true);
  assert.equal(board.addedTasks[0]?.subjectId, "core-id-api-and-wire-format");
});

test("Board source-challenge parsing still rejects genuinely unknown subjects", () => {
  const unknownSubjectChallenge = {
    ...challenge,
    addedTasks: [
      {
        ...challenge.addedTasks[0],
        subjectId: "invented-subject"
      }
    ]
  };

  assert.throws(
    () =>
      parseBoardSourceChallengeStageResult(unknownSubjectChallenge, {
        ...expected,
        researchPlan
      }),
    /names unknown subject invented-subject/
  );
});

test("Board source-challenge parsing gives one bounded repair attempt deterministic feedback", async () => {
  const invalid = {
    ...challenge,
    addedTasks: [
      {
        ...challenge.addedTasks[0],
        evidence: [
          {
            ...challenge.addedTasks[0]!.evidence[0],
            reference: "access-service.md"
          }
        ]
      }
    ]
  };
  const diagnostics: string[] = [];
  const result = await parseBoardSourceChallengeStageResultWithRepair(
    invalid,
    { ...expected, researchPlan },
    async (diagnostic, previousResult) => {
      diagnostics.push(diagnostic);
      assert.equal(previousResult, invalid);
      return challenge;
    }
  );

  assert.equal(result.addedTasks[0]?.evidence[0]?.reference, "id.go");
  assert.match(diagnostics[0] ?? "", /access-service\.md/);
});

test("Board source-challenge validation never retries a rejected correction", async () => {
  let attempts = 0;
  await assert.rejects(
    parseBoardSourceChallengeStageResultWithRepair(
      { ...challenge, worker: { ...challenge.worker, id: "wrong-worker" } },
      { ...expected, researchPlan },
      async () => {
        attempts += 1;
        return { ...challenge, worker: { ...challenge.worker, id: "still-wrong" } };
      }
    ),
    /worker id/
  );
  assert.equal(attempts, 1);
});
