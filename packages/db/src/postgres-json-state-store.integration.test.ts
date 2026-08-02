import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  PostgresJsonStateStore,
  StateStoreBusyError,
  WorkerReleaseRejectedError,
  type WorkerReleaseGuard
} from "./postgres-json-state-store.js";

// The test owns and recreates jina_runtime, so never fall back to DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
const ACTIVE_RELEASE: WorkerReleaseGuard = {
  releaseId: "release-active",
  credentialSha256: "a".repeat(64),
  service: "jina-context-worker",
  revision: "jina-context-worker-active"
};
const ACTIVE_CAUSAL_RELEASE: WorkerReleaseGuard = {
  releaseId: "causal-release-active",
  credentialSha256: "c".repeat(64),
  service: "jina-causal-graph-worker",
  revision: "jina-causal-graph-worker-active"
};

test("snapshot mutations fail fast when the global state lock is busy", { skip: !databaseUrl }, async () => {
  const controlPool = new Pool({ connectionString: databaseUrl, application_name: "jina-state-contention-test" });
  const store = new PostgresJsonStateStore<{ value: number }>({
    connectionString: databaseUrl,
    applicationName: "jina-state-contention-store-test",
    mutationLockTimeoutMillis: 100
  });
  const lockClient = await controlPool.connect();
  try {
    await controlPool.query("drop schema if exists jina_runtime cascade");
    await store.load();
    await lockClient.query("begin");
    await lockClient.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
    const startedAt = Date.now();
    await assert.rejects(
      store.update(async () => ({ state: { value: 1 }, result: true })),
      StateStoreBusyError
    );
    assert.ok(Date.now() - startedAt < 2_000, "lock contention must fail before a worker lease is endangered");
  } finally {
    await lockClient.query("rollback").catch(() => undefined);
    lockClient.release();
    await store.close().catch(() => undefined);
    await controlPool.query("drop schema if exists jina_runtime cascade").catch(() => undefined);
    await controlPool.end();
  }
});

test(
  "worker mutations are serialized with release changes and reject stale identities",
  { skip: !databaseUrl },
  async () => {
    const controlPool = new Pool({
      connectionString: databaseUrl,
      application_name: "jina-worker-release-control-test",
      max: 2
    });
    const store = new PostgresJsonStateStore<{ value: number }>({
      connectionString: databaseUrl,
      applicationName: "jina-worker-release-store-test",
      max: 2
    });
    let allowMutation: (() => void) | undefined;
    try {
      await controlPool.query("drop schema if exists jina_runtime cascade");
      await store.load();
      await enableRelease(controlPool, ACTIVE_RELEASE);
      await enableCausalRelease(controlPool, ACTIVE_CAUSAL_RELEASE);

      const causalExact = await store.update(
        async () => ({ state: { value: 0 }, result: "causal-accepted" }),
        undefined,
        ACTIVE_CAUSAL_RELEASE
      );
      assert.deepEqual(causalExact, { committed: true, result: "causal-accepted" });

      const exact = await store.update(
        async () => ({ state: { value: 1 }, result: "accepted" }),
        undefined,
        ACTIVE_RELEASE
      );
      assert.deepEqual(exact, { committed: true, result: "accepted" });

      await assert.rejects(
        store.update(async () => ({ state: { value: 2 }, result: "must-not-commit" }), undefined, {
          ...ACTIVE_RELEASE,
          revision: "jina-context-worker-stale"
        }),
        WorkerReleaseRejectedError
      );
      assert.deepEqual(await store.load(), { value: 1 });

      let mutationEntered: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        mutationEntered = resolve;
      });
      const allowed = new Promise<void>((resolve) => {
        allowMutation = resolve;
      });
      const inFlightMutation = store.update(
        async () => {
          mutationEntered?.();
          await allowed;
          return { state: { value: 3 }, result: "committed-before-pause" };
        },
        undefined,
        ACTIVE_RELEASE
      );
      await entered;

      const pauseClient = await controlPool.connect();
      let pauseCompleted = false;
      const pause = (async () => {
        try {
          await pauseClient.query("begin");
          await pauseClient.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
          await pauseClient.query(`
            update jina_runtime.release_control
            set worker_claims_enabled=false,
                worker_release_id=null,
                worker_credential_sha256=null,
                context_worker_revision=null,
                task_worker_revision=null,
                updated_at=now()
            where id=1
          `);
          await pauseClient.query("commit");
          pauseCompleted = true;
        } catch (error) {
          await pauseClient.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          pauseClient.release();
        }
      })();

      assert.equal(
        await Promise.race([
          pause.then(() => "paused"),
          new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100))
        ]),
        "waiting",
        "release pause must wait for the in-flight guarded state transaction"
      );
      assert.equal(pauseCompleted, false);

      allowMutation?.();
      assert.deepEqual(await inFlightMutation, {
        committed: true,
        result: "committed-before-pause"
      });
      await pause;
      assert.equal(pauseCompleted, true);
      assert.deepEqual(await store.load(), { value: 3 });

      await assert.rejects(
        store.update(async () => ({ state: { value: 4 }, result: "must-not-commit" }), undefined, ACTIVE_RELEASE),
        WorkerReleaseRejectedError
      );
      assert.deepEqual(await store.load(), { value: 3 });
    } finally {
      allowMutation?.();
      await store.close().catch(() => undefined);
      await controlPool.query("drop schema if exists jina_runtime cascade").catch(() => undefined);
      await controlPool.end();
    }
  }
);

test(
  "draining rejects new claims while the active generation can renew and complete",
  { skip: !databaseUrl },
  async () => {
    const controlPool = new Pool({ connectionString: databaseUrl, application_name: "jina-worker-drain-control-test" });
    const store = new PostgresJsonStateStore<{ value: number }>({
      connectionString: databaseUrl,
      applicationName: "jina-worker-drain-store-test"
    });
    const claimGuard: WorkerReleaseGuard = { ...ACTIVE_RELEASE, requireClaimAdmission: true };
    try {
      await controlPool.query("drop schema if exists jina_runtime cascade");
      await store.load();
      await enableRelease(controlPool, ACTIVE_RELEASE);
      await controlPool.query(
        `update jina_runtime.release_control
         set worker_accepts_claims=false,
             lease_release_id='deployment-drain',
             lease_credential_sha256='deployment-drain-credential',
             lease_expires_at=now()+interval '10 minutes',
             updated_at=now()
         where id=1`
      );

      await store.verifyWorkerRelease(ACTIVE_RELEASE);
      const completion = await store.update(
        async () => ({ state: { value: 1 }, result: "completed-during-drain" }),
        undefined,
        ACTIVE_RELEASE
      );
      assert.deepEqual(completion, { committed: true, result: "completed-during-drain" });
      await assert.rejects(store.verifyWorkerRelease(claimGuard), WorkerReleaseRejectedError);
      await assert.rejects(
        store.update(async () => ({ state: { value: 2 }, result: "claim" }), undefined, claimGuard),
        WorkerReleaseRejectedError
      );

      await controlPool.query(
        "update jina_runtime.release_control set lease_expires_at=now()-interval '1 second',updated_at=now() where id=1"
      );
      await store.verifyWorkerRelease(claimGuard);
      await controlPool.query(
        `update jina_runtime.release_control
         set lease_release_id=null,lease_credential_sha256=null,lease_expires_at=null,updated_at=now()
         where id=1`
      );
      await store.verifyWorkerRelease(claimGuard);
    } finally {
      await store.close().catch(() => undefined);
      await controlPool.query("drop schema if exists jina_runtime cascade").catch(() => undefined);
      await controlPool.end();
    }
  }
);

test(
  "the shared drain stops causal claims without revoking its active generation",
  { skip: !databaseUrl },
  async () => {
    const controlPool = new Pool({ connectionString: databaseUrl, application_name: "jina-causal-drain-control-test" });
    const store = new PostgresJsonStateStore<{ value: number }>({
      connectionString: databaseUrl,
      applicationName: "jina-causal-drain-store-test"
    });
    const causalRelease = {
      releaseId: "causal-release-active",
      credentialSha256: "c".repeat(64),
      service: "jina-causal-graph-worker",
      revision: "jina-causal-graph-worker-active"
    } as const;
    const claimGuard: WorkerReleaseGuard = { ...causalRelease, requireClaimAdmission: true };
    try {
      await controlPool.query("drop schema if exists jina_runtime cascade");
      await store.load();
      await enableCausalRelease(controlPool, causalRelease);
      await store.verifyWorkerRelease(claimGuard);
      await controlPool.query(
        `insert into jina_runtime.release_control (
         id,lease_release_id,lease_credential_sha256,lease_expires_at,worker_accepts_claims
       ) values (1,'deployment-drain','deployment-drain-credential',now()+interval '10 minutes',false)`
      );

      await store.verifyWorkerRelease(causalRelease);
      await assert.rejects(store.verifyWorkerRelease(claimGuard), WorkerReleaseRejectedError);
      await controlPool.query(
        "update jina_runtime.release_control set lease_expires_at=now()-interval '1 second',updated_at=now() where id=1"
      );
      await store.verifyWorkerRelease(claimGuard);
    } finally {
      await store.close().catch(() => undefined);
      await controlPool.query("drop schema if exists jina_runtime cascade").catch(() => undefined);
      await controlPool.end();
    }
  }
);

async function enableRelease(pool: Pool, release: WorkerReleaseGuard): Promise<void> {
  await pool.query(
    `insert into jina_runtime.release_control (
       id,worker_claims_enabled,worker_release_id,worker_credential_sha256,
       context_worker_revision,task_worker_revision
     ) values (1,true,$1,$2,$3,$4)`,
    [release.releaseId, release.credentialSha256, release.revision, "jina-task-worker-active"]
  );
}

async function enableCausalRelease(pool: Pool, release: WorkerReleaseGuard): Promise<void> {
  await pool.query(
    `insert into jina_runtime.causal_graph_release_control (
       id,worker_claims_enabled,worker_release_id,worker_credential_sha256,worker_revision
     ) values (1,true,$1,$2,$3)`,
    [release.releaseId, release.credentialSha256, release.revision]
  );
}
