import assert from "node:assert/strict";
import { test } from "node:test";

import pg from "pg";

import { rollbackInstallationTenantMove } from "./installation-tenant-transition.js";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "one Jina tenant owns repositories from multiple exact GitHub installations and can roll back safely",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    process.env.DATABASE_URL = connectionString;
    const {
      connectGithubInstallationToTenant,
      createReviewRun,
      getDispatchBillingContext,
      getInstalledRepositoryForReview,
      getReviewGraphTarget,
      isGithubInstallationInstaller,
      listTenantRepositoryAccess,
      listViewerTenants,
      recordInstallation,
    } = await import("./store.js");

    const client = new pg.Client({ connectionString });
    await client.connect();
    const seed = Date.now() * 1_000 + Math.floor(Math.random() * 100);
    const installationA = seed + 10;
    const installationB = seed + 20;
    const reinstalledB = seed + 30;
    const repoA = seed + 11;
    const repoB = seed + 21;
    let tenantA: string | undefined;
    let tenantB: string | undefined;

    try {
      tenantA = await recordInstallation({
        installationId: installationA,
        account: { id: seed + 1, login: "multi-org-a", type: "Organization" },
        installer: { id: seed + 3, login: "workspace-owner" },
        repositories: [
          { githubRepoId: repoA, fullName: "multi-org-a/service-a", defaultBranch: "main", private: true },
        ],
      });
      tenantB = await recordInstallation({
        installationId: installationB,
        account: { id: seed + 2, login: "multi-org-b", type: "Organization" },
        installer: { id: seed + 3, login: "workspace-owner" },
        repositories: [
          { githubRepoId: repoB, fullName: "multi-org-b/service-b", defaultBranch: "trunk", private: true },
        ],
      });
      assert.ok(tenantA);
      assert.ok(tenantB);
      assert.notEqual(tenantA, tenantB);
      assert.deepEqual(
        new Set((await listViewerTenants(seed + 3)).map((tenant) => tenant.tenant_id)),
        new Set([tenantA, tenantB]),
      );
      assert.equal(await isGithubInstallationInstaller(installationB, seed + 3), true);
      await client.query(
        `update installations
            set installer_verified_at = now() - interval '6 minutes'
          where github_installation_id = $1`,
        [installationB],
      );
      assert.equal(
        await isGithubInstallationInstaller(installationB, seed + 3),
        false,
        "signed-webhook installer proof expires instead of authorizing mutations forever",
      );
      await recordInstallation({
        installationId: installationB,
        account: { id: seed + 2, login: "multi-org-b", type: "Organization" },
        installer: { id: seed + 3, login: "workspace-owner" },
        repositories: [],
      });
      assert.equal(await isGithubInstallationInstaller(installationB, seed + 3), true);

      await client.query(
        `update installations
            set created_at = now() - interval '2 hours'
          where github_installation_id = $1`,
        [installationB],
      );
      await assert.rejects(
        connectGithubInstallationToTenant({
          tenantId: tenantA,
          installationId: installationB,
          account: { id: seed + 2, login: "multi-org-b", type: "Organization" },
          repositories: [],
          movedByGithubUserId: seed + 3,
        }),
        /established Jina workspace/,
      );
      await client.query(
        `update installations set created_at = now() where github_installation_id = $1`,
        [installationB],
      );
      await client.query(
        `insert into repositories
           (tenant_id, github_repo_id, owner, name, default_branch, private, enabled)
         values ($1, $2, 'multi-org-b', 'legacy-unmapped', 'main', true, true)`,
        [tenantB, seed + 22],
      );
      await assert.rejects(
        connectGithubInstallationToTenant({
          tenantId: tenantA,
          installationId: installationB,
          account: { id: seed + 2, login: "multi-org-b", type: "Organization" },
          repositories: [],
          movedByGithubUserId: seed + 3,
        }),
        /unresolved legacy repositories/,
      );
      await client.query("delete from repositories where github_repo_id = $1", [seed + 22]);

      const connected = await connectGithubInstallationToTenant({
        tenantId: tenantA,
        installationId: installationB,
        account: { id: seed + 2, login: "multi-org-b", type: "Organization" },
        repositories: [
          { githubRepoId: repoB, fullName: "multi-org-b/service-b", defaultBranch: "trunk", private: true },
        ],
        movedByGithubUserId: seed + 3,
      });
      assert.deepEqual(connected, { tenantId: tenantA, moved: true });
      assert.deepEqual(
        (await listViewerTenants(seed + 3)).map((tenant) => tenant.tenant_id),
        [tenantA],
        "the empty account-derived source workspace is retired from the switcher",
      );
      assert.equal(
        await recordInstallation({
          installationId: reinstalledB,
          account: { id: seed + 2, login: "multi-org-b", type: "Organization" },
          installer: { id: seed + 3, login: "workspace-owner" },
          repositories: [],
        }),
        tenantA,
        "a later installation for the same GitHub account follows the merged Jina workspace",
      );

      assert.deepEqual(await listTenantRepositoryAccess(tenantA), [
        { name: "multi-org-a/service-a", defaultBranch: "main", githubInstallationId: installationA },
        { name: "multi-org-b/service-b", defaultBranch: "trunk", githubInstallationId: installationB },
      ]);
      assert.equal(
        (await getInstalledRepositoryForReview({ fullName: "multi-org-b/service-b", githubRepoId: repoB }))
          ?.githubInstallationId,
        installationB,
      );
      assert.equal(
        (await getReviewGraphTarget({
          installationId: installationB,
          githubRepoId: repoB,
          repository: "multi-org-b/service-b",
        }))?.tenantId,
        tenantA,
      );
      assert.equal((await getDispatchBillingContext(installationB))?.tenantId, tenantA);

      // Dry-run the actual rollback primitive inside a transaction. Both the
      // installation and repository return to their original workspace.
      await client.query("begin");
      await client.query(
        `insert into repositories
           (tenant_id, github_repo_id, owner, name, default_branch, private, enabled)
         values ($1, $2, 'unknown', 'legacy-unmapped', 'main', true, true)`,
        [tenantA, seed + 23],
      );
      await assert.rejects(
        rollbackInstallationTenantMove(client, installationB, "postgres-test"),
        /repository scope changed/,
      );
      await client.query("rollback");

      await client.query("begin");
      const rollback = await rollbackInstallationTenantMove(client, installationB, "postgres-test");
      assert.deepEqual(rollback, { fromTenantId: tenantA, toTenantId: tenantB });
      const reverted = await client.query<{ installation_tenant: string; repository_tenant: string }>(
        `select installation.tenant_id as installation_tenant,
                repository.tenant_id as repository_tenant
           from installations installation
           join repositories repository on repository.installation_id = installation.id
          where installation.github_installation_id = $1
            and repository.github_repo_id = $2`,
        [installationB, repoB],
      );
      assert.deepEqual(reverted.rows[0], { installation_tenant: tenantB, repository_tenant: tenantB });
      const sourceTenant = await client.query<{ merged_into_tenant_id: string | null }>(
        "select merged_into_tenant_id from tenants where id = $1",
        [tenantB],
      );
      assert.equal(sourceTenant.rows[0]!.merged_into_tenant_id, null);
      await client.query("rollback");

      const reviewRunId = await createReviewRun({
        installationId: installationB,
        account: { id: seed + 2, login: "multi-org-b", type: "Organization" },
        repository: {
          githubRepoId: repoB,
          fullName: "multi-org-b/service-b",
          defaultBranch: "trunk",
          private: true,
        },
        pullRequest: { number: 1, headSha: "a".repeat(40) },
      });
      assert.ok(reviewRunId);

      // Once tenant-owned history exists, neither reconnect nor rollback may
      // silently change the historical billing owner.
      await assert.rejects(
        connectGithubInstallationToTenant({
          tenantId: tenantB,
          installationId: installationB,
          account: { id: seed + 2, login: "multi-org-b", type: "Organization" },
          repositories: [],
          movedByGithubUserId: seed + 3,
        }),
        /target Jina tenant does not exist/,
      );
      await client.query("begin");
      await assert.rejects(
        rollbackInstallationTenantMove(client, installationB, "postgres-test"),
        /has Jina history after the move/,
      );
      await client.query("rollback");
    } finally {
      await client.query("rollback").catch(() => {});
      await client
        .query("delete from installation_tenant_moves where github_installation_id = any($1::bigint[])", [
          [installationA, installationB],
        ])
        .catch(() => {});
      if (tenantA || tenantB) {
        await client
          .query("delete from tenants where id = any($1::uuid[])", [[tenantA, tenantB].filter(Boolean)])
          .catch(() => {});
      }
      await client.end();
    }
  },
);

test(
  "installation lifecycle events suspend, restore, and deactivate exact repository access",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    process.env.DATABASE_URL = connectionString;
    const {
      getInstalledRepositoryForReview,
      isGithubInstallationInstaller,
      recordInstallation,
      updateGithubInstallationLifecycle,
    } = await import("./store.js");
    const client = new pg.Client({ connectionString });
    await client.connect();
    const seed = Date.now() * 1_000 + Math.floor(Math.random() * 100);
    const installationId = seed + 1;
    const repositoryId = seed + 2;
    let tenantId: string | undefined;
    const installation = {
      installationId,
      account: { id: seed + 3, login: "lifecycle-org", type: "Organization" },
      installer: { id: seed + 4, login: "lifecycle-admin" },
      repositories: [
        {
          githubRepoId: repositoryId,
          fullName: "lifecycle-org/service",
          defaultBranch: "main",
          private: true,
        },
      ],
    };

    try {
      tenantId = await recordInstallation({ ...installation, lifecycle: "active" });
      assert.ok(await getInstalledRepositoryForReview({
        fullName: "lifecycle-org/service",
        githubRepoId: repositoryId,
      }));

      assert.equal(await updateGithubInstallationLifecycle(installationId, "suspended"), true);
      assert.equal(await getInstalledRepositoryForReview({
        fullName: "lifecycle-org/service",
        githubRepoId: repositoryId,
      }), undefined);

      await recordInstallation({ ...installation, repositories: [], lifecycle: "active" });
      assert.ok(await getInstalledRepositoryForReview({
        fullName: "lifecycle-org/service",
        githubRepoId: repositoryId,
      }));

      assert.equal(await updateGithubInstallationLifecycle(installationId, "deleted"), true);
      assert.equal(await getInstalledRepositoryForReview({
        fullName: "lifecycle-org/service",
        githubRepoId: repositoryId,
      }), undefined);
      assert.equal(await isGithubInstallationInstaller(installationId, seed + 4), false);
      const state = await client.query<{
        suspended: boolean;
        deleted: boolean;
        enabled: boolean;
      }>(
        `select installation.suspended_at is not null as suspended,
                installation.deleted_at is not null as deleted,
                repository.enabled
           from installations installation
           join repositories repository on repository.installation_id = installation.id
          where installation.github_installation_id = $1
            and repository.github_repo_id = $2`,
        [installationId, repositoryId],
      );
      assert.deepEqual(state.rows[0], { suspended: true, deleted: true, enabled: false });
    } finally {
      if (tenantId) {
        await client.query("delete from tenants where id = $1", [tenantId]).catch(() => {});
      }
      await client.end();
      const { getPool } = await import("./db.js");
      await getPool().end();
    }
  },
);
