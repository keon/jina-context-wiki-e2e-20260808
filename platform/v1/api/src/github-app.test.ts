import assert from "node:assert/strict";
import test from "node:test";

import {
  canUserAdministerInstallation,
  getInstallationForApp,
  listInstallationRepositories,
} from "./github-app.js";

test("listInstallationRepositories paginates the exact GitHub App installation repository set", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    full_name: `omxyz/repo-${String(index).padStart(3, "0")}`,
    default_branch: index === 0 ? "trunk" : "main",
  }));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({
      repositories: String(input).endsWith("page=1")
        ? firstPage
        : [{ full_name: "omxyz/z-last", default_branch: "main" }],
    });
  }) as typeof fetch;

  const repositories = await listInstallationRepositories(42, fetchImpl, async (installationId) => {
    assert.equal(installationId, 42);
    return "installation-token";
  });

  assert.equal(repositories.length, 101);
  assert.deepEqual(repositories[0], {
    name: "omxyz/repo-000",
    defaultBranch: "trunk",
    owner: "omxyz",
    repositoryName: "repo-000",
  });
  assert.deepEqual(repositories.at(-1), {
    name: "omxyz/z-last",
    defaultBranch: "main",
    owner: "omxyz",
    repositoryName: "z-last",
  });
  assert.deepEqual(requests, [
    {
      url: "https://api.github.com/installation/repositories?per_page=100&page=1",
      authorization: "Bearer installation-token",
    },
    {
      url: "https://api.github.com/installation/repositories?per_page=100&page=2",
      authorization: "Bearer installation-token",
    },
  ]);
});

test("listInstallationRepositories fails closed on a malformed GitHub response", async () => {
  const fetchImpl = (async () => Response.json({ repositories: null })) as typeof fetch;
  await assert.rejects(
    () => listInstallationRepositories(42, fetchImpl, async () => "installation-token"),
    /response was invalid/,
  );
});

test("getInstallationForApp verifies the untrusted setup id with an App JWT", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://api.github.com/app/installations/42");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer app-jwt");
    return Response.json({
      id: 42,
      account: { id: 8, login: "acme-labs", type: "Organization" },
    });
  }) as typeof fetch;

  assert.deepEqual(
    await getInstallationForApp(42, fetchImpl, () => "app-jwt"),
    { id: 42, account: { id: 8, login: "acme-labs", type: "Organization" } },
  );
});

test("getInstallationForApp rejects a spoofed setup installation id", async () => {
  const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
  assert.equal(await getInstallationForApp(42, fetchImpl, () => "app-jwt"), undefined);
});

test("canUserAdministerInstallation requires active GitHub org admin membership", async () => {
  const installation = { id: 42, account: { id: 8, login: "acme-labs", type: "Organization" } };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://api.github.com/user/memberships/orgs/acme-labs");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer oauth-token");
    return Response.json({ role: "admin", state: "active" });
  }) as typeof fetch;
  assert.equal(await canUserAdministerInstallation("oauth-token", 7, installation, fetchImpl), true);
});

test("canUserAdministerInstallation permits signed-webhook fallback when OAuth Apps are restricted", async () => {
  const installation = { id: 42, account: { id: 8, login: "restricted-org", type: "Organization" } };
  for (const status of [403, 404]) {
    const fetchImpl = (async () => new Response(null, { status })) as typeof fetch;
    assert.equal(await canUserAdministerInstallation("oauth-token", 7, installation, fetchImpl), false);
  }
});

test("canUserAdministerInstallation accepts only the owner for personal installations", async () => {
  const installation = { id: 42, account: { id: 7, login: "alice", type: "User" } };
  assert.equal(await canUserAdministerInstallation("unused", 7, installation), true);
  assert.equal(await canUserAdministerInstallation("unused", 8, installation), false);
});
