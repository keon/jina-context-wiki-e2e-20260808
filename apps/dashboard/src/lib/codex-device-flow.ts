/** Browser-side subset of the v1 Codex device authorization contract. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_VERIFY_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_SECURITY_SETTINGS_URL = "https://chatgpt.com/security-settings";
export const DEVICE_ENDPOINTS = {
  usercode: `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
  token: `${CODEX_ISSUER}/api/accounts/deviceauth/token`,
  oauthToken: `${CODEX_ISSUER}/oauth/token`,
  redirectUri: `${CODEX_ISSUER}/deviceauth/callback`
} as const;

export interface UsercodeResponse {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly intervalSeconds: number;
}

export function boundedInterval(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(60, Math.max(1, Math.floor(parsed))) : 5;
}

export function parseUsercodeResponse(raw: unknown): UsercodeResponse | null {
  if (!isRecord(raw)) return null;
  const deviceAuthId = raw.device_auth_id;
  const userCode = raw.user_code ?? raw.usercode;
  if (typeof deviceAuthId !== "string" || !deviceAuthId) return null;
  if (typeof userCode !== "string" || !userCode) return null;
  return { deviceAuthId, userCode, intervalSeconds: boundedInterval(raw.interval) };
}

export function classifyPollStatus(status: number): "success" | "pending" | "error" {
  if (status >= 200 && status < 300) return "success";
  return status === 403 || status === 404 ? "pending" : "error";
}

export function parseCodeSuccess(raw: unknown): { authorizationCode: string; codeVerifier: string } | null {
  if (
    !isRecord(raw) ||
    typeof raw.authorization_code !== "string" ||
    !raw.authorization_code ||
    typeof raw.code_verifier !== "string" ||
    !raw.code_verifier
  ) {
    return null;
  }
  return { authorizationCode: raw.authorization_code, codeVerifier: raw.code_verifier };
}

export function parseOAuthTokens(raw: unknown): { idToken: string; accessToken: string; refreshToken: string } | null {
  if (
    !isRecord(raw) ||
    typeof raw.id_token !== "string" ||
    typeof raw.access_token !== "string" ||
    typeof raw.refresh_token !== "string" ||
    !raw.id_token ||
    !raw.access_token ||
    !raw.refresh_token
  ) {
    return null;
  }
  return { idToken: raw.id_token, accessToken: raw.access_token, refreshToken: raw.refresh_token };
}

export function decodeAccountId(idToken: string): string | null {
  const segment = idToken.split(".")[1];
  if (!segment) return null;
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as unknown;
    return isRecord(parsed) && typeof parsed.chatgpt_account_id === "string" ? parsed.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

export function assembleAuthJson(input: {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string | null;
}): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: input.idToken,
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      account_id: input.accountId
    },
    last_refresh: new Date().toISOString()
  });
}

export function validCodexAuthJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      isRecord(parsed) &&
      isRecord(parsed.tokens) &&
      typeof parsed.tokens.refresh_token === "string" &&
      Boolean(parsed.tokens.refresh_token.trim())
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
