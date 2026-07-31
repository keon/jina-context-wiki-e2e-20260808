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
      pathname === "/api/context/metrics" ||
      pathname === "/api/context/releases" ||
      pathname === "/api/context/list" ||
      pathname === "/api/context/read" ||
      pathname === "/api/context/diff" ||
      pathname === "/api/context/builds" ||
      /^\/api\/context\/builds\/[^/]+\/progress$/.test(pathname));
  const allowedLocalDemo = !hasInternalApiToken && method === "POST" && pathname === "/api/dev/webhooks/github";
  const allowedContextSearch = method === "POST" && pathname === "/api/context/search";

  return allowedRead || allowedLocalDemo || allowedContextSearch;
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
