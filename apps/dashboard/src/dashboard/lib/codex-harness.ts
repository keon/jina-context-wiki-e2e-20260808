/**
 * Pure helpers for the Codex harness (ChatGPT subscription) integration UI.
 * Kept free of React/DOM so they can be unit-tested with `node --test`.
 */

export interface CodexHarnessInfo {
  configured: boolean;
  connected_at?: string;
  reconnect_required?: boolean;
}

/**
 * Result of the client-side pre-check on pasted ~/.codex/auth.json content.
 * `ok` gates the Connect button and gives instant feedback before the API
 * roundtrip; `reason` is a short, user-facing message when it doesn't look
 * right. The real validation still happens server-side.
 */
export type CodexAuthPrecheck = { ok: true } | { ok: false; reason: string };

/**
 * Cheap sanity-check that a paste looks like a `codex login` auth.json: valid
 * JSON, a top-level object, carrying a non-empty `tokens` object. This is a
 * hint only — it never inspects or validates the token values themselves.
 */
export function precheckCodexAuth(raw: string): CodexAuthPrecheck {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Paste the contents of ~/.codex/auth.json." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "That doesn't look like valid JSON." };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "Expected a JSON object from auth.json." };
  }

  const tokens = (parsed as Record<string, unknown>).tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    return { ok: false, reason: "No “tokens” object found — did you sign in with `codex login`?" };
  }

  if (Object.keys(tokens).length === 0) {
    return { ok: false, reason: "The “tokens” object is empty — try `codex login` again." };
  }

  return { ok: true };
}

/** Coerce an arbitrary API payload into a well-formed CodexHarnessInfo (tolerates the field being absent). */
export function normalizeCodexHarnessInfo(raw: unknown): CodexHarnessInfo {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const configured = record.configured === true;
  const connectedAt = typeof record.connected_at === "string" ? record.connected_at : undefined;
  return {
    configured,
    ...(connectedAt ? { connected_at: connectedAt } : {}),
    ...(configured && record.reconnect_required === true ? { reconnect_required: true } : {}),
  };
}
