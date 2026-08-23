import assert from "node:assert/strict";
import test from "node:test";
import { AccountDeletionRequests } from "../src/account-deletion.js";

test("account deletion requires one account-bound, single-use confirmation", () => {
  let now = 1_000;
  const requests = new AccountDeletionRequests({ now: () => now, ttlMs: 500 });

  const first = requests.request(" user-1 ");
  assert.deepEqual(requests.request("user-1"), first);
  assert.equal(first.userId, "user-1");
  assert.equal(first.expiresAt, 1_500);
  assert.equal(requests.confirm("other-user", first.token), false);
  assert.equal(requests.confirm("user-1", first.token), true);
  assert.equal(requests.confirm("user-1", first.token), false);

  now += 1;
  assert.notEqual(requests.request("user-1").token, first.token);
});

test("expired or cancelled deletion requests cannot delete an account", () => {
  let now = 2_000;
  const requests = new AccountDeletionRequests({ now: () => now, ttlMs: 100 });
  const expired = requests.request("user-2");

  now = expired.expiresAt;
  assert.equal(requests.confirm("user-2", expired.token), false);

  const cancelled = requests.request("user-2");
  assert.equal(requests.cancel("other-user", cancelled.token), false);
  assert.equal(requests.cancel("user-2", cancelled.token), true);
  assert.equal(requests.confirm("user-2", cancelled.token), false);
  assert.equal(requests.cancel("user-2", "missing"), false);
});

test("clock rollback fails closed and immediately recovers", () => {
  let now = 3_000;
  const requests = new AccountDeletionRequests({ now: () => now, ttlMs: 100 });
  const stale = requests.request("user-3");

  now = 1;
  assert.equal(requests.confirm("user-3", stale.token), false);
  const replacement = requests.request("user-3");
  assert.equal(replacement.expiresAt, 101);
});

test("future clock spikes cannot extend authorization after recovery", () => {
  let now = 4_000;
  const requests = new AccountDeletionRequests({ now: () => now, ttlMs: 100 });
  requests.request("before-spike");
  now = 40_000;
  const spike = requests.request("during-spike");
  now = 4_001;
  assert.equal(requests.confirm("during-spike", spike.token), false);
  assert.equal(requests.request("after-spike").expiresAt, 4_101);
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
        requests.cancel("user-4", token);
      } catch (error) {
        nestedError = error;
      }
    }
    return 5_000;
  };
  requests = new AccountDeletionRequests({ now });
  token = requests.request("user-4").token;
  assert.equal(requests.confirm("user-4", token), true);
  assert.match(nestedError.message, /reentrant/);
  assert.equal(requests.confirm("user-4", token), false);
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
  assert.equal(requests.confirm("user-overflow", first.token), true);
  assert.equal(requests.cancel("user-stable", second.token), true);
  assert.doesNotThrow(() => requests.request("user-recovered"));
});

test("tokens never replay during sustained bounded churn", () => {
  const requests = new AccountDeletionRequests({ maxEntries: 2 });
  const seen = new Set();
  for (let index = 0; index < 10_000; index += 1) {
    const request = requests.request(`user-${index}`);
    assert.equal(seen.has(request.token), false);
    seen.add(request.token);
    assert.equal(requests.cancel(request.userId, request.token), true);
  }
});

test("invalid deletion inputs fail before persistent state changes", () => {
  assert.throws(() => new AccountDeletionRequests({ ttlMs: 0 }), /positive safe integer/);
  assert.throws(() => new AccountDeletionRequests({ maxEntries: 0 }), /positive safe integer/);
  const requests = new AccountDeletionRequests();
  assert.throws(() => requests.request("   "), /user id is required/);
});
