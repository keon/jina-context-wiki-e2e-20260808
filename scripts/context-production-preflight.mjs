import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const LEGACY_CONTEXT_TABLES = ["derivation_progress", "pipeline_builds", "pipeline_stages"];
const TABLES_ADDED_AFTER_LEGACY = [
  "context_board_publications",
  "context_quota_ledgers",
  "current_context_board_releases",
  "current_issue_graph_releases",
  "issue_graph_releases"
];
const CURRENT_CONTEXT_VIEWS = [
  "current_repository_acl",
  "published_context_documents",
  "published_context_fragments",
  "published_hierarchy_nodes",
  "published_structural_relations"
];
const RESET_CONFIRMATION = "delete-rebuildable-context";
const PRESERVED_COLUMNS = {
  repositories: [
    "tenant_id:text",
    "repository:text",
    "provider:text",
    "provider_repository_id:text",
    "default_ref:text",
    "metadata:jsonb",
    "created_at:timestamp with time zone",
    "updated_at:timestamp with time zone"
  ],
  repository_acl_observations: [
    "id:text",
    "tenant_id:text",
    "repository:text",
    "principal_id:text",
    "permission:text",
    "acl_fingerprint:text",
    "source_observation_id:text",
    "observed_at:timestamp with time zone"
  ],
  erasure_filters: [
    "id:text",
    "tenant_id:text",
    "repository:text",
    "source_type:text",
    "source_id:text",
    "path_pattern:text",
    "content_digest:text",
    "reason:text",
    "actor_id:text",
    "created_at:timestamp with time zone"
  ],
  audit_events: [
    "id:text",
    "tenant_id:text",
    "repository:text",
    "sequence:bigint",
    "actor_id:text",
    "action:text",
    "target_type:text",
    "target_id:text",
    "payload:jsonb",
    "occurred_at:timestamp with time zone"
  ],
  api_tokens: [
    "id:text",
    "tenant_id:text",
    "principal_id:text",
    "name:text",
    "secret_hash:text",
    "scopes:ARRAY",
    "created_at:timestamp with time zone",
    "created_by:text",
    "expires_at:timestamp with time zone",
    "last_used_at:timestamp with time zone",
    "revoked_at:timestamp with time zone",
    "revoked_by:text"
  ]
};

const command = process.argv.at(-1);
if (command === "daytona") {
  await preflightDaytona();
} else if (command === "schema-preflight") {
  await withDatabase((pool, reset) => inspectSchema(pool, reset, true));
} else if (command === "schema-inspect") {
  await withDatabase((pool, reset) => inspectSchema(pool, reset, false));
} else if (command === "schema-reset") {
  await withDatabase((pool, reset) => resetLegacySchema(pool, reset));
} else if (command === "board-drain") {
  await withDatabase((pool) => drainBoardLeases(pool));
} else if (command === "board-await-drain") {
  await withDatabase((pool) => awaitBoardLeases(pool));
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
      "runtime-write-enable, release-release, board-drain, board-await-drain, board-verify, schema-preflight, " +
      "schema-inspect, or schema-reset"
  );
}

async function preflightDaytona() {
  const apiKey = requiredEnv("DAYTONA_API_KEY");
  const snapshot = optionalEnv("CONTEXT_DAYTONA_SNAPSHOT");
  const image = optionalEnv("CONTEXT_DAYTONA_IMAGE");
  if (Boolean(snapshot) === Boolean(image)) {
    throw new Error("Daytona preflight requires exactly one snapshot or image");
  }
  const secretName = requiredEnv("CONTEXT_DAYTONA_MODEL_SECRET");
  const secretEnvironment = requiredEnv("CONTEXT_DAYTONA_MODEL_SECRET_ENV");
  const allowedDomains = requiredEnv("CONTEXT_DAYTONA_MODEL_DOMAINS")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);
  const daytonaModulePath = process.env.CONTEXT_DAYTONA_MODULE_PATH ?? "/app/node_modules/@jina/daytona/dist/index.js";
  const resolvedDaytonaModulePath = realpathSync(daytonaModulePath);
  const { DaytonaBoardAgentStageRunner } = await import(pathToFileURL(resolvedDaytonaModulePath).href);
  if (snapshot) {
    const daytonaRequire = createRequire(resolvedDaytonaModulePath);
    const { Daytona } = await import(pathToFileURL(daytonaRequire.resolve("@daytona/sdk")).href);
    const daytona = new Daytona({ apiKey });
    try {
      const snapshotRecord = await daytona.snapshot.get(snapshot);
      if (snapshotRecord.name !== snapshot || snapshotRecord.state !== "active") {
        throw new Error(`Daytona snapshot ${snapshot} is not active`);
      }
    } catch (error) {
      // The SDK cause is untrusted and may include request credentials.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `Daytona snapshot verification failed: ${sanitizedDiagnostic(error instanceof Error ? error.message : error, [
          apiKey
        ])}`
      );
    } finally {
      await daytona[Symbol.asyncDispose]();
    }
  }

  const configuredModel = optionalEnv("CONTEXT_CODEX_MODEL") ?? "gpt-5.6-terra";
  const archive = archiveWithFile("README.md", "production Daytona preflight\n");
  let result;
  try {
    const runner = new DaytonaBoardAgentStageRunner({
      daytonaApiKey: apiKey,
      ...(snapshot ? { snapshot } : { image }),
      modelSecret: {
        environmentVariable: secretEnvironment,
        secretName
      },
      allowedDomains,
      model: configuredModel.replace(/^openai\//, ""),
      effort: optionalEnv("CONTEXT_CODEX_EFFORT") ?? "low",
      verbosity: optionalEnv("CONTEXT_CODEX_VERBOSITY") ?? "high",
      setupTimeoutSeconds: 300,
      protectedValues: [apiKey]
    });
    result = await runner.run({
      id: "production-preflight",
      prompt:
        'Use the shell tool to write exactly TOOL_OK, with no trailing newline, to the only declared output file. Verify the file, then return exactly {"status":"AUTH_OK"}.',
      schema: {
        type: "object",
        properties: { status: { type: "string", enum: ["AUTH_OK"] } },
        required: ["status"],
        additionalProperties: false
      },
      repository: {
        commitSha: "0".repeat(40),
        archive,
        sha256: createHash("sha256").update(archive).digest("hex")
      },
      artifacts: [],
      limits: {
        timeoutSeconds: 180,
        contextTokens: positiveIntegerEnv("CONTEXT_CODEX_CONTEXT_TOKENS", 128_000),
        compactTokens: positiveIntegerEnv("CONTEXT_CODEX_COMPACT_TOKENS", 96_000),
        attempt: 1,
        maxAttempts: 1,
        maxOutputBytes: 1_024
      },
      outputFiles: [{ path: "tool-ok", contentType: "text/plain", maxBytes: 64 }]
    });
  } catch (error) {
    // The original cause can contain provider stderr or credentials. Deliberately
    // do not attach it to the process-visible error after constructing the safe diagnostic.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `Daytona production BoardAgent preflight failed: ${sanitizedDiagnostic(
        error instanceof Error ? error.message : error,
        [apiKey]
      )}`
    );
  }
  const response = JSON.parse(Buffer.from(result.bytes).toString("utf8"));
  const toolOutput = result.files.find((file) => file.path === "tool-ok");
  if (
    response.status !== "AUTH_OK" ||
    Object.keys(response).length !== 1 ||
    result.files.length !== 1 ||
    !toolOutput ||
    Buffer.from(toolOutput.bytes).toString("utf8") !== "TOOL_OK"
  ) {
    throw new Error("Daytona production BoardAgent preflight returned an invalid bounded result");
  }
  console.log(`Daytona production BoardAgent preflight passed for ${snapshot ?? image}`);
}

async function withDatabase(operation) {
  const modulePath = process.env.CONTEXT_RESET_MODULE_PATH ?? "/app/node_modules/@jina/db/dist/reset-context-data.js";
  const realModulePath = realpathSync(modulePath);
  const reset = await import(pathToFileURL(realModulePath).href);
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
    await operation(pool, reset);
  } finally {
    await pool.end();
  }
}

async function inspectSchema(pool, reset, beforeMigration) {
  if (optionalReleaseInput()) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='60s'");
      await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
      await assertDeploymentLease(client);
      await inspectSchemaDatabase(client, reset, beforeMigration);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  await inspectSchemaDatabase(pool, reset, beforeMigration);
}

async function inspectSchemaDatabase(database, reset, beforeMigration) {
  const mode = resetMode();
  const tables = await contextTables(database);
  const current = currentTables(reset);
  const legacy = legacyLayout(current);
  if (mode === "disabled") {
    const views = await contextViews(database);
    if (beforeMigration) {
      assertNoUnexpected(tables, current, "current Context v2 schema");
      assertNoUnexpected(views, CURRENT_CONTEXT_VIEWS, "current Context v2 views");
    } else {
      assertExactSet(tables, current, "current Context v2 schema");
      assertExactSet(views, CURRENT_CONTEXT_VIEWS, "current Context v2 views");
    }
  } else {
    assertExactSet(tables, legacy, "one-time legacy Context schema");
    assertExactSet(await contextViews(database), CURRENT_CONTEXT_VIEWS, "one-time legacy Context views");
  }
  await assertPreservedShapes(database);
  console.log(
    JSON.stringify({
      mode,
      layout: mode === "disabled" ? (beforeMigration ? "current-pre-migration" : "current") : "legacy-transition",
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
    // exempt: migration/reset hold the Board lock for their full critical
    // section and must still be able to renew the deployment lease.
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
        if (!row?.worker_claims_enabled) {
          throw new Error("cannot drain an inactive worker generation");
        }
        await client.query(
          `update jina_runtime.release_control
           set worker_accepts_claims=false,
               updated_at=clock_timestamp()
           where id=1`
        );
      } else if (action === "worker-resume") {
        if (!row?.worker_claims_enabled) {
          throw new Error("cannot resume an inactive worker generation");
        }
        await client.query(
          `update jina_runtime.release_control
           set worker_accepts_claims=true,
               updated_at=clock_timestamp()
           where id=1`
        );
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
          action === "worker-enable" || action === "worker-resume"
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

async function awaitBoardLeases(pool) {
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
      if (leases.length === 0) {
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
          event: "release_control.board_drained_and_worker_paused",
          boardLeases: 0,
          workerClaimsEnabled: false,
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

async function resetLegacySchema(pool, reset) {
  if (resetMode() !== "legacy-once") {
    throw new Error("schema-reset is available only with JINA_CONTEXT_RESET_MODE=legacy-once");
  }
  if (process.env.JINA_CONFIRM_CONTEXT_RESET !== RESET_CONFIRMATION) {
    throw new Error(`JINA_CONFIRM_CONTEXT_RESET=${RESET_CONFIRMATION} is required`);
  }
  if (!/^[1-9][0-9]*$/.test(requiredEnv("JINA_CONTEXT_RESET_BACKUP_ID"))) {
    throw new Error("A verified Cloud SQL backup ID is required before schema-reset");
  }

  const current = currentTables(reset);
  const expectedBefore = [...current, ...LEGACY_CONTEXT_TABLES].sort();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='60s'");
    await client.query("set local statement_timeout='15min'");
    await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
    await assertDeploymentLease(client, true);
    await client.query("select pg_advisory_xact_lock(hashtext('jina-context-reset'))");
    assertExactSet(await contextTables(client), expectedBefore, "post-migration legacy Context schema");
    assertExactSet(await contextViews(client), CURRENT_CONTEXT_VIEWS, "post-migration Context views");
    await assertPreservedShapes(client);
    const preservedBefore = await preservedDigests(client);

    await client.query(`
      create temporary table context_reset_acl_observations
        on commit drop
        as select * from jina_context.repository_acl_observations;
      create temporary table context_reset_acl_sources
        on commit drop
        as
          select observation.*
          from jina_context.observations observation
          where exists (
            select 1
            from jina_context.repository_acl_observations acl
            where acl.tenant_id=observation.tenant_id
              and acl.repository=observation.repository
              and acl.source_observation_id=observation.id
          );
    `);
    await client.query(
      `truncate ${reset.REBUILDABLE_CONTEXT_TABLES.map((table) => `jina_context.${table}`).join(
        ","
      )} restart identity cascade`
    );
    await client.query(`
      insert into jina_context.observations
        select * from context_reset_acl_sources;
      insert into jina_context.repository_acl_observations
        select * from context_reset_acl_observations;
    `);
    // No CASCADE: any unclassified dependency makes the whole transaction fail
    // instead of silently deleting data outside the three audited legacy tables.
    await client.query(`drop table ${LEGACY_CONTEXT_TABLES.map((table) => `jina_context.${table}`).join(",")}`);

    assertExactSet(await contextTables(client), current, "reset Context v2 schema");
    assertExactSet(await contextViews(client), CURRENT_CONTEXT_VIEWS, "reset Context v2 views");
    const preservedAfter = await preservedDigests(client);
    if (JSON.stringify(preservedAfter) !== JSON.stringify(preservedBefore)) {
      throw new Error("Context reset changed preserved identity or control-plane rows");
    }
    // The reset is atomic, so loss of the renewable release lease can still
    // fail closed here and roll every destructive statement back.
    await assertDeploymentLease(client, true);
    await client.query("commit");
    console.log(
      JSON.stringify({
        mode: "legacy-once",
        backupId: process.env.JINA_CONTEXT_RESET_BACKUP_ID,
        droppedLegacyTables: LEGACY_CONTEXT_TABLES,
        preservedTables: reset.PRESERVED_CONTEXT_TABLES
      })
    );
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function currentTables(reset) {
  return [...reset.REBUILDABLE_CONTEXT_TABLES, ...reset.PRESERVED_CONTEXT_TABLES].sort();
}

function legacyLayout(current) {
  return [...current.filter((table) => !TABLES_ADDED_AFTER_LEGACY.includes(table)), ...LEGACY_CONTEXT_TABLES].sort();
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

async function assertPreservedShapes(database) {
  const result = await database.query(
    `select table_name,column_name,data_type
     from information_schema.columns
     where table_schema='jina_context' and table_name=any($1::text[])
     order by table_name,ordinal_position`,
    [Object.keys(PRESERVED_COLUMNS)]
  );
  const actual = Object.fromEntries(Object.keys(PRESERVED_COLUMNS).map((table) => [table, []]));
  for (const row of result.rows) actual[row.table_name]?.push(`${row.column_name}:${row.data_type}`);
  for (const [table, expected] of Object.entries(PRESERVED_COLUMNS)) {
    if (JSON.stringify(actual[table]) !== JSON.stringify(expected)) {
      throw new Error(`Preserved table jina_context.${table} has an unexpected shape`);
    }
  }
}

async function preservedDigests(database) {
  const digests = {};
  for (const table of Object.keys(PRESERVED_COLUMNS).sort()) {
    const result = await database.query(
      `select count(*)::text rows,
              md5(coalesce(string_agg(to_jsonb(record)::text,E'\\n'
                  order by to_jsonb(record)::text),'')) digest
       from jina_context.${table} record`
    );
    digests[table] = result.rows[0];
  }
  const aclSources = await database.query(
    `select count(*)::text rows,
            md5(coalesce(string_agg(to_jsonb(observation)::text,E'\\n'
                order by to_jsonb(observation)::text),'')) digest
     from jina_context.observations observation
     where exists (
       select 1
       from jina_context.repository_acl_observations acl
       where acl.tenant_id=observation.tenant_id
         and acl.repository=observation.repository
         and acl.source_observation_id=observation.id
     )`
  );
  digests.repository_acl_source_observations = aclSources.rows[0];
  return digests;
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

function assertNoUnexpected(actual, expected, label) {
  const allowed = new Set(expected);
  const extra = actual.filter((value) => !allowed.has(value));
  if (extra.length > 0) {
    throw new Error(`${label} mismatch; unexpected=[${extra.join(",")}]`);
  }
}

function resetMode() {
  const mode = process.env.JINA_CONTEXT_RESET_MODE ?? "disabled";
  if (mode !== "disabled" && mode !== "legacy-once") {
    throw new Error("JINA_CONTEXT_RESET_MODE must be disabled or legacy-once");
  }
  return mode;
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

function positiveIntegerEnv(name, fallback) {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(raw);
}

function archiveWithFile(name, body) {
  const payload = Buffer.from(body, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(payload.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return gzipSync(
    Buffer.concat([header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512), Buffer.alloc(1024)])
  );
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
