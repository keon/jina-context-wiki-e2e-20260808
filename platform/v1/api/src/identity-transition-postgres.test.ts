import assert from "node:assert/strict";
import { test } from "node:test";

import pg from "pg";

import { runInternalUserTransition } from "./identity-transition.js";
import { resolveRepositoryInstallations } from "./resolve-repository-installations.js";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "internal user transition backfills mock legacy data and reruns idempotently",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query("begin");
      const seed = Date.now() * 1_000 + Math.floor(Math.random() * 100);
      const githubIds = {
        alice: seed + 1,
        bob: seed + 2,
        charlie: seed + 3,
        dana: seed + 4,
        erin: seed + 5,
      };

      const personal = await client.query<{ id: string }>(
        `insert into tenants (github_account_id, github_account_login, github_account_type)
         values ($1, 'alice-transition', 'User')
         returning id`,
        [githubIds.alice],
      );
      const team = await client.query<{ id: string }>(
        `insert into tenants (github_account_id, github_account_login, github_account_type)
         values ($1, 'acme-transition', 'Organization')
         returning id`,
        [seed + 100],
      );

      await client.query(
        `insert into tenant_members (tenant_id, github_user_id, github_login, role, source)
         values
           ($1, $2, 'alice-transition', 'admin', 'oauth'),
           ($3, $4, 'bob-transition', 'admin', 'installer')`,
        [personal.rows[0]!.id, githubIds.alice, team.rows[0]!.id, githubIds.bob],
      );
      await client.query(
        `insert into user_integrations (github_user_id, github_login)
         values ($1, 'charlie-transition')`,
        [githubIds.charlie],
      );
      await client.query(
        `insert into dashboard_sessions (id, session_json, expires_at)
         values (
           $1,
           jsonb_build_object(
             'id', $1::text,
             'user', jsonb_build_object(
               'id', $2::bigint,
               'login', 'dana-transition',
               'name', 'Dana Transition',
               'avatar_url', 'https://example.test/dana.png'
             ),
             'organizations', '[]'::jsonb,
             'projects', '[]'::jsonb,
             'teams', '[]'::jsonb,
             'expiresAt', 4102444800000,
             'createdAt', '2026-07-23T00:00:00.000Z',
             'updatedAt', '2026-07-23T00:00:00.000Z'
           ),
           timestamptz '2100-01-01'
         )`,
        [`identity-transition-${seed}`, githubIds.dana],
      );
      await client.query(
        `insert into installations (tenant_id, github_installation_id)
         values ($1, $2)`,
        [team.rows[0]!.id, seed + 200],
      );
      await client.query(
        `insert into repositories
           (tenant_id, github_repo_id, owner, name, default_branch, private, enabled)
         values ($1, $2, 'acme-transition', 'v2-compat', 'main', true, true)`,
        [team.rows[0]!.id, seed + 300],
      );
      const rollbackSnapshot = await legacyRollbackSnapshot(client, {
        tenantIds: [personal.rows[0]!.id, team.rows[0]!.id],
        memberGithubIds: [githubIds.alice, githubIds.bob],
        integrationGithubId: githubIds.charlie,
        sessionId: `identity-transition-${seed}`,
      });

      const first = await runInternalUserTransition(client);
      assert.equal(first.candidates, 4);
      assert.equal(first.identitiesCreated, 4);
      assert.equal(first.membershipsBackfilled, 2);
      assert.equal(first.integrationsBackfilled, 1);
      assert.equal(first.sessionsBackfilled, 1);
      assert.equal(first.unmappedMemberships, 0);
      assert.equal(first.unmappedIntegrations, 0);
      assert.equal(first.unmappedSessions, 0);
      assert.equal(first.unmappedIdentities, 0);
      assert.equal(first.unmappedRepositories, 0);

      const identities = await client.query<{
        provider_user_id: string;
        user_id: string;
        provider_login: string;
      }>(
        `select provider_user_id, user_id, provider_login
         from user_identities
         where provider = 'github'
           and provider_user_id = any($1::text[])
         order by provider_user_id`,
        [Object.values(githubIds).slice(0, 4).map(String)],
      );
      assert.equal(identities.rowCount, 4);
      assert.equal(new Set(identities.rows.map((identity) => identity.user_id)).size, 4);

      const personalTenant = await client.query<{
        kind: string;
        name: string;
        personal_owner_user_id: string;
      }>(
        `select kind, name, personal_owner_user_id
         from tenants
         where id = $1`,
        [personal.rows[0]!.id],
      );
      assert.equal(personalTenant.rows[0]!.kind, "personal");
      assert.equal(personalTenant.rows[0]!.name, "alice-transition");
      assert.equal(
        personalTenant.rows[0]!.personal_owner_user_id,
        identities.rows.find((identity) => identity.provider_user_id === String(githubIds.alice))!.user_id,
      );

      const teamTenant = await client.query<{ kind: string; name: string }>(
        "select kind, name from tenants where id = $1",
        [team.rows[0]!.id],
      );
      assert.deepEqual(teamTenant.rows[0], { kind: "team", name: "acme-transition" });

      const installation = await client.query<{
        github_account_id: string;
        github_account_login: string;
        github_account_type: string;
        installed_by_github_user_id: string;
      }>(
        `select github_account_id::text, github_account_login, github_account_type,
                installed_by_github_user_id::text
         from installations
         where tenant_id = $1`,
        [team.rows[0]!.id],
      );
      assert.deepEqual(installation.rows[0], {
        github_account_id: String(seed + 100),
        github_account_login: "acme-transition",
        github_account_type: "Organization",
        installed_by_github_user_id: String(githubIds.bob),
      });

      // Jina v2 reads these public tables through its read-only shared-identity
      // adapter. Keep its current repository and member lookup contract working
      // while v1 dual-writes the new internal user ids.
      const v2Repository = await client.query<{
        tenant_id: string;
        github_account_id: string;
        github_account_login: string;
        github_account_type: string;
        github_repository_id: string;
        repository_owner: string;
        repository_name: string;
        default_branch: string;
      }>(
        `select
           t.id::text as tenant_id,
           t.github_account_id::text as github_account_id,
           t.github_account_login,
           t.github_account_type,
           r.github_repo_id::text as github_repository_id,
           r.owner as repository_owner,
           r.name as repository_name,
           r.default_branch
         from public.repositories r
         join public.tenants t on t.id = r.tenant_id
         where r.enabled = true
           and exists (
             select 1
             from public.installations i
             where i.tenant_id = r.tenant_id
               and ($2::bigint is null or i.github_installation_id = $2::bigint)
               and i.suspended_at is null
           )
           and (
             ($1::bigint is not null and r.github_repo_id = $1::bigint)
             or (
               lower(r.owner) = lower($3)
               and lower(r.name) = lower($4)
             )
           )
         order by
           case when $1::bigint is not null and r.github_repo_id = $1::bigint then 0 else 1 end,
           r.created_at desc
         limit 1`,
        [seed + 300, seed + 200, "ACME-TRANSITION", "V2-COMPAT"],
      );
      assert.deepEqual(v2Repository.rows[0], {
        tenant_id: team.rows[0]!.id,
        github_account_id: String(seed + 100),
        github_account_login: "acme-transition",
        github_account_type: "Organization",
        github_repository_id: String(seed + 300),
        repository_owner: "acme-transition",
        repository_name: "v2-compat",
        default_branch: "main",
      });

      const v2Member = await client.query<{
        tenant_id: string;
        github_user_id: string;
        github_login: string;
        role: string;
      }>(
        `select
           tm.tenant_id::text as tenant_id,
           tm.github_user_id::text as github_user_id,
           tm.github_login,
           tm.role
         from public.tenant_members tm
         join public.tenants t on t.id = tm.tenant_id
         where tm.tenant_id = $1::uuid
           and tm.github_user_id = $2::bigint
         limit 1`,
        [team.rows[0]!.id, githubIds.bob],
      );
      assert.deepEqual(v2Member.rows[0], {
        tenant_id: team.rows[0]!.id,
        github_user_id: String(githubIds.bob),
        github_login: "bob-transition",
        role: "admin",
      });
      assert.deepEqual(
        await legacyRollbackSnapshot(client, {
          tenantIds: [personal.rows[0]!.id, team.rows[0]!.id],
          memberGithubIds: [githubIds.alice, githubIds.bob],
          integrationGithubId: githubIds.charlie,
          sessionId: `identity-transition-${seed}`,
        }),
        rollbackSnapshot,
        "the transition must preserve every column read or written by the previous v1 revision",
      );

      const stableIds = new Map(identities.rows.map((identity) => [identity.provider_user_id, identity.user_id]));
      const second = await runInternalUserTransition(client);
      assert.equal(second.identitiesCreated, 0);
      assert.equal(second.membershipsBackfilled, 0);
      assert.equal(second.integrationsBackfilled, 0);
      assert.equal(second.sessionsBackfilled, 0);
      assert.equal(second.repositoriesBackfilled, 0);

      const rerunIdentities = await client.query<{ provider_user_id: string; user_id: string }>(
        `select provider_user_id, user_id
         from user_identities
         where provider = 'github'
           and provider_user_id = any($1::text[])`,
        [[...stableIds.keys()]],
      );
      assert.deepEqual(
        new Map(rerunIdentities.rows.map((identity) => [identity.provider_user_id, identity.user_id])),
        stableIds,
      );

      await client.query(
        `insert into tenant_members (tenant_id, github_user_id, github_login, role, source)
         values ($1, $2, 'erin-transition', 'member', 'oauth')`,
        [team.rows[0]!.id, githubIds.erin],
      );
      const catchUp = await runInternalUserTransition(client);
      assert.equal(catchUp.identitiesCreated, 1);
      assert.equal(catchUp.membershipsBackfilled, 1);
      const erin = await client.query<{ user_id: string }>(
        `select user_id
         from tenant_members
         where tenant_id = $1 and github_user_id = $2`,
        [team.rows[0]!.id, githubIds.erin],
      );
      assert.ok(erin.rows[0]!.user_id);
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  },
);

test(
  "transition refuses ambiguous or cross-tenant repository links but ignores disabled history",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query("begin");
      const seed = Date.now() * 1_000 + Math.floor(Math.random() * 100);
      const source = await client.query<{ id: string }>(
        `insert into tenants (github_account_id, github_account_login, github_account_type)
         values ($1, 'ambiguous-transition', 'Organization')
         returning id`,
        [seed + 1],
      );
      const other = await client.query<{ id: string }>(
        `insert into tenants (github_account_id, github_account_login, github_account_type)
         values ($1, 'other-transition', 'Organization')
         returning id`,
        [seed + 2],
      );
      await client.query(
        `insert into installations
           (tenant_id, github_installation_id, github_account_id, github_account_login, github_account_type)
         values
           ($1, $2, $3, 'ambiguous-transition', 'Organization'),
           ($1, $4, $3, 'ambiguous-transition', 'Organization'),
           ($1, $5, $3, 'ambiguous-transition', 'Organization')`,
        [source.rows[0]!.id, seed + 10, seed + 1, seed + 11, seed + 13],
      );
      const foreignInstallation = await client.query<{ id: string }>(
        `insert into installations
           (tenant_id, github_installation_id, github_account_id, github_account_login, github_account_type)
         values ($1, $2, $3, 'other-transition', 'Organization')
         returning id`,
        [other.rows[0]!.id, seed + 12, seed + 2],
      );
      await client.query(
        `insert into repositories
           (tenant_id, installation_id, github_repo_id, owner, name, default_branch, private, enabled)
         values
           ($1, null, $2, 'ambiguous-transition', 'enabled-ambiguous', 'main', true, true),
           ($1, null, $3, 'ambiguous-transition', 'disabled-history', 'main', true, false),
           ($1, $4, $5, 'ambiguous-transition', 'cross-tenant', 'main', true, true)`,
        [
          source.rows[0]!.id,
          seed + 20,
          seed + 21,
          foreignInstallation.rows[0]!.id,
          seed + 22,
        ],
      );

      const report = await runInternalUserTransition(client);
      assert.equal(report.repositoriesBackfilled, 0);
      assert.equal(report.unmappedIdentities, 0);
      assert.equal(
        report.unmappedRepositories,
        2,
        "only enabled repositories without an exact same-tenant installation block rollout",
      );

      const resolution = await resolveRepositoryInstallations(client, async (installationId) => {
        if (installationId === seed + 10) {
          return [
            {
              name: "ambiguous-transition/enabled-ambiguous",
              defaultBranch: "main",
              githubRepoId: seed + 20,
            },
            {
              name: "ambiguous-transition/cross-tenant",
              defaultBranch: "main",
              githubRepoId: seed + 22,
            },
          ];
        }
        if (installationId === seed + 13) return undefined;
        return [];
      });
      assert.deepEqual(resolution, {
        candidates: 2,
        resolved: 2,
        unresolved: 0,
        ambiguous: 0,
        deletedInstallations: 1,
      });
      assert.equal((await runInternalUserTransition(client)).unmappedRepositories, 0);
      const deleted = await client.query<{ deleted: boolean; suspended: boolean }>(
        `select deleted_at is not null as deleted, suspended_at is not null as suspended
         from installations
         where github_installation_id = $1`,
        [seed + 13],
      );
      assert.deepEqual(deleted.rows[0], { deleted: true, suspended: true });
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  },
);

async function legacyRollbackSnapshot(
  client: InstanceType<typeof pg.Client>,
  scope: {
    tenantIds: string[];
    memberGithubIds: number[];
    integrationGithubId: number;
    sessionId: string;
  },
): Promise<Record<string, unknown>> {
  const result = await client.query<{ snapshot: Record<string, unknown> }>(
    `select jsonb_build_object(
       'tenants', (
         select jsonb_agg(
           (to_jsonb(tenant_row) - 'kind' - 'name' - 'personal_owner_user_id')
           order by tenant_row.id
         )
         from tenants tenant_row
         where tenant_row.id = any($1::uuid[])
       ),
       'memberships', (
         select jsonb_agg((to_jsonb(member_row) - 'user_id') order by member_row.tenant_id, member_row.github_user_id)
         from tenant_members member_row
         where member_row.github_user_id = any($2::bigint[])
       ),
       'integration', (
         select to_jsonb(integration_row) - 'user_id'
         from user_integrations integration_row
         where integration_row.github_user_id = $3::bigint
       ),
       'session', (
         select to_jsonb(session_row) - 'user_id'
         from dashboard_sessions session_row
         where session_row.id = $4
       ),
       'installations', (
         select jsonb_agg(
           (
             to_jsonb(installation_row)
             - 'github_account_id'
             - 'github_account_login'
             - 'github_account_type'
             - 'installed_by_github_user_id'
             - 'installer_verified_at'
           )
           order by installation_row.id
         )
         from installations installation_row
         where installation_row.tenant_id = any($1::uuid[])
       ),
       'repositories', (
         select jsonb_agg((to_jsonb(repository_row) - 'installation_id') order by repository_row.id)
         from repositories repository_row
         where repository_row.tenant_id = any($1::uuid[])
       )
     ) as snapshot`,
    [scope.tenantIds, scope.memberGithubIds, scope.integrationGithubId, scope.sessionId],
  );
  return result.rows[0]!.snapshot;
}
