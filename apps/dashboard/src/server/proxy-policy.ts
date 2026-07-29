export function isAllowedDashboardApiRequest(
  method: string | undefined,
  pathname: string,
  hasInternalApiToken: boolean
): boolean {
  const allowedRead =
    method === "GET" &&
    (pathname === "/api/board" ||
      pathname === "/api/events" ||
      pathname === "/api/overview" ||
      pathname === "/api/task-types" ||
      pathname === "/api/context/generations" ||
      /^\/api\/context\/generations\/[^/]+$/.test(pathname) ||
      pathname === "/api/context/documents" ||
      /^\/api\/context\/documents\/[^/]+$/.test(pathname) ||
      pathname === "/api/context/metrics" ||
      pathname === "/api/context/structure");
  const allowedLocalDemo = !hasInternalApiToken && method === "POST" && pathname === "/api/dev/webhooks/github";
  const allowedContextMutation =
    method === "POST" &&
    (pathname === "/api/context/query" ||
      pathname === "/api/context/rebuild" ||
      /^\/api\/context\/knowledge\/[^/]+\/review$/.test(pathname));

  return allowedRead || allowedLocalDemo || allowedContextMutation;
}

export interface DashboardPrincipalInput {
  readonly iapEmailHeader: string | null | undefined;
  readonly authorizationHeader: string | null | undefined;
  readonly webAuthUsername: string | null | undefined;
  readonly webAuthPassword: string | null | undefined;
  readonly webPrincipal: string | null | undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function isValidBasicAuthorization(
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
 * Google Cloud deployments use IAP's verified email header. Vercel deployments
 * use app-level HTTP authentication and an explicit fixed tenant principal.
 */
export function resolveDashboardPrincipal(input: DashboardPrincipalInput): string | undefined {
  const iapEmail = input.iapEmailHeader
    ?.replace(/^accounts\.google\.com:/i, "")
    .trim()
    .toLowerCase();
  if (iapEmail && /^[^\s@]+@[^\s@]+$/.test(iapEmail)) return `user:${iapEmail}`;

  if (!isValidBasicAuthorization(input.authorizationHeader, input.webAuthUsername, input.webAuthPassword)) {
    return undefined;
  }
  const principal = input.webPrincipal?.trim();
  return principal && /^(?:user|svc):[^\s]+$/.test(principal) ? principal : undefined;
}
