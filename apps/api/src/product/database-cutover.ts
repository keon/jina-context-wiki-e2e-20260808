import { databaseCutoverPhase, databaseRole, quoteRole } from "./database-cutover-lib.js";
import { getPool } from "./db.js";

const phase = databaseCutoverPhase(process.env.JINA_DATABASE_CUTOVER_PHASE);
const runtimeRole = databaseRole(process.env.JINA_PRODUCT_RUNTIME_DB_ROLE, "JINA_PRODUCT_RUNTIME_DB_ROLE");
const legacyRole = databaseRole(process.env.JINA_PRODUCT_LEGACY_DB_ROLE, "JINA_PRODUCT_LEGACY_DB_ROLE");
const pool = getPool();
const client = await pool.connect();

try {
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtext('jina_product.database_v2_cutover'))");

  const currentUser = databaseRole(
    (await client.query<{ current_user: string }>("select current_user")).rows[0]?.current_user,
    "current_user",
  );
  await assertRoleExists(client, runtimeRole);
  const legacyExists = await roleExists(client, legacyRole);

  if (phase === "prepare") {
    if (!legacyExists) throw new Error(`Legacy role ${legacyRole} does not exist`);
    const unsafeOwnership = await client.query<{ identity: string }>(
      `select pg_describe_object(classid, objid, objsubid) as identity
       from pg_shdepend
       where refobjid=(select oid from pg_roles where rolname=$1)
         and deptype='o'
         and not (
           (classid='pg_class'::regclass and objid in (
             select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname='public'
           )) or
           (classid='pg_proc'::regclass and objid in (
             select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public'
           )) or
           (classid='pg_extension'::regclass and objid in (
             select e.oid from pg_extension e where e.extname='uuid-ossp'
           ))
         )`,
      [legacyRole],
    );
    if (unsafeOwnership.rows.length > 0) {
      throw new Error(
        `Legacy role owns objects outside the product schema: ${unsafeOwnership.rows
          .map((row) => row.identity)
          .join(", ")}`,
      );
    }

    await client.query(`reassign owned by ${quoteRole(legacyRole)} to ${quoteRole(currentUser)}`);
    await grantProductRuntime(client, runtimeRole, currentUser);
    // Keep the old revision healthy until Cloud Run traffic has moved to the v2 role.
    await grantProductRuntime(client, legacyRole, currentUser, false);
  }

  if (phase === "finalize") {
    await grantProductRuntime(client, runtimeRole, currentUser);
    if (legacyExists) {
      await client.query(`revoke all privileges on all tables in schema public from ${quoteRole(legacyRole)}`);
      await client.query(`revoke all privileges on all sequences in schema public from ${quoteRole(legacyRole)}`);
      await client.query(`revoke all privileges on schema public from ${quoteRole(legacyRole)}`);
      await client.query(`drop owned by ${quoteRole(legacyRole)}`);
      await client.query(`alter role ${quoteRole(legacyRole)} nologin`);
    }
  }

  const audit = await auditCutover(client, runtimeRole, legacyRole);
  if (audit.legacyOwnedObjects !== 0 || audit.runtimeTablesMissingDml !== 0) {
    throw new Error(`Database cutover verification failed: ${JSON.stringify(audit)}`);
  }
  if ((phase === "finalize" || phase === "verify") && audit.legacyTablePrivileges !== 0) {
    throw new Error(`Legacy database privileges remain: ${JSON.stringify(audit)}`);
  }

  await client.query("commit");
  console.log(JSON.stringify({ phase, database: "v2-shared", ...audit }));
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}

type QueryClient = Pick<import("pg").PoolClient, "query">;

async function roleExists(client: QueryClient, role: string): Promise<boolean> {
  return Boolean((await client.query("select 1 from pg_roles where rolname=$1", [role])).rowCount);
}

async function assertRoleExists(client: QueryClient, role: string): Promise<void> {
  if (!(await roleExists(client, role))) throw new Error(`Runtime role ${role} does not exist`);
}

async function grantProductRuntime(
  client: QueryClient,
  role: string,
  owner: string,
  includeDefaults = true,
): Promise<void> {
  const quotedRole = quoteRole(role);
  await client.query(`grant usage on schema public to ${quotedRole}`);
  await client.query(`grant select, insert, update, delete on all tables in schema public to ${quotedRole}`);
  await client.query(`grant usage, select, update on all sequences in schema public to ${quotedRole}`);
  if (includeDefaults) {
    await client.query(
      `alter default privileges for role ${quoteRole(owner)} in schema public ` +
        `grant select, insert, update, delete on tables to ${quotedRole}`,
    );
    await client.query(
      `alter default privileges for role ${quoteRole(owner)} in schema public ` +
        `grant usage, select, update on sequences to ${quotedRole}`,
    );
  }
}

async function auditCutover(client: QueryClient, runtimeRole: string, legacyRole: string) {
  const legacyOwnedObjects = Number(
    (
      await client.query<{ count: string }>(
        `select count(*)::text as count
         from pg_class c join pg_roles r on r.oid=c.relowner
         where r.rolname=$1`,
        [legacyRole],
      )
    ).rows[0]?.count ?? 0,
  );
  const legacyTablePrivileges = Number(
    (
      await client.query<{ count: string }>(
        `select count(*)::text as count from information_schema.role_table_grants
         where grantee=$1 and table_schema='public'`,
        [legacyRole],
      )
    ).rows[0]?.count ?? 0,
  );
  const runtimeTablesMissingDml = Number(
    (
      await client.query<{ count: string }>(
        `select count(*)::text as count
         from pg_tables
         where schemaname='public' and not (
           has_table_privilege($1, format('%I.%I', schemaname, tablename), 'SELECT') and
           has_table_privilege($1, format('%I.%I', schemaname, tablename), 'INSERT') and
           has_table_privilege($1, format('%I.%I', schemaname, tablename), 'UPDATE') and
           has_table_privilege($1, format('%I.%I', schemaname, tablename), 'DELETE')
         )`,
        [runtimeRole],
      )
    ).rows[0]?.count ?? 0,
  );
  return {
    legacyRoleExists: await roleExists(client, legacyRole),
    legacyOwnedObjects,
    legacyTablePrivileges,
    runtimeTablesMissingDml,
  };
}
