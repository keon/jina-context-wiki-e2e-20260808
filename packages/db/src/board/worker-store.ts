import type { Pool, PoolClient } from "pg";

import {
  RelationalBoardWorkerRepository,
  type BeginRelationalBoardEffectInput,
  type ClaimedRelationalBoardTask,
  type ClaimRelationalBoardTaskInput,
  type CompleteRelationalBoardTaskInput,
  type FailRelationalBoardTaskInput,
  type RelationalBoardFenceInput,
  type RelationalBoardMutationResult,
  type RescheduleExternalRelationalBoardTaskInput,
  type RetryRelationalBoardEffectInput,
  type RetryRelationalBoardTaskInput,
  type WaitExternalRelationalBoardTaskInput
} from "./worker-repository.js";

export interface RelationalBoardWorkerReleaseIdentity {
  readonly releaseId: string;
  readonly credentialSha256: string;
  readonly service: ClaimRelationalBoardTaskInput["workerService"];
  readonly revision: string;
}

export interface StoredRelationalBoardClaimInput extends Omit<ClaimRelationalBoardTaskInput, "requireReleaseGate"> {
  readonly releaseIdentity?: RelationalBoardWorkerReleaseIdentity;
}

/**
 * Owns the transaction boundary for HTTP worker operations. The repository
 * remains composable for admission transactions while this adapter guarantees
 * a lease mutation and its release-generation check commit together.
 */
export class PostgresRelationalBoardWorkerStore {
  constructor(
    private readonly pool: Pool,
    private readonly repository = new RelationalBoardWorkerRepository()
  ) {}

  claim(input: StoredRelationalBoardClaimInput): Promise<ClaimedRelationalBoardTask | undefined> {
    return this.transaction(async (client) => {
      if (input.releaseIdentity) {
        await verifyRelationalBoardWorkerRelease(client, input.releaseIdentity, true);
      }
      return this.repository.claimTask(client, input);
    });
  }

  renew(
    input: RelationalBoardFenceInput,
    releaseIdentity?: RelationalBoardWorkerReleaseIdentity
  ): Promise<RelationalBoardMutationResult> {
    return this.guardedMutation(releaseIdentity, (client) => this.repository.renewAttempt(client, input));
  }

  release(
    input: RelationalBoardFenceInput,
    releaseIdentity?: RelationalBoardWorkerReleaseIdentity
  ): Promise<RelationalBoardMutationResult> {
    return this.guardedMutation(releaseIdentity, (client) => this.repository.releaseAttempt(client, input));
  }

  beginEffect(
    input: BeginRelationalBoardEffectInput,
    releaseIdentity?: RelationalBoardWorkerReleaseIdentity
  ): Promise<RelationalBoardMutationResult> {
    return this.guardedMutation(releaseIdentity, (client) => this.repository.beginEffectAttempt(client, input));
  }

  waitExternal(
    input: WaitExternalRelationalBoardTaskInput,
    releaseIdentity?: RelationalBoardWorkerReleaseIdentity
  ): Promise<RelationalBoardMutationResult> {
    return this.guardedMutation(releaseIdentity, (client) => this.repository.waitExternalAttempt(client, input));
  }

  rescheduleExternal(
    input: RescheduleExternalRelationalBoardTaskInput,
    releaseIdentity?: RelationalBoardWorkerReleaseIdentity
  ): Promise<RelationalBoardMutationResult> {
    return this.guardedMutation(releaseIdentity, (client) => this.repository.rescheduleExternalWait(client, input));
  }

  retryEffect(
    input: RetryRelationalBoardEffectInput,
    releaseIdentity?: RelationalBoardWorkerReleaseIdentity
  ): Promise<RelationalBoardMutationResult> {
    return this.guardedMutation(releaseIdentity, (client) => this.repository.failOrRetryEffectAttempt(client, input));
  }

  complete(
    input: CompleteRelationalBoardTaskInput,
    releaseIdentity?: RelationalBoardWorkerReleaseIdentity
  ): Promise<RelationalBoardMutationResult> {
    return this.guardedMutation(releaseIdentity, (client) => this.repository.completeAttempt(client, input));
  }

  retry(
    input: RetryRelationalBoardTaskInput,
    releaseIdentity?: RelationalBoardWorkerReleaseIdentity
  ): Promise<RelationalBoardMutationResult> {
    return this.guardedMutation(releaseIdentity, (client) => this.repository.retryAttempt(client, input));
  }

  fail(
    input: FailRelationalBoardTaskInput,
    releaseIdentity?: RelationalBoardWorkerReleaseIdentity
  ): Promise<RelationalBoardMutationResult> {
    return this.guardedMutation(releaseIdentity, (client) => this.repository.failAttempt(client, input));
  }

  private guardedMutation(
    releaseIdentity: RelationalBoardWorkerReleaseIdentity | undefined,
    operation: (client: PoolClient) => Promise<RelationalBoardMutationResult>
  ): Promise<RelationalBoardMutationResult> {
    return this.transaction(async (client) => {
      if (releaseIdentity) await verifyRelationalBoardWorkerRelease(client, releaseIdentity, false);
      return operation(client);
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function verifyRelationalBoardWorkerRelease(
  client: PoolClient,
  identity: RelationalBoardWorkerReleaseIdentity,
  requireClaimAdmission: boolean
): Promise<void> {
  const accepted =
    identity.service === "jina-causal-graph-worker"
      ? await client.query(
          `select 1
           from jina_runtime.causal_graph_release_control
           where id=1
             and worker_claims_enabled
             and worker_release_id=$1
             and worker_credential_sha256=$2
             and worker_revision=$3
             and (
               not $4::boolean
               or coalesce(
                 (select worker_accepts_claims or lease_expires_at <= clock_timestamp()
                  from jina_runtime.release_control where id=1),
                 true
               )
             )`,
          [identity.releaseId, requiredSha256(identity.credentialSha256), identity.revision, requireClaimAdmission]
        )
      : await client.query(
          `select 1
           from jina_runtime.release_control
           where id=1
             and worker_claims_enabled
             and worker_release_id=$1
             and worker_credential_sha256=$2
             and ${workerRevisionColumn(identity.service)}=$3
             and (
               not $4::boolean
               or coalesce(worker_accepts_claims or lease_expires_at <= clock_timestamp(), true)
             )`,
          [identity.releaseId, requiredSha256(identity.credentialSha256), identity.revision, requireClaimAdmission]
        );
  if (accepted.rowCount !== 1) throw new RelationalBoardWorkerReleaseRejectedError();
}

export class RelationalBoardWorkerReleaseRejectedError extends Error {
  constructor() {
    super("worker release identity is not active for relational Board work");
    this.name = "RelationalBoardWorkerReleaseRejectedError";
  }
}

function workerRevisionColumn(service: RelationalBoardWorkerReleaseIdentity["service"]): string {
  return service === "jina-context-worker" ? "context_worker_revision" : "task_worker_revision";
}

function requiredSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("worker release credential digest is invalid");
  return value;
}
