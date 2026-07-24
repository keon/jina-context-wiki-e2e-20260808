import assert from "node:assert/strict";
import test from "node:test";
import {
  publicContextGraphExecutionSettings,
  resolveContextGraphExecutionRoute,
  scopedContextGraphGeneratorVersion
} from "./execution-settings.js";

test("public settings never expose stored integration values", () => {
  const status = publicContextGraphExecutionSettings({
    tenantId: "tenant",
    provider: "codex",
    assertionModel: "openai/gpt-5.6-terra",
    openrouterApiKey: "encrypted-openrouter",
    openaiApiKey: "encrypted-openai",
    codexHarnessAuth: "encrypted-auth",
    revision: 4,
    updatedAt: "2026-07-24T00:00:00.000Z"
  });
  assert.deepEqual(status.integrations, {
    codex: { configured: true },
    openrouter: { configured: true },
    openai: { configured: true }
  });
  assert.equal(JSON.stringify(status).includes("encrypted"), false);
});

test("Codex selection uses native model names when a harness is connected", () => {
  assert.deepEqual(
    resolveContextGraphExecutionRoute({
      provider: "codex",
      assertionModel: "openai/gpt-5.6-sol",
      codexHarnessAuth: '{"tokens":{}}'
    }),
    {
      selectedProvider: "codex",
      source: "codex",
      provider: "codex",
      model: "gpt-5.6-sol",
      codexHarnessAuth: '{"tokens":{}}'
    }
  );
});

test("Codex selection follows the v1 fallback order without leaking managed credentials", () => {
  assert.deepEqual(
    resolveContextGraphExecutionRoute({
      provider: "codex",
      assertionModel: "openai/gpt-5.6-luna",
      openrouterApiKey: "or-key",
      openaiApiKey: "oa-key"
    }),
    {
      selectedProvider: "codex",
      source: "byok",
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      apiKey: "or-key",
      fallbackReason: "codex_not_connected"
    }
  );
});

test("native OpenAI BYOK only covers openai models and otherwise falls back whole-run", () => {
  assert.equal(
    resolveContextGraphExecutionRoute({
      provider: "byok",
      assertionModel: "openai/gpt-5.5",
      openaiApiKey: "oa-key"
    }).provider,
    "openai"
  );
  assert.deepEqual(
    resolveContextGraphExecutionRoute({
      provider: "byok",
      assertionModel: "anthropic/claude-opus-4.1",
      openaiApiKey: "oa-key"
    }),
    {
      selectedProvider: "byok",
      source: "managed",
      provider: "openrouter",
      model: "anthropic/claude-opus-4.1",
      fallbackReason: "model_not_supported"
    }
  );
});

test("assertion cache scope changes with selected provider or model but not credentials", () => {
  const managed = scopedContextGraphGeneratorVersion("generator-v1", "managed", "openai/gpt-5.6-luna");
  assert.equal(managed, scopedContextGraphGeneratorVersion("generator-v1", "managed", "openai/gpt-5.6-luna"));
  assert.notEqual(managed, scopedContextGraphGeneratorVersion("generator-v1", "byok", "openai/gpt-5.6-luna"));
  assert.notEqual(managed, scopedContextGraphGeneratorVersion("generator-v1", "managed", "openai/gpt-5.6-sol"));
});
