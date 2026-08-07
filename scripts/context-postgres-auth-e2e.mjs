#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL = "user:postgres-auth@jina.internal";
const OTHER_PRINCIPAL = "user:postgres-auth-other@jina.internal";
const INTERNAL_PRINCIPAL = "svc:context-auth-acceptance";
const REPOSITORY = "acme/private-context";
const FORBIDDEN_REPOSITORY = "acme/forbidden-context";
const NONEXISTENT_REPOSITORY = "acme/repository-that-does-not-exist";
const EXACT_MCP_TOOLS = ["search_context", "list_context", "read_context", "diff_context"];
const DEFAULT_REPORT = "/tmp/jina-context-postgres-auth-e2e.json";
const PROCESS_OUTPUT_LIMIT = 64 * 1024;

const HELP = `Usage: context-postgres-auth-e2e.mjs [--report PATH]

Build @jina/api and @jina/db first. The harness then:
  - starts its own disposable PostgreSQL 17 container on a random loopback port;
  - installs the production schema, capability roles, and an ordinary NOINHERIT runtime login;
  - starts two separate API processes against that shared database;
  - mints on instance A and authenticates HTTP plus real MCP SDK traffic on instance B;
  - proves repository ACL, cross-tenant, unknown-object, revocation, and database-time expiry behavior;
  - removes both API processes, the temporary files, and only its exact container.

It never reads, restarts, or modifies the retained /tmp/jina-dev stack.
Default report: ${DEFAULT_REPORT}
`;

export async function runPostgresAuthAcceptance(options = {}) {
  const reportPath = resolve(options.reportPath ?? DEFAULT_REPORT);
  const startedAt = new Date().toISOString();
  const nonce = `${process.pid}-${randomBytes(5).toString("hex")}`;
  const container = `jina-context-auth-${nonce}`;
  const database = "jina_auth_e2e";
  const migrationUser = "jina_auth_migration";
  const runtimeUser = "jina_auth_runtime";
  const postgresPassword = randomBytes(24).toString("hex");
  const migrationPassword = randomBytes(24).toString("hex");
  const runtimePassword = randomBytes(24).toString("hex");
  const internalToken = randomBytes(32).toString("hex");
  const staticContextToken = randomBytes(32).toString("hex");
  const secrets = [postgresPassword, migrationPassword, runtimePassword, internalToken, staticContextToken];
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "jina-context-postgres-auth-"));
  const artifactDirectory = join(temporaryDirectory, "artifacts");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });

  let apiA;
  let apiB;
  let containerStarted = false;
  let phase = "preflight";
  let report;
  let cleanup;
  try {
    await requireCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
    await requireCommand("psql", ["--version"]);

    phase = "allocate_ports";
    const [postgresPort, apiAPort, apiBPort] = await distinctLoopbackPorts(3);
    const postgresAdmin = postgresConnection({
      port: postgresPort,
      database,
      user: "postgres",
      password: postgresPassword
    });
    const migration = postgresConnection({
      port: postgresPort,
      database,
      user: migrationUser,
      password: migrationPassword
    });
    const runtime = postgresConnection({
      port: postgresPort,
      database,
      user: runtimeUser,
      password: runtimePassword
    });

    phase = "start_postgres";
    await runCommand("docker", [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "com.jina.context-auth-acceptance=true",
      "-e",
      `POSTGRES_PASSWORD=${postgresPassword}`,
      "-e",
      `POSTGRES_DB=${database}`,
      "-p",
      `127.0.0.1:${postgresPort}:5432`,
      "postgres:17-alpine"
    ]);
    containerStarted = true;
    await waitForPostgres(postgresAdmin);

    phase = "create_database_roles";
    await psql(
      postgresAdmin,
      `
create role :"migration_user" login password :'migration_password' createrole;
create role :"runtime_user" login password :'runtime_password' noinherit;
grant :"runtime_user" to :"migration_user" with admin option;
grant create,usage on schema public to :"migration_user";
alter database :"database_name" owner to :"migration_user";
`,
      {
        migration_user: migrationUser,
        migration_password: migrationPassword,
        runtime_user: runtimeUser,
        runtime_password: runtimePassword,
        database_name: database
      }
    );

    phase = "create_shared_identity_schema";
    await psql(
      migration,
      `
create table public.tenants (
  id uuid primary key,
  name text,
  kind text,
  github_account_login text,
  github_account_type text,
  merged_into_tenant_id uuid
);
create table public.installations (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  github_installation_id bigint not null,
  github_account_id bigint not null,
  github_account_login text not null,
  github_account_type text not null,
  suspended_at timestamptz,
  deleted_at timestamptz
);
create table public.repositories (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  installation_id uuid not null references public.installations(id),
  github_repo_id bigint not null,
  owner text not null,
  name text not null,
  default_branch text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id),
  github_user_id bigint not null,
  github_login text,
  role text not null,
  synced_at timestamptz not null
);
insert into public.tenants
  (id,name,kind,github_account_login,github_account_type)
values
  (:'tenant_a','Context auth tenant','team','acme','Organization'),
  (:'tenant_b','Other context auth tenant','team','other-acme','Organization');
insert into public.installations
  (id,tenant_id,github_installation_id,github_account_id,github_account_login,github_account_type)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',:'tenant_a',1001,2001,'acme','Organization'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',:'tenant_b',1002,2002,'other-acme','Organization');
insert into public.repositories
  (id,tenant_id,installation_id,github_repo_id,owner,name,default_branch)
values
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    :'tenant_a',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    3001,
    'acme',
    'private-context',
    'main'
  );
insert into public.tenant_members
  (tenant_id,github_user_id,github_login,role,synced_at)
values
  (:'tenant_a',4001,'postgres-auth','member',clock_timestamp()),
  (:'tenant_b',4002,'postgres-auth-other','member',clock_timestamp());

create schema jina_runtime authorization :"migration_user";
create table jina_runtime.api_state (
  id smallint primary key check (id=1),
  snapshot jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
create table jina_runtime.github_deliveries (
  delivery_id text primary key,
  received_at timestamptz not null default now()
);
grant usage on schema public,jina_runtime to :"runtime_user";
grant select on
  public.tenants,public.tenant_members,public.installations,public.repositories
to :"runtime_user";
grant select,insert,update on jina_runtime.api_state to :"runtime_user";
grant select,insert on jina_runtime.github_deliveries to :"runtime_user";
`,
      {
        migration_user: migrationUser,
        runtime_user: runtimeUser,
        tenant_a: TENANT,
        tenant_b: OTHER_TENANT
      }
    );

    phase = "migrate_context_schema";
    await runCommand(process.execPath, [join(ROOT, "packages/db/dist/migrate.js"), "--install-roles"], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: migration.url,
        CONTEXT_RUNTIME_DB_USER: runtimeUser
      }
    });

    phase = "verify_runtime_role";
    const roleBoundary = await verifyRuntimeRoleBoundary(postgresAdmin, runtime, runtimeUser);
    const commonApiEnvironment = {
      ...process.env,
      DATABASE_URL: runtime.url,
      INTERNAL_API_TOKEN: internalToken,
      CONTEXT_API_TOKEN: staticContextToken,
      JINA_TENANCY_MODE: "shared-db",
      JINA_ENABLE_DEV_ENDPOINTS: "true",
      JINA_TRUST_DEV_IDENTITY_HEADERS: "false",
      JINA_SIMULATE_RUNS: "false",
      JINA_DB_MANAGE_SCHEMA: "false",
      JINA_DB_MANAGE_ROLES: "false",
      JINA_CONTEXT_TENANT_ID: TENANT,
      JINA_CONTEXT_PRINCIPAL_ID: PRINCIPAL,
      JINA_INTERNAL_PRINCIPAL_ID: INTERNAL_PRINCIPAL,
      JINA_TENANT_ADMIN_PRINCIPALS: "",
      JINA_TENANT_ALIASES: "",
      CONTEXT_ARTIFACT_DIRECTORY: artifactDirectory
    };
    delete commonApiEnvironment.JINA_TENANT_ID;
    delete commonApiEnvironment.K_SERVICE;
    delete commonApiEnvironment.CONTEXT_GCS_BUCKET;

    phase = "start_api_instances";
    apiA = startApi("A", apiAPort, commonApiEnvironment);
    apiB = startApi("B", apiBPort, commonApiEnvironment);
    const apiAUrl = `http://127.0.0.1:${apiAPort}`;
    const apiBUrl = `http://127.0.0.1:${apiBPort}`;
    const [healthA, healthB] = await Promise.all([waitForApi(apiAUrl, apiA), waitForApi(apiBUrl, apiB)]);
    assert.equal(healthA.body.ok, true);
    assert.equal(healthA.body.storage, "postgres");
    assert.equal(healthB.body.ok, true);
    assert.equal(healthB.body.storage, "postgres");
    assert.notEqual(apiA.process.pid, apiB.process.pid);

    phase = "synchronize_repository_acl";
    const access = await jsonRequest(apiAUrl, "/internal/context/access/sync", {
      method: "POST",
      token: internalToken,
      tenantId: TENANT,
      principalId: PRINCIPAL,
      body: { repositories: [REPOSITORY], mode: "replace" }
    });
    assert.equal(access.status, 200, diagnostic("repository access sync", access));
    assert.equal(access.body.repositoryCount, 1);

    phase = "mint_primary_token";
    const issued = await mintToken(apiAUrl, internalToken, TENANT, PRINCIPAL, "cross-instance read token");
    secrets.push(issued.secret);
    const allowedHttp = await jsonRequest(apiBUrl, `/wiki/releases?repository=${encodeURIComponent(REPOSITORY)}`, {
      token: issued.secret
    });
    assert.equal(allowedHttp.status, 200, diagnostic("instance B HTTP authentication", allowedHttp));
    assert.deepEqual(allowedHttp.body, { releases: [] });

    phase = "use_primary_token_over_mcp";
    const validMcp = await useMcpOnAllowedRepository(apiBUrl, issued.secret);
    assert.deepEqual(validMcp.tools, EXACT_MCP_TOOLS);
    assert.equal(validMcp.listAdmitted, true);

    phase = "verify_repository_oracles";
    const forbiddenHttp = await jsonRequest(
      apiBUrl,
      `/wiki/releases?repository=${encodeURIComponent(FORBIDDEN_REPOSITORY)}`,
      { token: issued.secret }
    );
    const nonexistentHttp = await jsonRequest(
      apiBUrl,
      `/wiki/releases?repository=${encodeURIComponent(NONEXISTENT_REPOSITORY)}`,
      { token: issued.secret }
    );
    assert.equal(forbiddenHttp.status, 404);
    assert.equal(nonexistentHttp.status, forbiddenHttp.status);
    assert.deepEqual(nonexistentHttp.body, forbiddenHttp.body);
    assert.deepEqual(forbiddenHttp.body, {
      accepted: false,
      code: "not_found",
      error: "repository context not found"
    });

    const forbiddenMcp = await callMcpList(apiBUrl, issued.secret, FORBIDDEN_REPOSITORY);
    const nonexistentMcp = await callMcpList(apiBUrl, issued.secret, NONEXISTENT_REPOSITORY);
    assert.deepEqual(nonexistentMcp, forbiddenMcp);
    assert.equal(forbiddenMcp.isError, true);
    assert.match(JSON.stringify(forbiddenMcp), /repository context not found/i);

    phase = "verify_cross_tenant_oracles";
    const unknownSecret = issuedTokenSecret();
    secrets.push(unknownSecret);
    const crossTenantHttp = await jsonRequest(apiBUrl, "/wiki/releases", {
      token: issued.secret,
      tenantId: OTHER_TENANT
    });
    const unknownHttp = await jsonRequest(apiBUrl, "/wiki/releases", {
      token: unknownSecret,
      tenantId: OTHER_TENANT
    });
    assert.equal(crossTenantHttp.status, 401);
    assert.equal(unknownHttp.status, crossTenantHttp.status);
    assert.deepEqual(unknownHttp.body, crossTenantHttp.body);
    assert.deepEqual(crossTenantHttp.body, { error: "unauthorized" });

    const crossTenantMcp = await rawMcpList(apiBUrl, issued.secret, OTHER_TENANT);
    const unknownMcp = await rawMcpList(apiBUrl, unknownSecret, OTHER_TENANT);
    assert.equal(crossTenantMcp.status, 401);
    assert.equal(unknownMcp.status, crossTenantMcp.status);
    assert.deepEqual(unknownMcp.body, crossTenantMcp.body);

    phase = "verify_revoke_oracle";
    const wrongTenantRevoke = await revokeToken(apiAUrl, internalToken, OTHER_TENANT, issued.id);
    const wrongTenantUnknownRevoke = await revokeToken(apiAUrl, internalToken, OTHER_TENANT, "atk_not_present");
    assert.equal(wrongTenantRevoke.status, 404);
    assert.equal(wrongTenantUnknownRevoke.status, wrongTenantRevoke.status);
    assert.deepEqual(wrongTenantUnknownRevoke.body, wrongTenantRevoke.body);

    phase = "verify_row_bound_tenant";
    const otherTenantIssued = await mintToken(
      apiAUrl,
      internalToken,
      OTHER_TENANT,
      OTHER_PRINCIPAL,
      "other tenant read token"
    );
    secrets.push(otherTenantIssued.secret);
    const otherTenantTarget = await jsonRequest(
      apiBUrl,
      `/wiki/releases?repository=${encodeURIComponent(REPOSITORY)}`,
      { token: otherTenantIssued.secret }
    );
    const otherTenantUnknown = await jsonRequest(
      apiBUrl,
      `/wiki/releases?repository=${encodeURIComponent(NONEXISTENT_REPOSITORY)}`,
      { token: otherTenantIssued.secret }
    );
    assert.equal(otherTenantTarget.status, 404);
    assert.equal(otherTenantUnknown.status, otherTenantTarget.status);
    assert.deepEqual(otherTenantUnknown.body, otherTenantTarget.body);

    phase = "verify_cross_instance_revocation";
    const revoked = await revokeToken(apiAUrl, internalToken, TENANT, issued.id);
    assert.equal(revoked.status, 200, diagnostic("instance A revocation", revoked));
    assert.equal(typeof revoked.body.token?.revokedAt, "string");
    assert.equal("secret" in revoked.body.token, false);
    assert.equal("secretHash" in revoked.body.token, false);
    const revokedHttp = await jsonRequest(apiBUrl, `/wiki/releases?repository=${encodeURIComponent(REPOSITORY)}`, {
      token: issued.secret
    });
    const revokedMcp = await rawMcpList(apiBUrl, issued.secret);
    assert.equal(revokedHttp.status, 401);
    assert.deepEqual(revokedHttp.body, { error: "unauthorized" });
    assert.equal(revokedMcp.status, 401);
    assert.deepEqual(revokedMcp.body, revokedHttp.body);

    phase = "verify_database_time_expiry";
    const expiring = await mintToken(apiAUrl, internalToken, TENANT, PRINCIPAL, "database-time expiry token");
    secrets.push(expiring.secret);
    const beforeExpiryHttp = await jsonRequest(apiBUrl, `/wiki/releases?repository=${encodeURIComponent(REPOSITORY)}`, {
      token: expiring.secret
    });
    assert.equal(beforeExpiryHttp.status, 200, diagnostic("pre-expiry instance B request", beforeExpiryHttp));
    const beforeExpiryMcp = await rawMcpList(apiBUrl, expiring.secret);
    assert.equal(beforeExpiryMcp.status, 200, diagnostic("pre-expiry MCP request", beforeExpiryMcp));

    const databaseExpiry = await expireTokenUsingDatabaseTime(migration, TENANT, expiring.id);
    assert.equal(databaseExpiry.expiredByDatabaseTime, true);
    const expiredHttp = await jsonRequest(apiBUrl, `/wiki/releases?repository=${encodeURIComponent(REPOSITORY)}`, {
      token: expiring.secret
    });
    const expiredMcp = await rawMcpList(apiBUrl, expiring.secret);
    assert.equal(expiredHttp.status, 401);
    assert.deepEqual(expiredHttp.body, { error: "unauthorized" });
    assert.equal(expiredMcp.status, 401);
    assert.deepEqual(expiredMcp.body, expiredHttp.body);

    report = {
      schemaVersion: "context-postgres-auth-e2e-v1",
      status: "passed",
      startedAt,
      finishedAt: new Date().toISOString(),
      isolation: {
        disposablePostgres: true,
        postgresMajor: 17,
        loopbackOnly: true,
        retainedStackTouched: false,
        cleanupRequired: true
      },
      topology: {
        sharedDatabase: true,
        apiInstances: 2,
        distinctProcesses: true,
        sharedDbTenancyMode: true,
        developmentIdentityHeadersTrusted: false,
        productionBearerVerificationPath: true
      },
      databaseBoundary: roleBoundary,
      issuedCredential: {
        mintedThroughInstanceA: true,
        usedThroughInstanceB: {
          http: allowedHttp.status,
          mcpSdk: validMcp.listAdmitted,
          tools: validMcp.tools
        },
        repositoryAcl: {
          allowed: allowedHttp.status,
          forbidden: forbiddenHttp.status,
          nonexistent: nonexistentHttp.status,
          httpOracleEquivalent: true,
          mcpOracleEquivalent: true
        },
        crossTenant: {
          assertedTenantMismatch: crossTenantHttp.status,
          unknownCredential: unknownHttp.status,
          httpOracleEquivalent: true,
          mcpOracleEquivalent: true,
          wrongTenantRevoke: wrongTenantRevoke.status,
          unknownTokenRevoke: wrongTenantUnknownRevoke.status,
          revokeOracleEquivalent: true,
          rowBoundTenantDeniedRepository: otherTenantTarget.status
        },
        revocation: {
          revokedThroughInstanceA: revoked.status,
          instanceBHttpAfterRevoke: revokedHttp.status,
          instanceBMcpAfterRevoke: revokedMcp.status,
          immediate: true
        },
        expiry: {
          simulatedByDatabaseTime: databaseExpiry.expiredByDatabaseTime,
          instanceBHttpBeforeExpiry: beforeExpiryHttp.status,
          instanceBMcpBeforeExpiry: beforeExpiryMcp.status,
          instanceBHttpAfterExpiry: expiredHttp.status,
          instanceBMcpAfterExpiry: expiredMcp.status
        }
      },
      secretInspection: {
        plaintextTokenRetained: false,
        tokenHashRetained: false,
        reportContainsIssuedTokenPrefix: false
      }
    };
  } catch (error) {
    report = {
      schemaVersion: "context-postgres-auth-e2e-v1",
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      failure: { phase, ...sanitizeFailure(error, secrets) },
      isolation: {
        disposablePostgres: true,
        retainedStackTouched: false,
        cleanupRequired: true
      }
    };
  } finally {
    const [apiAStopped, apiBStopped] = await Promise.all([stopApi(apiA), stopApi(apiB)]);
    let disposablePostgresRemoved = !containerStarted;
    if (containerStarted) {
      const removed = await runCommand("docker", ["rm", "-f", container], { allowFailure: true });
      const absent = await runCommand("docker", ["inspect", container], { allowFailure: true });
      disposablePostgresRemoved = removed.code === 0 && absent.code !== 0;
    }
    const temporaryFilesRemoved = await rm(temporaryDirectory, { recursive: true, force: true }).then(
      () => true,
      () => false
    );
    cleanup = {
      apiProcessesStopped: apiAStopped && apiBStopped,
      disposablePostgresRemoved,
      temporaryFilesRemoved,
      finishedAt: new Date().toISOString()
    };
    if (!cleanup.apiProcessesStopped || !cleanup.disposablePostgresRemoved || !cleanup.temporaryFilesRemoved) {
      report = {
        ...report,
        status: "failed",
        failure: report.failure ?? {
          phase: "cleanup",
          code: "cleanup_failed",
          message: "one or more isolated acceptance resources could not be removed"
        }
      };
    }
  }

  report = {
    ...report,
    cleanup
  };
  await writeSafeReport(reportPath, report, secrets);
  return { report, reportPath };
}

async function verifyRuntimeRoleBoundary(admin, runtime, runtimeUser) {
  const attributes = await psqlQuery(
    admin,
    `select concat_ws(
       ',',
       rolsuper::text,
       rolbypassrls::text,
       rolreplication::text,
       rolcreatedb::text,
       rolcreaterole::text,
       rolinherit::text
     )
     from pg_roles
     where rolname=:'runtime_user'`,
    { runtime_user: runtimeUser }
  );
  assert.equal(attributes, "false,false,false,false,false,false");
  const adminMembership = await psqlQuery(
    admin,
    `select count(*)::text
     from pg_auth_members membership
     join pg_roles granted on granted.oid=membership.roleid
     join pg_roles member on member.oid=membership.member
     where member.rolname=:'runtime_user'
       and granted.rolname='jina_context_admin'`,
    { runtime_user: runtimeUser }
  );
  assert.equal(adminMembership, "0");
  const inheritingCapabilities = await psqlQuery(
    admin,
    `select count(*)::text
     from pg_auth_members membership
     join pg_roles granted on granted.oid=membership.roleid
     join pg_roles member on member.oid=membership.member
     where member.rolname=:'runtime_user'
       and granted.rolname like 'jina_context_%'
       and membership.inherit_option`,
    { runtime_user: runtimeUser }
  );
  assert.equal(inheritingCapabilities, "0");
  const directRead = await psqlResult(runtime, "select count(*) from jina_context.api_tokens");
  assert.notEqual(directRead.code, 0, "runtime login unexpectedly read api_tokens without activating a capability");
  assert.match(directRead.stderr, /permission denied/i);
  return {
    ordinaryRuntimeLogin: true,
    noInherit: true,
    noSuperuser: true,
    noBypassRls: true,
    noContextAdminMembership: true,
    noInheritedContextCapabilities: true,
    ambientTokenTableReadDenied: true
  };
}

async function expireTokenUsingDatabaseTime(connection, tenantId, tokenId) {
  const result = await psqlQuery(
    connection,
    `update jina_context.api_tokens
       set created_at=clock_timestamp()-interval '10 minutes',
           expires_at=clock_timestamp()-interval '1 second'
     where tenant_id=:'tenant_id' and id=:'token_id'
     returning (expires_at <= now())::text`,
    { tenant_id: tenantId, token_id: tokenId }
  );
  return { expiredByDatabaseTime: result === "true" || result === "t" };
}

async function mintToken(apiUrl, internalToken, tenantId, principalId, name) {
  const response = await jsonRequest(apiUrl, "/internal/context/tokens", {
    method: "POST",
    token: internalToken,
    tenantId,
    principalId: INTERNAL_PRINCIPAL,
    body: {
      principalId,
      name,
      scopes: ["context:read", "context:query"],
      expiresInMinutes: 5
    }
  });
  assert.equal(response.status, 201, diagnostic(`mint ${name}`, response));
  assert.match(response.body.secret, /^jina_atk_[A-Za-z0-9_-]{43}$/);
  assert.equal(typeof response.body.token?.id, "string");
  assert.equal("secret" in response.body.token, false);
  assert.equal("secretHash" in response.body.token, false);
  return {
    id: response.body.token.id,
    secret: response.body.secret
  };
}

function revokeToken(apiUrl, internalToken, tenantId, tokenId) {
  return jsonRequest(apiUrl, `/internal/context/tokens/${encodeURIComponent(tokenId)}/revoke`, {
    method: "POST",
    token: internalToken,
    tenantId,
    principalId: INTERNAL_PRINCIPAL
  });
}

async function useMcpOnAllowedRepository(apiUrl, secret) {
  const client = new Client({ name: "jina-postgres-auth-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", apiUrl), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
    fetch: (url, init = {}) =>
      fetch(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
      })
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => tool.name);
    const result = await client.callTool({
      name: "list_context",
      arguments: { repository: REPOSITORY }
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /context not found/i);
    assert.doesNotMatch(JSON.stringify(result), /scope does not permit|repository context not found/i);
    return { tools, listAdmitted: true };
  } finally {
    await client.close();
  }
}

async function callMcpList(apiUrl, secret, repository) {
  const client = new Client({ name: "jina-postgres-auth-oracle-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", apiUrl), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } }
  });
  try {
    await client.connect(transport);
    return await client.callTool({
      name: "list_context",
      arguments: { repository }
    });
  } finally {
    await client.close();
  }
}

function rawMcpList(apiUrl, token, tenantId) {
  return jsonRequest(apiUrl, "/mcp", {
    method: "POST",
    token,
    ...(tenantId ? { tenantId } : {}),
    body: {
      jsonrpc: "2.0",
      id: "context-postgres-auth",
      method: "tools/list",
      params: {}
    },
    accept: "application/json, text/event-stream"
  });
}

async function jsonRequest(apiUrl, path, input = {}) {
  const response = await fetch(new URL(path, apiUrl), {
    method: input.method ?? "GET",
    headers: {
      accept: input.accept ?? "application/json",
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.tenantId ? { "x-jina-tenant-id": input.tenantId } : {}),
      ...(input.principalId ? { "x-jina-principal-id": input.principalId } : {}),
      ...(input.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { parseError: true };
  }
  return { status: response.status, body };
}

function startApi(name, port, environment) {
  const processOutput = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(ROOT, "apps/api/dist/dev-server.js")], {
    cwd: ROOT,
    env: { ...environment, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => {
    processOutput.stdout = boundedAppend(processOutput.stdout, chunk.toString());
  });
  child.stderr?.on("data", (chunk) => {
    processOutput.stderr = boundedAppend(processOutput.stderr, chunk.toString());
  });
  return { name, process: child, output: processOutput };
}

async function stopApi(api) {
  if (!api?.process || api.process.exitCode !== null || api.process.signalCode !== null) return true;
  api.process.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => api.process.once("exit", () => resolve(true))),
    delay(5_000).then(() => false)
  ]);
  if (!exited && api.process.exitCode === null && api.process.signalCode === null) {
    api.process.kill("SIGKILL");
    await Promise.race([new Promise((resolve) => api.process.once("exit", resolve)), delay(2_000)]);
  }
  return api.process.exitCode !== null || api.process.signalCode !== null;
}

async function waitForApi(apiUrl, api) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (api.process.exitCode !== null || api.process.signalCode !== null) {
      throw new Error(`API instance ${api.name} exited before health: ${safeProcessOutput(api.output)}`);
    }
    try {
      const result = await jsonRequest(apiUrl, "/health");
      if (result.status === 200) return result;
    } catch {
      // Startup races are expected while the process initializes its pools.
    }
    await delay(250);
  }
  throw new Error(`API instance ${api.name} did not become healthy: ${safeProcessOutput(api.output)}`);
}

async function waitForPostgres(connection) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await psqlResult(connection, "select 1");
    if (result.code === 0) return;
    await delay(250);
  }
  throw new Error("disposable PostgreSQL did not become ready");
}

function postgresConnection({ port, database, user, password }) {
  return {
    port,
    database,
    user,
    password,
    url: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`
  };
}

async function psql(connection, sql, variables = {}) {
  const result = await psqlResult(connection, sql, variables);
  if (result.code !== 0) {
    throw new Error(`psql failed: ${safePsqlError(result.stderr)}`);
  }
  return result.stdout;
}

async function psqlQuery(connection, sql, variables = {}) {
  const result = await psqlResult(connection, sql, variables, ["-q", "-tA"]);
  if (result.code !== 0) {
    throw new Error(`psql query failed: ${safePsqlError(result.stderr)}`);
  }
  return result.stdout.trim();
}

function psqlResult(connection, sql, variables = {}, extraArguments = []) {
  const variableArguments = Object.entries(variables).flatMap(([name, value]) => ["-v", `${name}=${String(value)}`]);
  return runCommand(
    "psql",
    [
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      "127.0.0.1",
      "-p",
      String(connection.port),
      "-U",
      connection.user,
      "-d",
      connection.database,
      ...variableArguments,
      ...extraArguments
    ],
    {
      allowFailure: true,
      env: { ...process.env, PGPASSWORD: connection.password },
      input: sql
    }
  );
}

async function requireCommand(command, args) {
  const result = await runCommand(command, args, { allowFailure: true });
  if (result.code !== 0) throw new Error(`${command} is required for PostgreSQL auth acceptance`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk.toString());
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      const result = { code: code ?? (signal ? 128 : 1), signal, stdout, stderr };
      if (!options.allowFailure && result.code !== 0) {
        rejectPromise(new Error(`${command} exited ${result.code}: ${safeProcessOutput(result)}`));
        return;
      }
      resolvePromise(result);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function distinctLoopbackPorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freeLoopbackPort());
  return [...ports];
}

function freeLoopbackPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) rejectPromise(error);
        else if (!port) rejectPromise(new Error("failed to allocate a loopback port"));
        else resolvePromise(port);
      });
    });
  });
}

async function writeSafeReport(reportPath, report, secrets) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) throw new Error("acceptance report contains secret material");
  }
  if (/jina_atk_[A-Za-z0-9_-]+/.test(serialized) || /secret_hash/i.test(serialized)) {
    throw new Error("acceptance report contains token material");
  }
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, serialized, { mode: 0o600 });
  await chmod(reportPath, 0o600);
}

function sanitizeFailure(error, secrets) {
  let message = error instanceof Error ? error.message : "unknown acceptance failure";
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  message = message
    .replace(/jina_atk_[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[redacted-database-url]")
    .replace(/[0-9a-f]{64}/g, "[redacted-credential]");
  return {
    code: error instanceof assert.AssertionError ? "assertion_failed" : "acceptance_failed",
    message: message.slice(0, 500)
  };
}

function diagnostic(operation, response) {
  return `${operation} returned HTTP ${response.status}: ${JSON.stringify(response.body).slice(0, 500)}`;
}

function safePsqlError(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function safeProcessOutput(value) {
  return `${value.stderr || value.stdout || "no process output"}`.replace(/\s+/g, " ").trim().slice(-500);
}

function boundedAppend(current, next) {
  const combined = `${current}${next}`;
  return combined.length <= PROCESS_OUTPUT_LIMIT ? combined : combined.slice(-PROCESS_OUTPUT_LIMIT);
}

function issuedTokenSecret() {
  return `jina_atk_${randomBytes(32).toString("base64url")}`;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--report") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--report requires a path");
      options.reportPath = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const { report, reportPath } = await runPostgresAuthAcceptance(options);
  process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath })}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
