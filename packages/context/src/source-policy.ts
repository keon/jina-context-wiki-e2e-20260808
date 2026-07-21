export interface SourcePolicy {
  readonly egressEnabled: boolean;
  readonly allowlist: readonly string[];
}

export function isSourceAllowed(policy: SourcePolicy, sourceUri: string): boolean {
  if (!policy.egressEnabled) return false;
  let source: URL;
  try {
    source = new URL(sourceUri);
  } catch {
    return false;
  }
  if (source.protocol !== "https:" && source.protocol !== "http:") return false;
  return policy.allowlist.some((allowed) => {
    try {
      const boundary = new URL(allowed);
      if (boundary.protocol !== source.protocol || boundary.origin !== source.origin) return false;
      const allowedPath = boundary.pathname.endsWith("/") ? boundary.pathname : `${boundary.pathname}/`;
      return source.pathname === boundary.pathname || source.pathname.startsWith(allowedPath);
    } catch {
      return false;
    }
  });
}
