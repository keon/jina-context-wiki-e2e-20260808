import type { ContextQueueTopic, ContextWriteFence } from "@jina/context-engine";
import type { PoolClient } from "pg";

/**
 * Validate and lock the stage row inside the writer's transaction. The caller
 * invokes this both before writing and immediately before commit. Holding the
 * row lock prevents release, renewal, completion, or a replacement claim from
 * racing the commit.
 */
export async function assertContextWriteFence(
  client: PoolClient,
  tenantId: string,
  expectedTopic: ContextQueueTopic | readonly ContextQueueTopic[],
  fence?: ContextWriteFence
): Promise<void> {
  if (!fence) return;
  const original = await client.query<{ current_role: string }>("select current_role");
  const originalRole = original.rows[0]?.current_role;
  if (!originalRole || !/^jina_context_[a-z_]+$/.test(originalRole)) {
    throw new Error("Context write fence requires an activated context capability role");
  }
  await client.query("set local role jina_context_coordinator");
  let result;
  try {
    result = await client.query(
      `select 1
       from jina_context.pipeline_stages stage
       join jina_context.pipeline_builds build on build.id=stage.build_id
       where build.tenant_id=$1 and build.id=$2
         and stage.id=$3 and stage.topic=any($4::text[]) and stage.status='leased'
         and stage.attempt=$5 and stage.lease_id=$6 and stage.fence_token=$7
         and stage.lease_expires_at=$8
         and stage.lease_expires_at > clock_timestamp()
       for share of stage`,
      [
        tenantId,
        fence.buildId,
        fence.stageId,
        Array.isArray(expectedTopic) ? expectedTopic : [expectedTopic],
        fence.attempt,
        fence.leaseId,
        fence.token,
        fence.leaseExpiresAt
      ]
    );
  } finally {
    await client.query(`set local role ${originalRole}`);
  }
  if (result.rowCount !== 1) throw new Error("Context write fence is stale or invalid");
}
