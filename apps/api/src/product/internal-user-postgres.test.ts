import assert from "node:assert/strict";
import { test } from "node:test";

import pg from "pg";

import type { DashboardSession } from "./auth.js";
import { runInternalUserTransition } from "./identity-transition.js";
import { upsertGithubUserIdentity as upsertGithubUserIdentityWithClient } from "./internal-user.js";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "GitHub sign-in creates one stable user and personal workspace while dual-writing legacy rows",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    process.env.DATABASE_URL = connectionString;
    const {
      deleteSession,
      getSession,
      getGithubTenantAdminRefreshRequirement,
      getTenantIdForUser,
      getTenantMembershipRole,
      listViewerTenants,
      recordInstallation,
      refreshGithubTenantAdminMembership,
      saveSession,
      saveUserHarnessIntegration,
      syncTenantMemberships,
      upsertGithubUserIdentity,
    } = await import("./store.js");

    const client = new pg.Client({ connectionString });
    await client.connect();
    const seed = Date.now() * 1_000 + Math.floor(Math.random() * 100);
    const githubUserId = seed + 1;
    const orgAccountId = seed + 2;
    const sessionId = `internal-user-${seed}`;
    const legacySessionId = `internal-user-legacy-${seed}`;
    let personalTenantId: string | undefined;
    let orgTenantId: string | undefined;
    let userId: string | undefined;

    try {
      // A live login transaction holds the shared transition lock until it
      // commits, so a catch-up backfill fails fast instead of racing identity
      // creation and leaving an orphan user or a failed login.
      await client.query("begin");
      let transitionClient: pg.Client | undefined;
      try {
        await upsertGithubUserIdentityWithClient(client, {
          githubUserId: seed + 100,
          githubLogin: "runtime-lock-user",
        });
        transitionClient = new pg.Client({ connectionString });
        await transitionClient.connect();
        await transitionClient.query("begin");
        await assert.rejects(
          runInternalUserTransition(transitionClient),
          /retry after active sign-ins finish/,
        );
        await transitionClient.query("rollback");
      } finally {
        await transitionClient?.query("rollback").catch(() => {});
        await transitionClient?.end().catch(() => {});
        await client.query("rollback");
      }

      orgTenantId = await recordInstallation({
        installationId: seed + 3,
        account: {
          id: orgAccountId,
          login: "runtime-org",
          type: "Organization",
        },
        installer: {
          id: githubUserId,
          login: "runtime-user",
        },
        repositories: [
          {
            githubRepoId: seed + 4,
            owner: "runtime-org",
            name: "runtime-repository",
            defaultBranch: "main",
            private: true,
          },
        ],
      });
      assert.ok(orgTenantId);
      await client.query(
        `insert into user_integrations (github_user_id, github_login)
         values ($1, 'runtime-user')`,
        [githubUserId],
      );

      const profile = {
        githubUserId,
        githubLogin: "runtime-user",
        displayName: "Runtime User",
        avatarUrl: "https://example.test/runtime-user.png",
      };
      const [first, concurrent] = await Promise.all([
        upsertGithubUserIdentity(profile),
        upsertGithubUserIdentity(profile),
      ]);
      assert.ok(first);
      assert.deepEqual(concurrent, first);
      userId = first.userId;
      personalTenantId = first.personalTenantId;
      assert.equal(await getTenantIdForUser(githubUserId, userId), personalTenantId);
      assert.equal(
        await getTenantIdForUser(githubUserId),
        personalTenantId,
        "a pre-transition session retains its personal-tenant billing lookup",
      );
      assert.equal(
        await getTenantIdForUser(
          githubUserId,
          "00000000-0000-4000-8000-000000000001",
        ),
        undefined,
        "an internal identity mismatch cannot borrow the legacy GitHub billing lookup",
      );

      const second = await upsertGithubUserIdentity({
        githubUserId,
        githubLogin: "runtime-user-renamed",
        displayName: "Runtime User Renamed",
        avatarUrl: "https://example.test/runtime-user-renamed.png",
      });
      assert.deepEqual(second, first);

      const identity = await client.query<{
        user_id: string;
        provider_login: string;
        display_name: string;
        avatar_url: string;
      }>(
        `select identity.user_id, identity.provider_login, app_user.display_name, app_user.avatar_url
           from user_identities identity
           join users app_user on app_user.id = identity.user_id
          where identity.provider = 'github' and identity.provider_user_id = $1`,
        [String(githubUserId)],
      );
      assert.deepEqual(identity.rows[0], {
        user_id: userId,
        provider_login: "runtime-user-renamed",
        display_name: "Runtime User Renamed",
        avatar_url: "https://example.test/runtime-user-renamed.png",
      });

      await client.query("begin");
      try {
        await client.query(
          `insert into dashboard_sessions (id, session_json, expires_at)
           values (
             $1,
             jsonb_build_object(
               'user', jsonb_build_object(
                 'id', $2::bigint,
                 'login', 'runtime-user-stale',
                 'name', 'Runtime User Stale',
                 'avatar_url', 'https://example.test/runtime-user-stale.png'
               )
             ),
             timestamptz '2100-01-01'
           )`,
          [`internal-user-stale-${seed}`, githubUserId],
        );
        await runInternalUserTransition(client);
        const afterCatchUp = await client.query<{
          provider_login: string;
          display_name: string;
          avatar_url: string;
        }>(
          `select identity.provider_login, app_user.display_name, app_user.avatar_url
             from user_identities identity
             join users app_user on app_user.id = identity.user_id
            where identity.provider = 'github' and identity.provider_user_id = $1`,
          [String(githubUserId)],
        );
        assert.deepEqual(afterCatchUp.rows[0], {
          provider_login: "runtime-user-renamed",
          display_name: "Runtime User Renamed",
          avatar_url: "https://example.test/runtime-user-renamed.png",
        });
      } finally {
        await client.query("rollback");
      }

      const personal = await client.query<{
        kind: string;
        name: string;
        personal_owner_user_id: string;
        github_account_login: string;
      }>(
        `select kind, name, personal_owner_user_id, github_account_login
           from tenants
          where id = $1`,
        [personalTenantId],
      );
      assert.deepEqual(personal.rows[0], {
        kind: "personal",
        name: "runtime-user-renamed",
        personal_owner_user_id: userId,
        github_account_login: "runtime-user-renamed",
      });

      await syncTenantMemberships(
        githubUserId,
        "runtime-user-renamed",
        [{ organizationId: orgAccountId, login: "runtime-org", role: "admin" }],
        userId,
      );
      const memberships = await client.query<{ tenant_id: string; user_id: string; source: string }>(
        `select tenant_id, user_id, source
           from tenant_members
          where github_user_id = $1
          order by tenant_id`,
        [githubUserId],
      );
      assert.equal(memberships.rowCount, 2);
      assert.ok(memberships.rows.every((membership) => membership.user_id === userId));
      assert.equal(
        memberships.rows.find((membership) => membership.tenant_id === orgTenantId)!.source,
        "installer",
      );
      assert.deepEqual(
        new Set((await listViewerTenants(githubUserId, userId)).map((tenant) => tenant.tenant_id)),
        new Set([personalTenantId, orgTenantId]),
      );
      // An old session created during the rolling window has no internal id,
      // so it must retain GitHub-id access even after memberships are linked.
      assert.deepEqual(
        new Set((await listViewerTenants(githubUserId)).map((tenant) => tenant.tenant_id)),
        new Set([personalTenantId, orgTenantId]),
      );
      assert.equal(await getTenantMembershipRole(githubUserId, orgTenantId), "admin");
      assert.equal(
        await getGithubTenantAdminRefreshRequirement(githubUserId, orgTenantId, userId),
        undefined,
        "a recently verified GitHub-derived admin grant remains usable",
      );
      await client.query(
        `update tenant_members
            set synced_at = now() - interval '6 minutes'
          where tenant_id = $1 and github_user_id = $2`,
        [orgTenantId, githubUserId],
      );
      assert.deepEqual(
        await getGithubTenantAdminRefreshRequirement(githubUserId, orgTenantId, userId),
        {
          account: {
            id: orgAccountId,
            login: "runtime-org",
            type: "Organization",
          },
        },
      );
      await refreshGithubTenantAdminMembership(githubUserId, orgTenantId, userId);
      assert.equal(
        await getGithubTenantAdminRefreshRequirement(githubUserId, orgTenantId, userId),
        undefined,
      );
      assert.equal(
        await getTenantMembershipRole(
          githubUserId,
          orgTenantId,
          "00000000-0000-4000-8000-000000000001",
        ),
        undefined,
      );

      await client.query("delete from user_integrations where github_user_id = $1", [githubUserId]);
      await saveUserHarnessIntegration(githubUserId, { githubLogin: "runtime-user-renamed" });
      const integration = await client.query<{ user_id: string }>(
        "select user_id from user_integrations where github_user_id = $1",
        [githubUserId],
      );
      assert.equal(integration.rows[0].user_id, userId);

      const now = new Date().toISOString();
      const session: DashboardSession = {
        id: sessionId,
        userId,
        user: { id: githubUserId, login: "runtime-user-renamed" },
        organizations: [],
        projects: [],
        teams: [],
        expiresAt: Date.now() + 60_000,
        createdAt: now,
        updatedAt: now,
      };
      await saveSession(session);
      const storedSession = await client.query<{ user_id: string }>(
        "select user_id from dashboard_sessions where id = $1",
        [sessionId],
      );
      assert.equal(storedSession.rows[0].user_id, userId);
      assert.equal((await getSession(sessionId))!.userId, userId);

      // An old-revision session can be backfilled in place; the new reader
      // hydrates the canonical column without rewriting its JSON.
      await client.query(
        `insert into dashboard_sessions (id, session_json, expires_at, user_id)
         values (
           $1,
           jsonb_build_object(
             'id', $1::text,
             'user', jsonb_build_object('id', $2::bigint, 'login', 'runtime-user-renamed'),
             'organizations', '[]'::jsonb,
             'projects', '[]'::jsonb,
             'teams', '[]'::jsonb,
             'expiresAt', $3::bigint,
             'createdAt', $4::text,
             'updatedAt', $4::text
           ),
           to_timestamp($3::bigint / 1000.0),
           $5
         )`,
        [legacySessionId, githubUserId, Date.now() + 60_000, now, userId],
      );
      assert.equal((await getSession(legacySessionId))!.userId, userId);
    } finally {
      await deleteSession(sessionId).catch(() => {});
      await deleteSession(legacySessionId).catch(() => {});
      if (personalTenantId || orgTenantId) {
        await client
          .query("delete from tenants where id = any($1::uuid[])", [
            [personalTenantId, orgTenantId].filter(Boolean),
          ])
          .catch(() => {});
      }
      if (userId) {
        await client.query("delete from users where id = $1", [userId]).catch(() => {});
      }
      await client.query("delete from user_integrations where github_user_id = $1", [githubUserId]).catch(() => {});
      await client.end();
      const { getPool } = await import("./db.js");
      await getPool().end();
    }
  },
);
