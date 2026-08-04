import { createHash, randomBytes } from "node:crypto";

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { callbackUrlFor, cookieSecurity, requireDashboardSession } from "./auth.js";
import type { AppConfig } from "./config.js";
import { decryptSecret, encryptSecret, isEncryptedEnvelope } from "./crypto.js";
import {
  ensurePersonalTenantId,
  getTenantMembershipRole,
  saveTenantOpenRouterIntegration,
} from "./store.js";

// The PKCE verifier is held in a short-lived HttpOnly cookie between /start and
// /callback, scoped to the OAuth route so it is not sent with other requests.
const PKCE_COOKIE_NAME = "jina_openrouter_pkce";
const OAUTH_COOKIE_PATH = "/dashboard/integrations/openrouter/oauth";
const CALLBACK_PATH = "/dashboard/integrations/openrouter/oauth/callback";
const PKCE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

/** Generate a base64url PKCE code verifier (32 random bytes -> 43 chars, > the RFC minimum). */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** Derive the S256 PKCE code challenge: base64url(sha256(verifier)). */
export function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * FINDING 6a: the PKCE cookie must bind the flow to the user who started it, or a completed callback
 * could attach an OpenRouter key across users (the callback previously trusted whatever session was
 * active). The cookie payload binds { code_verifier, github_user_id, nonce } and is protected with
 * the app's existing secret-at-rest primitive (authenticated AES-256-GCM via SECRETS_ENCRYPTION_KEY),
 * so github_user_id cannot be forged. The callback compares the bound id to the active session.
 */
// tenant_id is the tenant the resolved key will be saved to (the caller validated the viewer is an
// admin of it, or omitted it to default to the personal tenant). It is carried INSIDE the encrypted
// binding so the callback cannot be pointed at a different tenant than the one authorized at start.
export type VerifierBinding = {
  code_verifier: string;
  github_user_id: number;
  nonce: string;
  tenant_id?: string;
};

export function encodeVerifierBinding(binding: VerifierBinding): string {
  return encryptSecret(JSON.stringify(binding));
}

/**
 * FINDING (flow fencing): the PKCE binding lives in ONE fixed cookie, so a second /oauth/start in the
 * same browser overwrites the first flow's binding. Without a per-flow marker the FIRST callback would
 * exchange its code under the SECOND flow's binding — including its tenant_id — attaching the key to a
 * tenant the first flow never authorized. The start endpoint stamps the binding's nonce onto the
 * callback URL (?flow=<nonce>, which OpenRouter echoes untouched); the callback then requires the query
 * nonce to equal the cookie binding's nonce, so an overwritten cookie can no longer serve an older
 * flow's callback. An absent/blank query nonce never matches.
 */
export function callbackFlowMatchesBinding(queryFlow: string | undefined, binding: VerifierBinding): boolean {
  return typeof queryFlow === "string" && queryFlow.length > 0 && queryFlow === binding.nonce;
}

export function decodeVerifierBinding(raw: string | undefined): VerifierBinding | undefined {
  // FINDING 4b: the binding MUST be an authenticated encryption envelope. decryptSecret has a legacy
  // plaintext passthrough (it returns non-envelope values as-is), so accepting a plaintext cookie would
  // let anyone forge { github_user_id: <victim> } and attach a key across users. Reject any value that
  // is not an envelope outright — even in dev — so the binding is never forgeable. (In production
  // SECRETS_ENCRYPTION_KEY is required, per config.ts, so encode always yields an envelope.)
  if (!raw || !isEncryptedEnvelope(raw)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(decryptSecret(raw)) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as VerifierBinding).code_verifier === "string" &&
      typeof (parsed as VerifierBinding).github_user_id === "number" &&
      (( parsed as VerifierBinding).tenant_id === undefined || typeof (parsed as VerifierBinding).tenant_id === "string")
    ) {
      return parsed as VerifierBinding;
    }
  } catch {
    // Tampered / undecryptable / malformed cookie — treat as no binding.
  }
  return undefined;
}

export async function startOpenRouterOAuth(c: Context, config: AppConfig): Promise<Response> {
  const session = await requireDashboardSession(c, config);
  if (!session) {
    // Auth disabled: there is no user to attach the key to.
    return c.json({ error: "dashboard authentication required" }, 401);
  }

  // Optional target tenant. When provided the viewer must be an ADMIN of it; when omitted the flow
  // targets the viewer's personal tenant (ensured here so the callback always has a concrete tenant id).
  let tenantId: string | undefined;
  const requestedTenantId = c.req.query("tenant_id")?.trim();
  if (requestedTenantId) {
    const role = await getTenantMembershipRole(session.user.id, requestedTenantId, session.userId);
    if (role !== "admin") {
      return c.json({ error: "tenant admin access required" }, 403);
    }
    tenantId = requestedTenantId;
  } else {
    tenantId = await ensurePersonalTenantId(session.user.id);
  }

  const verifier = generateCodeVerifier();
  const challenge = deriveCodeChallenge(verifier);
  const nonce = randomBytes(16).toString("base64url");

  // Bind the verifier to the initiating user (FINDING 6a) AND the authorized target tenant so the
  // callback can reject a session that did not start this flow and cannot retarget another tenant.
  const cookieValue = encodeVerifierBinding({
    code_verifier: verifier,
    github_user_id: session.user.id,
    nonce,
    tenant_id: tenantId,
  });

  setCookie(c, PKCE_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    maxAge: PKCE_COOKIE_MAX_AGE_SECONDS,
    path: OAUTH_COOKIE_PATH,
    ...cookieSecurity(config),
  });

  // Fence the callback to THIS flow: stamp the binding's nonce onto the callback URL. OpenRouter echoes
  // the callback_url untouched (appending ?code=...), so the nonce survives the round trip and lets the
  // callback reject a cookie left by a later /oauth/start (see callbackFlowMatchesBinding).
  const callbackUrl = new URL(callbackUrlFor(c, config, CALLBACK_PATH));
  callbackUrl.searchParams.set("flow", nonce);

  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callbackUrl.toString());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return c.json({ url: url.toString() });
}

export async function openRouterOAuthCallback(c: Context, config: AppConfig): Promise<Response> {
  const rawCookie = getCookie(c, PKCE_COOKIE_NAME);
  deleteCookie(c, PKCE_COOKIE_NAME, { path: OAUTH_COOKIE_PATH, ...cookieSecurity(config) });

  const successRedirect = `${config.dashboardUrl}/integrations?openrouter=connected`;
  const errorRedirect = `${config.dashboardUrl}/integrations?openrouter=error`;

  try {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      throw new Error("no dashboard session");
    }
    const binding = decodeVerifierBinding(rawCookie);
    if (!binding) {
      throw new Error("missing or invalid PKCE binding cookie");
    }
    // FINDING 6a: the callback must run for the same user who started the flow, else a key could be
    // attached across users. Bail (error redirect + warning) on a mismatch rather than proceeding.
    if (binding.github_user_id !== session.user.id) {
      console.warn("openrouter_oauth_user_mismatch", {
        session_user_id: session.user.id,
        bound_user_id: binding.github_user_id,
      });
      return c.redirect(errorRedirect, 302);
    }
    // FINDING (flow fencing): the callback must belong to the SAME flow that set this cookie. A second
    // /oauth/start overwrites the single PKCE cookie, so require the nonce stamped on the callback URL
    // to match the cookie binding's nonce — otherwise an older flow's callback could exchange its code
    // under this (newer) binding, including its authorized tenant_id.
    if (!callbackFlowMatchesBinding(c.req.query("flow"), binding)) {
      console.warn("openrouter_oauth_flow_mismatch", {
        session_user_id: session.user.id,
      });
      return c.redirect(errorRedirect, 302);
    }
    const code = c.req.query("code");
    if (!code) {
      throw new Error("missing authorization code");
    }
    // Resolve the target tenant from the binding (authorized at start). Older bindings without a
    // tenant_id (or a session whose personal tenant was created since) fall back to the personal tenant.
    const tenantId = binding.tenant_id ?? (await ensurePersonalTenantId(session.user.id));
    if (!tenantId) {
      throw new Error("no target tenant for openrouter key");
    }
    const key = await exchangeCodeForKey(code, binding.code_verifier);
    // The flow can outlive the membership that authorized it. Re-check immediately before the write;
    // personal tenants resolve through the same implicit-admin membership helper.
    if ((await getTenantMembershipRole(session.user.id, tenantId, session.userId)) !== "admin") {
      return c.redirect(errorRedirect, 302);
    }
    await saveTenantOpenRouterIntegration(tenantId, {
      openrouter: key,
      openrouterSource: "oauth",
      configuredByUserId: session.user.id,
      configuredByLogin: session.user.login,
    });
    return c.redirect(successRedirect, 302);
  } catch (error) {
    // Never log the key. Error messages here carry no secret material.
    console.warn("openrouter_oauth_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.redirect(errorRedirect, 302);
  }
}

async function exchangeCodeForKey(code: string, verifier: string): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!response.ok) {
    throw new Error(`openrouter key exchange failed: ${response.status}`);
  }
  const data = (await response.json().catch(() => undefined)) as { key?: unknown } | undefined;
  if (!data || typeof data.key !== "string" || data.key.length === 0) {
    throw new Error("openrouter key exchange returned no key");
  }
  return data.key;
}
