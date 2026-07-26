import type { PoolClient } from "pg";
import { contextDigest } from "./database.js";

export function repositoryAccessLockKey(tenantId: string, repository: string): string {
  return `context-repository-access:${tenantId}:${repository}`;
}

export async function lockRepositoryAccess(client: PoolClient, tenantId: string, repository: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    repositoryAccessLockKey(tenantId, repository)
  ]);
}

export async function currentRepositoryAccessFingerprint(
  client: PoolClient,
  tenantId: string,
  repository: string
): Promise<string> {
  const result = await client.query<{
    id: string;
    principal_id: string;
    permission: string;
    acl_fingerprint: string;
    observed_at: Date;
  }>(
    `select distinct on (principal_id)
       id,principal_id,permission,acl_fingerprint,observed_at
     from jina_context.repository_acl_observations
     where tenant_id=$1 and repository=$2
     order by principal_id,observed_at desc,id desc`,
    [tenantId, repository]
  );
  return contextDigest(
    result.rows.map((row) => ({
      id: row.id,
      principalId: row.principal_id,
      permission: row.permission,
      aclFingerprint: row.acl_fingerprint,
      observedAt: row.observed_at.toISOString()
    }))
  );
}

export async function assertRepositoryAccessFingerprint(
  client: PoolClient,
  tenantId: string,
  repository: string,
  expected: string
): Promise<void> {
  const current = await currentRepositoryAccessFingerprint(client, tenantId, repository);
  if (current !== expected) {
    throw new Error(`Repository access changed while indexing ${repository}; retry with a new generation`);
  }
}
