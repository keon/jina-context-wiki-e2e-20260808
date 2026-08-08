import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeCodexHarnessAuthInput,
  validateCodexHarnessAuth,
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
