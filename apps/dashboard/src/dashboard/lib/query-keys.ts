/**
 * Query keys for the dashboard's cached reads.
 *
 * Every tenant-scoped read is keyed by the same fence the imperative code
 * checked with `isResponseForCurrentTenant`: the viewer the request belongs to,
 * the fence version (bumped whenever tenant authorization is lost or the scope
 * is re-established), and the selected tenant. Encoding it in the key means a
 * response can only ever be read back under the exact scope it was issued for —
 * a switch does not "reject a late response", it addresses a different cache
 * entry entirely.
 *
 * Kept React-free so the key shape and the eviction predicate stay unit-testable.
 */

/**
 * Cached resources that carry tenant data. Listed explicitly because the
 * fail-closed path (401/403) has to be able to identify — and remove — every
 * cache entry that could hold a payload the viewer is no longer entitled to.
 */
export type TenantScopedResource =
  | "dashboard-review-runs"
  | "review-run-detail"
  | "usage"
  | "billing"
  | "model-config"
  | "integrations"
  | "github-installations"
  | "tokens"
  | "poll";

const TENANT_SCOPED_RESOURCES: ReadonlySet<string> = new Set<TenantScopedResource>([
  "dashboard-review-runs",
  "review-run-detail",
  "usage",
  "billing",
  "model-config",
  "integrations",
  "github-installations",
  "tokens",
  "poll"
]);

/** The fence a tenant-scoped request is issued under. */
export interface TenantQueryScope {
  /** The viewer the request belongs to; null when signed out or auth is disabled. */
  readonly viewerUserId: number | null;
  /** Increments when tenant authorization is lost, invalidating every prior key. */
  readonly fenceVersion: number;
  /** The selected tenant, or null for the auth-disabled local fixture. */
  readonly tenantId: string | null;
}

export type TenantQueryKey = readonly unknown[];

/**
 * `[resource, viewerUserId, fenceVersion, tenantId, ...resource params]`.
 *
 * The first four segments are the fence; anything after them (a period, a run
 * id) distinguishes reads within one scope.
 */
export function tenantQueryKey(
  resource: TenantScopedResource,
  scope: TenantQueryScope,
  ...params: readonly (string | number | boolean | null)[]
): TenantQueryKey {
  return [resource, scope.viewerUserId, scope.fenceVersion, scope.tenantId, ...params];
}

/**
 * `usePoll` is handed a fully-formed same-origin URL rather than a tenant, and
 * every tenant-scoped path already embeds the tenant id, so the path is the
 * fence. It is still classified as tenant-scoped so the 401/403 path evicts it.
 */
export function pollQueryKey(path: string): TenantQueryKey {
  return ["poll", path];
}

/** True when the key addresses data belonging to a tenant (see the eviction path). */
export function isTenantScopedQueryKey(key: readonly unknown[]): boolean {
  const [resource] = key;
  return typeof resource === "string" && TENANT_SCOPED_RESOURCES.has(resource);
}

/** Leading segments of a key that make up the fence. */
const FENCE_SEGMENTS = 4;

/**
 * Whether two keys address the same fence, differing only in resource
 * parameters (a filter, a period).
 *
 * Carrying a payload from one key to another — as placeholder data does, to keep
 * a list on screen while a filter change loads — is only ever safe within one
 * scope. Across scopes it would show one tenant's data under another's view,
 * which is the exact failure the fence exists to prevent.
 */
export function isSameTenantScope(left: readonly unknown[], right: readonly unknown[]): boolean {
  for (let index = 0; index < FENCE_SEGMENTS; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
