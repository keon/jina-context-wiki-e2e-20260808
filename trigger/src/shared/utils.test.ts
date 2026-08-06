import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reviewCodexModel,
  runtimeAgentModel,
  runtimeMentalTraceModel,
  runtimePlannerModel,
} from "./utils.js";

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
