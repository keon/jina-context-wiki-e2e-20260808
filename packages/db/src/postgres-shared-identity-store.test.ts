import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSharedRepositoryIdentityQuery,
  normalizeSharedRepositoryIdentityRow
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
  assert.doesNotMatch(query.text, /OmXYZ|Jina/);
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
