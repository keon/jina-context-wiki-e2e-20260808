import assert from "node:assert/strict";
import test from "node:test";
import { executionFallback, normalizeExecutionSettings } from "./context-graph-execution.ts";

test("normalizes execution settings without accepting secret-shaped fields", () => {
  const settings = normalizeExecutionSettings({
    provider: "codex",
    assertionModel: "openai/gpt-5.6-sol",
    revision: 3,
    openrouterApiKey: "must-not-survive",
    integrations: { codex: { configured: true } },
    models: [{ id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" }]
  });
  assert.equal(settings.provider, "codex");
  assert.equal(settings.integrations.codex.configured, true);
  assert.equal(JSON.stringify(settings).includes("must-not-survive"), false);
});

test("explains whole-run fallback only when the selected route cannot run", () => {
  const disconnected = normalizeExecutionSettings({ provider: "codex" });
  assert.match(executionFallback(disconnected) ?? "", /fall back/);
  const connected = normalizeExecutionSettings({
    provider: "codex",
    integrations: { codex: { configured: true } }
  });
  assert.equal(executionFallback(connected), null);
});
