import assert from "node:assert/strict";
import test from "node:test";

import {
  createDashboardWikiSourceResolver,
  parseDashboardWikiRef,
} from "./dashboard-wiki-source.js";
import { ApiError } from "./errors.js";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);

test("dashboard wiki refs distinguish branches, pull requests, and commits", () => {
  assert.deepEqual(parseDashboardWikiRef("release/next"), {
    scopeKind: "branch",
    branch: "release/next",
  });
  assert.deepEqual(parseDashboardWikiRef("refs/heads/main"), {
    scopeKind: "branch",
    branch: "main",
  });
  assert.deepEqual(parseDashboardWikiRef("refs/pull/18/head"), {
    scopeKind: "pull_request",
    pullRequest: 18,
  });
  assert.deepEqual(parseDashboardWikiRef(`refs/commits/${headSha}`), {
    scopeKind: "commit",
    commitSha: headSha,
  });
  assert.deepEqual(parseDashboardWikiRef(headSha.toUpperCase()), {
    scopeKind: "branch",
    branch: headSha.toUpperCase(),
  });
  assert.deepEqual(parseDashboardWikiRef("pull/18/head"), {
    scopeKind: "branch",
    branch: "pull/18/head",
  });
});

test("dashboard wiki refs reject unsupported or unsafe Git refs", () => {
  for (const ref of [
    "refs/tags/v1",
    "refs/pull/0/head",
    "feature/../main",
    "feature bad",
    "feature.lock/child",
    "feature/@{old}",
    "feature\u0000bad",
  ]) {
    assert.throws(
      () => parseDashboardWikiRef(ref),
      (error: unknown) => error instanceof ApiError && error.status === 400,
      ref,
    );
  }
});

test("a mutable branch resolves to an exact commit with a repository-scoped token", async () => {
  const tokenRequests: unknown[] = [];
  const githubRequests: { url: string; authorization: string | null }[] = [];
  const resolver = createDashboardWikiSourceResolver({
    tokenFactory: async (installationId, repository) => {
      tokenRequests.push({ installationId, repository });
      return "repository-token";
    },
    fetchImpl: async (input, init) => {
      githubRequests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ sha: headSha.toUpperCase() });
    },
  });

  assert.deepEqual(
    await resolver({
      installationId: 42,
      repository: "omxyz/a",
      defaultBranch: "release/next",
    }),
    {
      scopeKind: "branch",
      ref: "refs/heads/release/next",
      commitSha: headSha,
    },
  );
  assert.deepEqual(tokenRequests, [
    { installationId: 42, repository: "omxyz/a" },
  ]);
  assert.deepEqual(githubRequests, [
    {
      url: "https://api.github.com/repos/omxyz/a/commits/release%2Fnext",
      authorization: "Bearer repository-token",
    },
  ]);
});

test("authoritative default branches cannot be reinterpreted as PR or commit selectors", async () => {
  const requestedUrls: string[] = [];
  const resolver = createDashboardWikiSourceResolver({
    tokenFactory: async () => "repository-token",
    fetchImpl: async (input) => {
      requestedUrls.push(String(input));
      return Response.json({ sha: headSha });
    },
  });

  for (const defaultBranch of ["pull/18/head", "c".repeat(40)]) {
    const source = await resolver({
      installationId: 42,
      repository: "omxyz/a",
      defaultBranch,
    });
    assert.deepEqual(source, {
      scopeKind: "branch",
      ref: `refs/heads/${defaultBranch}`,
      commitSha: headSha,
    });
  }
  assert.deepEqual(requestedUrls, [
    "https://api.github.com/repos/omxyz/a/commits/pull%2F18%2Fhead",
    `https://api.github.com/repos/omxyz/a/commits/${"c".repeat(40)}`,
  ]);
});

test("a pull request resolves both immutable head and base commits", async () => {
  const resolver = createDashboardWikiSourceResolver({
    tokenFactory: async () => "repository-token",
    fetchImpl: async (input) => {
      assert.equal(
        String(input),
        "https://api.github.com/repos/omxyz/a/pulls/18",
      );
      return Response.json({
        head: { sha: headSha.toUpperCase() },
        base: { sha: baseSha },
      });
    },
  });

  assert.deepEqual(
    await resolver({
      installationId: 42,
      repository: "omxyz/a",
      defaultBranch: "main",
      ref: "refs/pull/18/head",
    }),
    {
      scopeKind: "pull_request",
      ref: "refs/pull/18/head",
      pullRequest: 18,
      commitSha: headSha,
      baseCommitSha: baseSha,
    },
  );
});

test("an explicit commit source does not mint a token or call GitHub", async () => {
  let touchedGithub = false;
  const resolver = createDashboardWikiSourceResolver({
    tokenFactory: async () => {
      touchedGithub = true;
      throw new Error("unexpected token mint");
    },
    fetchImpl: async () => {
      touchedGithub = true;
      throw new Error("unexpected GitHub request");
    },
  });

  assert.deepEqual(
    await resolver({
      installationId: 42,
      repository: "omxyz/a",
      defaultBranch: "main",
      commitSha: headSha,
    }),
    {
      scopeKind: "commit",
      ref: `refs/commits/${headSha}`,
      commitSha: headSha,
    },
  );
  assert.equal(touchedGithub, false);
});

test("an explicit SHA cannot bypass resolution of a mutable branch", async () => {
  const resolver = createDashboardWikiSourceResolver({
    tokenFactory: async () => "repository-token",
    fetchImpl: async () => Response.json({ sha: headSha }),
  });

  await assert.rejects(
    () =>
      resolver({
        installationId: 42,
        repository: "omxyz/a",
        defaultBranch: "main",
        ref: "refs/heads/main",
        commitSha: "c".repeat(40),
      }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 409 &&
      error.message === "branch head changed; refresh and retry",
  );
});

test("a changed pull request head is rejected instead of building a different source", async () => {
  const resolver = createDashboardWikiSourceResolver({
    tokenFactory: async () => "repository-token",
    fetchImpl: async () =>
      Response.json({ head: { sha: headSha }, base: { sha: baseSha } }),
  });

  await assert.rejects(
    () =>
      resolver({
        installationId: 42,
        repository: "omxyz/a",
        defaultBranch: "main",
        ref: "refs/pull/18/head",
        commitSha: "c".repeat(40),
      }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 409 &&
      error.message === "pull request head changed; refresh and retry",
  );
});

test("GitHub failures expose only a bounded generic error", async () => {
  const resolver = createDashboardWikiSourceResolver({
    tokenFactory: async () => "repository-token",
    fetchImpl: async () =>
      new Response("private upstream diagnostics ".repeat(10_000), {
        status: 500,
      }),
  });

  await assert.rejects(
    () =>
      resolver({
        installationId: 42,
        repository: "omxyz/a",
        defaultBranch: "main",
      }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 502 &&
      error.message === "GitHub source resolution is unavailable" &&
      error.details === undefined,
  );
});
