import { Pool, type PoolConfig } from "pg";

export interface PostgresSharedIdentityStoreConfig extends PoolConfig {
  readonly applicationName?: string;
}

export interface ResolveSharedRepositoryInput {
  readonly githubRepositoryId?: number;
  readonly githubInstallationId?: number;
  readonly repository: string;
}

export interface SharedRepositoryIdentity {
  readonly tenantId: string;
  readonly githubAccountId: string;
  readonly githubAccountLogin: string;
  readonly githubAccountType: string;
  readonly githubRepositoryId?: string;
  readonly repository: string;
  readonly defaultBranch?: string;
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

export interface SharedRepositoryIdentityQuery {
  readonly text: string;
  readonly values: readonly (string | null)[];
}

const RESOLVE_REPOSITORY_SQL = `
  select
    t.id::text as tenant_id,
    t.github_account_id::text as github_account_id,
    t.github_account_login,
    t.github_account_type,
    r.github_repo_id::text as github_repository_id,
    r.owner as repository_owner,
    r.name as repository_name,
    r.default_branch
  from public.repositories r
  join public.tenants t on t.id = r.tenant_id
  where
    r.enabled = true
    and exists (
      select 1
      from public.installations i
      where i.tenant_id = r.tenant_id
        and ($2::bigint is null or i.github_installation_id = $2::bigint)
        and i.suspended_at is null
    )
    and (
      ($1::bigint is not null and r.github_repo_id = $1::bigint)
      or (
        lower(r.owner) = lower($3)
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
  limit 1`;

const LIST_ACTIVE_TENANT_IDS_SQL = `
  select distinct t.id::text as tenant_id
  from public.tenants t
  join public.repositories r on r.tenant_id = t.id and r.enabled = true
  where exists (
    select 1
    from public.installations i
    where i.tenant_id = t.id
      and i.suspended_at is null
  )
  order by tenant_id`;

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

  async listTenantIds(): Promise<readonly string[]> {
    const result = await this.pool.query<{ readonly tenant_id: string }>(LIST_ACTIVE_TENANT_IDS_SQL);
    return result.rows.map((row) => requiredText(row.tenant_id, "tenant_id"));
  }

  async ping(): Promise<void> {
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function buildSharedRepositoryIdentityQuery(input: ResolveSharedRepositoryInput): SharedRepositoryIdentityQuery {
  const [owner, name] = splitRepository(input.repository);
  const githubRepositoryId = optionalGithubId(input.githubRepositoryId, "githubRepositoryId");
  const githubInstallationId = optionalGithubId(input.githubInstallationId, "githubInstallationId");
  return {
    text: RESOLVE_REPOSITORY_SQL,
    values: [githubRepositoryId, githubInstallationId, owner, name]
  };
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
    repository: `${owner}/${name}`,
    defaultBranch: requiredText(row.default_branch, "default_branch")
  };
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

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  return normalized;
}

function appendPostgresOption(existing: string | undefined, option: string): string {
  return existing?.trim() ? `${existing.trim()} ${option}` : option;
}
