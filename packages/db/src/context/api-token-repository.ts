import type { ApiTokenRecord, MintApiTokenInput, VerifiedApiToken } from "@jina/context-engine";
import { ContextDatabase, contextSystemScope, contextTenantScope, dateString } from "./database.js";

interface ApiTokenRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly name: string;
  readonly scopes: string[];
  readonly created_at: Date;
  readonly created_by: string;
  readonly expires_at: Date;
  readonly last_used_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_by: string | null;
}

const TOKEN_COLUMNS =
  "id,tenant_id,principal_id,name,scopes,created_at,created_by,expires_at,last_used_at,revoked_at,revoked_by";

/**
 * Per-principal API tokens.
 *
 * Every method here runs as `jina_context_tokens`, which is the only capability
 * granted anything on this table. Verification is the single read in this
 * package that runs at system scope, because it resolves the tenant from the row
 * it is looking for; everything else knows its tenant and stays scoped to it.
 */
export class PostgresApiTokenRepository {
  constructor(private readonly database: ContextDatabase) {}

  /**
   * Liveness is decided by the same database that evaluates the row policy, so a
   * skewed instance clock cannot accept an expired token and the two cannot
   * disagree. This must not run inside a tenant scope: `transactionAs` lets an
   * ambient scope override the requested system scope, and the read would then
   * silently match nothing.
   */
  async verifyApiToken(secretHash: string): Promise<VerifiedApiToken | undefined> {
    const result = await this.database.queryAs<{
      id: string;
      tenant_id: string;
      principal_id: string;
      scopes: string[];
      last_used_at: Date | null;
    }>(
      "jina_context_tokens",
      contextSystemScope,
      `select id,tenant_id,principal_id,scopes,last_used_at
       from jina_context.api_tokens
       where secret_hash=$1 and revoked_at is null and expires_at > now()`,
      [secretHash]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      tokenId: row.id,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      scopes: row.scopes,
      ...(row.last_used_at ? { lastUsedAt: dateString(row.last_used_at) } : {})
    };
  }

  /** Best-effort: the caller is already authenticated and must not fail on this. */
  async stampApiTokenUse(tenantId: string, tokenId: string, usedAt: string): Promise<void> {
    await this.database.queryAs(
      "jina_context_tokens",
      contextTenantScope(tenantId),
      "update jina_context.api_tokens set last_used_at=$3 where tenant_id=$1 and id=$2",
      [tenantId, tokenId, usedAt]
    );
  }

  /**
   * A plain insert with no conflict clause. Issuance is not idempotent: the only
   * copy of the secret is the one the caller is handed, so there is nothing a
   * replay could return.
   */
  async mintApiToken(token: MintApiTokenInput): Promise<ApiTokenRecord> {
    const result = await this.database.queryAs<ApiTokenRow>(
      "jina_context_tokens",
      contextTenantScope(token.tenantId),
      `insert into jina_context.api_tokens
         (id,tenant_id,principal_id,name,secret_hash,scopes,created_at,created_by,expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning ${TOKEN_COLUMNS}`,
      [
        token.id,
        token.tenantId,
        token.principalId,
        token.name,
        token.secretHash,
        [...token.scopes],
        token.createdAt,
        token.createdBy,
        token.expiresAt
      ]
    );
    return apiTokenRecord(result.rows[0]!);
  }

  async listApiTokens(tenantId: string): Promise<ApiTokenRecord[]> {
    const result = await this.database.queryAs<ApiTokenRow>(
      "jina_context_tokens",
      contextTenantScope(tenantId),
      `select ${TOKEN_COLUMNS} from jina_context.api_tokens
       where tenant_id=$1 order by created_at desc,id desc`,
      [tenantId]
    );
    return result.rows.map(apiTokenRecord);
  }

  /**
   * Revoking twice preserves the first revoker rather than overwriting the audit
   * trail, so the update is guarded and the row is read back separately. That
   * also lets the caller tell "revoked now" from "already revoked" from "no such
   * token in this tenant".
   */
  async revokeApiToken(
    tenantId: string,
    tokenId: string,
    revokedBy: string,
    revokedAt: string
  ): Promise<ApiTokenRecord | undefined> {
    await this.database.queryAs(
      "jina_context_tokens",
      contextTenantScope(tenantId),
      `update jina_context.api_tokens set revoked_at=$4,revoked_by=$3
       where tenant_id=$1 and id=$2 and revoked_at is null`,
      [tenantId, tokenId, revokedBy, revokedAt]
    );
    const result = await this.database.queryAs<ApiTokenRow>(
      "jina_context_tokens",
      contextTenantScope(tenantId),
      `select ${TOKEN_COLUMNS} from jina_context.api_tokens where tenant_id=$1 and id=$2`,
      [tenantId, tokenId]
    );
    const row = result.rows[0];
    return row ? apiTokenRecord(row) : undefined;
  }
}

function apiTokenRecord(row: ApiTokenRow): ApiTokenRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    name: row.name,
    scopes: row.scopes,
    createdAt: dateString(row.created_at),
    createdBy: row.created_by,
    expiresAt: dateString(row.expires_at),
    ...(row.last_used_at ? { lastUsedAt: dateString(row.last_used_at) } : {}),
    ...(row.revoked_at ? { revokedAt: dateString(row.revoked_at) } : {}),
    ...(row.revoked_by ? { revokedBy: row.revoked_by } : {})
  };
}
