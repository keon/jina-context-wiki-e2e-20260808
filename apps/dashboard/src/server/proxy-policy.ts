export function isAllowedDashboardApiRequest(
  method: string | undefined,
  pathname: string,
  hasInternalApiToken: boolean
): boolean {
  if (isProductDashboardApiRequest(method, pathname)) return true;
  const allowedRead =
    method === "GET" &&
    (pathname === "/api/board" ||
      pathname === "/api/events" ||
      pathname === "/api/overview" ||
      pathname === "/api/task-types" ||
      pathname === "/api/wiki/metrics" ||
      pathname === "/api/wiki/releases" ||
      pathname === "/api/wiki/list" ||
      pathname === "/api/wiki/read" ||
      pathname === "/api/wiki/diff" ||
      pathname === "/api/causal-graph" ||
      pathname === "/api/causal-graph/issues" ||
      /^\/api\/causal-graph\/issues\/[^/]+(?:\/trace)?$/.test(pathname) ||
      pathname === "/api/wiki/builds" ||
      /^\/api\/wiki\/builds\/[^/]+\/progress$/.test(pathname));
  const allowedLocalDemo = !hasInternalApiToken && method === "POST" && pathname === "/api/dev/webhooks/github";
  const allowedContextSearch = method === "POST" && pathname === "/api/wiki/search";

  return allowedRead || allowedLocalDemo || allowedContextSearch;
}

/** Routes that authenticate with the signed-in Clerk user, not the Context service token. */
export function isProductDashboardApiRequest(method: string | undefined, pathname: string): boolean {
  if (!method || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
  return (
    pathname.startsWith("/api/dashboard/") ||
    pathname === "/api/auth/github/login" ||
    pathname === "/api/auth/github/callback" ||
    pathname === "/api/auth/logout"
  );
}

export interface DashboardPrincipalInput {
  readonly iapEmailHeader: string | null | undefined;
  readonly authorizationHeader: string | null | undefined;
  readonly webAuthUsername: string | null | undefined;
  readonly webAuthPassword: string | null | undefined;
  readonly webPrincipal: string | null | undefined;
}

/**
 * Cloud Run consumes the bearer token in Authorization before the request
 * reaches Next.js. Candidate checks therefore carry the app's Basic credential
 * in a separate header. Browser/Vercel requests keep using Authorization.
 */
export function dashboardWebAuthorization(
  authorizationHeader: string | null | undefined,
  webAuthorizationHeader: string | null | undefined
): string | null | undefined {
  return webAuthorizationHeader ?? authorizationHeader;
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
    if (separator < 0) return false;
    return (
      constantTimeEqual(decoded.slice(0, separator), username) &&
      constantTimeEqual(decoded.slice(separator + 1), password)
    );
  } catch {
    return false;
  }
}

/**
 * Resolves the principal the server-side proxy may forward to the API.
 *
 * IAP or HTTP Basic authentication establishes the deployment boundary. When
 * the deployment configures a fixed principal, both boundaries forward that
 * same tenant-scoped identity; otherwise IAP falls back to its verified user.
 */
export function resolveDashboardPrincipal(input: DashboardPrincipalInput): string | undefined {
  const configuredPrincipal = input.webPrincipal?.trim();
  const fixedPrincipal =
    configuredPrincipal &&
    (/^(?:user|svc):[^\s]+$/.test(configuredPrincipal) ||
      /^tenant:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configuredPrincipal))
      ? configuredPrincipal.toLowerCase()
      : undefined;
  const iapEmail = input.iapEmailHeader
    ?.replace(/^accounts\.google\.com:/i, "")
    .trim()
    .toLowerCase();
  if (iapEmail && /^[^\s@]+@[^\s@]+$/.test(iapEmail)) return fixedPrincipal ?? `user:${iapEmail}`;

  if (!isValidBasicAuthorization(input.authorizationHeader, input.webAuthUsername, input.webAuthPassword)) {
    return undefined;
  }
  return fixedPrincipal;
}
