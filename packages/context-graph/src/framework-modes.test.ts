import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONTEXT_FRAMEWORK_MODES, parseContextFrameworkModes } from "./framework-modes.js";

test("context framework modes preserve legacy behavior by default", () => {
  assert.deepEqual(parseContextFrameworkModes({}), DEFAULT_CONTEXT_FRAMEWORK_MODES);
  assert.deepEqual(parseContextFrameworkModes({ CONTEXT_GRAPH_ASSERTION_MODE: "  " }), DEFAULT_CONTEXT_FRAMEWORK_MODES);
});

test("context framework modes parse explicit rollout settings", () => {
  assert.deepEqual(
    parseContextFrameworkModes({
      CONTEXT_GRAPH_ASSERTION_MODE: "model_shadow",
      CONTEXT_GRAPH_ADMISSION_MODE: "shadow",
      CONTEXT_GRAPH_CAUSAL_MODE: "mechanism_shadow",
      CONTEXT_GRAPH_CHANGESET_SHADOW_SAMPLE_BPS: "250"
    }),
    {
      assertion: "model_shadow",
      admission: "shadow",
      causal: "mechanism_shadow",
      modelShadowSampleBps: 250
    }
  );
});

test("context framework modes reject unknown or unsafe values", () => {
  assert.throws(
    () => parseContextFrameworkModes({ CONTEXT_GRAPH_ASSERTION_MODE: "automatic" }),
    /CONTEXT_GRAPH_ASSERTION_MODE must be one of/
  );
  assert.throws(
    () => parseContextFrameworkModes({ CONTEXT_GRAPH_ADMISSION_MODE: "human_review" }),
    /CONTEXT_GRAPH_ADMISSION_MODE must be one of/
  );
  assert.throws(
    () => parseContextFrameworkModes({ CONTEXT_GRAPH_CAUSAL_MODE: "guess" }),
    /CONTEXT_GRAPH_CAUSAL_MODE must be one of/
  );
  for (const value of ["-1", "10001", "1.5", "all"]) {
    assert.throws(
      () => parseContextFrameworkModes({ CONTEXT_GRAPH_CHANGESET_SHADOW_SAMPLE_BPS: value }),
      /must be an integer between 0 and 10000/
    );
  }
});
