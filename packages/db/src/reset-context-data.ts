import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";

export const CONTEXT_RESET_CONFIRMATION = "delete-rebuildable-context";

/**
 * Every disposable table in the fresh jina_context schema. Keep the schema
 * coverage assertion in reset-context-data.integration.test.ts in sync: a new
 * Context table must be deliberately classified before this reset can pass.
 */
export const REBUILDABLE_CONTEXT_TABLES = [
  "observations",
  "evidence_records",
  "evidence_checkpoints",
  "projection_input_events",
  "evidence_checkpoint_records",
  "evidence_checkpoint_manifest",
  "refs",
  "commits",
  "commit_parents",
  "trees",
  "blobs",
  "tree_entries",
  "commit_changes",
  "blob_analyses",
  "symbols",
  "imports",
  "structural_facts",
  "evidence_checkpoint_structural_facts",
  "entities",
  "identities",
  "derivation_runs",
  "knowledge_documents",
  "knowledge_document_revisions",
  "knowledge_revision_evidence",
  "knowledge_revision_events",
  "outbox",
  "index_generations",
  "context_board_publications",
  "current_context_board_releases",
  "issue_graph_releases",
  "current_issue_graph_releases",
  "generation_projectors",
  "projection_checkpoints",
  "ref_manifest",
  "current_knowledge_revisions",
  "context_documents",
  "context_fragments",
  "exact_index",
  "context_embeddings",
  "hierarchy_nodes",
  "structural_relations",
  "identity_projection",
  "repository_acl_projection",
  "query_runs",
  "retrieval_candidates",
  "answer_citations",
  "retrieval_metrics",
  "context_phase_checkpoints",
  "context_quota_ledgers"
] as const;

export const PRESERVED_CONTEXT_TABLES = [
  "repositories",
  "repository_acl_observations",
  "erasure_filters",
  "audit_events",
  "api_tokens"
] as const;

const BOARD_STATE_TABLE = "jina_runtime.api_state";

export interface ContextResetTargetCount {
  readonly table: string;
  readonly rows: string;
}

export interface ContextResetReport {
  readonly targets: readonly ContextResetTargetCount[];
  readonly totalRows: string;
}

interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
}

/**
 * Returns exact deletable-row counts without mutating the database. ACL source
 * observations are intentionally excluded: the canonical ACL observation has
 * a foreign key to that source row and both are part of the preserved control
 * plane.
 */
export async function inspectContextDataReset(database: Queryable): Promise<ContextResetReport> {
  const targets: ContextResetTargetCount[] = [];
  for (const table of REBUILDABLE_CONTEXT_TABLES) {
    const qualified = `jina_context.${table}`;
    await requireTable(database, qualified);
    const result =
      table === "observations"
        ? await database.query<{ rows: string }>(
            `select count(*)::text rows
             from jina_context.observations observation
             where not exists (
               select 1
               from jina_context.repository_acl_observations acl
               where acl.tenant_id=observation.tenant_id
                 and acl.repository=observation.repository
                 and acl.source_observation_id=observation.id
             )`
          )
        : await database.query<{ rows: string }>(`select count(*)::text rows from ${qualified}`);
    targets.push({ table: qualified, rows: requiredCount(result.rows[0]?.rows, qualified) });
  }
  if (await tableExists(database, BOARD_STATE_TABLE)) {
    const result = await database.query<{ rows: string }>(`select count(*)::text rows from ${BOARD_STATE_TABLE}`);
    targets.push({
      table: BOARD_STATE_TABLE,
      rows: requiredCount(result.rows[0]?.rows, BOARD_STATE_TABLE)
    });
  }
  return {
    targets,
    totalRows: targets.reduce((total, target) => total + BigInt(target.rows), 0n).toString()
  };
}

/**
 * Deletes only the inspected rebuildable corpus in one transaction. The exact
 * confirmation is checked before any database query so an operator typo fails
 * closed even when pointed at an unavailable database.
 */
export async function executeContextDataReset(
  pool: Pool,
  confirmation: string | undefined
): Promise<ContextResetReport> {
  if (confirmation !== CONTEXT_RESET_CONFIRMATION) {
    throw new Error(`JINA_CONFIRM_CONTEXT_RESET=${CONTEXT_RESET_CONFIRMATION} is required with --execute`);
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('jina-context-reset'))");
    const report = await inspectContextDataReset(client);
    await preserveAclControlRows(client);
    await truncateContextTables(client);
    await restoreAclControlRows(client);
    if (report.targets.some((target) => target.table === BOARD_STATE_TABLE)) {
      await client.query(`truncate ${BOARD_STATE_TABLE}`);
    }
    await client.query("commit");
    return report;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function truncateContextTables(client: PoolClient): Promise<void> {
  await client.query(
    `truncate ${REBUILDABLE_CONTEXT_TABLES.map((table) => `jina_context.${table}`).join(",")} restart identity cascade`
  );
}

/**
 * observations is append-only, so DELETE is intentionally blocked by its
 * immutable-row trigger. TRUNCATE bypasses row triggers but cascades to the ACL
 * observations that reference their source. Preserve that small control-plane
 * slice transactionally, truncate the corpus, then restore it unchanged.
 */
async function preserveAclControlRows(client: PoolClient): Promise<void> {
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
}

async function restoreAclControlRows(client: PoolClient): Promise<void> {
  await client.query(`
    insert into jina_context.observations
      select * from context_reset_acl_sources;
    insert into jina_context.repository_acl_observations
      select * from context_reset_acl_observations;
  `);
}

async function tableExists(database: Queryable, qualified: string): Promise<boolean> {
  const result = await database.query<{ relation: string | null }>("select to_regclass($1)::text relation", [
    qualified
  ]);
  return result.rows[0]?.relation != null;
}

async function requireTable(database: Queryable, qualified: string): Promise<void> {
  if (!(await tableExists(database, qualified))) {
    throw new Error(`Context reset target ${qualified} does not exist; refusing a partial reset`);
  }
}

function requiredCount(value: string | undefined, table: string): string {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Context reset count for ${table} was not a non-negative integer`);
  }
  return value;
}

function poolConfig(environment: NodeJS.ProcessEnv): PoolConfig | undefined {
  const connectionString = nonEmpty(environment.DATABASE_URL) ?? nonEmpty(environment.TEST_DATABASE_URL);
  if (connectionString) return { connectionString };
  const host = nonEmpty(environment.INSTANCE_UNIX_SOCKET) ?? nonEmpty(environment.DB_HOST);
  if (!host) return undefined;
  return {
    host,
    user: requiredEnv(environment, "DB_USER"),
    password: requiredEnv(environment, "DB_PASS"),
    database: requiredEnv(environment, "DB_NAME"),
    ...(nonEmpty(environment.DB_PORT) ? { port: Number(environment.DB_PORT) } : {})
  };
}

function requiredEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = nonEmpty(environment[name]);
  if (!value) throw new Error(`${name} is required when DATABASE_URL is not set`);
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const json = process.argv.includes("--json");
  if (execute && process.env.JINA_CONFIRM_CONTEXT_RESET !== CONTEXT_RESET_CONFIRMATION) {
    throw new Error(`JINA_CONFIRM_CONTEXT_RESET=${CONTEXT_RESET_CONFIRMATION} is required with --execute`);
  }
  const config = poolConfig(process.env);
  if (!config) {
    if (execute) {
      throw new Error("DATABASE_URL, TEST_DATABASE_URL, INSTANCE_UNIX_SOCKET, or DB_HOST is required with --execute");
    }
    printStaticDryRun();
    return;
  }

  const pool = new Pool({ ...config, application_name: "jina-context-reset", max: 1 });
  try {
    const report = execute
      ? await executeContextDataReset(pool, process.env.JINA_CONFIRM_CONTEXT_RESET)
      : await inspectContextDataReset(pool);
    if (json) {
      console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", ...report }));
    } else {
      printReport(report, execute);
    }
  } finally {
    await pool.end();
  }
}

function printStaticDryRun(): void {
  console.log("Dry run. Rebuildable Context data that would be deleted:");
  for (const table of REBUILDABLE_CONTEXT_TABLES) console.log(`- jina_context.${table}`);
  console.log(`- ${BOARD_STATE_TABLE} (when present)`);
  printPreserved();
  console.log(`Run with --execute and JINA_CONFIRM_CONTEXT_RESET=${CONTEXT_RESET_CONFIRMATION} to apply.`);
}

function printReport(report: ContextResetReport, execute: boolean): void {
  console.log(
    execute ? "Deleted rebuildable Context data:" : "Dry run. Exact rebuildable Context rows that would be deleted:"
  );
  for (const target of report.targets) {
    console.log(`- ${target.table}: ${target.rows}`);
  }
  console.log(`Total rebuildable rows: ${report.totalRows}`);
  printPreserved();
  if (!execute) {
    console.log(`Run with --execute and JINA_CONFIRM_CONTEXT_RESET=${CONTEXT_RESET_CONFIRMATION} to apply.`);
  }
}

function printPreserved(): void {
  console.log(
    "Preserved: tenant/installation/repository registrations, ACL observations and their source observations, " +
      "API token hashes, erasure filters, audit events, and GitHub delivery identity."
  );
}

const entrypoint = process.argv[1] ? await realpath(resolve(process.argv[1])) : undefined;
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  await main();
}
