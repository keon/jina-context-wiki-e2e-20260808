import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSharedActiveTenantIdsQuery,
  buildSharedRepositoryIdentityQuery,
  normalizeSharedRepositoryIdentityRow,
  normalizeSharedTenantSummaryRows
} from "./postgres-shared-identity-store.js";

test("shared identity repository query uses parameterized public-schema lookups", () => {
  const query = buildSharedRepositoryIdentityQuery({
    githubRepositoryId: 987654321,
    githubInstallationId: 123456789,
    repository: "OmXYZ/Jina"
  });

  assert.deepEqual(query.values, ["987654321", "123456789", "OmXYZ", "Jina"]);
  assert.match(query.text, /public\.repositories/);
  assert.match(query.text, /public\.tenants/);
  assert.match(query.text, /public\.installations/);
  assert.match(query.text, /i\.id = r\.installation_id/);
  assert.match(query.text, /i\.github_account_login/);
  assert.match(query.text, /i\.github_installation_id = \$2::bigint/);
  assert.match(query.text, /t\.merged_into_tenant_id is null/);
  assert.doesNotMatch(query.text, /t\.github_account_login/);
  assert.doesNotMatch(query.text, /OmXYZ|Jina/);
});

test("active shared tenants exclude merged source tenants", () => {
  const query = buildSharedActiveTenantIdsQuery();
  assert.match(query, /i\.id = r\.installation_id/);
  assert.match(query, /i\.suspended_at is null/);
  assert.match(query, /i\.deleted_at is null/);
  assert.match(query, /t\.merged_into_tenant_id is null/);
});

test("shared identity repository query permits installation/name and name-only fallback", () => {
  assert.deepEqual(buildSharedRepositoryIdentityQuery({ githubInstallationId: 123, repository: "omxyz/jina" }).values, [
    null,
    "123",
    "omxyz",
    "jina"
  ]);
  assert.deepEqual(buildSharedRepositoryIdentityQuery({ repository: "omxyz/jina" }).values, [
    null,
    null,
    "omxyz",
    "jina"
  ]);
});

test("shared identity repository input rejects ambiguous names and unsafe GitHub IDs", () => {
  assert.throws(() => buildSharedRepositoryIdentityQuery({ repository: "jina" }), /owner\/name/);
  assert.throws(() => buildSharedRepositoryIdentityQuery({ repository: "omxyz/jina/extra" }), /owner\/name/);
  assert.throws(
    () => buildSharedRepositoryIdentityQuery({ githubRepositoryId: Number.MAX_SAFE_INTEGER + 1, repository: "a/b" }),
    /positive safe integer/
  );
  assert.throws(
    () => buildSharedRepositoryIdentityQuery({ githubInstallationId: 0, repository: "a/b" }),
    /positive safe integer/
  );
});

test("shared identity repository rows normalize bigint IDs without number coercion", () => {
  assert.deepEqual(
    normalizeSharedRepositoryIdentityRow({
      tenant_id: "e752bea3-c5f1-49d9-9f6d-51953f5deeb4",
      github_account_id: "9007199254740993",
      github_account_login: "omxyz",
      github_account_type: "Organization",
      github_repository_id: "9007199254740995",
      repository_owner: "omxyz",
      repository_name: "jina",
      default_branch: "main"
    }),
    {
      tenantId: "e752bea3-c5f1-49d9-9f6d-51953f5deeb4",
      githubAccountId: "9007199254740993",
      githubAccountLogin: "omxyz",
      githubAccountType: "Organization",
      githubRepositoryId: "9007199254740995",
      repository: "omxyz/jina",
      defaultBranch: "main"
    }
  );
});

test("shared tenant rows preserve Jina names and aggregate multiple GitHub organizations", () => {
  assert.deepEqual(
    normalizeSharedTenantSummaryRows([
      {
        tenant_id: "e752bea3-c5f1-49d9-9f6d-51953f5deeb4",
        tenant_name: "Acme Workspace",
        tenant_kind: "team",
        github_account_login: null,
        github_installation_id: "101",
        installation_login: "acme-inc",
        installation_type: "Organization",
        repository_count: 3
      },
      {
        tenant_id: "e752bea3-c5f1-49d9-9f6d-51953f5deeb4",
        tenant_name: "Acme Workspace",
        tenant_kind: "team",
        github_account_login: null,
        github_installation_id: "202",
        installation_login: "acme-labs",
        installation_type: "Organization",
        repository_count: 2
      },
      {
        tenant_id: "f752bea3-c5f1-49d9-9f6d-51953f5deeb4",
        tenant_name: "octocat",
        tenant_kind: "personal",
        github_account_login: "octocat",
        github_installation_id: null,
        installation_login: null,
        installation_type: null,
        repository_count: 0
      }
    ]),
    [
      {
        tenantId: "e752bea3-c5f1-49d9-9f6d-51953f5deeb4",
        name: "Acme Workspace",
        kind: "team",
        repositoryCount: 5,
        githubConnections: [
          { installationId: "101", login: "acme-inc", type: "Organization", repositoryCount: 3 },
          { installationId: "202", login: "acme-labs", type: "Organization", repositoryCount: 2 }
        ]
      },
      {
        tenantId: "f752bea3-c5f1-49d9-9f6d-51953f5deeb4",
        name: "octocat",
        kind: "personal",
        githubAccountLogin: "octocat",
        repositoryCount: 0,
        githubConnections: []
      }
    ]
  );
});
