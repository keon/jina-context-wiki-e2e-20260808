import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HARNESS_MODELS,
  coerceStoredHarnessModel,
  normalizeCodexHarnessAuthInput,
  normalizeHarnessModelInput,
  validateCodexHarnessAuth,
  validateHarnessModel,
} from "./codex-harness.js";
import { ApiError } from "./errors.js";

const VALID_AUTH = JSON.stringify({
  tokens: { refresh_token: "rt-secret-value", access_token: "at-value", id_token: "id-value" },
  OPENAI_API_KEY: null,
});

function expect400(fn: () => void): ApiError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, "expected an ApiError");
    assert.equal(error.status, 400);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

test("validateCodexHarnessAuth accepts a well-formed auth.json blob", () => {
  assert.doesNotThrow(() => validateCodexHarnessAuth(VALID_AUTH));
});

test("validateCodexHarnessAuth rejects malformed JSON", () => {
  const error = expect400(() => validateCodexHarnessAuth("{not json"));
  assert.match(error.message, /not valid Codex auth\.json content/);
});

test("validateCodexHarnessAuth rejects a JSON array (non-object)", () => {
  const error = expect400(() => validateCodexHarnessAuth('[{"tokens":{"refresh_token":"x"}}]'));
  assert.match(error.message, /expected a JSON object/);
});

test("validateCodexHarnessAuth rejects a blob with no tokens object", () => {
  const error = expect400(() => validateCodexHarnessAuth('{"OPENAI_API_KEY":"sk-x"}'));
  assert.match(error.message, /tokens/);
});

test("validateCodexHarnessAuth rejects tokens with a missing/empty refresh_token", () => {
  expect400(() => validateCodexHarnessAuth('{"tokens":{"access_token":"a"}}'));
  expect400(() => validateCodexHarnessAuth('{"tokens":{"refresh_token":"   "}}'));
  const error = expect400(() => validateCodexHarnessAuth('{"tokens":{"refresh_token":123}}'));
  assert.match(error.message, /tokens\.refresh_token/);
});

test("validateCodexHarnessAuth rejects an oversized blob (> 64 KB)", () => {
  const oversized = JSON.stringify({ tokens: { refresh_token: "r" }, pad: "x".repeat(64 * 1024) });
  const error = expect400(() => validateCodexHarnessAuth(oversized));
  assert.match(error.message, /64 KB/);
});

test("validation errors NEVER echo the submitted content (secrets stay out of messages)", () => {
  const secret = "rt-super-secret-should-never-appear";
  const error = expect400(() => validateCodexHarnessAuth(JSON.stringify({ tokens: { refresh_token: secret, extra: [] } }) + "trailing"));
  assert.ok(!error.message.includes(secret));
  assert.equal(error.details, undefined);
});

test("normalizeCodexHarnessAuthInput treats an empty string as a disconnect (no validation)", () => {
  assert.equal(normalizeCodexHarnessAuthInput(""), "");
});

test("normalizeCodexHarnessAuthInput leaves an omitted/non-string field unchanged (undefined)", () => {
  assert.equal(normalizeCodexHarnessAuthInput(undefined), undefined);
  assert.equal(normalizeCodexHarnessAuthInput(42), undefined);
  assert.equal(normalizeCodexHarnessAuthInput(null), undefined);
});

test("normalizeCodexHarnessAuthInput validates and returns a non-empty blob", () => {
  assert.equal(normalizeCodexHarnessAuthInput(VALID_AUTH), VALID_AUTH);
  expect400(() => normalizeCodexHarnessAuthInput("{bad"));
});

/* ------------------------------------------- harness model preference (feature (c)) --- */

test("validateHarnessModel accepts each HARNESS_MODELS value and null/empty -> null", () => {
  for (const model of HARNESS_MODELS) {
    assert.equal(validateHarnessModel(model), model);
  }
  assert.equal(validateHarnessModel(null), null);
  assert.equal(validateHarnessModel(undefined), null);
  assert.equal(validateHarnessModel(""), null);
  assert.equal(validateHarnessModel("   "), null);
});

test("validateHarnessModel rejects an unknown model and a non-string with 400", () => {
  expect400(() => validateHarnessModel("gpt-4o"));
  expect400(() => validateHarnessModel("openai/gpt-5.5")); // OpenRouter slug is not a native harness model
  expect400(() => validateHarnessModel(42));
});

test("normalizeHarnessModelInput distinguishes an omitted field from an explicit reset", () => {
  // Omitted -> not provided (leave stored value untouched).
  assert.deepEqual(normalizeHarnessModelInput(undefined, false), { model: null, provided: false });
  // Present null/empty -> provided reset to the Codex default.
  assert.deepEqual(normalizeHarnessModelInput(null, true), { model: null, provided: true });
  assert.deepEqual(normalizeHarnessModelInput("", true), { model: null, provided: true });
  // Present valid value -> provided with the validated value.
  assert.deepEqual(normalizeHarnessModelInput("gpt-5.4", true), { model: "gpt-5.4", provided: true });
  // Present invalid value -> 400.
  expect400(() => normalizeHarnessModelInput("bogus", true));
});

test("coerceStoredHarnessModel returns valid values and null for anything else (never throws)", () => {
  assert.equal(coerceStoredHarnessModel("gpt-5.5"), "gpt-5.5");
  assert.equal(coerceStoredHarnessModel("made-up"), null);
  assert.equal(coerceStoredHarnessModel(null), null);
  assert.equal(coerceStoredHarnessModel(undefined), null);
  assert.equal(coerceStoredHarnessModel(123), null);
});
