/**
 * Pure helpers for tenant membership: the tenant switcher's sorting/labeling,
 * the role-gate predicate that decides whether write controls are enabled, and
 * the Codex harness model option mapping. Kept free of React/DOM so they can be
 * unit-tested with `node --test`.
 */

export type TenantType = "User" | "Organization";
export type TenantRole = "admin" | "member";

/** A tenant the viewer belongs to, as returned by GET /dashboard/tenants. */
export interface ViewerTenant {
  tenant_id: string;
  login: string;
  type: TenantType;
  role: TenantRole;
  clerk_organization_id?: string;
}

/**
 * The active tenant exposed through the tenant context. `null` (absent) means
 * local fixture behavior — production pages require an explicit tenant.
 */
export interface SelectedTenant {
  tenantId: string;
  login: string;
  type: TenantType;
  role: TenantRole;
  clerkOrganizationId?: string;
}

/** localStorage key holding the last-selected tenant id (persists the switcher choice). */
export const TENANT_STORAGE_KEY = "jina.dashboard.tenant";

/**
 * Namespace the persisted tenant selection by the viewer's GitHub user id so a
 * selection made by one account is never read back for another (after logout/login
 * as a different user). A null/undefined id (auth disabled / no viewer) uses the
 * bare key for the auth-disabled local fixture.
 */
export function tenantStorageKey(viewerUserId: number | null | undefined): string {
  return viewerUserId == null ? TENANT_STORAGE_KEY : `${TENANT_STORAGE_KEY}.${viewerUserId}`;
}

/**
 * Fencing predicate for tenant-scoped async responses: a response captured for
 * `requestTenantId` may only be applied when both the still-selected tenant and
 * viewer/session scope match. The scope comparison also fences null-to-null
 * local requests across account transitions.
 */
export function isResponseForCurrentTenant(
  requestTenantId: string | null,
  currentTenantId: string | null,
  requestScope: unknown = null,
  currentScope: unknown = null,
): boolean {
  return requestTenantId === currentTenantId && requestScope === currentScope;
}

/**
 * Order for the tenant switcher (mirrors the API's sortViewerTenants): personal
 * ('User') tenants first, then organizations, each group alphabetical by login
 * (case-insensitive). Returns a new sorted array.
 */
export function sortViewerTenants(tenants: ViewerTenant[]): ViewerTenant[] {
  return [...tenants].sort((a, b) => {
    const aPersonal = a.type === "User" ? 0 : 1;
    const bPersonal = b.type === "User" ? 0 : 1;
    if (aPersonal !== bPersonal) {
      return aPersonal - bPersonal;
    }
    return a.login.toLowerCase().localeCompare(b.login.toLowerCase());
  });
}

/** Parse a complete /tenants payload (array or { tenants }); malformed snapshots throw. */
export function normalizeViewerTenants(raw: unknown): ViewerTenant[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { tenants?: unknown }).tenants)
      ? (raw as { tenants: unknown[] }).tenants
      : null;
  if (!list) {
    throw new TypeError("Invalid tenants response");
  }
  const tenants: ViewerTenant[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Invalid tenant entry");
    }
    const record = entry as Record<string, unknown>;
    const tenantId = typeof record.tenant_id === "string" ? record.tenant_id.trim() : "";
    const login = typeof record.login === "string" ? record.login.trim() : "";
    if (
      !tenantId ||
      !login ||
      (record.type !== "User" && record.type !== "Organization") ||
      (record.role !== "admin" && record.role !== "member")
    ) {
      throw new TypeError("Invalid tenant entry");
    }
    tenants.push({
      tenant_id: tenantId,
      login,
      type: record.type,
      role: record.role,
      ...(typeof record.clerk_organization_id === "string" && record.clerk_organization_id.trim()
        ? { clerk_organization_id: record.clerk_organization_id.trim() }
        : {}),
    });
  }
  return sortViewerTenants(tenants);
}

/** Badge label for a tenant's type: personal accounts read "Personal", orgs "Organization". */
export function tenantTypeLabel(type: TenantType): string {
  return type === "Organization" ? "Organization" : "Personal";
}

/** Human role label (only meaningful for org tenants; personal owners are always admins). */
export function tenantRoleLabel(role: TenantRole): string {
  return role === "admin" ? "Admin" : "Member";
}

/**
 * Resolve which tenant the switcher should show as selected: the stored id when
 * it still matches a known tenant, otherwise the first (personal) tenant. Returns
 * null when the viewer has no tenants.
 */
export function resolveSelectedTenant(tenants: ViewerTenant[], storedId: string | null): ViewerTenant | null {
  if (tenants.length === 0) return null;
  if (storedId) {
    const match = tenants.find((tenant) => tenant.tenant_id === storedId);
    if (match) return match;
  }
  return tenants[0] ?? null;
}

/**
 * Role-gate predicate for write controls (key save/disconnect, model edits,
 * top-up). Writes are allowed for the auth-disabled local fixture (null), for personal
 * ('User') tenants, and for org admins; org members get read-only controls. The
 * API is the real enforcer — this only decides the UI's disabled state.
 */
export function isTenantWritable(selected: SelectedTenant | null): boolean {
  if (!selected) return true;
  if (selected.type === "User") return true;
  return selected.role === "admin";
}
