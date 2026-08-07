import assert from "node:assert/strict";
import { test } from "node:test";

import { validateModelSettingsSlugs, type CatalogModel } from "./model-settings.js";

const catalog: CatalogModel[] = [
  { id: "openai/gpt-5.5", name: "GPT-5.5", context_length: null, pricing: { prompt_per_1m: null, completion_per_1m: null } },
];

test("validateModelSettingsSlugs accepts Codex subscription ids even when the catalog lacks them", async () => {
  // The public OpenRouter catalog may not list the GPT-5.6 codenames, but a Codex-provider tenant must be
  // able to SAVE them (the harness runs them natively) — the picker offers exactly these ids as stubs.
  await validateModelSettingsSlugs(
    { planner_model: "openai/gpt-5.6-sol", investigation_model: "openai/gpt-5.6-terra", review_model: "openai/gpt-5.4-mini" },
    async () => catalog,
  );
});

test("validateModelSettingsSlugs still rejects unknown non-Codex slugs against the catalog", async () => {
  await assert.rejects(
    validateModelSettingsSlugs({ planner_model: "openai/gpt-9000", investigation_model: null, review_model: null }, async () => catalog),
    /unknown model slug: openai\/gpt-9000/,
  );
});
