import assert from "node:assert/strict";
import test from "node:test";

import { parseScenarioJson, parseScenarios } from "./historical-scenarios.js";

test("parses structured scenario JSON into indexed dashboard scenarios", () => {
  const scenarios = parseScenarioJson({
    schemaVersion: 1,
    scenarios: [
      {
        id: "loads-app",
        title: "Fresh page load wires the TODO script correctly",
        summary: "verify the entrypoint initializes the app",
        riskLevel: "high",
        files: ["todo-app/index.html", "todo-app/todo.js"],
        surface: ["todo-app"],
        preconditions: ["The PR checkout is available."],
        steps: ["Open todo-app/index.html.", "Wait for initial script evaluation.", "Check console errors."],
        expectedOutcome: ["The UI initializes without runtime errors."],
        rationale: "The changed entrypoint loads the changed script.",
      },
    ],
  });

  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0]?.id, "scenario-1");
  assert.equal(scenarios[0]?.risk, "high");
  assert.deepEqual(scenarios[0]?.relevantPaths, ["todo-app/index.html", "todo-app/todo.js"]);
  assert.deepEqual(scenarios[0]?.steps, [
    "Open todo-app/index.html.",
    "Wait for initial script evaluation.",
    "Check console errors.",
  ]);
  assert.equal(scenarios[0]?.expectedResult, "The UI initializes without runtime errors.");
});

test("parses checked and status-tagged legacy scenario markdown", () => {
  const scenarios = parseScenarios(`
- [x] [pass] [risk: high] Fresh page load wires the TODO script correctly. Relevant paths: todo-app/index.html, todo-app/todo.js.
  Steps:
  1. Open todo-app/index.html.
  2. Check console errors.
  Expected result: The UI initializes without runtime errors.
`);

  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0]?.risk, "high");
  assert.equal(scenarios[0]?.title, "Fresh page load wires the TODO script correctly. Relevant paths: todo-app/index.html, todo-app/todo.js.");
  assert.deepEqual(scenarios[0]?.relevantPaths, ["todo-app/index.html", "todo-app/todo.js"]);
  assert.deepEqual(scenarios[0]?.steps, ["Open todo-app/index.html.", "Check console errors."]);
  assert.equal(scenarios[0]?.expectedResult, "The UI initializes without runtime errors.");
});
