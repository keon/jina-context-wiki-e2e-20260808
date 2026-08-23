import assert from "node:assert/strict";
import test from "node:test";
import { AccountDeletionRequests } from "../src/account-deletion.js";

test("account deletion requires one live confirmation and is idempotent while pending", () => {
  let now = 1_000;
  const requests = new AccountDeletionRequests({ now: () => now, ttlMs: 500 });

  const first = requests.request(" user-1 ");
  const repeated = requests.request("user-1");
  assert.deepEqual(repeated, first);
  assert.equal(first.userId, "user-1");
  assert.equal(first.expiresAt, 1_500);
  assert.equal(requests.confirm(first.token), true);
  assert.equal(requests.confirm(first.token), false);

  now += 1;
  assert.notEqual(requests.request("user-1").token, first.token);
});

test("expired or cancelled deletion requests cannot delete an account", () => {
  let now = 2_000;
  const requests = new AccountDeletionRequests({ now: () => now, ttlMs: 100 });
  const expired = requests.request("user-2");

  now = expired.expiresAt;
  assert.equal(requests.confirm(expired.token), false);

  const cancelled = requests.request("user-2");
  assert.equal(requests.cancel(cancelled.token), true);
  assert.equal(requests.confirm(cancelled.token), false);
  assert.equal(requests.cancel("missing"), false);
});

test("invalid deletion inputs fail before persistent state changes", () => {
  assert.throws(() => new AccountDeletionRequests({ ttlMs: 0 }), /positive safe integer/);
  const requests = new AccountDeletionRequests();
  assert.throws(() => requests.request("   "), /user id is required/);
});
