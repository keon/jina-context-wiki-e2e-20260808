export interface SourcePolicy {
  readonly egressEnabled: boolean;
  readonly allowlist: readonly string[];
}

export function isSourceAllowed(policy: SourcePolicy, sourceUri: string): boolean {
  return policy.egressEnabled && policy.allowlist.some((allowed) => sourceUri.startsWith(allowed));
}

