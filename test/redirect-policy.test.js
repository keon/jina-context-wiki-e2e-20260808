import assert from "node:assert/strict";
import test from "node:test";

import { isTrustedRedirect } from "../src/redirect-policy.js";

test("accepts an HTTPS callback on the configured host", () => {
  assert.equal(isTrustedRedirect("https://app.example.test/oauth/callback", "app.example.test"), true);
});

test("rejects non-HTTPS and unrelated callbacks", () => {
  assert.equal(isTrustedRedirect("http://app.example.test/oauth/callback", "app.example.test"), false);
  assert.equal(isTrustedRedirect("https://attacker.example/oauth/callback", "app.example.test"), false);
});
