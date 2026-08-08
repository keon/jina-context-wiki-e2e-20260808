import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CURRENT_CONTEXT_TABLES = [
  "context_phase_checkpoints",
  "context_quota_ledgers",
  "context_releases",
  "issue_graph_releases",
  "repositories",
  "repository_access"
];

// api_tokens moved to public (migration 0038); the compatibility view keeps
// the old name alive for the previous revision until the next baseline squash.
const CURRENT_CONTEXT_VIEWS = ["api_tokens"];

const command = process.argv.at(-1);
if (command === "daytona") {
  await preflightDaytona();
} else if (command === "schema-preflight") {
  await withDatabase((pool) => inspectSchema(pool, true));
} else if (command === "schema-inspect") {
  await withDatabase((pool) => inspectSchema(pool, false));
} else if (command === "board-drain") {
  await withDatabase((pool) => drainBoardLeases(pool));
} else if (command === "board-await-drain") {
  await withDatabase((pool) => awaitBoardLeases(pool, { pauseGenerationAfterDrain: true }));
} else if (command === "board-await-quiescence") {
  await withDatabase((pool) => awaitBoardLeases(pool, { pauseGenerationAfterDrain: false }));
} else if (command === "board-verify") {
  await withDatabase((pool) => verifyBoardLeases(pool));
} else if (
  [
    "release-acquire",
    "release-renew",
    "worker-drain",
    "worker-resume",
    "worker-pause",
    "worker-enable",
    "runtime-write-enable",
    "release-release"
  ].includes(command)
) {
  await withDatabase((pool) => updateReleaseControlWithRetry(pool, command));
} else {
  throw new Error(
    "Expected daytona, release-acquire, release-renew, worker-drain, worker-resume, worker-pause, worker-enable, " +
      "runtime-write-enable, release-release, board-drain, board-await-drain, board-await-quiescence, " +
      "board-verify, schema-preflight, " +
      "or schema-inspect"
  );
}

async function preflightDaytona() {
  const apiKey = requiredEnv("DAYTONA_API_KEY");
  const snapshot = optionalEnv("CONTEXT_DAYTONA_SNAPSHOT");
  const image = optionalEnv("CONTEXT_DAYTONA_IMAGE");
  if (Boolean(snapshot) === Boolean(image)) {
    throw new Error("Daytona preflight requires exactly one snapshot or image");
  }
  const daytonaModulePath = process.env.CONTEXT_DAYTONA_MODULE_PATH ?? "/app/node_modules/@jina/daytona/dist/index.js";
  const resolvedDaytonaModulePath = realpathSync(daytonaModulePath);
  const daytonaRequire = createRequire(resolvedDaytonaModulePath);
  const sdkModulePath = optionalEnv("CONTEXT_DAYTONA_SDK_MODULE_PATH");
  const { Daytona } = await import(
    pathToFileURL(sdkModulePath ? realpathSync(sdkModulePath) : daytonaRequire.resolve("@daytona/sdk")).href
  );
  const daytona = new Daytona({ apiKey });
  let sandbox;
  let failure;
  try {
    if (snapshot) {
      const snapshotRecord = await daytona.snapshot.get(snapshot);
      if (snapshotRecord.name !== snapshot || snapshotRecord.state !== "active") {
        throw new Error(`Daytona snapshot ${snapshot} is not active`);
      }
    }
    sandbox = await daytona.create(
      {
        language: "typescript",
        ...(snapshot ? { snapshot } : { image }),
        envVars: { NODE_ENV: "production", LANG: "C.UTF-8" },
        labels: { "jina-preflight": "context" },
        networkBlockAll: true,
        public: false,
        ephemeral: true,
        ttlMinutes: 5
      },
      { timeout: 300 }
    );
    const command = await sandbox.process.executeCommand(
      'set -eu\nprintf TOOL_OK > /tmp/jina-context-preflight\ntest "$(cat /tmp/jina-context-preflight)" = TOOL_OK\nprintf AUTH_OK',
      undefined,
      { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
      60
    );
    if (command.exitCode !== 0 || String(command.result ?? "").trim() !== "AUTH_OK") {
      throw new Error(`sandbox command failed: ${sanitizedDiagnostic(command.result, [apiKey])}`);
    }
  } catch (error) {
    failure = new Error(
      `Daytona production sandbox preflight failed: ${sanitizedDiagnostic(
        error instanceof Error ? error.message : error,
        [apiKey]
      )}`
    );
  } finally {
    try {
      if (sandbox) await sandbox.delete(60, true);
    } catch (error) {
      if (!failure) {
        failure = new Error(
          `Daytona production sandbox preflight cleanup failed: ${sanitizedDiagnostic(
            error instanceof Error ? error.message : error,
            [apiKey]
          )}`
        );
      }
    }
    try {
      await daytona[Symbol.asyncDispose]();
    } catch (error) {
      if (!failure) {
        failure = new Error(
          `Daytona production sandbox preflight cleanup failed: ${sanitizedDiagnostic(
            error instanceof Error ? error.message : error,
            [apiKey]
          )}`
        );
      }
    }
  }
  if (failure) throw failure;
  console.log(`Daytona production sandbox preflight passed for ${snapshot ?? image}`);
}

async function withDatabase(operation) {
  const modulePath = process.env.CONTEXT_DB_MODULE_PATH ?? "/app/node_modules/@jina/db/dist/index.js";
  const realModulePath = realpathSync(modulePath);
  const require = createRequire(realModulePath);
  const { Pool } = require("pg");
  const host = optionalEnv("INSTANCE_UNIX_SOCKET") ?? optionalEnv("DB_HOST");
  const connectionString = optionalEnv("DATABASE_URL");
  const pool = new Pool({
    ...(connectionString
      ? { connectionString }
      : {
          host: required("INSTANCE_UNIX_SOCKET or DB_HOST", host),
          user: requiredEnv("DB_USER"),
          password: requiredEnv("DB_PASS"),
          database: requiredEnv("DB_NAME"),
          ...(optionalEnv("DB_PORT") ? { port: Number(process.env.DB_PORT) } : {})
        }),
    application_name: "jina-context-production-transition",
    max: 1
  });
  try {
    await operation(pool);
  } finally {
    await pool.end();
  }
}

async function inspectSchema(pool, beforeMigration) {
  if (optionalReleaseInput()) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='60s'");
      await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
      await assertDeploymentLease(client);
      await inspectSchemaDatabase(client, beforeMigration);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  await inspectSchemaDatabase(pool, beforeMigration);
}

async function inspectSchemaDatabase(database, beforeMigration) {
  const tables = await contextTables(database);
  if (!beforeMigration) {
    assertExactSet(tables, CURRENT_CONTEXT_TABLES, "current Context schema");
    assertExactSet(await contextViews(database), CURRENT_CONTEXT_VIEWS, "current Context views");
  }
  console.log(
    JSON.stringify({
      layout: beforeMigration ? "migration-pending" : "current",
      tableCount: tables.length
    })
  );
}

async function updateReleaseControl(pool, action) {
  await ensureReleaseControlTable(pool);
  const release = requiredReleaseInput();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='60s'");
    await client.query("set local statement_timeout='5min'");
    // Gate changes take the Board lock first. Worker mutations take this same
    // lock before reading release_control, so pausing/enabling a release cannot
    // race a final claim/renew/complete transaction. Renewal is deliberately
    // exempt: migrations hold the Board lock for their full critical section
    // and must still be able to renew the deployment lease.
    if (action !== "release-renew") {
      await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
    }
    await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.release_control'))");
    const current = await client.query(
      `select lease_release_id,lease_credential_sha256,lease_expires_at,worker_claims_enabled,worker_accepts_claims
       from jina_runtime.release_control
       where id=1
       for update`
    );
    const row = current.rows[0];

    if (action === "release-acquire") {
      if (
        row?.lease_expires_at &&
        Date.parse(String(row.lease_expires_at)) > Date.now() &&
        (row.lease_release_id !== release.releaseId || row.lease_credential_sha256 !== release.credentialSha256)
      ) {
        throw new Error(`coordinated release ${row.lease_release_id} already holds the deployment lease`);
      }
      await client.query(
        `insert into jina_runtime.release_control
           (id,lease_release_id,lease_credential_sha256,lease_expires_at)
         values (1,$1,$2,clock_timestamp()+($3::text || ' seconds')::interval)
         on conflict (id) do update
           set lease_release_id=excluded.lease_release_id,
               lease_credential_sha256=excluded.lease_credential_sha256,
               lease_expires_at=excluded.lease_expires_at,
               updated_at=clock_timestamp()`,
        [release.releaseId, release.credentialSha256, release.leaseSeconds]
      );
    } else {
      assertCurrentDeploymentLease(row, release);
      if (action === "release-renew") {
        await client.query(
          `update jina_runtime.release_control
           set lease_expires_at=clock_timestamp()+($1::text || ' seconds')::interval,
               updated_at=clock_timestamp()
           where id=1`,
          [release.leaseSeconds]
        );
      } else if (action === "worker-drain") {
        await client.query(
          `update jina_runtime.release_control
           set worker_accepts_claims=false,
               updated_at=clock_timestamp()
         where id=1`
        );
      } else if (action === "worker-resume") {
        // A rejected prior release deliberately leaves workers inactive. A
        // subsequent release must be able to pass through the same drain and
        // rollback protocol without reviving that unaccepted generation.
        if (row?.worker_claims_enabled) {
          await client.query(
            `update jina_runtime.release_control
             set worker_accepts_claims=true,
                 updated_at=clock_timestamp()
             where id=1`
          );
        }
      } else if (action === "worker-pause") {
        await pauseWorkerGeneration(client);
      } else if (action === "worker-enable") {
        const contextRevision = requiredWorkerRevision("JINA_CONTEXT_WORKER_REVISION", "jina-context-worker");
        const taskRevision = requiredWorkerRevision("JINA_TASK_WORKER_REVISION", "jina-task-worker");
        const workerCredentialSha256 = requiredWorkerGenerationCredentialSha256();
        await client.query(
          `update jina_runtime.release_control
           set worker_claims_enabled=true,
               worker_accepts_claims=true,
               worker_release_id=$1,
               worker_credential_sha256=$2,
               context_worker_revision=$3,
               task_worker_revision=$4,
               updated_at=clock_timestamp()
           where id=1`,
          [release.releaseId, workerCredentialSha256, contextRevision, taskRevision]
        );
        await client.query(
          `grant select,insert,update on jina_runtime.api_state to "${requiredRuntimeUser().replaceAll('"', '""')}"`
        );
      } else if (action === "runtime-write-enable") {
        await client.query(
          `grant select,insert,update on jina_runtime.api_state to "${requiredRuntimeUser().replaceAll('"', '""')}"`
        );
      } else if (action === "release-release") {
        await client.query(
          `update jina_runtime.release_control
           set lease_release_id=null,
               lease_credential_sha256=null,
               lease_expires_at=null,
               updated_at=clock_timestamp()
           where id=1`
        );
      } else {
        throw new Error(`unsupported release control action ${action}`);
      }
    }
    await client.query("commit");
    console.log(
      JSON.stringify({
        action,
        releaseId: release.releaseId,
        leaseSeconds: release.leaseSeconds,
        workerClaimsEnabled: action === "worker-enable" ? true : action === "worker-pause" ? false : undefined,
        workerAcceptsClaims:
          action === "worker-enable" || (action === "worker-resume" && row?.worker_claims_enabled)
            ? true
            : action === "worker-drain" || action === "worker-pause"
              ? false
              : undefined
      })
    );
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function updateReleaseControlWithRetry(pool, action) {
  const maximumAttempts = action === "release-renew" ? 3 : 12;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await updateReleaseControl(pool, action);
      return;
    } catch (error) {
      if (error?.code !== "55P03" || attempt === maximumAttempts) {
        throw error;
      }
      console.warn(
        JSON.stringify({
          event: "release_control.lock_retry",
          action,
          attempt,
          maximumAttempts,
          retryDelaySeconds: 5
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

async function ensureReleaseControlTable(pool) {
  await pool.query(`
    create schema if not exists jina_runtime;
    create table if not exists jina_runtime.release_control (
      id smallint primary key check (id = 1),
      lease_release_id text,
      lease_credential_sha256 text,
      lease_expires_at timestamptz,
      worker_claims_enabled boolean not null default false,
      worker_accepts_claims boolean not null default true,
      worker_release_id text,
      worker_credential_sha256 text,
      context_worker_revision text,
      task_worker_revision text,
      updated_at timestamptz not null default now(),
      check (
        (lease_release_id is null and lease_credential_sha256 is null and lease_expires_at is null)
        or
        (lease_release_id is not null and lease_credential_sha256 is not null and lease_expires_at is not null)
      ),
      check (
        (not worker_claims_enabled and worker_release_id is null and worker_credential_sha256 is null
           and context_worker_revision is null and task_worker_revision is null)
        or
        (worker_claims_enabled and worker_release_id is not null and worker_credential_sha256 is not null
           and context_worker_revision is not null and task_worker_revision is not null)
      )
    )
  `);
  await pool.query(`
    alter table jina_runtime.release_control
      add column if not exists worker_accepts_claims boolean not null default true
  `);
  const runtimeUser = requiredRuntimeUser();
  await pool.query(`grant select on jina_runtime.release_control to "${runtimeUser.replaceAll('"', '""')}"`);
}

function requiredRuntimeUser() {
  const runtimeUser = requiredEnv("CONTEXT_RUNTIME_DB_USER");
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(runtimeUser)) {
    throw new Error("CONTEXT_RUNTIME_DB_USER is not a safe PostgreSQL role name");
  }
  return runtimeUser;
}

function requiredReleaseInput() {
  const releaseId = requiredEnv("JINA_WORKER_RELEASE_ID");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(releaseId)) {
    throw new Error("JINA_WORKER_RELEASE_ID is invalid");
  }
  const credential = requiredEnv("JINA_WORKER_RELEASE_CREDENTIAL");
  if (credential.length < 32 || credential.length > 512) {
    throw new Error("JINA_WORKER_RELEASE_CREDENTIAL must contain 32..512 characters");
  }
  const leaseSeconds = Number(process.env.JINA_DEPLOYMENT_LEASE_SECONDS ?? "1800");
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 300 || leaseSeconds > 43_200) {
    throw new Error("JINA_DEPLOYMENT_LEASE_SECONDS must be an integer between 300 and 43200");
  }
  return {
    releaseId,
    credentialSha256: createHash("sha256").update(credential, "utf8").digest("hex"),
    leaseSeconds
  };
}

function requiredWorkerGenerationCredentialSha256() {
  const digest = requiredEnv("JINA_WORKER_GENERATION_CREDENTIAL_SHA256");
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("JINA_WORKER_GENERATION_CREDENTIAL_SHA256 must be a lowercase SHA-256 digest");
  }
  return digest;
}

function optionalReleaseInput() {
  const releaseId = optionalEnv("JINA_WORKER_RELEASE_ID");
  const credential = optionalEnv("JINA_WORKER_RELEASE_CREDENTIAL");
  if (!releaseId && !credential) return undefined;
  return requiredReleaseInput();
}

function assertCurrentDeploymentLease(row, release) {
  if (
    !row ||
    row.lease_release_id !== release.releaseId ||
    row.lease_credential_sha256 !== release.credentialSha256 ||
    !row.lease_expires_at ||
    Date.parse(String(row.lease_expires_at)) <= Date.now()
  ) {
    throw new Error(`coordinated release ${release.releaseId} does not hold a live deployment lease`);
  }
}

async function assertDeploymentLease(database, required = false) {
  const release = required ? requiredReleaseInput() : optionalReleaseInput();
  if (!release) return;
  const result = await database.query(
    `select lease_release_id,lease_credential_sha256,lease_expires_at
     from jina_runtime.release_control
     where id=1`
  );
  assertCurrentDeploymentLease(result.rows[0], release);
}

function requiredWorkerRevision(name, service) {
  const revision = requiredEnv(name);
  if (!revision.startsWith(`${service}-`) || revision.length > 63) {
    throw new Error(`${name} must be an exact ${service} revision name`);
  }
  return revision;
}

async function drainBoardLeases(pool) {
  const boardModulePath = process.env.CONTEXT_BOARD_MODULE_PATH ?? "/app/node_modules/@jina/board/dist/index.js";
  const board = await import(pathToFileURL(realpathSync(boardModulePath)).href);
  if (typeof board.fenceOutboxLeases !== "function") {
    throw new Error("The coordinated release image does not provide fenceOutboxLeases");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='60s'");
    await client.query("set local statement_timeout='5min'");
    await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
    await assertDeploymentLease(client, true);
    await requireBoardStateTable(client);
    const result = await client.query("select snapshot from jina_runtime.api_state where id=1 for update");
    const snapshot = result.rows[0]?.snapshot;
    if (snapshot === undefined) {
      await client.query("commit");
      console.log(JSON.stringify({ boardLeasesBefore: 0, boardLeasesAfter: 0, fencedMessageCount: 0 }));
      return;
    }

    const drained = fenceBoardSnapshot(snapshot, board.fenceOutboxLeases, {
      now: new Date().toISOString(),
      actorId: `deployment:${requiredEnv("CLOUD_BUILD_ID")}`,
      reason: "coordinated production release worker drain"
    });
    if (drained.fencedMessageIds.length > 0) {
      await client.query(
        `update jina_runtime.api_state
         set snapshot=$1::jsonb,version=version+1,updated_at=clock_timestamp()
         where id=1`,
        [JSON.stringify(drained.snapshot)]
      );
    }

    await client.query("commit");
    console.log(
      JSON.stringify({
        boardLeasesBefore: drained.boardLeasesBefore,
        boardLeasesAfter: 0,
        fencedMessageCount: drained.fencedMessageIds.length
      })
    );
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function awaitBoardLeases(pool, { pauseGenerationAfterDrain }) {
  const timeoutSeconds = Number(process.env.JINA_WORKER_DRAIN_TIMEOUT_SECONDS ?? "1800");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 14_400) {
    throw new Error("JINA_WORKER_DRAIN_TIMEOUT_SECONDS must be an integer between 60 and 14400");
  }
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const startedAt = Date.now();
  let priorCount;
  let nextHeartbeatAt = startedAt;
  while (true) {
    const client = await pool.connect();
    let leases;
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='60s'");
      await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
      await assertDeploymentLease(client, true);
      await requireBoardStateTable(client);
      const result = await client.query("select snapshot from jina_runtime.api_state where id=1 for update");
      leases = result.rows[0]?.snapshot === undefined ? [] : activeBoardLeaseInventory(result.rows[0].snapshot);
      if (leases.length === 0 && pauseGenerationAfterDrain) {
        await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.release_control'))");
        const current = await client.query(
          `select lease_release_id,lease_credential_sha256,lease_expires_at,worker_claims_enabled
           from jina_runtime.release_control
           where id=1
           for update`
        );
        assertCurrentDeploymentLease(current.rows[0], requiredReleaseInput());
        await pauseWorkerGeneration(client);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (leases.length === 0) {
      console.log(
        JSON.stringify({
          event: pauseGenerationAfterDrain
            ? "release_control.board_drained_and_worker_paused"
            : "release_control.board_quiescent_with_generation_preserved",
          boardLeases: 0,
          workerGenerationPreserved: !pauseGenerationAfterDrain,
          verified: true
        })
      );
      return;
    }
    const now = Date.now();
    if (leases.length !== priorCount || now >= nextHeartbeatAt) {
      console.log(
        JSON.stringify({
          event: "release_control.board_drain_wait",
          boardLeases: leases.length,
          messageIds: leases.map((lease) => lease.id),
          topics: [...new Set(leases.map((lease) => lease.topic))],
          elapsedSeconds: Math.floor((now - startedAt) / 1_000),
          deadlineAt: new Date(deadline).toISOString()
        })
      );
      priorCount = leases.length;
      nextHeartbeatAt = now + 60_000;
    }
    if (now >= deadline) {
      throw new Error(`Board still has ${leases.length} active leases after ${timeoutSeconds} seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function pauseWorkerGeneration(client) {
  await requireBoardStateTable(client);
  const boardResult = await client.query("select snapshot from jina_runtime.api_state where id=1 for update");
  const snapshot = boardResult.rows[0]?.snapshot;
  const leases = snapshot === undefined ? [] : activeBoardLeaseInventory(snapshot);
  if (leases.length > 0) {
    throw new Error(`cannot pause worker generation with ${leases.length} active Board leases`);
  }
  await client.query(
    `update jina_runtime.release_control
     set worker_claims_enabled=false,
         worker_accepts_claims=false,
         worker_release_id=null,
         worker_credential_sha256=null,
         context_worker_revision=null,
         task_worker_revision=null,
         updated_at=clock_timestamp()
     where id=1`
  );
  await client.query(
    `revoke insert,update on jina_runtime.api_state from "${requiredRuntimeUser().replaceAll('"', '""')}"`
  );
}

async function verifyBoardLeases(pool) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='60s'");
    await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
    await assertDeploymentLease(client, true);
    await requireBoardStateTable(client);
    const result = await client.query("select snapshot from jina_runtime.api_state where id=1 for update");
    const snapshot = result.rows[0]?.snapshot;
    const leases = snapshot === undefined ? [] : activeBoardLeaseInventory(snapshot);
    if (leases.length > 0) {
      throw new Error(`Board has ${leases.length} active leases after worker drain`);
    }
    await client.query("commit");
    console.log(JSON.stringify({ boardLeases: 0, verified: true }));
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function requireBoardStateTable(database) {
  const result = await database.query("select to_regclass('jina_runtime.api_state')::text relation");
  if (result.rows[0]?.relation !== "jina_runtime.api_state") {
    throw new Error("jina_runtime.api_state is missing; Board leases cannot be verified");
  }
}

function activeBoardLeaseInventory(snapshot) {
  const board = boardState(snapshot);
  const leases = [];
  for (const [index, message] of board.outbox.entries()) {
    if (!isRecord(message)) throw new Error(`Board outbox message ${index} is malformed`);
    if (message.status !== "leased") continue;
    for (const field of ["id", "topic", "leaseId", "writeFenceToken", "leaseExpiresAt"]) {
      if (typeof message[field] !== "string" || message[field].length === 0) {
        throw new Error(`Leased Board outbox message ${index} has no ${field}`);
      }
    }
    leases.push({ id: message.id, topic: message.topic });
  }
  return leases;
}

function fenceBoardSnapshot(snapshot, fenceOutboxLeases, input) {
  if (typeof fenceOutboxLeases !== "function") {
    throw new Error("fenceOutboxLeases must be a function");
  }
  const leases = activeBoardLeaseInventory(snapshot);
  if (leases.length === 0) {
    return { snapshot, boardLeasesBefore: 0, fencedMessageIds: [] };
  }
  const topics = [...new Set(leases.map((lease) => lease.topic))];
  const fenced = fenceOutboxLeases(boardState(snapshot), { topics, ...input });
  const nextSnapshot = {
    ...snapshot,
    intakeState: {
      ...snapshot.intakeState,
      board: fenced.state
    }
  };
  const remaining = activeBoardLeaseInventory(nextSnapshot);
  if (remaining.length > 0) {
    throw new Error(`Board drain left ${remaining.length} active leases`);
  }
  if (fenced.releasedMessageIds.length !== leases.length) {
    throw new Error("Board drain did not fence exactly the active lease inventory");
  }
  return {
    snapshot: nextSnapshot,
    boardLeasesBefore: leases.length,
    fencedMessageIds: fenced.releasedMessageIds
  };
}

function boardState(snapshot) {
  if (!isRecord(snapshot) || !isRecord(snapshot.intakeState) || !isRecord(snapshot.intakeState.board)) {
    throw new Error("jina_runtime.api_state does not contain the expected Board snapshot");
  }
  if (!Array.isArray(snapshot.intakeState.board.outbox)) {
    throw new Error("Board snapshot has no outbox array");
  }
  return snapshot.intakeState.board;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function contextTables(database) {
  const result = await database.query(
    `select table_name
     from information_schema.tables
     where table_schema='jina_context' and table_type='BASE TABLE'
     order by table_name`
  );
  return result.rows.map((row) => row.table_name);
}

async function contextViews(database) {
  const result = await database.query(
    `select table_name
     from information_schema.views
     where table_schema='jina_context'
     order by table_name`
  );
  return result.rows.map((row) => row.table_name);
}

function assertExactSet(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  const missing = expectedSorted.filter((table) => !actualSorted.includes(table));
  const extra = actualSorted.filter((table) => !expectedSorted.includes(table));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${label} mismatch; missing=[${missing.join(",")}], unexpected=[${extra.join(",")}]`);
  }
}

function requiredEnv(name) {
  return required(name, optionalEnv(name));
}

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function sanitizedDiagnostic(value, protectedValues = []) {
  let diagnostic = String(value || "(no diagnostic)")
    .replace(/\b(?:sk|dtn_secret)[-_][A-Za-z0-9._-]{8,}\b/gi, "[credential-redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [credential-redacted]");
  for (const protectedValue of [...new Set(protectedValues)].sort((left, right) => right.length - left.length)) {
    if (protectedValue.length >= 8) diagnostic = diagnostic.replaceAll(protectedValue, "[credential-redacted]");
  }
  return diagnostic.slice(-2_000);
}
