import assert from "node:assert/strict";
import test from "node:test";
import { parseResearchPlanWithRepair } from "./board-research-plan.js";

const API_QUESTION = "How does a maintainer add an authenticated API route safely?";
const STORAGE_QUESTION = "How does a maintainer change persisted task state without violating tenant isolation?";

const VALID_PLAN = {
  version: 1,
  repositorySummary: "A small API service with tenant-scoped persistence.",
  assignments: [
    {
      id: "api",
      objective: "Trace authenticated API ingress.",
      focusPaths: ["README.md", "apps/api"],
      questions: [API_QUESTION],
      reason: "API ingress is a distinct trust boundary."
    },
    {
      id: "storage",
      objective: "Trace durable tenant-scoped state.",
      focusPaths: ["packages/db"],
      questions: [STORAGE_QUESTION],
      reason: "Persistence owns the durable tenant boundary."
    }
  ]
};

const OPTIONS = {
  repositoryFiles: [
    { path: "README.md", contentAvailable: true },
    { path: "apps/api/src/server.ts", contentAvailable: true },
    { path: "packages/db/src/store.ts", contentAvailable: true },
    { path: "assets/architecture.png", contentAvailable: false }
  ],
  repositoryAreas: ["apps", "apps/api", "assets", "packages", "packages/db", "root"]
};

test("research planning repairs one semantic rejection with its exact diagnostic", async () => {
  const invalid = {
    ...VALID_PLAN,
    assignments: VALID_PLAN.assignments.map((assignment, index) =>
      index === 0 ? { ...assignment, focusPaths: ["repository/work/apps/api"] } : assignment
    )
  };
  let repairCalls = 0;
  const plan = await parseResearchPlanWithRepair({
    candidate: invalid,
    options: OPTIONS,
    repair: async ({ diagnostic, invalidPlan }) => {
      repairCalls += 1;
      assert.equal(
        diagnostic,
        "research assignment api focus path does not resolve to readable checkpoint evidence: repository/work/apps/api"
      );
      assert.deepEqual(JSON.parse(invalidPlan), invalid);
      return VALID_PLAN;
    }
  });
  assert.equal(repairCalls, 1);
  assert.deepEqual(plan.assignments[0]?.focusPaths, ["README.md", "apps/api"]);
});

test("research planning does not spend a repair call on a valid candidate", async () => {
  const plan = await parseResearchPlanWithRepair({
    candidate: VALID_PLAN,
    options: OPTIONS,
    repair: async () => {
      throw new Error("repair must not run");
    }
  });
  assert.equal(plan.assignments.length, 2);
});

test("research planning fails closed when the one repair is still semantically invalid", async () => {
  const invalid = {
    ...VALID_PLAN,
    assignments: [VALID_PLAN.assignments[0]]
  };
  let repairCalls = 0;
  await assert.rejects(
    parseResearchPlanWithRepair({
      candidate: invalid,
      options: OPTIONS,
      repair: async ({ diagnostic }) => {
        repairCalls += 1;
        assert.equal(diagnostic, "research plan does not cover repository areas: packages, packages/db");
        return invalid;
      }
    }),
    /research plan does not cover repository areas: packages, packages\/db/
  );
  assert.equal(repairCalls, 1);
});
