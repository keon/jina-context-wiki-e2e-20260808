import assert from "node:assert/strict";
import test from "node:test";
import { openSecret, sealSecret, secretAssociatedData } from "./secret-envelope.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

test("integration secrets are authenticated against tenant and provider", () => {
  const aad = secretAssociatedData("tenant-a", "codex");
  const envelope = sealSecret('{"tokens":{"refresh_token":"secret"}}', aad, KEY);
  assert.match(envelope, /^enc:v1:/);
  assert.equal(openSecret(envelope, aad, KEY), '{"tokens":{"refresh_token":"secret"}}');
  assert.throws(() => openSecret(envelope, secretAssociatedData("tenant-b", "codex"), KEY));
  assert.throws(() => openSecret(envelope, secretAssociatedData("tenant-a", "openai"), KEY));
});

test("secret storage fails closed when encryption is not configured", () => {
  assert.throws(() => sealSecret("secret", "scope", undefined), /SECRETS_ENCRYPTION_KEY/);
});
