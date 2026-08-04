import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeCodexHarnessInfo, precheckCodexAuth } from "./codex-harness";

test("precheckCodexAuth accepts a plausible auth.json with a tokens object", () => {
  const auth = JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: "a", access_token: "b", refresh_token: "c" },
    last_refresh: "2026-07-08T00:00:00Z",
  });
  assert.deepEqual(precheckCodexAuth(auth), { ok: true });
});

test("precheckCodexAuth rejects empty / whitespace-only input", () => {
  assert.equal(precheckCodexAuth("").ok, false);
  assert.equal(precheckCodexAuth("   \n ").ok, false);
});

test("precheckCodexAuth rejects invalid JSON", () => {
  const result = precheckCodexAuth("{ not json ");
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /valid JSON/i);
});

test("precheckCodexAuth rejects non-object JSON (array, string, number)", () => {
  assert.equal(precheckCodexAuth("[]").ok, false);
  assert.equal(precheckCodexAuth('"hello"').ok, false);
  assert.equal(precheckCodexAuth("42").ok, false);
  assert.equal(precheckCodexAuth("null").ok, false);
});

test("precheckCodexAuth rejects an object without a usable tokens object", () => {
  assert.equal(precheckCodexAuth(JSON.stringify({ OPENAI_API_KEY: "x" })).ok, false);
  assert.equal(precheckCodexAuth(JSON.stringify({ tokens: null })).ok, false);
  assert.equal(precheckCodexAuth(JSON.stringify({ tokens: "str" })).ok, false);
  assert.equal(precheckCodexAuth(JSON.stringify({ tokens: [] })).ok, false);
  assert.equal(precheckCodexAuth(JSON.stringify({ tokens: {} })).ok, false);
});

test("normalizeCodexHarnessInfo tolerates absent / malformed payloads", () => {
  assert.deepEqual(normalizeCodexHarnessInfo(undefined), { configured: false });
  assert.deepEqual(normalizeCodexHarnessInfo(null), { configured: false });
  assert.deepEqual(normalizeCodexHarnessInfo("nope"), { configured: false });
  assert.deepEqual(normalizeCodexHarnessInfo([]), { configured: false });
  assert.deepEqual(normalizeCodexHarnessInfo({ configured: "yes" }), { configured: false });
});

test("normalizeCodexHarnessInfo keeps configured + connected_at when present", () => {
  assert.deepEqual(
    normalizeCodexHarnessInfo({ configured: true, connected_at: "2026-07-08T00:00:00Z" }),
    { configured: true, connected_at: "2026-07-08T00:00:00Z" },
  );
  // connected_at of the wrong type is dropped.
  assert.deepEqual(normalizeCodexHarnessInfo({ configured: true, connected_at: 5 }), { configured: true });
});

test("normalizeCodexHarnessInfo keeps the reconnect-required notice state", () => {
  assert.deepEqual(
    normalizeCodexHarnessInfo({
      configured: true,
      connected_at: "2026-07-08T00:00:00Z",
      reconnect_required: true,
    }),
    {
      configured: true,
      connected_at: "2026-07-08T00:00:00Z",
      reconnect_required: true,
    },
  );
  assert.deepEqual(
    normalizeCodexHarnessInfo({ configured: false, reconnect_required: true }),
    { configured: false },
  );
});
