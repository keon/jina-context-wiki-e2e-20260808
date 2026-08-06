import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { looksLikeJwt, resetGoogleJwksCache, verifyGoogleIdToken } from "./google-oidc.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
const EXPECTATION = {
  audience: "https://api.example.com/internal/schedules/billing-retry",
  email: "scheduler@project.iam.gserviceaccount.com",
};

function signToken(payload: Record<string, unknown>, kid = "test-key"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(privateKey).toString("base64url")}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: EXPECTATION.audience,
    iat: now - 10,
    exp: now + 3600,
    email: EXPECTATION.email,
    email_verified: true,
    ...overrides,
  };
}

const fetchJwks = () => Promise.resolve({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] });

test("verifyGoogleIdToken accepts a valid Google-signed identity token", async () => {
  resetGoogleJwksCache();
  await verifyGoogleIdToken(signToken(validPayload()), EXPECTATION, fetchJwks);
});

test("verifyGoogleIdToken rejects tampered and mismatched tokens", async () => {
  resetGoogleJwksCache();
  const reject = (token: string) => assert.rejects(verifyGoogleIdToken(token, EXPECTATION, fetchJwks));

  await reject(signToken(validPayload({ aud: "https://other.example.com" })));
  await reject(signToken(validPayload({ iss: "https://evil.example.com" })));
  await reject(signToken(validPayload({ email: "attacker@project.iam.gserviceaccount.com" })));
  await reject(signToken(validPayload({ email_verified: false })));
  await reject(signToken(validPayload({ exp: Math.floor(Date.now() / 1000) - 120 })));
  await reject(signToken(validPayload(), "unknown-kid"));

  const valid = signToken(validPayload());
  const [header, payload] = valid.split(".");
  const forgedBody = Buffer.from(JSON.stringify(validPayload({ email: "attacker@x" }))).toString("base64url");
  await reject(`${header}.${forgedBody}.${valid.split(".")[2]}`);
  await reject(`${header}.${payload}.`);
});

test("verifyGoogleIdToken rejects alg confusion", async () => {
  resetGoogleJwksCache();
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "test-key" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(validPayload())).toString("base64url");
  await assert.rejects(verifyGoogleIdToken(`${header}.${body}.x`, EXPECTATION, fetchJwks));
});

test("looksLikeJwt distinguishes identity tokens from static bearers", () => {
  assert.equal(looksLikeJwt(signToken(validPayload())), true);
  assert.equal(looksLikeJwt("static-internal-token"), false);
  assert.equal(looksLikeJwt("a.b"), false);
});
