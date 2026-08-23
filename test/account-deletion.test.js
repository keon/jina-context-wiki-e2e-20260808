import assert from "node:assert/strict";
import test from "node:test";
import { AccountDeletionRequests } from "../src/account-deletion.js";

test("account deletion requires one live confirmation and is idempotent while pending", () => {
  let now = 1_000;
  const requests = new AccountDeletionRequests({ now: () => now, ttlMs: 500 });

  const first = requests.request(" user-1 ");
  assert.deepEqual(requests.request("user-1"), first);
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

test("clock rollback cannot revive or extend a deletion request", () => {
  let now = 3_000;
  const requests = new AccountDeletionRequests({ now: () => now, ttlMs: 100 });
  const expired = requests.request("user-3");

  now = expired.expiresAt;
  assert.equal(requests.confirm(expired.token), false);
  now = 1;
  const replacement = requests.request("user-3");
  assert.equal(replacement.expiresAt, 3_200);
});

test("canonical user IDs share one live request", () => {
  const requests = new AccountDeletionRequests();
  const composed = requests.request("caf\u00e9");
  assert.deepEqual(requests.request("cafe\u0301"), composed);
  assert.throws(() => requests.request("\ud800"), /well formed/);
});

test("reentrant clocks cannot produce two terminal outcomes or orphan live requests", () => {
  let token;
  let requests;
  let nestedError;
  const now = () => {
    if (token) {
      try {
        requests.cancel(token);
      } catch (error) {
        nestedError = error;
      }
    }
    return 5_000;
  };
  requests = new AccountDeletionRequests({ now });
  token = requests.request("user-4").token;
  assert.equal(requests.confirm(token), true);
  assert.match(nestedError.message, /reentrant/);
  assert.equal(requests.confirm(token), false);
});

test("capacity is bounded and expired entries yield space", () => {
  let now = 6_000;
  const requests = new AccountDeletionRequests({ maxEntries: 2, now: () => now, ttlMs: 100 });
  requests.request("user-a");
  requests.request("user-b");
  assert.throws(() => requests.request("user-c"), /capacity/);
  now += 100;
  assert.doesNotThrow(() => requests.request("user-c"));
});

test("unrepresentable deadlines preserve live requests and do not poison recovery", () => {
  let now = 7_000;
  const requests = new AccountDeletionRequests({ maxEntries: 2, now: () => now, ttlMs: 100 });
  const first = requests.request("user-overflow");
  const second = requests.request("user-stable");

  now = Number.MAX_SAFE_INTEGER;
  assert.throws(() => requests.request("user-overflow"), /not representable/);
  now = 7_001;
  assert.equal(requests.confirm(first.token), true);
  assert.equal(requests.cancel(second.token), true);
  assert.doesNotThrow(() => requests.request("user-recovered"));
});

test("duplicate generated tokens are rejected without rebinding authorization", () => {
  const original = crypto.randomUUID;
  const fixed = original.call(crypto);
  crypto.randomUUID = () => fixed;
  try {
    const requests = new AccountDeletionRequests();
    const first = requests.request("user-5");
    assert.equal(requests.cancel(first.token), true);
    assert.throws(() => requests.request("user-6"), /unique deletion token/);
    assert.equal(requests.confirm(first.token), false);
  } finally {
    crypto.randomUUID = original;
  }
});

test("invalid deletion inputs fail before persistent state changes", () => {
  assert.throws(() => new AccountDeletionRequests({ ttlMs: 0 }), /positive safe integer/);
  assert.throws(() => new AccountDeletionRequests({ maxEntries: 0 }), /positive safe integer/);
  const requests = new AccountDeletionRequests();
  assert.throws(() => requests.request("   "), /user id is required/);
});
