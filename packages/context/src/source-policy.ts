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
  if (source.username || source.password) return false;
  return policy.allowlist.some((allowed) => {
    try {
      const boundary = new URL(allowed);
      if (
        boundary.username ||
        boundary.password ||
        boundary.protocol !== source.protocol ||
        boundary.origin !== source.origin
      )
        return false;
      const boundaryPath = normalizedBoundaryPath(boundary.pathname);
      const sourcePath = normalizedBoundaryPath(source.pathname);
      return sourcePath === boundaryPath || source.pathname.startsWith(boundaryPath === "/" ? "/" : `${boundaryPath}/`);
    } catch {
      return false;
    }
  });
}

function normalizedBoundaryPath(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}
