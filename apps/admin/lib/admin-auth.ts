// Inbound authentication policy for the admin console.
//
// The app renders cross-tenant context data through a dedicated API credential,
// so the app itself is the security boundary:
// it must never serve a request that did not pass app-level HTTP
// authentication. Caller-supplied proxy identity headers are deliberately
// ignored because this service is directly internet reachable.
//
// These helpers are pure so the decision is unit-testable and identical
// whether evaluated in the request proxy or a server component.

export type AdminAccessDecision =
  | { readonly ok: true; readonly actorId: string; readonly email?: string }
  | { readonly ok: false; readonly status: 401 | 403; readonly error: string };

export interface AdminAccessInput {
  /** True when a production API credential is configured (auth required). */
  readonly authRequired: boolean;
  readonly authorizationHeader?: string | null | undefined;
  readonly webAuthUsername?: string | null | undefined;
  readonly webAuthPassword?: string | null | undefined;
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

/** Decides whether an inbound request may view tenant-wide context. */
export function evaluateAdminAccess(input: AdminAccessInput): AdminAccessDecision {
  // Local and CI runs deploy without API credentials and are not internet
  // reachable; enforcing Basic authentication there would break `pnpm dev`.
  if (!input.authRequired) return { ok: true, actorId: "svc:admin-dev" };

  if (isValidBasicAuthorization(input.authorizationHeader, input.webAuthUsername, input.webAuthPassword)) {
    const username = input.webAuthUsername?.trim().toLowerCase() ?? "web";
    return {
      ok: true,
      actorId: /^[a-z0-9._@-]+$/.test(username) ? `admin:${username}` : "admin:web"
    };
  }

  return { ok: false, status: 401, error: "authenticated identity required" };
}
