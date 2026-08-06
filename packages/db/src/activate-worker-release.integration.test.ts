import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.TEST_DATABASE_URL;
const activationScript = fileURLToPath(new URL("./activate-worker-release.js", import.meta.url));

test(
  "staging worker release activation enables an exact generation and can restore the disabled state",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, application_name: "jina-worker-release-activation-test" });
    const runtimeUser = new URL(databaseUrl!).username;
    const credential = "staging-worker-release-credential-1234567890";
    try {
      await pool.query("drop schema if exists jina_runtime cascade");
      await pool.query(`
      create schema jina_runtime;
      create table jina_runtime.api_state (
        id smallint primary key check (id=1),
        snapshot jsonb not null,
        version bigint not null default 1,
        updated_at timestamptz not null default now()
      )
    `);

      const enabled = await execFileAsync(process.execPath, [activationScript], {
        env: {
          ...process.env,
          DATABASE_URL: "",
          TEST_DATABASE_URL: databaseUrl,
          RUNTIME_DB_USER: runtimeUser,
          JINA_WORKER_RELEASE_ENABLED: "true",
          JINA_WORKER_ACCEPTS_CLAIMS: "false",
          JINA_WORKER_RELEASE_ID: "staging-release-test",
          JINA_WORKER_RELEASE_CREDENTIAL: credential,
          JINA_CONTEXT_WORKER_REVISION: "jina-context-worker-staging-release-test",
          JINA_TASK_WORKER_REVISION: "jina-task-worker-staging-release-test"
        }
      });
      assert.deepEqual(JSON.parse(enabled.stdout), {
        enabled: true,
        acceptsClaims: false,
        releaseId: "staging-release-test",
        contextRevision: "jina-context-worker-staging-release-test",
        taskRevision: "jina-task-worker-staging-release-test"
      });
      const active = await pool.query(
        `select worker_claims_enabled,worker_accepts_claims,worker_release_id,worker_credential_sha256,
              context_worker_revision,task_worker_revision
       from jina_runtime.release_control where id=1`
      );
      assert.deepEqual(active.rows[0], {
        worker_claims_enabled: true,
        worker_accepts_claims: false,
        worker_release_id: "staging-release-test",
        worker_credential_sha256: createHash("sha256").update(credential, "utf8").digest("hex"),
        context_worker_revision: "jina-context-worker-staging-release-test",
        task_worker_revision: "jina-task-worker-staging-release-test"
      });

      const reopened = await execFileAsync(process.execPath, [activationScript], {
        env: {
          ...process.env,
          DATABASE_URL: "",
          TEST_DATABASE_URL: databaseUrl,
          RUNTIME_DB_USER: runtimeUser,
          JINA_WORKER_RELEASE_ENABLED: "true",
          JINA_WORKER_ACCEPTS_CLAIMS: "true",
          JINA_WORKER_RELEASE_ID: "staging-release-test",
          JINA_WORKER_RELEASE_CREDENTIAL: credential,
          JINA_CONTEXT_WORKER_REVISION: "jina-context-worker-staging-release-test",
          JINA_TASK_WORKER_REVISION: "jina-task-worker-staging-release-test"
        }
      });
      assert.equal(JSON.parse(reopened.stdout).acceptsClaims, true);
      assert.equal(
        (await pool.query("select worker_accepts_claims from jina_runtime.release_control where id=1")).rows[0]
          .worker_accepts_claims,
        true
      );

      const disabled = await execFileAsync(process.execPath, [activationScript], {
        env: {
          ...process.env,
          DATABASE_URL: "",
          TEST_DATABASE_URL: databaseUrl,
          RUNTIME_DB_USER: runtimeUser,
          JINA_WORKER_RELEASE_ENABLED: "false"
        }
      });
      assert.deepEqual(JSON.parse(disabled.stdout), { enabled: false });
      const inactive = await pool.query(
        `select worker_claims_enabled,worker_accepts_claims,worker_release_id,worker_credential_sha256,
              context_worker_revision,task_worker_revision
       from jina_runtime.release_control where id=1`
      );
      assert.deepEqual(inactive.rows[0], {
        worker_claims_enabled: false,
        worker_accepts_claims: true,
        worker_release_id: null,
        worker_credential_sha256: null,
        context_worker_revision: null,
        task_worker_revision: null
      });
    } finally {
      await pool.query("drop schema if exists jina_runtime cascade").catch(() => undefined);
      await pool.end();
    }
  }
);
