// Inbound authentication policy for the admin console.
//
// The app renders cross-tenant context data through a dedicated API credential,
// so the app itself is the security boundary:
// it must never serve a request that did not pass app-level HTTP
// authentication. Caller-supplied proxy identity headers are deliberately
// ignored because this service is directly internet reachable.
//
// The gate keys off the web credentials themselves, never off an unrelated API
// credential: dropping `INTERNAL_API_TOKEN` must not silently disable inbound
// authentication on an internet-reachable deployment. When no credentials are
// configured the decision fails closed unless the caller explicitly declares a
// non-deployed local run.
//
// These helpers are pure so the decision is unit-testable and identical
// whether evaluated in the request proxy or a server component.

export type AdminAccessDecision =
  | { readonly ok: true; readonly actorId: string; readonly email?: string }
  | { readonly ok: false; readonly status: 401 | 403 | 503; readonly error: string };

export interface AdminAccessInput {
  readonly authorizationHeader?: string | null | undefined;
  readonly webAuthUsername?: string | null | undefined;
  readonly webAuthPassword?: string | null | undefined;
  /**
   * True only for a local, non-deployed run (`pnpm dev`) where no credentials
   * are configured and the app is not internet reachable. Deployed images build
   * with `NODE_ENV=production`, which compiles this escape hatch out.
   */
  readonly allowUnauthenticatedLocalDev?: boolean | undefined;
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
  expectedUsername: string,
  expectedPassword: string
): boolean {
  const encoded = header?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!encoded) return false;
  try {
    const decoded = globalThis.atob(encoded);
    const separator = decoded.indexOf(":");
    return (
      separator >= 0 &&
      constantTimeEqual(decoded.slice(0, separator), expectedUsername) &&
      constantTimeEqual(decoded.slice(separator + 1), expectedPassword)
    );
  } catch {
    return false;
  }
}

/** Decides whether an inbound request may view tenant-wide context. */
export function evaluateAdminAccess(input: AdminAccessInput): AdminAccessDecision {
  const username = input.webAuthUsername?.trim() ?? "";
  const password = input.webAuthPassword?.trim() ?? "";

  if (!username || !password) {
    // Half-configured credentials are always a deployment mistake: refusing is
    // the only response that cannot be mistaken for a working login.
    if (username || password) {
      return { ok: false, status: 503, error: "admin authentication is misconfigured" };
    }
    // The documented local escape hatch: `pnpm dev` with no credentials set.
    if (input.allowUnauthenticatedLocalDev) return { ok: true, actorId: "svc:admin-dev" };
    return { ok: false, status: 503, error: "admin authentication is not configured" };
  }

  if (isValidBasicAuthorization(input.authorizationHeader, username, password)) {
    const actor = username.toLowerCase();
    return {
      ok: true,
      actorId: /^[a-z0-9._@-]+$/.test(actor) ? `admin:${actor}` : "admin:web"
    };
  }

  return { ok: false, status: 401, error: "authenticated identity required" };
}
