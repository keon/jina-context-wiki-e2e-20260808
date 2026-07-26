import { Pool, type PoolConfig } from "pg";
import { pingPostgresPool } from "./postgres-health.js";

export interface PostgresSharedIdentityStoreConfig extends PoolConfig {
  readonly applicationName?: string;
}

export interface ResolveSharedRepositoryInput {
  readonly githubRepositoryId?: number;
  readonly githubInstallationId?: number;
  /** Trusted tenant scope used to discover current installation provenance. */
  readonly tenantId?: string;
  readonly repository: string;
}

export interface ResolveSharedTenantRepositoriesInput {
  readonly tenantId: string;
  readonly repositories?: readonly string[];
}

export interface SharedRepositoryIdentity {
  readonly tenantId: string;
  readonly githubAccountId: string;
  readonly githubAccountLogin: string;
  readonly githubAccountType: string;
  readonly githubRepositoryId?: string;
  readonly githubInstallationId?: string;
  readonly repository: string;
  readonly defaultBranch?: string;
}

export interface SharedTenantGithubConnection {
  readonly installationId: string;
  readonly login: string;
  readonly type: string;
  readonly repositoryCount: number;
}

export interface SharedTenantSummary {
  readonly tenantId: string;
  readonly name: string;
  readonly kind: "personal" | "team";
  readonly githubAccountLogin?: string;
  readonly repositoryCount: number;
  readonly githubConnections: readonly SharedTenantGithubConnection[];
}

export interface ResolveSharedTenantMemberInput {
  readonly tenantId: string;
  readonly githubUserId: number;
}

export interface SharedTenantMember {
  readonly tenantId: string;
  readonly githubUserId: string;
  readonly githubLogin?: string;
  readonly role: string;
  readonly syncedAt: string;
}

interface SharedRepositoryIdentityRow {
  readonly tenant_id: string;
  readonly github_account_id: string | number;
  readonly github_account_login: string;
  readonly github_account_type: string;
  readonly github_repository_id: string | number;
  readonly github_installation_id: string | number;
  readonly repository_owner: string;
  readonly repository_name: string;
  readonly default_branch: string;
}

interface SharedTenantMemberRow {
  readonly tenant_id: string;
  readonly github_user_id: string | number;
  readonly github_login: string | null;
  readonly role: string;
  readonly synced_at: Date | string;
}

interface SharedTenantSummaryRow {
  readonly tenant_id: string;
  readonly tenant_name: string;
  readonly tenant_kind: string;
  readonly github_account_login: string | null;
  readonly github_installation_id: string | number | null;
  readonly installation_login: string | null;
  readonly installation_type: string | null;
  readonly repository_count: string | number;
}

export interface SharedRepositoryIdentityQuery {
  readonly text: string;
  readonly values: readonly (string | null)[];
}

export interface SharedTenantRepositoriesQuery {
  readonly text: string;
  readonly values: readonly [string, readonly string[] | null];
}

const RESOLVE_REPOSITORY_SQL = `
  select
    t.id::text as tenant_id,
    i.github_account_id::text as github_account_id,
    i.github_account_login,
    i.github_account_type,
    i.github_installation_id::text as github_installation_id,
    r.github_repo_id::text as github_repository_id,
    r.owner as repository_owner,
    r.name as repository_name,
    r.default_branch
  from public.repositories r
  join public.tenants t on t.id = r.tenant_id
  join public.installations i
    on i.id = r.installation_id
   and i.tenant_id = r.tenant_id
  where
    r.enabled = true
    and t.merged_into_tenant_id is null
    and i.suspended_at is null
    and i.deleted_at is null
    and (
      ($2::bigint is not null and i.github_installation_id = $2::bigint)
      or ($2::bigint is null and $5::uuid is not null and r.tenant_id = $5::uuid)
    )
    and (
      ($1::bigint is not null and r.github_repo_id = $1::bigint)
      or (
        $1::bigint is null
        and lower(r.owner) = lower($3)
        and lower(r.name) = lower($4)
      )
    )
  order by
    case when $1::bigint is not null and r.github_repo_id = $1::bigint then 0 else 1 end,
    r.created_at desc
  limit 1`;

const RESOLVE_TENANT_MEMBER_SQL = `
  select
    tm.tenant_id::text as tenant_id,
    tm.github_user_id::text as github_user_id,
    tm.github_login,
    tm.role,
    tm.synced_at
  from public.tenant_members tm
  join public.tenants t on t.id = tm.tenant_id
  where tm.tenant_id = $1::uuid
    and tm.github_user_id = $2::bigint
    and t.merged_into_tenant_id is null
  limit 1`;

const RESOLVE_TENANT_REPOSITORIES_SQL = `
  select
    r.owner as repository_owner,
    r.name as repository_name
  from public.repositories r
  join public.tenants t on t.id = r.tenant_id
  join public.installations i
    on i.id = r.installation_id
   and i.tenant_id = r.tenant_id
  where r.tenant_id = $1::uuid
    and r.enabled = true
    and t.merged_into_tenant_id is null
    and i.suspended_at is null
    and i.deleted_at is null
    and (
      $2::text[] is null
      or lower(r.owner) || '/' || lower(r.name) = any($2::text[])
    )
  order by lower(r.owner), lower(r.name)`;

const LIST_ACTIVE_TENANT_IDS_SQL = `
  select distinct t.id::text as tenant_id
  from public.tenants t
  join public.repositories r
    on r.tenant_id = t.id
   and r.enabled = true
  join public.installations i
    on i.id = r.installation_id
   and i.tenant_id = r.tenant_id
   and i.suspended_at is null
   and i.deleted_at is null
  where t.merged_into_tenant_id is null
  order by tenant_id`;

const LIST_TENANTS_SQL = `
  select
    tenant.id::text as tenant_id,
    coalesce(
      nullif(btrim(tenant.name), ''),
      nullif(btrim(tenant.github_account_login), ''),
      tenant.id::text
    ) as tenant_name,
    coalesce(
      tenant.kind,
      case when lower(coalesce(tenant.github_account_type, '')) = 'user' then 'personal' else 'team' end
    ) as tenant_kind,
    tenant.github_account_login,
    installation.github_installation_id,
    installation.github_account_login as installation_login,
    installation.github_account_type as installation_type,
    count(repository.id) filter (where repository.enabled = true)::int as repository_count
  from public.tenants tenant
  left join public.installations installation
    on installation.tenant_id = tenant.id
   and installation.suspended_at is null
   and installation.deleted_at is null
  left join public.repositories repository
    on repository.tenant_id = tenant.id
   and repository.installation_id = installation.id
  where tenant.merged_into_tenant_id is null
  group by tenant.id, installation.id
  order by lower(coalesce(tenant.name, tenant.github_account_login, tenant.id::text)),
           installation.github_installation_id`;

/**
 * Read-only access to identity and tenancy records owned by the original Jina
 * deployment. Use a database role with SELECT grants only on the four public
 * tables referenced here; the read-only connection option is defense in depth,
 * not a replacement for those grants.
 */
export class PostgresSharedIdentityStore {
  private readonly pool: Pool;

  constructor(config: PostgresSharedIdentityStoreConfig) {
    const { applicationName, ...poolConfig } = config;
    this.pool = new Pool({
      ...poolConfig,
      application_name: applicationName ?? "jina-shared-identity",
      max: poolConfig.max ?? 3,
      idleTimeoutMillis: poolConfig.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: poolConfig.connectionTimeoutMillis ?? 10_000,
      options: appendPostgresOption(poolConfig.options, "-c default_transaction_read_only=on")
    });
    this.pool.on("error", (error) => {
      console.error("shared identity postgres idle connection error", error);
    });
  }

  async resolveRepository(input: ResolveSharedRepositoryInput): Promise<SharedRepositoryIdentity | undefined> {
    const query = buildSharedRepositoryIdentityQuery(input);
    const result = await this.pool.query<SharedRepositoryIdentityRow>(query.text, [...query.values]);
    const row = result.rows[0];
    return row ? normalizeSharedRepositoryIdentityRow(row) : undefined;
  }

  async resolveTenantMember(input: ResolveSharedTenantMemberInput): Promise<SharedTenantMember | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId");
    const githubUserId = githubId(input.githubUserId, "githubUserId");
    const result = await this.pool.query<SharedTenantMemberRow>(RESOLVE_TENANT_MEMBER_SQL, [tenantId, githubUserId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      tenantId: requiredText(row.tenant_id, "tenant_id"),
      githubUserId: decimalId(row.github_user_id, "github_user_id"),
      ...(row.github_login ? { githubLogin: row.github_login } : {}),
      role: requiredText(row.role, "role"),
      syncedAt: row.synced_at instanceof Date ? row.synced_at.toISOString() : requiredText(row.synced_at, "synced_at")
    };
  }

  async resolveTenantRepositories(input: ResolveSharedTenantRepositoriesInput): Promise<readonly string[]> {
    const query = buildSharedTenantRepositoriesQuery(input);
    const result = await this.pool.query<{ readonly repository_owner: string; readonly repository_name: string }>(
      query.text,
      [...query.values]
    );
    return result.rows.map(
      (row) =>
        `${requiredText(row.repository_owner, "repository_owner")}/${requiredText(row.repository_name, "repository_name")}`
    );
  }

  async listTenantIds(): Promise<readonly string[]> {
    const result = await this.pool.query<{ readonly tenant_id: string }>(buildSharedActiveTenantIdsQuery());
    return result.rows.map((row) => requiredText(row.tenant_id, "tenant_id"));
  }

  async listTenants(): Promise<readonly SharedTenantSummary[]> {
    const result = await this.pool.query<SharedTenantSummaryRow>(LIST_TENANTS_SQL);
    return normalizeSharedTenantSummaryRows(result.rows);
  }

  async ping(): Promise<void> {
    await pingPostgresPool(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function buildSharedRepositoryIdentityQuery(input: ResolveSharedRepositoryInput): SharedRepositoryIdentityQuery {
  const [owner, name] = splitRepository(input.repository);
  const githubRepositoryId = optionalGithubId(input.githubRepositoryId, "githubRepositoryId");
  const githubInstallationId = optionalGithubId(input.githubInstallationId, "githubInstallationId");
  const tenantId = input.tenantId ? requiredText(input.tenantId, "tenantId") : null;
  return {
    text: RESOLVE_REPOSITORY_SQL,
    values: [githubRepositoryId, githubInstallationId, owner, name, tenantId]
  };
}

export function buildSharedTenantRepositoriesQuery(
  input: ResolveSharedTenantRepositoriesInput
): SharedTenantRepositoriesQuery {
  const tenantId = requiredText(input.tenantId, "tenantId");
  const repositories = input.repositories
    ? [
        ...new Set(
          input.repositories.map((repository) => {
            const [owner, name] = splitRepository(repository);
            return `${owner.toLowerCase()}/${name.toLowerCase()}`;
          })
        )
      ].sort()
    : null;
  return { text: RESOLVE_TENANT_REPOSITORIES_SQL, values: [tenantId, repositories] };
}

export function buildSharedActiveTenantIdsQuery(): string {
  return LIST_ACTIVE_TENANT_IDS_SQL;
}

export function normalizeSharedRepositoryIdentityRow(row: SharedRepositoryIdentityRow): SharedRepositoryIdentity {
  const owner = requiredText(row.repository_owner, "repository_owner");
  const name = requiredText(row.repository_name, "repository_name");
  return {
    tenantId: requiredText(row.tenant_id, "tenant_id"),
    githubAccountId: decimalId(row.github_account_id, "github_account_id"),
    githubAccountLogin: requiredText(row.github_account_login, "github_account_login"),
    githubAccountType: requiredText(row.github_account_type, "github_account_type"),
    githubRepositoryId: decimalId(row.github_repository_id, "github_repository_id"),
    githubInstallationId: decimalId(row.github_installation_id, "github_installation_id"),
    repository: `${owner}/${name}`,
    defaultBranch: requiredText(row.default_branch, "default_branch")
  };
}

export function normalizeSharedTenantSummaryRows(
  rows: readonly SharedTenantSummaryRow[]
): readonly SharedTenantSummary[] {
  const tenants = new Map<
    string,
    {
      name: string;
      kind: "personal" | "team";
      githubAccountLogin?: string;
      repositoryCount: number;
      githubConnections: SharedTenantGithubConnection[];
    }
  >();
  for (const row of rows) {
    const tenantId = requiredText(row.tenant_id, "tenant_id");
    const kind = requiredText(row.tenant_kind, "tenant_kind");
    if (kind !== "personal" && kind !== "team") throw new TypeError("tenant_kind must be personal or team");
    const current = tenants.get(tenantId) ?? {
      name: requiredText(row.tenant_name, "tenant_name"),
      kind,
      ...(row.github_account_login
        ? { githubAccountLogin: requiredText(row.github_account_login, "github_account_login") }
        : {}),
      repositoryCount: 0,
      githubConnections: []
    };
    const repositoryCount = nonNegativeInteger(row.repository_count, "repository_count");
    current.repositoryCount += repositoryCount;
    if (row.github_installation_id !== null) {
      current.githubConnections.push({
        installationId: decimalId(row.github_installation_id, "github_installation_id"),
        login: row.installation_login
          ? requiredText(row.installation_login, "installation_login")
          : `GitHub installation ${row.github_installation_id}`,
        type: row.installation_type ? requiredText(row.installation_type, "installation_type") : "Organization",
        repositoryCount
      });
    }
    tenants.set(tenantId, current);
  }
  return [...tenants.entries()].map(([tenantId, tenant]) => ({ tenantId, ...tenant }));
}

function splitRepository(repository: string): readonly [string, string] {
  const value = requiredText(repository, "repository");
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new TypeError("repository must be in owner/name form");
  }
  return [parts[0].trim(), parts[1].trim()];
}

function optionalGithubId(value: number | undefined, field: string): string | null {
  return value === undefined ? null : githubId(value, field);
}

function githubId(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return String(value);
}

function decimalId(value: string | number, field: string): string {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : String(value).trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new TypeError(`${field} must be a positive decimal identifier`);
  }
  return normalized;
}

function nonNegativeInteger(value: string | number, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return normalized;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  return normalized;
}

function appendPostgresOption(existing: string | undefined, option: string): string {
  return existing?.trim() ? `${existing.trim()} ${option}` : option;
}
