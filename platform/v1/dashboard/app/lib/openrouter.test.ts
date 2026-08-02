import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterModels,
  normalizeModelSettings,
  openRouterSourceLabel,
  parseOpenRouterCallbackParam,
  type CatalogModel,
} from "./openrouter";

const CATALOG: CatalogModel[] = [
  { id: "openai/gpt-5.5", name: "GPT-5.5" },
  { id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { id: "anthropic/claude-opus", name: "Claude Opus" },
  { id: "meta/llama-3", name: "Llama 3" },
];

test("parseOpenRouterCallbackParam reads connected/error and ignores others", () => {
  assert.equal(parseOpenRouterCallbackParam("?openrouter=connected"), "connected");
  assert.equal(parseOpenRouterCallbackParam("?openrouter=error"), "error");
  assert.equal(parseOpenRouterCallbackParam("?openrouter=bogus"), null);
  assert.equal(parseOpenRouterCallbackParam("?other=1"), null);
  assert.equal(parseOpenRouterCallbackParam(""), null);
});

test("openRouterSourceLabel maps known sources only", () => {
  assert.equal(openRouterSourceLabel("oauth"), "OAuth");
  assert.equal(openRouterSourceLabel("manual"), "Manual");
  assert.equal(openRouterSourceLabel("something"), null);
  assert.equal(openRouterSourceLabel(null), null);
  assert.equal(openRouterSourceLabel(undefined), null);
});

test("filterModels matches slug and name, case-insensitively", () => {
  assert.deepEqual(
    filterModels(CATALOG, "gpt").map((m) => m.id),
    ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
  );
  assert.deepEqual(
    filterModels(CATALOG, "OPUS").map((m) => m.id),
    ["anthropic/claude-opus"],
  );
  // Name-based match ("Mini" only appears in the display name).
  assert.deepEqual(
    filterModels(CATALOG, "mini").map((m) => m.id),
    ["openai/gpt-5.4-mini"],
  );
});

test("filterModels returns whole list for empty query and respects the cap", () => {
  assert.equal(filterModels(CATALOG, "").length, CATALOG.length);
  assert.equal(filterModels(CATALOG, "  ").length, CATALOG.length);
  assert.equal(filterModels(CATALOG, "", 2).length, 2);
  assert.equal(filterModels(CATALOG, "gpt", 1).length, 1);
});

test("normalizeModelSettings coerces to nulls for missing/blank/invalid slugs", () => {
  assert.deepEqual(normalizeModelSettings(null), {
    planner_model: null,
    investigation_model: null,
    review_model: null,
    context_model: null,
    planner_effort: null,
    investigation_effort: null,
    review_effort: null,
    context_effort: null,
    review_fallback_policy: "fail_notify",
    context_fallback_policy: "fail_notify",
  });
  assert.deepEqual(
    normalizeModelSettings({ planner_model: "openai/gpt-5.5", investigation_model: "  ", review_model: 42 }),
    {
      planner_model: "openai/gpt-5.5",
      investigation_model: null,
      review_model: null,
      context_model: null,
      planner_effort: null,
      investigation_effort: null,
      review_effort: null,
      context_effort: null,
      review_fallback_policy: "fail_notify",
      context_fallback_policy: "fail_notify",
    },
  );
});
