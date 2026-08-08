import { ApiError } from "./errors.js";

// A Codex harness credential is the content of ~/.codex/auth.json — OAuth tokens to a ChatGPT
// account, MORE sensitive than an API key. It is validated on save, stored encrypted, and NEVER
// echoed anywhere (logs, error messages, GET responses). Every validation error names the problem
// with a fixed string and NEVER includes any part of the submitted content.

// auth.json is a small JSON document; anything materially larger is not a real Codex credential.
const MAX_CODEX_AUTH_BYTES = 64 * 1024;
const INVALID = "not valid Codex auth.json content";

/**
 * Validate a non-empty Codex auth.json submission. Throws ApiError(400) — with a fixed,
 * content-free message — when the blob is not parseable JSON, is not a non-array object, exceeds
 * the 64 KB limit, or lacks a `tokens` object carrying a non-empty string `refresh_token`.
 */
export function validateCodexHarnessAuth(raw: string): void {
  // Size guard first (byte length, not char length) so an oversized blob is never parsed.
  if (Buffer.byteLength(raw, "utf8") > MAX_CODEX_AUTH_BYTES) {
    throw new ApiError(400, `${INVALID}: exceeds 64 KB limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, `${INVALID}: not parseable JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, `${INVALID}: expected a JSON object`);
  }
  const tokens = (parsed as Record<string, unknown>).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new ApiError(400, `${INVALID}: missing tokens object`);
  }
  const refreshToken = (tokens as Record<string, unknown>).refresh_token;
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    throw new ApiError(400, `${INVALID}: missing tokens.refresh_token`);
  }
}

/**
 * Interpret a POSTed `codex_harness_auth` field into the value passed to saveUserHarnessIntegration:
 *   - omitted / non-string -> undefined (leave the stored credential unchanged)
 *   - empty string         -> "" (explicit disconnect; skips validation)
 *   - non-empty string     -> validated (throws ApiError(400) on invalid) then returned as-is
 */
export function normalizeCodexHarnessAuthInput(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "") {
    return "";
  }
  validateCodexHarnessAuth(value);
  return value;
}

// The Codex-native OpenAI subscription models a per-stage model may map into when a run executes on
// a Codex harness (NOT OpenRouter slugs — own-harness runs never touch OpenRouter).
// The GPT-5.6 family (sol=flagship, terra=balanced, luna=fast) leads the list; the 5.5/5.4 line stays
// for back-compat and cheaper runs.
// KEEP IN SYNC with the HARNESS_MODELS Set in packages/review-agent/src/runtime-review/index.ts (separate package, no
// shared import): a drift is caught by that package's harnessModelForStageSlug test, which pins this exact
// list. A model valid here but missing there is silently downgraded to the subscription default.
export const HARNESS_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;
