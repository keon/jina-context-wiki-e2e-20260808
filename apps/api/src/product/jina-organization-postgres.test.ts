import assert from "node:assert/strict";
import { test } from "node:test";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "a Jina organization owns multiple GitHub organizations without deriving its identity from either",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    process.env.DATABASE_URL = connectionString;
    const {
      connectGithubInstallationToTenant,
      createJinaOrganization,
      listTenantGithubConnections,
      listTenantRepositoryAccess,
      listViewerTenants,
      recordInstallation,
      syncTenantMemberships,
      updateJinaOrganizationName,
    } = await import("./store.js");

    const seed = Date.now() * 1_000 + Math.floor(Math.random() * 100);
    const githubUserId = seed + 1;
    const target = await createJinaOrganization({
      name: `Jina Workspace ${seed}`,
      creatorGithubUserId: githubUserId,
      creatorGithubLogin: `owner-${seed}`,
    });

    for (const suffix of ["alpha", "beta"] as const) {
      const offset = suffix === "alpha" ? 10 : 20;
      const installationId = seed + offset;
      const account = {
        id: seed + offset + 1,
        login: `github-${suffix}-${seed}`,
        type: "Organization",
      };
      await recordInstallation({
        installationId,
        account,
        installer: { id: githubUserId, login: `owner-${seed}` },
        repositories: [{
          githubRepoId: seed + offset + 2,
          fullName: `${account.login}/service`,
          defaultBranch: "main",
          private: true,
        }],
      });
      const connected = await connectGithubInstallationToTenant({
        tenantId: target.tenant_id,
        installationId,
        account,
        repositories: [{
          githubRepoId: seed + offset + 2,
          fullName: `${account.login}/service`,
          defaultBranch: "main",
          private: true,
        }],
        movedByGithubUserId: githubUserId,
      });
      assert.equal(connected.tenantId, target.tenant_id);
      assert.equal(connected.moved, true);
    }

    assert.deepEqual(
      (await listTenantGithubConnections(target.tenant_id)).map((connection) => ({
        login: connection.login,
        repositories: connection.repository_count,
        status: connection.status,
      })),
      [
        { login: `github-alpha-${seed}`, repositories: 1, status: "active" },
        { login: `github-beta-${seed}`, repositories: 1, status: "active" },
      ],
    );
    assert.deepEqual(
      (await listTenantRepositoryAccess(target.tenant_id)).map((repository) => repository.name),
      [
        `github-alpha-${seed}/service`,
        `github-beta-${seed}/service`,
      ],
    );

    await syncTenantMemberships(githubUserId, `owner-${seed}`, []);
    const visible = await listViewerTenants(githubUserId);
    assert.deepEqual(
      visible.filter((tenant) => tenant.tenant_id === target.tenant_id),
      [{
        tenant_id: target.tenant_id,
        login: `Jina Workspace ${seed}`,
        type: "Organization",
        role: "admin",
      }],
      "GitHub membership refreshes must not delete Jina-native organization ownership",
    );

    const renamed = await updateJinaOrganizationName(target.tenant_id, `Renamed Workspace ${seed}`);
    assert.deepEqual(renamed, {
      tenant_id: target.tenant_id,
      login: `Renamed Workspace ${seed}`,
      type: "Organization",
      role: "admin",
    });
    assert.equal(
      (await listViewerTenants(githubUserId)).find((tenant) => tenant.tenant_id === target.tenant_id)?.login,
      `Renamed Workspace ${seed}`,
      "renaming preserves the stable Jina organization id and membership",
    );
  },
);
