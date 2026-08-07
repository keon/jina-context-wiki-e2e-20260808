import assert from "node:assert/strict";
import { test } from "node:test";

import pg from "pg";

import {
  linkClerkUserIdentity,
  upsertGithubUserIdentity,
} from "./internal-user.js";
import { syncClerkTenantMembershipsWithClient } from "./store.js";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "Clerk identity and membership bridge is additive, explicit, idempotent, and reversible",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query("begin");
      const seed = Date.now() * 1_000 + Math.floor(Math.random() * 100);
      const githubUserId = seed + 1;
      const otherGithubUserId = seed + 2;
      const clerkUserId = `user_clerk_bridge_${seed}`;
      const clerkOrganizationId = `org_clerk_bridge_${seed}`;
      const ignoredOrganizationId = `org_unlinked_bridge_${seed}`;

      const identity = await upsertGithubUserIdentity(client, {
        githubUserId,
        githubLogin: `bridge-${seed}`,
      });
      const otherIdentity = await upsertGithubUserIdentity(client, {
        githubUserId: otherGithubUserId,
        githubLogin: `bridge-other-${seed}`,
      });
      const tenant = await client.query<{ id: string }>(
        `insert into tenants (kind, name, clerk_organization_id)
         values ('team', $1, $2)
         returning id`,
        [`Bridge ${seed}`, clerkOrganizationId],
      );
      await client.query(
        `insert into tenant_members
           (tenant_id, github_user_id, github_login, user_id, role, source, synced_at)
         values ($1, $2, $3, $4, 'admin', 'installer', now())`,
        [tenant.rows[0].id, githubUserId, `bridge-${seed}`, identity.userId],
      );

      assert.deepEqual(
        await linkClerkUserIdentity(client, {
          clerkUserId,
          userId: identity.userId,
          providerLogin: `bridge-${seed}@example.test`,
        }),
        { status: "linked", userId: identity.userId },
      );
      assert.deepEqual(
        await linkClerkUserIdentity(client, {
          clerkUserId,
          userId: identity.userId,
          providerLogin: `bridge-${seed}@example.test`,
        }),
        { status: "already-linked", userId: identity.userId },
      );
      assert.deepEqual(
        await linkClerkUserIdentity(client, {
          clerkUserId,
          userId: otherIdentity.userId,
        }),
        { status: "conflict", userId: identity.userId },
      );
      assert.deepEqual(
        await linkClerkUserIdentity(client, {
          clerkUserId: `${clerkUserId}_other`,
          userId: identity.userId,
        }),
        { status: "conflict", userId: identity.userId },
      );

      const beforeTenantCount = await client.query<{ count: number }>(
        "select count(*)::integer as count from tenants",
      );
      const sync = await syncClerkTenantMembershipsWithClient(client, {
        clerkUserId,
        githubUserId,
        githubLogin: `bridge-${seed}`,
        userId: identity.userId,
        memberships: [
          { organizationId: clerkOrganizationId, name: `Bridge ${seed}`, role: "member" },
          { organizationId: ignoredOrganizationId, name: "Must not become a tenant", role: "admin" },
        ],
      });
      assert.deepEqual(sync, {
        linkedTenantIds: [tenant.rows[0].id],
        ignoredOrganizations: [{ organizationId: ignoredOrganizationId, name: "Must not become a tenant" }],
      });
      const afterTenantCount = await client.query<{ count: number }>(
        "select count(*)::integer as count from tenants",
      );
      assert.equal(afterTenantCount.rows[0].count, beforeTenantCount.rows[0].count);

      const clerkMembership = await client.query<{
        role: string;
        clerk_user_id: string;
        user_id: string;
      }>(
        `select role, clerk_user_id, user_id
           from clerk_tenant_memberships
          where tenant_id = $1 and clerk_user_id = $2`,
        [tenant.rows[0].id, clerkUserId],
      );
      assert.deepEqual(clerkMembership.rows[0], {
        role: "member",
        clerk_user_id: clerkUserId,
        user_id: identity.userId,
      });
      const legacyMembership = await client.query<{ role: string; source: string }>(
        `select role, source
           from tenant_members
          where tenant_id = $1 and github_user_id = $2`,
        [tenant.rows[0].id, githubUserId],
      );
      assert.deepEqual(legacyMembership.rows[0], { role: "admin", source: "installer" });

      await syncClerkTenantMembershipsWithClient(client, {
        clerkUserId,
        githubUserId,
        githubLogin: `bridge-${seed}`,
        userId: identity.userId,
        memberships: [],
      });
      assert.equal(
        (
          await client.query(
            "select 1 from clerk_tenant_memberships where clerk_user_id = $1",
            [clerkUserId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await client.query(
            "select 1 from tenant_members where tenant_id = $1 and github_user_id = $2 and source = 'installer'",
            [tenant.rows[0].id, githubUserId],
          )
        ).rowCount,
        1,
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  },
);
