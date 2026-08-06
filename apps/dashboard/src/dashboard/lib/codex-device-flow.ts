/**
 * Pure/typed helpers for the BROWSER-SIDE Codex device-code handshake.
 *
 * The whole OpenAI device flow runs in the user's browser (auth.openai.com answers cross-origin with
 * `access-control-allow-origin: *`), because our server-side POSTs are blocked by Cloudflare's
 * TLS-fingerprint challenge. Only the assembled auth.json is sent back to our own encrypted endpoint.
 *
 * These helpers are kept free of React/DOM so they can be unit-tested with `node --test`.
 *
 * OpenAI contract (source-confirmed from openai/codex + live CORS probes):
 *   1. POST /api/accounts/deviceauth/usercode  { client_id }  -> { device_auth_id, user_code, interval, expires_at }
 *   2. user opens /codex/device and enters user_code (after enabling device-code auth in ChatGPT settings)
 *   3. POST /api/accounts/deviceauth/token  { device_auth_id, user_code }
 *        403/404 -> STILL PENDING (keep polling); 200 -> { authorization_code, code_challenge, code_verifier }
 *   4. POST /oauth/token (form) grant_type=authorization_code ... -> { id_token, access_token, refresh_token }
 *   5. account_id = `chatgpt_account_id` claim of the id_token JWT
 *   6. assemble auth.json { OPENAI_API_KEY: null, tokens: {…}, last_refresh }
 */

/** OpenAI's public Codex app registration. Not a secret; not configurable. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const CODEX_ISSUER = "https://auth.openai.com";

/** The exact OpenAI endpoints the browser drives (note the /api/accounts/ prefix on the device endpoints). */
export const DEVICE_ENDPOINTS = {
  usercode: `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
  token: `${CODEX_ISSUER}/api/accounts/deviceauth/token`,
  oauthToken: `${CODEX_ISSUER}/oauth/token`,
  // usercode/token carry /api/accounts but the token-exchange redirect_uri does NOT
  // (Codex source: redirect_uri = {issuer}/deviceauth/callback). The /api/accounts
  // form makes /oauth/token 400 with token_exchange_user_error.
  redirectUri: `${CODEX_ISSUER}/deviceauth/callback`,
} as const;

/** The page the user opens to enter their one-time code. */
export const CODEX_VERIFY_URL = `${CODEX_ISSUER}/codex/device`;

/** Where the user enables "Device code authorization for Codex". */
export const CODEX_SECURITY_SETTINGS_URL = "https://chatgpt.com/security-settings";

// Guard rails around the server-provided poll interval so a hostile/absent value can't busy-loop or stall.
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 60;
const DEFAULT_INTERVAL_SECONDS = 5;

export interface UsercodeResponse {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAtMs: number | null;
}

export interface StoredCodexDeviceFlow {
  version: 1;
  flowId: string;
  tenantId: string;
  startedAtMs: number;
  start: UsercodeResponse;
}

export interface CodexConnectTelemetryEvent {
  event:
    | "flow_started"
    | "flow_resumed"
    | "user_code_received"
    | "verification_opened"
    | "visibility_changed"
    | "authorization_approved"
    | "token_exchange_succeeded"
    | "credential_save_started"
    | "credential_save_succeeded"
    | "flow_failed"
    | "flow_cancelled";
  flow_id: string;
  stage?: "ui" | "start" | "poll" | "exchange" | "save";
  reason?: string;
  http_status?: number;
  elapsed_ms?: number;
  attempt?: number;
  visibility?: "visible" | "hidden";
}

export type PollStatus = "success" | "pending" | "error";

export interface CodeSuccess {
  authorizationCode: string;
  codeVerifier: string;
}

export interface OAuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

/** Clamp a raw interval (seconds) into the sane 1..60 range, defaulting on garbage. */
export function boundedInterval(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(Math.max(Math.floor(value), MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
}

/** Parse the /deviceauth/usercode response into the fields the browser flow needs. */
export function parseUsercodeResponse(raw: unknown): UsercodeResponse | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const deviceAuthId = record.device_auth_id;
  const userCode = record.user_code ?? record.usercode;
  if (typeof deviceAuthId !== "string" || deviceAuthId.length === 0) return null;
  if (typeof userCode !== "string" || userCode.length === 0) return null;
  const expiresAtMs = parseExpiryMs(record.expires_at);
  return {
    deviceAuthId,
    userCode,
    intervalSeconds: boundedInterval(record.interval),
    expiresAtMs,
  };
}

function parseExpiryMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // OpenAI has returned both Unix seconds and milliseconds over time.
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Restore only an unexpired flow for the currently selected tenant. */
export function parseStoredCodexDeviceFlow(
  raw: string | null,
  tenantId: string,
  nowMs = Date.now(),
): StoredCodexDeviceFlow | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredCodexDeviceFlow>;
    const start = value.start as Partial<UsercodeResponse> | undefined;
    if (
      value.version !== 1 ||
      typeof value.flowId !== "string" ||
      value.flowId.length < 8 ||
      value.tenantId !== tenantId ||
      typeof value.startedAtMs !== "number" ||
      !start ||
      typeof start.deviceAuthId !== "string" ||
      typeof start.userCode !== "string" ||
      typeof start.intervalSeconds !== "number"
    ) {
      return null;
    }
    const expiresAtMs = typeof start.expiresAtMs === "number" ? start.expiresAtMs : null;
    const effectiveExpiry = Math.min(value.startedAtMs + 15 * 60 * 1000, expiresAtMs ?? Number.POSITIVE_INFINITY);
    if (effectiveExpiry <= nowMs) return null;
    return {
      version: 1,
      flowId: value.flowId,
      tenantId,
      startedAtMs: value.startedAtMs,
      start: {
        deviceAuthId: start.deviceAuthId,
        userCode: start.userCode,
        intervalSeconds: boundedInterval(start.intervalSeconds),
        expiresAtMs,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Classify one poll of the device token endpoint from its HTTP status alone:
 *   200      -> success (body carries the authorization_code + PKCE verifier)
 *   403/404  -> pending (OpenAI's "not approved yet" signal — keep polling)
 *   anything else -> error
 */
export function classifyPollStatus(httpStatus: number): PollStatus {
  if (httpStatus >= 200 && httpStatus < 300) return "success";
  if (httpStatus === 403 || httpStatus === 404) return "pending";
  return "error";
}

/** Parse the successful /deviceauth/token response (server-issued authorization code + PKCE verifier). */
export function parseCodeSuccess(raw: unknown): CodeSuccess | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const authorizationCode = record.authorization_code;
  const codeVerifier = record.code_verifier;
  if (typeof authorizationCode !== "string" || authorizationCode.length === 0) return null;
  if (typeof codeVerifier !== "string" || codeVerifier.length === 0) return null;
  return { authorizationCode, codeVerifier };
}

/** Parse the /oauth/token authorization_code exchange response. */
export function parseOAuthTokens(raw: unknown): OAuthTokens | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const idToken = record.id_token;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  if (typeof idToken !== "string" || idToken.length === 0) return null;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return null;
  return { idToken, accessToken, refreshToken };
}

/** base64url-decode a JWT segment to a UTF-8 string in the browser (atob + %-escape). Null-safe. */
function decodeJwtSegment(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    // Percent-escape each byte so multi-byte UTF-8 sequences decode correctly.
    const escaped = Array.from(binary, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    return decodeURIComponent(escaped);
  } catch {
    return null;
  }
}

/**
 * Decode the `chatgpt_account_id` claim from a JWT id_token WITHOUT verifying the signature.
 * Defensive: returns null on any malformed input rather than throwing.
 */
export function decodeAccountId(idToken: string): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  const json = decodeJwtSegment(parts[1]!);
  if (json === null) return null;
  try {
    const payload = JSON.parse(json) as Record<string, unknown>;
    const accountId = payload.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

/**
 * Assemble the ~/.codex/auth.json document EXACTLY as `codex login` writes it, so the worker's Codex
 * harness consumes it unchanged. OPENAI_API_KEY is always null on the browser path (Codex derives it
 * lazily from the refresh token at runtime).
 */
export function assembleAuthJson(input: {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
  now?: Date;
}): string {
  const authJson = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: input.idToken,
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      account_id: input.accountId,
    },
    last_refresh: (input.now ?? new Date()).toISOString(),
  };
  return JSON.stringify(authJson);
}

/** Human-readable, retryable message for a handshake failure reason. Never surfaces token material. */
export function handshakeErrorMessage(reason: string): string {
  switch (reason) {
    case "denied":
      return "Authorization was declined. Try again to retry.";
    case "expired":
      return "Code expired — generate a new one.";
    case "start_failed":
    case "start_http_error":
    case "start_invalid_response":
      return "Couldn't start device authorization with OpenAI. Try again.";
    case "exchange_failed":
    case "exchange_http_error":
    case "exchange_invalid_response":
    case "exchange_unreachable":
    case "poll_http_error":
      return "Couldn't complete sign-in with OpenAI. Try again.";
    case "save_failed":
    case "save_http_error":
    case "save_unreachable":
    case "save_not_effective":
      return "Signed in with OpenAI, but saving the connection failed. Try again.";
    case "no_tenant":
      return "Select an organization before connecting Codex.";
    case "tenant_changed":
      return "Signed in with OpenAI, but the organization changed before the connection was saved. Reopen Connect and try again.";
    case "unreachable":
    case "openai_unreachable":
      return "Your browser couldn't reach OpenAI's approval service (auth.openai.com). Check that no extension, VPN, or network is blocking it, then try again.";
    default:
      return "Something went wrong connecting Codex. Try again.";
  }
}
