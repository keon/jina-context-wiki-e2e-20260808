import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { decryptSecret, encryptSecret, isEncryptedEnvelope } from "./crypto.js";

test("round-trips a secret when an encryption key is configured", async () => {
  const previous = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    // Force the module to re-read the env by importing a fresh copy.
    const { encryptSecret: enc, decryptSecret: dec, isEncryptedEnvelope: isEnc } = await import(
      `./crypto.js?keyed=${Date.now()}`
    );
    const ciphertext = enc("sk-test-secret-value");
    assert.equal(isEnc(ciphertext), true);
    assert.notEqual(ciphertext, "sk-test-secret-value");
    assert.equal(dec(ciphertext), "sk-test-secret-value");
  } finally {
    if (previous === undefined) {
      delete process.env.SECRETS_ENCRYPTION_KEY;
    } else {
      process.env.SECRETS_ENCRYPTION_KEY = previous;
    }
  }
});

test("returns plaintext unchanged when no key is configured", () => {
  assert.equal(encryptSecret("plain"), "plain");
  assert.equal(isEncryptedEnvelope("plain"), false);
});

test("treats legacy non-envelope values as plaintext on decrypt", () => {
  assert.equal(decryptSecret("legacy-plaintext-key"), "legacy-plaintext-key");
});
