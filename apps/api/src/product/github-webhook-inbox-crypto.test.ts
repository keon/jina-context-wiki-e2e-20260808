import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  decryptGithubWebhookPayload,
  encryptGithubWebhookPayload,
  githubWebhookPayloadDigest,
} from "./github-webhook-inbox-crypto.js";

test("GitHub webhook inbox encryption round-trips exact bytes with authenticated metadata", () => {
  const key = randomBytes(32);
  const rawBody = Buffer.from([0, 1, 2, 10, 13, 255]);
  const binding = {
    deliveryId: "delivery-1",
    event: "issue_comment",
    payloadSha256: githubWebhookPayloadDigest(rawBody),
    encryptionKeyVersion: "7",
  };
  const encrypted = encryptGithubWebhookPayload(rawBody, key, binding);

  assert.notDeepEqual(encrypted, rawBody);
  assert.deepEqual(decryptGithubWebhookPayload(encrypted, key, binding), rawBody);
});

test("GitHub webhook inbox encryption rejects ciphertext or metadata tampering", () => {
  const key = randomBytes(32);
  const rawBody = Buffer.from('{"action":"created"}');
  const binding = {
    deliveryId: "delivery-1",
    event: "issue_comment",
    payloadSha256: githubWebhookPayloadDigest(rawBody),
    encryptionKeyVersion: "3",
  };
  const encrypted = encryptGithubWebhookPayload(rawBody, key, binding);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;

  assert.throws(() => decryptGithubWebhookPayload(tampered, key, binding));
  assert.throws(() => decryptGithubWebhookPayload(encrypted, key, {
    ...binding,
    deliveryId: "delivery-2",
  }));
});
