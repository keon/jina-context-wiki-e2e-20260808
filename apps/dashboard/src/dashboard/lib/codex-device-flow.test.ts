import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assembleAuthJson,
  boundedInterval,
  classifyPollStatus,
  decodeAccountId,
  handshakeErrorMessage,
  parseCodeSuccess,
  parseOAuthTokens,
  parseStoredCodexDeviceFlow,
  parseUsercodeResponse,
} from "./codex-device-flow";

/* ---------- interval bounds ---------- */

test("boundedInterval clamps to 1..60 and defaults on garbage", () => {
  assert.equal(boundedInterval(5), 5);
  assert.equal(boundedInterval(1), 1); // floor
  assert.equal(boundedInterval(0), 5); // default (non-positive)
  assert.equal(boundedInterval(-3), 5);
  assert.equal(boundedInterval(999), 60); // ceil
  assert.equal(boundedInterval(undefined), 5);
  assert.equal(boundedInterval("7"), 7);
  assert.equal(boundedInterval("nope"), 5);
});

/* ---------- poll classification ---------- */

test("classifyPollStatus maps http status to flow state", () => {
  assert.equal(classifyPollStatus(200), "success");
  assert.equal(classifyPollStatus(204), "success");
  assert.equal(classifyPollStatus(403), "pending"); // OpenAI: not approved yet
  assert.equal(classifyPollStatus(404), "pending");
  assert.equal(classifyPollStatus(400), "error");
  assert.equal(classifyPollStatus(500), "error");
});

/* ---------- usercode / token parsing ---------- */

test("parseUsercodeResponse normalizes the usercode payload", () => {
  assert.deepEqual(
    parseUsercodeResponse({ device_auth_id: "d1", user_code: "ABCD-1234", interval: 5, expires_at: 1_800_000_000 }),
    { deviceAuthId: "d1", userCode: "ABCD-1234", intervalSeconds: 5, expiresAtMs: 1_800_000_000_000 },
  );
  // Tolerates the `usercode` alias and defaults a missing interval / expiry.
  assert.deepEqual(parseUsercodeResponse({ device_auth_id: "d1", usercode: "ZZ" }), {
    deviceAuthId: "d1",
    userCode: "ZZ",
    intervalSeconds: 5,
    expiresAtMs: null,
  });
  assert.equal(
    parseUsercodeResponse({ device_auth_id: "d1", user_code: "ZZ", expires_at: "2027-01-15T08:00:00Z" })?.expiresAtMs,
    Date.parse("2027-01-15T08:00:00Z"),
  );
  assert.equal(parseUsercodeResponse({ user_code: "no-device-id" }), null);
  assert.equal(parseUsercodeResponse(null), null);
});

test("parseStoredCodexDeviceFlow restores only the current tenant's unexpired flow", () => {
  const stored = JSON.stringify({
    version: 1,
    flowId: "flow_12345678",
    tenantId: "tenant-a",
    startedAtMs: 1_000,
    start: { deviceAuthId: "device", userCode: "CODE", intervalSeconds: 5, expiresAtMs: 901_000 },
  });
  assert.deepEqual(parseStoredCodexDeviceFlow(stored, "tenant-a", 2_000), {
    version: 1,
    flowId: "flow_12345678",
    tenantId: "tenant-a",
    startedAtMs: 1_000,
    start: { deviceAuthId: "device", userCode: "CODE", intervalSeconds: 5, expiresAtMs: 901_000 },
  });
  assert.equal(parseStoredCodexDeviceFlow(stored, "tenant-b", 2_000), null);
  assert.equal(parseStoredCodexDeviceFlow(stored, "tenant-a", 901_000), null);
  assert.equal(parseStoredCodexDeviceFlow("not-json", "tenant-a", 2_000), null);
});

test("parseCodeSuccess / parseOAuthTokens require their fields", () => {
  assert.deepEqual(parseCodeSuccess({ authorization_code: "ac", code_verifier: "cv", code_challenge: "cc" }), {
    authorizationCode: "ac",
    codeVerifier: "cv",
  });
  assert.equal(parseCodeSuccess({ authorization_code: "ac" }), null); // no verifier
  assert.deepEqual(parseOAuthTokens({ id_token: "i", access_token: "a", refresh_token: "r" }), {
    idToken: "i",
    accessToken: "a",
    refreshToken: "r",
  });
  assert.equal(parseOAuthTokens({ id_token: "i", access_token: "a" }), null); // no refresh
});

/* ---------- JWT account_id decode (fabricated token) ---------- */

function makeIdToken(claims: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url(claims)}.`;
}

test("decodeAccountId reads chatgpt_account_id and tolerates garbage", () => {
  assert.equal(decodeAccountId(makeIdToken({ chatgpt_account_id: "acc_123" })), "acc_123");
  assert.equal(decodeAccountId(makeIdToken({ email: "x@y.z" })), null); // claim absent
  assert.equal(decodeAccountId("not-a-jwt"), null);
  assert.equal(decodeAccountId(""), null);
  // Multi-byte UTF-8 in the payload must not break decoding.
  assert.equal(decodeAccountId(makeIdToken({ chatgpt_account_id: "acc_café", name: "José" })), "acc_café");
});

/* ---------- auth.json assembly ---------- */

test("assembleAuthJson matches the codex auth.json shape (OPENAI_API_KEY null)", () => {
  const now = new Date("2026-07-08T00:00:00.000Z");
  const raw = assembleAuthJson({
    idToken: "id",
    accessToken: "acc",
    refreshToken: "ref",
    accountId: "acc_1",
    now,
  });
  assert.deepEqual(JSON.parse(raw), {
    OPENAI_API_KEY: null,
    tokens: { id_token: "id", access_token: "acc", refresh_token: "ref", account_id: "acc_1" },
    last_refresh: "2026-07-08T00:00:00.000Z",
  });
  // A null account_id is preserved (JWT lacked the claim).
  const noAccount = JSON.parse(
    assembleAuthJson({ idToken: "i", accessToken: "a", refreshToken: "r", accountId: null }),
  ) as {
    OPENAI_API_KEY: string | null;
    tokens: { account_id: string | null };
    last_refresh: string;
  };
  assert.equal(noAccount.OPENAI_API_KEY, null);
  assert.equal(noAccount.tokens.account_id, null);
  assert.equal(typeof noAccount.last_refresh, "string");
});

// A completed OpenAI sign-in that cannot be stored must say why. Both of these
// stood for a guard that returned silently, leaving the spinner running with
// nothing to explain it.
test("handshakeErrorMessage explains why a completed sign-in was not saved", () => {
  assert.match(handshakeErrorMessage("no_tenant"), /Select an organization/);
  assert.match(handshakeErrorMessage("tenant_changed"), /organization changed/);
  // The signed-in-but-unsaved cases stay distinguishable from a failed sign-in.
  assert.notEqual(handshakeErrorMessage("tenant_changed"), handshakeErrorMessage("save_failed"));
  assert.notEqual(handshakeErrorMessage("no_tenant"), handshakeErrorMessage("start_failed"));
  // An unknown reason still falls back rather than rendering the raw token.
  assert.match(handshakeErrorMessage("something_new"), /Something went wrong/);
});
