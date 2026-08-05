import { createPublicKey, verify as verifySignature } from "node:crypto";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 30;

interface Jwk { kty: string; kid?: string; alg?: string; n?: string; e?: string }
type JwksFetcher = () => Promise<{ keys: Jwk[] }>;

export interface GoogleOidcExpectation {
  audience: string;
  email: string;
}

let cachedJwks: { keys: Jwk[]; fetchedAt: number } | undefined;

async function defaultFetchJwks(): Promise<{ keys: Jwk[] }> {
  const response = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Google JWKS request failed with status ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error("Google JWKS response is missing keys");
  return { keys: body.keys };
}

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT segment is not an object");
  }
  return parsed as Record<string, unknown>;
}

/** True when the header shape is a Google-signed ID token rather than a static bearer. */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Verify a Google-issued OIDC identity token: RS256 signature against Google's
 * published JWKS, issuer, audience, expiry, and the verified email of the
 * calling service account. Throws on any mismatch.
 */
export async function verifyGoogleIdToken(
  token: string,
  expectation: GoogleOidcExpectation,
  fetchJwks: JwksFetcher = defaultFetchJwks,
  nowSeconds = () => Math.floor(Date.now() / 1000)
): Promise<void> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("identity token is not a JWT");
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const header = decodeSegment(headerSegment);
  if (header.alg !== "RS256") throw new Error("identity token algorithm must be RS256");
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  if (!kid) throw new Error("identity token is missing kid");

  if (!cachedJwks || Date.now() - cachedJwks.fetchedAt > JWKS_CACHE_TTL_MS) {
    cachedJwks = { ...(await fetchJwks()), fetchedAt: Date.now() };
  }
  let jwk = cachedJwks.keys.find((key) => key.kid === kid);
  if (!jwk) {
    // Key rotation: refresh once before rejecting.
    cachedJwks = { ...(await fetchJwks()), fetchedAt: Date.now() };
    jwk = cachedJwks.keys.find((key) => key.kid === kid);
  }
  if (!jwk) throw new Error("identity token kid is not a current Google signing key");

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, "utf8");
  const signature = Buffer.from(signatureSegment, "base64url");
  if (!verifySignature("RSA-SHA256", signed, publicKey, signature)) {
    throw new Error("identity token signature is invalid");
  }

  const payload = decodeSegment(payloadSegment);
  if (typeof payload.iss !== "string" || !GOOGLE_ISSUERS.has(payload.iss)) {
    throw new Error("identity token issuer is not Google");
  }
  if (payload.aud !== expectation.audience) throw new Error("identity token audience mismatch");
  const now = nowSeconds();
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS <= now) {
    throw new Error("identity token is expired");
  }
  if (typeof payload.iat === "number" && payload.iat - CLOCK_SKEW_SECONDS > now) {
    throw new Error("identity token is not yet valid");
  }
  if (payload.email !== expectation.email || payload.email_verified !== true) {
    throw new Error("identity token is not from the expected service account");
  }
}

/** Test seam: drop the cached JWKS so a fresh fetcher takes effect. */
export function resetGoogleJwksCache(): void {
  cachedJwks = undefined;
}
