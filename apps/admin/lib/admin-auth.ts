// Inbound authentication policy for the admin console.
//
// The app renders tenant-wide graph data by calling the API as the
// tenant-admin service principal, so the app itself is the security boundary:
// it must never serve a request that did not arrive through the trusted
// identity-aware proxy. This mirrors the dashboard, which enforces a valid
// Google IAP identity whenever the internal API token is configured. Because
// this console is strictly more privileged (every repository's graphs, not an
// ACL-scoped subset), it additionally supports an explicit admin allowlist.
//
// These helpers are pure so the decision is unit-testable and identical
// whether evaluated in the request proxy or a server component.

export type AdminAccessDecision =
  | { readonly ok: true; readonly email?: string }
  | { readonly ok: false; readonly status: 401 | 403; readonly error: string };

export interface AdminAccessInput {
  /** True when a production internal API token is configured (auth required). */
  readonly authRequired: boolean;
  /** Raw value of the IAP-populated `x-goog-authenticated-user-email` header. */
  readonly iapEmailHeader: string | null | undefined;
  /** Raw comma-separated admin allowlist, if any. */
  readonly allowlistRaw: string | null | undefined;
  readonly authorizationHeader?: string | null | undefined;
  readonly webAuthUsername?: string | null | undefined;
  readonly webAuthPassword?: string | null | undefined;
}

/** Normalizes an IAP email header (`accounts.google.com:you@x.com`) or returns undefined. */
export function normalizeIapEmail(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const email = header
    .replace(/^accounts\.google\.com:/i, "")
    .trim()
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
}

/** Parses the comma-separated allowlist into a lowercase set, or undefined when unset. */
export function parseAdminAllowlist(raw: string | null | undefined): ReadonlySet<string> | undefined {
  if (!raw) return undefined;
  const emails = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return emails.length > 0 ? new Set(emails) : undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isValidBasicAuthorization(
  header: string | null | undefined,
  expectedUsername: string | null | undefined,
  expectedPassword: string | null | undefined
): boolean {
  const username = expectedUsername?.trim();
  const password = expectedPassword?.trim();
  const encoded = header?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!username || !password || !encoded) return false;
  try {
    const decoded = globalThis.atob(encoded);
    const separator = decoded.indexOf(":");
    return (
      separator >= 0 &&
      constantTimeEqual(decoded.slice(0, separator), username) &&
      constantTimeEqual(decoded.slice(separator + 1), password)
    );
  } catch {
    return false;
  }
}

/** Decides whether an inbound request may view tenant-wide graphs. */
export function evaluateAdminAccess(input: AdminAccessInput): AdminAccessDecision {
  // Local and CI runs deploy without the internal token and are not internet
  // reachable; enforcing IAP there would break `pnpm dev`. This matches the
  // dashboard, which only demands an IAP identity once the token is present.
  if (!input.authRequired) return { ok: true };

  if (isValidBasicAuthorization(input.authorizationHeader, input.webAuthUsername, input.webAuthPassword)) {
    return { ok: true };
  }

  const email = normalizeIapEmail(input.iapEmailHeader);
  if (!email) {
    return { ok: false, status: 401, error: "authenticated identity required" };
  }

  const allowlist = parseAdminAllowlist(input.allowlistRaw);
  if (allowlist && !allowlist.has(email)) {
    return { ok: false, status: 403, error: "administrator access required" };
  }

  return { ok: true, email };
}
