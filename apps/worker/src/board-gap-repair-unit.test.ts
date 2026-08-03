import assert from "node:assert/strict";
import { test } from "node:test";
import { gapRepairPageProblems } from "./board-gap-repair.js";

const snapshot = {
  tenantId: "tenant-1",
  repository: "acme/sample",
  ref: "main",
  refSequence: 1,
  commitSha: "a".repeat(40),
  files: [
    {
      path: "src/runtime.ts",
      blobSha: "b".repeat(40),
      body: [
        "export function run() {",
        "  return 'ready';",
        "}",
        "export function retry(status: number) {",
        "  return status >= 500;",
        "}"
      ].join("\n"),
      executable: false,
      contentOmitted: false,
      entryType: "file" as const
    }
  ],
  observations: [],
  aclFingerprint: "c".repeat(64),
  observationFrontier: "{}",
  sourceComplete: true,
  createdAt: "2026-08-02T00:00:00.000Z"
};

const plannedPage = {
  id: "architecture",
  path: "architecture.md",
  title: "Architecture",
  purpose: "Explain runtime control flow and retry behavior.",
  sourceAssignmentIds: ["runtime"],
  maintenanceQuestions: ["How does runtime retry behavior work?"],
  coverageAreas: ["src"],
  requiredTopics: ["runtime control flow", "retry behavior"],
  diagram: "none" as const,
  dependencies: []
};

const publicationPlan = {
  version: 1 as const,
  hierarchyRationale: "One architecture page owns the runtime subject.",
  pages: [plannedPage],
  writers: [{ id: "writer-runtime", objective: "Document runtime behavior.", pageIds: ["architecture"] }],
  excludedAreas: []
};

const validPage = [
  "# Architecture",
  "",
  "[The runtime entry point returns a ready result](src/runtime.ts#L1-L3). This page explains runtime control flow for maintainers.",
  "",
  "## Retry behavior",
  "",
  "[The retry helper retries statuses of 500 or greater](src/runtime.ts#L4-L6). This boundary is the central retry behavior.",
  "",
  "## Control flow",
  "",
  "[A maintainer starts at `run`](src/runtime.ts#L1-L3), then inspects `retry` when a request fails. The source links bind the runtime control flow and failure decision while this connective guidance identifies the inspection order.",
  "",
  "## Verification",
  "",
  "[Verify the ready path and the numeric failure boundary around these exported functions](src/runtime.ts#L1-L6). What additional retry cases should a future change cover?"
].join("\n");

test("global repair page validation isolates a shallow candidate without invalidating its checkpoint sibling", () => {
  const problems = gapRepairPageProblems({
    currentPage: { documentPath: "architecture.md", bodyMarkdown: validPage },
    candidateBodyMarkdown: "# Architecture\n\nToo short.",
    plannedPage,
    publicationPlan,
    snapshot
  });
  assert.ok(problems.some((problem) => problem.includes("shallow")));
  assert.ok(problems.some((problem) => problem.includes("planned") || problem.includes("coverage")));
});

test("global repair page validation accepts a corrected source-grounded candidate", () => {
  const corrected = `${validPage}\n\n## Operations\n\n[Inspect \`retry\` when a failure status reaches the runtime](src/runtime.ts#L4-L6).`;
  assert.deepEqual(
    gapRepairPageProblems({
      currentPage: { documentPath: "architecture.md", bodyMarkdown: validPage },
      candidateBodyMarkdown: corrected,
      plannedPage,
      publicationPlan,
      snapshot
    }),
    []
  );
});
