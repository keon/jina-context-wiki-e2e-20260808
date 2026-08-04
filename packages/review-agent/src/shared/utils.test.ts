import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reviewCodexModel,
  runCommand,
  runtimeAgentModel,
  runtimeMentalTraceModel,
  runtimePlannerModel
} from "./utils.js";

test("runCommand lets the child exit code decide when a short-lived process closes stdin", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdin.destroy(); process.stdout.write('ok')"], {
    input: "x".repeat(4 * 1024 * 1024),
    timeoutMs: 10_000
  });
  assert.equal(result.stdout, "ok");
});

test("model defaults are OpenRouter slugs", () => {
  assert.equal(reviewCodexModel({}), "openai/gpt-5.6-luna");
  assert.equal(runtimePlannerModel({}), "openai/gpt-5.6-sol");
  assert.equal(runtimeAgentModel({}), "openai/gpt-5.6-luna");
  assert.equal(runtimeMentalTraceModel({}), "openai/gpt-5.6-luna");
});

test("model env overrides win over defaults", () => {
  assert.equal(reviewCodexModel({ REVIEW_CODEX_MODEL: "anthropic/claude-opus-4.1" }), "anthropic/claude-opus-4.1");
  assert.equal(runtimeAgentModel({ RUNTIME_AGENT_MODEL: "openai/gpt-5.4-mini" }), "openai/gpt-5.4-mini");
});
