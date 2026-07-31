import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Pool } from "pg";
import { CONTEXT_SCHEMA_SQL } from "./context/schema.js";
import {
  CONTEXT_RESET_CONFIRMATION,
  PRESERVED_CONTEXT_TABLES,
  REBUILDABLE_CONTEXT_TABLES,
  type ContextResetReport
} from "./reset-context-data.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const resetCli = fileURLToPath(new URL("./reset-context-data.js", import.meta.url));
const EXPECTED_REBUILDABLE_ROWS = REBUILDABLE_CONTEXT_TABLES.length + 1;

test("packaged Context reset CLI executes through a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jina-context-reset-"));
  const linkedCli = join(directory, "reset-context-data.js");
  try {
    await symlink(resetCli, linkedCli);
    const result = await runResetCli([], "", undefined, linkedCli);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Dry run\. Rebuildable Context data that would be deleted:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "explicit Context reset reports exact rows, fails closed, and preserves identity and control data",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, application_name: "jina-context-reset-test", max: 1 });
    try {
      await pool.query("drop schema if exists jina_runtime cascade");
      await pool.query("drop schema if exists jina_context cascade");
      await pool.query("drop schema if exists reset_identity cascade");

      // A fresh schema must classify every table. This makes adding a table
      // without deciding whether reset preserves or rebuilds it a test failure.
      await pool.query(CONTEXT_SCHEMA_SQL);
      const freshTables = await pool.query<{ table_name: string }>(
        `select table_name
         from information_schema.tables
         where table_schema='jina_context' and table_type='BASE TABLE'
         order by table_name`
      );
      assert.deepEqual(
        freshTables.rows.map((row) => row.table_name),
        [...REBUILDABLE_CONTEXT_TABLES, ...PRESERVED_CONTEXT_TABLES].sort()
      );
      await seedFreshSchemaControlRows(pool);
      const freshSchemaReset = await runResetCli(["--execute"], databaseUrl!, CONTEXT_RESET_CONFIRMATION);
      assert.equal(freshSchemaReset.code, 0, freshSchemaReset.stderr);
      assert.equal((JSON.parse(freshSchemaReset.stdout) as ContextResetReport).totalRows, "1");
      assert.deepEqual(
        (await pool.query<{ id: string }>("select id from jina_context.observations order by id")).rows.map(
          (row) => row.id
        ),
        ["acl-source"]
      );
      for (const table of PRESERVED_CONTEXT_TABLES) {
        assert.equal(await tableCount(pool, `jina_context.${table}`), "1", `fresh schema ${table}`);
      }

      // The reset behavior is exercised against one row in every classified
      // table. Focused table shapes keep this boundary test independent from
      // unrelated domain constraints while the assertion above pins it to the
      // real fresh schema.
      await pool.query("drop schema jina_context cascade");
      await createResetAcceptanceSchema(pool);
      await seedResetAcceptanceRows(pool);

      const before = await snapshotAcceptanceRows(pool);
      const dryRun = await runResetCli([], databaseUrl!);
      assert.equal(dryRun.code, 0, dryRun.stderr);
      const dryReport = JSON.parse(dryRun.stdout) as ContextResetReport & { readonly mode: string };
      assert.equal(dryReport.mode, "dry-run");
      assert.equal(dryReport.targets.length, EXPECTED_REBUILDABLE_ROWS);
      assert.equal(dryReport.totalRows, String(EXPECTED_REBUILDABLE_ROWS));
      assert.deepEqual(
        dryReport.targets.map((target) => [target.table, target.rows]),
        [
          ...REBUILDABLE_CONTEXT_TABLES.map((table) => [`jina_context.${table}`, "1"] as const),
          ["jina_runtime.api_state", "1"] as const
        ]
      );
      assert.deepEqual(await snapshotAcceptanceRows(pool), before);

      const refused = await runResetCli(["--execute"], databaseUrl!, "delete-all-context");
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, new RegExp(`JINA_CONFIRM_CONTEXT_RESET=${CONTEXT_RESET_CONFIRMATION}`));
      assert.deepEqual(await snapshotAcceptanceRows(pool), before);

      const executed = await runResetCli(["--execute"], databaseUrl!, CONTEXT_RESET_CONFIRMATION);
      assert.equal(executed.code, 0, executed.stderr);
      const executeReport = JSON.parse(executed.stdout) as ContextResetReport & { readonly mode: string };
      assert.equal(executeReport.mode, "execute");
      assert.equal(executeReport.totalRows, dryReport.totalRows);
      assert.deepEqual(executeReport.targets, dryReport.targets);

      for (const table of REBUILDABLE_CONTEXT_TABLES) {
        if (table === "observations") continue;
        assert.equal(await tableCount(pool, `jina_context.${table}`), "0", table);
      }
      assert.deepEqual(
        (await pool.query<{ id: string }>("select id from jina_context.observations order by id")).rows.map(
          (row) => row.id
        ),
        ["acl-source"]
      );
      assert.equal(await tableCount(pool, "jina_runtime.api_state"), "0");

      for (const table of PRESERVED_CONTEXT_TABLES) {
        assert.equal(await tableCount(pool, `jina_context.${table}`), "1", table);
      }
      for (const table of ["tenants", "installations", "repositories"]) {
        assert.equal(await tableCount(pool, `reset_identity.${table}`), "1", table);
      }
      assert.equal(await tableCount(pool, "jina_runtime.github_deliveries"), "1");
      assert.equal(await tableCount(pool, "jina_runtime.release_control"), "1");

      const emptyDryRun = await runResetCli([], databaseUrl!);
      assert.equal(emptyDryRun.code, 0, emptyDryRun.stderr);
      assert.equal((JSON.parse(emptyDryRun.stdout) as ContextResetReport).totalRows, "0");
    } finally {
      await pool.query("drop schema if exists jina_runtime cascade").catch(() => undefined);
      await pool.query("drop schema if exists jina_context cascade").catch(() => undefined);
      await pool.query("drop schema if exists reset_identity cascade").catch(() => undefined);
      await pool.end();
    }
  }
);

async function seedFreshSchemaControlRows(pool: Pool): Promise<void> {
  await pool.query(`
    insert into jina_context.repositories (
      tenant_id,repository,provider,provider_repository_id,default_ref,created_at,updated_at
    ) values (
      'tenant-reset','acme/reset','github','repository-1','main',now(),now()
    );
    insert into jina_context.observations (
      id,tenant_id,repository,source,source_type,recorded_at,payload,content_digest
    ) values
      (
        'acl-source','tenant-reset','acme/reset','github-acl','provider_snapshot',
        now(),'{}'::jsonb,repeat('a',64)
      ),
      (
        'context-source','tenant-reset','acme/reset','github-repository','provider_snapshot',
        now(),'{}'::jsonb,repeat('b',64)
      );
    insert into jina_context.repository_acl_observations (
      id,tenant_id,repository,principal_id,permission,acl_fingerprint,source_observation_id,observed_at
    ) values (
      'acl-1','tenant-reset','acme/reset','user:reset@example.com','admin',
      repeat('c',64),'acl-source',now()
    );
    insert into jina_context.erasure_filters (
      id,tenant_id,repository,source_type,source_id,reason,actor_id,created_at
    ) values (
      'erasure-1','tenant-reset','acme/reset','issue','issue-1',
      'requested deletion','user:reset@example.com',now()
    );
    insert into jina_context.audit_events (
      id,tenant_id,repository,sequence,actor_id,action,target_type,target_id,occurred_at
    ) values (
      'audit-1','tenant-reset','acme/reset',1,'user:reset@example.com',
      'context.reset.acceptance','repository','acme/reset',now()
    );
    insert into jina_context.api_tokens (
      id,tenant_id,principal_id,name,secret_hash,scopes,created_at,created_by,expires_at
    ) values (
      'atk_reset','tenant-reset','user:reset@example.com','Reset acceptance',
      repeat('d',64),array['context:admin'],now(),'user:reset@example.com',now()+interval '1 day'
    );
  `);
}

async function createResetAcceptanceSchema(pool: Pool): Promise<void> {
  await pool.query(`
    create schema jina_context;
    create schema jina_runtime;
    create schema reset_identity;

    create table jina_context.repositories (marker text not null);
    create table jina_context.observations (
      tenant_id text not null,
      repository text not null,
      id text primary key,
      marker text not null
    );
    create table jina_context.repository_acl_observations (
      tenant_id text not null,
      repository text not null,
      source_observation_id text not null references jina_context.observations(id),
      marker text not null
    );
    create table jina_context.erasure_filters (marker text not null);
    create table jina_context.audit_events (marker text not null);
    create table jina_context.api_tokens (marker text not null);

    create table jina_runtime.api_state (marker text not null);
    create table jina_runtime.github_deliveries (marker text not null);
    create table jina_runtime.release_control (marker text not null);

    create table reset_identity.tenants (marker text not null);
    create table reset_identity.installations (marker text not null);
    create table reset_identity.repositories (marker text not null);
  `);
  for (const table of REBUILDABLE_CONTEXT_TABLES) {
    if (table === "observations") continue;
    await pool.query(`create table jina_context.${table} (marker text not null)`);
  }
}

async function seedResetAcceptanceRows(pool: Pool): Promise<void> {
  await pool.query(`
    insert into jina_context.repositories values ('preserved-context-repository');
    insert into jina_context.observations values
      ('tenant-reset','acme/reset','acl-source','preserved-acl-source'),
      ('tenant-reset','acme/reset','context-source','rebuildable-observation');
    insert into jina_context.repository_acl_observations
      values ('tenant-reset','acme/reset','acl-source','preserved-acl');
    insert into jina_context.erasure_filters values ('preserved-erasure');
    insert into jina_context.audit_events values ('preserved-audit');
    insert into jina_context.api_tokens values ('preserved-token-hash');

    insert into jina_runtime.api_state values ('rebuildable-board');
    insert into jina_runtime.github_deliveries values ('preserved-delivery');
    insert into jina_runtime.release_control values ('preserved-release-control');

    insert into reset_identity.tenants values ('preserved-tenant');
    insert into reset_identity.installations values ('preserved-installation');
    insert into reset_identity.repositories values ('preserved-repository');
  `);
  for (const table of REBUILDABLE_CONTEXT_TABLES) {
    if (table === "observations") continue;
    await pool.query(`insert into jina_context.${table} values ('rebuildable-${table}')`);
  }
}

async function snapshotAcceptanceRows(pool: Pool): Promise<Readonly<Record<string, string>>> {
  const tables = [
    ...REBUILDABLE_CONTEXT_TABLES.map((table) => `jina_context.${table}`),
    ...PRESERVED_CONTEXT_TABLES.map((table) => `jina_context.${table}`),
    "jina_runtime.api_state",
    "jina_runtime.github_deliveries",
    "jina_runtime.release_control",
    "reset_identity.tenants",
    "reset_identity.installations",
    "reset_identity.repositories"
  ];
  return Object.fromEntries(
    await Promise.all(tables.map(async (table) => [table, await tableCount(pool, table)] as const))
  );
}

async function tableCount(pool: Pool, table: string): Promise<string> {
  const result = await pool.query<{ count: string }>(`select count(*)::text count from ${table}`);
  return result.rows[0]?.count ?? "missing";
}

async function runResetCli(
  args: readonly string[],
  targetDatabaseUrl: string,
  confirmation?: string,
  cli = resetCli
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const environment = {
    ...process.env,
    DATABASE_URL: "",
    TEST_DATABASE_URL: targetDatabaseUrl,
    JINA_CONFIRM_CONTEXT_RESET: confirmation ?? ""
  };
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, "--json", ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}
