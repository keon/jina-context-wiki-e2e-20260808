import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { runProductionTriggerAcceptance } from "./context-production-trigger-e2e.mjs";

const REPOSITORY = "omxyz/jina-context-graph-e2e";
const TENANT = "omlabs";
const PRINCIPAL = "user:production-trigger-acceptance@jina.invalid";
const OPERATIONAL_APP_ID = 123456;
const FIXTURE_APP_ID = 4434994;
const OPERATIONAL_INSTALLATION_ID = 140435029;
const FIXTURE_INSTALLATION_ID = 150069172;
const REPOSITORY_ID = 987654321;
const MAIN_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const SYNCHRONIZED_COMMIT_SHA = "d".repeat(40);
const MARKER_BLOB_SHA = "e".repeat(40);
const SYNCHRONIZED_MARKER_BLOB_SHA = "f".repeat(40);
const NOW = new Date("2026-07-30T18:00:00.000Z");
const MINTED_TOKEN = "ghs_scoped_fixture_installation_token";
const IGNORED_TOKEN = "github-token-ignored-without-override";
const OVERRIDE_TOKEN = "github-explicit-local-override-token";
const REQUIRED_PERMISSIONS = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read"
};
const { privateKey: operationalPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: fixturePrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PRIVATE_KEY = operationalPrivateKey.export({ type: "pkcs8", format: "pem" });
const FIXTURE_APP_PRIVATE_KEY = fixturePrivateKey.export({ type: "pkcs8", format: "pem" });

test("real-trigger contract uses an exact repository-scoped App token, advances frontiers, and cleans up", async () => {
  const fixture = productionFixture();
  const report = await runProductionTriggerAcceptance(baseOptions(), {
    fetch: fixture.fetch,
    now: () => NOW,
    sleep: async () => undefined
  });

  assert.equal(report.status, "passed", JSON.stringify(report.violations));
  assert.deepEqual(
    report.actions.map((action) => action.name),
    [
      "create_ephemeral_branch",
      "full_initialization",
      "issue_comment_noop",
      "new_issue",
      "new_commit",
      "new_pull_request",
      "synchronize_commit",
      "synchronize_pull_request"
    ]
  );
  assert.equal(report.actions.find((action) => action.name === "full_initialization").observed.build.refSequence, 1);
  assert.equal(report.actions.find((action) => action.name === "new_issue").observed.build.refSequence, 5);
  assert.equal(report.actions.find((action) => action.name === "new_commit").observed.build.refSequence, 2);
  assert.equal(report.actions.find((action) => action.name === "new_pull_request").observed.build.refSequence, 1);
  assert.equal(report.actions.find((action) => action.name === "synchronize_commit").observed.build.refSequence, 3);
  assert.equal(
    report.actions.find((action) => action.name === "synchronize_pull_request").observed.build.refSequence,
    2
  );
  assert.equal(report.actions.find((action) => action.name === "issue_comment_noop").observed.delivery.statusCode, 202);
  assert.equal(report.releases.fullInitialization.commitSha, MAIN_SHA);
  assert.equal(report.releases.issue.commitSha, MAIN_SHA);
  assert.equal(report.releases.commit.commitSha, COMMIT_SHA);
  assert.equal(report.releases.pullRequest.commitSha, COMMIT_SHA);
  assert.equal(report.releases.synchronizedCommit.commitSha, SYNCHRONIZED_COMMIT_SHA);
  assert.equal(report.releases.synchronizedPullRequest.commitSha, SYNCHRONIZED_COMMIT_SHA);
  assert.notEqual(report.releases.synchronizedCommit.id, report.releases.commit.id);
  assert.notEqual(report.releases.synchronizedPullRequest.id, report.releases.pullRequest.id);
  assert.equal(
    report.actions.find((action) => action.name === "synchronize_commit").observed.redelivery.exactBuildDelta,
    0
  );
  assert.equal(
    report.actions.find((action) => action.name === "synchronize_pull_request").observed.redelivery.exactBuildDelta,
    0
  );
  assert.deepEqual(
    report.cleanup.map(({ kind, status }) => ({ kind, status })),
    [
      { kind: "pull_request", status: "cleaned" },
      { kind: "issue_comment", status: "cleaned" },
      { kind: "issue", status: "cleaned" },
      { kind: "branch", status: "cleaned" }
    ]
  );
  assert.equal(fixture.state.defaultBranchWrites, 0);
  assert.equal(fixture.state.merges, 0);
  assert.equal(fixture.state.branchDeleted, true);
  assert.equal(fixture.state.issueClosed, true);
  assert.equal(fixture.state.pullRequestClosed, true);
  assert.equal(fixture.state.commentDeleted, true);
  assert.equal(fixture.state.manualBuildCalls, 2);
  assert.equal(fixture.state.markerUpdates, 2);
  assert.equal(fixture.state.mintRequests.length, 1);
  assert.equal(report.target.operationalInstallationId, OPERATIONAL_INSTALLATION_ID);
  assert.equal(report.target.fixtureInstallationId, FIXTURE_INSTALLATION_ID);
  assert.deepEqual(fixture.state.mintRequests[0], {
    repositories: ["jina-context-graph-e2e"],
    permissions: REQUIRED_PERMISSIONS
  });
  assert.ok(fixture.state.repositoryRequests > 0);
  assert.deepEqual(report.mutationCredential, {
    source: "scoped_installation_access_token",
    repository: REPOSITORY,
    repositoryScopeVerified: true,
    permissionsVerified: true,
    permissions: REQUIRED_PERMISSIONS,
    mintCount: 1,
    repositoryId: REPOSITORY_ID,
    expiresAt: "2026-07-30T19:00:00.000Z"
  });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(MINTED_TOKEN));
  assert.ok(!serialized.includes(IGNORED_TOKEN));
  assert.ok(!serialized.includes("internal-production-trigger-token"));
  assert.ok(!serialized.includes(APP_PRIVATE_KEY));
  assert.ok(!serialized.includes(FIXTURE_APP_PRIVATE_KEY));
});

test("an issue-comment build fails acceptance while exact created resources are still cleaned", async () => {
  const fixture = productionFixture({ commentCreatesBuild: true, runId: "comment-regression" });
  const report = await runProductionTriggerAcceptance(baseOptions({ runId: "comment-regression" }), {
    fetch: fixture.fetch,
    now: () => NOW,
    sleep: async () => undefined
  });

  assert.equal(report.status, "failed");
  assert.match(report.violations.map((violation) => violation.message).join("\n"), /non-trigger action unexpectedly/);
  assert.deepEqual(
    report.cleanup.map(({ kind, status }) => ({ kind, status })),
    [
      { kind: "issue_comment", status: "cleaned" },
      { kind: "issue", status: "cleaned" },
      { kind: "branch", status: "cleaned" }
    ]
  );
  assert.equal(fixture.state.branchDeleted, true);
  assert.equal(fixture.state.issueClosed, true);
  assert.equal(fixture.state.commentDeleted, true);
});

test("an invalid synchronize frontier fails acceptance and still cleans every created GitHub resource", async () => {
  const runId = "synchronize-sequence-regression";
  const fixture = productionFixture({ runId, synchronizePullRefSequence: 3 });
  const report = await runProductionTriggerAcceptance(baseOptions({ runId }), {
    fetch: fixture.fetch,
    now: () => NOW,
    sleep: async () => undefined
  });

  assert.equal(report.status, "failed");
  assert.match(
    report.violations.map((violation) => violation.message).join("\n"),
    /pull_request refSequence was 3; expected exact frontier 2/
  );
  assert.deepEqual(
    report.cleanup.map(({ kind, status }) => ({ kind, status })),
    [
      { kind: "pull_request", status: "cleaned" },
      { kind: "issue_comment", status: "cleaned" },
      { kind: "issue", status: "cleaned" },
      { kind: "branch", status: "cleaned" }
    ]
  );
  assert.equal(fixture.state.pullRequestClosed, true);
  assert.equal(fixture.state.commentDeleted, true);
  assert.equal(fixture.state.issueClosed, true);
  assert.equal(fixture.state.branchDeleted, true);
});

test("repository confirmation and allowlist fail before any request", async () => {
  let requests = 0;
  await assert.rejects(
    runProductionTriggerAcceptance(
      {
        ...baseOptions(),
        repository: "omxyz/other",
        confirmRepository: "omxyz/other"
      },
      {
        fetch: async () => {
          requests += 1;
          return new Response();
        }
      }
    ),
    /controlled fixture/
  );
  assert.equal(requests, 0);

  await assert.rejects(
    runProductionTriggerAcceptance(
      {
        ...baseOptions(),
        confirmRepository: "omxyz/other"
      },
      {
        fetch: async () => {
          requests += 1;
          return new Response();
        }
      }
    ),
    /confirmRepository/
  );
  assert.equal(requests, 0);
});

test("fixture and operational identities must be distinct before any request", async () => {
  let requests = 0;
  const dependencies = {
    fetch: async () => {
      requests += 1;
      return new Response();
    }
  };

  await assert.rejects(
    runProductionTriggerAcceptance(baseOptions({ fixtureInstallationId: OPERATIONAL_INSTALLATION_ID }), dependencies),
    /fixtureInstallationId must differ/
  );
  await assert.rejects(
    runProductionTriggerAcceptance(baseOptions({ fixtureGithubAppId: OPERATIONAL_APP_ID }), dependencies),
    /fixtureGithubAppId must differ/
  );
  assert.equal(requests, 0);
});

test("insufficient App installation permissions fail before any repository request and do not retain the token", async () => {
  const fixture = productionFixture({ insufficientPermissions: true });
  const report = await runProductionTriggerAcceptance(baseOptions(), {
    fetch: fixture.fetch,
    now: () => NOW,
    sleep: async () => undefined
  });

  assert.equal(report.status, "failed");
  assert.match(
    report.violations.map((violation) => violation.message).join("\n"),
    /permissions.*exact required minimum/
  );
  assert.equal(fixture.state.mintRequests.length, 1);
  assert.equal(fixture.state.repositoryRequests, 0);
  assert.ok(!JSON.stringify(report).includes(MINTED_TOKEN));
});

test("GITHUB_TOKEN is used only with the explicit local override and is not retained", async () => {
  const runId = "explicit-token-override";
  const fixture = productionFixture({ runId, mutationToken: OVERRIDE_TOKEN });
  const report = await runProductionTriggerAcceptance(
    baseOptions({
      runId,
      useGithubTokenOverride: true,
      githubToken: OVERRIDE_TOKEN
    }),
    {
      fetch: fixture.fetch,
      now: () => NOW,
      sleep: async () => undefined
    }
  );

  assert.equal(report.status, "passed", JSON.stringify(report.violations));
  assert.equal(fixture.state.mintRequests.length, 0);
  assert.ok(fixture.state.repositoryRequests > 0);
  assert.deepEqual(report.mutationCredential, {
    source: "explicit_github_token_override",
    repository: REPOSITORY,
    repositoryScopeVerified: false,
    permissionsVerified: false,
    mintCount: 0
  });
  assert.ok(!JSON.stringify(report).includes(OVERRIDE_TOKEN));
});

function baseOptions(overrides = {}) {
  return {
    apiUrl: "https://jina-api.example.test",
    tenantId: TENANT,
    principalId: PRINCIPAL,
    internalToken: "internal-production-trigger-token",
    githubToken: IGNORED_TOKEN,
    githubAppId: OPERATIONAL_APP_ID,
    githubAppPrivateKey: APP_PRIVATE_KEY,
    fixtureGithubAppId: FIXTURE_APP_ID,
    fixtureGithubAppPrivateKey: FIXTURE_APP_PRIVATE_KEY,
    repository: REPOSITORY,
    allowedRepository: REPOSITORY,
    installationId: OPERATIONAL_INSTALLATION_ID,
    fixtureInstallationId: FIXTURE_INSTALLATION_ID,
    confirmRepository: REPOSITORY,
    runId: "trigger-acceptance",
    timeoutMs: 60_000,
    pollMs: 100,
    commentQuietMs: 0,
    deliveryTimeoutMs: 10_000,
    requestTimeoutMs: 1_000,
    allowInsecureTestTarget: true,
    ...overrides
  };
}

function productionFixture(configuration = {}) {
  const runId = configuration.runId ?? "trigger-acceptance";
  const acceptanceBranch = `e2e/context-trigger-acceptance-${runId}`;
  const state = {
    roots: [
      root("baseline-main", "main", 4, MAIN_SHA, "manual", "baseline-main-request"),
      stage("baseline-main-publish", "baseline-main", "publish-context-release"),
      stage("baseline-main-index", "baseline-main", "index-context-release")
    ],
    releases: [
      release("release-main-prior", "main", MAIN_SHA),
      release("release-main-historical", "main", "c".repeat(40))
    ],
    branchCreated: false,
    branchDeleted: false,
    issueClosed: false,
    commentDeleted: false,
    pullRequestClosed: false,
    defaultBranchWrites: 0,
    merges: 0,
    manualBuildCalls: 0,
    markerUpdates: 0,
    mintRequests: [],
    repositoryRequests: 0,
    deliveries: [],
    nextDeliveryId: 7001,
    issueNumber: 41,
    commentId: 501,
    pullRequestNumber: 42,
    acceptanceBranch
  };

  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;

    if (url.origin === "https://jina-api.example.test") {
      if (url.pathname === "/internal/context/access/sync" && method === "POST") {
        return json({ repositoryCount: 1 });
      }
      if (url.pathname === "/board" && method === "GET") {
        return json({ tasks: state.roots, events: [] });
      }
      if (url.pathname === "/context/releases" && method === "GET") {
        return json({ releases: state.releases });
      }
      if (url.pathname === "/context/build" && method === "POST") {
        state.manualBuildCalls += 1;
        const existing = state.roots.find((candidate) => candidate.metadata?.requestKey === body.requestKey);
        if (existing) return json({ duplicate: true, build: { id: existing.id } });
        const build = root("build-full", body.ref, 1, body.commitSha, "manual", body.requestKey);
        state.roots.push(
          build,
          stage("build-full-publish", build.id, "publish-context-release"),
          stage("build-full-index", build.id, "index-context-release")
        );
        state.releases.unshift(release("release-full", body.ref, body.commitSha));
        return json({ duplicate: false, build: { id: build.id } }, 202);
      }
      return json({ error: "not found" }, 404);
    }

    if (url.origin !== "https://api.github.com") return json({ error: "unexpected origin" }, 500);

    if (url.pathname === `/app/installations/${FIXTURE_INSTALLATION_ID}/access_tokens` && method === "POST") {
      assert.equal(githubAppIdFromAuthorization(init.headers), FIXTURE_APP_ID);
      state.mintRequests.push(body);
      return json(
        {
          token: MINTED_TOKEN,
          expires_at: "2026-07-30T19:00:00.000Z",
          repository_selection: "selected",
          permissions: configuration.insufficientPermissions
            ? { ...REQUIRED_PERMISSIONS, contents: "read" }
            : REQUIRED_PERMISSIONS,
          repositories: [{ id: REPOSITORY_ID, name: "jina-context-graph-e2e", full_name: REPOSITORY }]
        },
        201
      );
    }
    if (url.pathname.startsWith(`/repos/${REPOSITORY}`)) {
      state.repositoryRequests += 1;
      assert.equal(headerValue(init.headers, "authorization"), `Bearer ${configuration.mutationToken ?? MINTED_TOKEN}`);
    }
    if (url.pathname === `/repos/${REPOSITORY}` && method === "GET") {
      return json({
        id: REPOSITORY_ID,
        full_name: REPOSITORY,
        default_branch: "main",
        archived: false,
        disabled: false,
        permissions: { push: true }
      });
    }
    if (url.pathname === `/repos/${REPOSITORY}/git/ref/heads/main` && method === "GET") {
      return json({ object: { sha: MAIN_SHA } });
    }
    if (url.pathname === `/repos/${REPOSITORY}/branches` && method === "GET") {
      return json([{ name: "main" }]);
    }
    if (url.pathname === `/repos/${REPOSITORY}/issues` && method === "GET") {
      return json([]);
    }
    if (
      url.pathname === `/repos/${REPOSITORY}/git/ref/heads/${encodeURIComponent(acceptanceBranch)}` &&
      method === "GET"
    ) {
      return state.branchCreated ? json({ object: { sha: MAIN_SHA } }) : json({ message: "Not Found" }, 404);
    }
    if (url.pathname === `/repos/${REPOSITORY}/git/refs` && method === "POST") {
      assert.equal(body.ref, `refs/heads/${acceptanceBranch}`);
      assert.equal(body.sha, MAIN_SHA);
      state.branchCreated = true;
      return json({ ref: body.ref, object: { sha: MAIN_SHA } }, 201);
    }
    if (url.pathname === `/repos/${REPOSITORY}/issues` && method === "POST") {
      recordDelivery(state, {
        guid: "delivery-issue",
        event: "issues",
        action: "opened",
        payload: { issue: { number: state.issueNumber } },
        statusCode: 202
      });
      const issueBuild = root(
        "build-issue",
        "main",
        5,
        undefined,
        "issue",
        `github:issue:${REPOSITORY}:${state.issueNumber}`
      );
      state.roots.push(
        issueBuild,
        stage("build-issue-publish", issueBuild.id, "publish-context-release"),
        stage("build-issue-index", issueBuild.id, "index-context-release")
      );
      state.releases.unshift(release("release-issue", "main", MAIN_SHA));
      return json({ number: state.issueNumber }, 201);
    }
    if (url.pathname === `/repos/${REPOSITORY}/issues/${state.issueNumber}/comments` && method === "POST") {
      recordDelivery(state, {
        guid: "delivery-comment",
        event: "issue_comment",
        action: "created",
        payload: { comment: { id: state.commentId } },
        statusCode: 202
      });
      if (configuration.commentCreatesBuild) {
        state.roots.push(
          root("build-comment-regression", "main", 6, undefined, "issue", `broken:comment:${state.commentId}`)
        );
      }
      return json({ id: state.commentId }, 201);
    }
    if (url.pathname === "/app/hook/deliveries" && method === "GET") {
      assert.equal(githubAppIdFromAuthorization(init.headers), OPERATIONAL_APP_ID);
      return json([...state.deliveries].reverse().map(deliverySummary));
    }
    const deliveryMatch = /^\/app\/hook\/deliveries\/([1-9][0-9]*)$/.exec(url.pathname);
    if (deliveryMatch && method === "GET") {
      assert.equal(githubAppIdFromAuthorization(init.headers), OPERATIONAL_APP_ID);
      const delivery = state.deliveries.find((candidate) => candidate.id === Number(deliveryMatch[1]));
      return delivery ? json(delivery) : json({ message: "Not Found" }, 404);
    }
    const redeliveryMatch = /^\/app\/hook\/deliveries\/([1-9][0-9]*)\/attempts$/.exec(url.pathname);
    if (redeliveryMatch && method === "POST") {
      assert.equal(githubAppIdFromAuthorization(init.headers), OPERATIONAL_APP_ID);
      const original = state.deliveries.find((candidate) => candidate.id === Number(redeliveryMatch[1]));
      assert.ok(original);
      recordDelivery(state, {
        guid: original.guid,
        event: original.event,
        action: original.action,
        payload: original.request.payload,
        statusCode: 200,
        redelivery: true
      });
      return json({}, 202);
    }
    if (url.pathname === `/repos/${REPOSITORY}/contents/.context-trigger-acceptance/${runId}.md`) {
      assert.equal(method, "PUT");
      assert.equal(body.branch, acceptanceBranch);
      state.markerUpdates += 1;
      if (body.sha === undefined) {
        recordDelivery(state, {
          guid: "delivery-push",
          event: "push",
          payload: { ref: `refs/heads/${acceptanceBranch}`, after: COMMIT_SHA },
          statusCode: 202
        });
        const pushBuild = root(
          "build-push",
          acceptanceBranch,
          2,
          COMMIT_SHA,
          "push",
          `github:push:${REPOSITORY}:${acceptanceBranch}:${COMMIT_SHA}:delivery-push`
        );
        state.roots.push(
          pushBuild,
          stage("build-push-publish", pushBuild.id, "publish-context-release"),
          stage("build-push-index", pushBuild.id, "index-context-release")
        );
        state.releases.unshift(release("release-push", acceptanceBranch, COMMIT_SHA));
        return json({ content: { sha: MARKER_BLOB_SHA }, commit: { sha: COMMIT_SHA } }, 201);
      }

      assert.equal(body.sha, MARKER_BLOB_SHA);
      assert.equal(state.pullRequestClosed, false);
      recordDelivery(state, {
        guid: "delivery-push-synchronize",
        event: "push",
        payload: { ref: `refs/heads/${acceptanceBranch}`, after: SYNCHRONIZED_COMMIT_SHA },
        statusCode: 202
      });
      const synchronizedPushBuild = root(
        "build-push-synchronize",
        acceptanceBranch,
        3,
        SYNCHRONIZED_COMMIT_SHA,
        "push",
        `github:push:${REPOSITORY}:${acceptanceBranch}:${SYNCHRONIZED_COMMIT_SHA}:delivery-push-synchronize`
      );
      state.roots.push(
        synchronizedPushBuild,
        stage("build-push-synchronize-publish", synchronizedPushBuild.id, "publish-context-release"),
        stage("build-push-synchronize-index", synchronizedPushBuild.id, "index-context-release")
      );
      state.releases.unshift(release("release-push-synchronize", acceptanceBranch, SYNCHRONIZED_COMMIT_SHA));

      recordDelivery(state, {
        guid: "delivery-pull-synchronize",
        event: "pull_request",
        action: "synchronize",
        payload: {
          number: state.pullRequestNumber,
          pull_request: { head: { sha: SYNCHRONIZED_COMMIT_SHA } }
        },
        statusCode: 202
      });
      const synchronizedPullBuild = root(
        "build-pull-synchronize",
        `pull/${state.pullRequestNumber}/head`,
        configuration.synchronizePullRefSequence ?? 2,
        SYNCHRONIZED_COMMIT_SHA,
        "pull_request",
        `github:pull:${REPOSITORY}:${state.pullRequestNumber}:${SYNCHRONIZED_COMMIT_SHA}:delivery-pull-synchronize`
      );
      state.roots.push(
        synchronizedPullBuild,
        stage("build-pull-synchronize-publish", synchronizedPullBuild.id, "publish-context-release"),
        stage("build-pull-synchronize-index", synchronizedPullBuild.id, "index-context-release")
      );
      state.releases.unshift(
        release("release-pull-synchronize", synchronizedPullBuild.metadata.ref, SYNCHRONIZED_COMMIT_SHA)
      );
      return json(
        {
          content: { sha: SYNCHRONIZED_MARKER_BLOB_SHA },
          commit: { sha: SYNCHRONIZED_COMMIT_SHA }
        },
        200
      );
    }
    if (url.pathname === `/repos/${REPOSITORY}/pulls` && method === "POST") {
      if (body.base !== "main") state.defaultBranchWrites += 1;
      recordDelivery(state, {
        guid: "delivery-pull",
        event: "pull_request",
        action: "opened",
        payload: {
          number: state.pullRequestNumber,
          pull_request: { head: { sha: COMMIT_SHA } }
        },
        statusCode: 202
      });
      const pullBuild = root(
        "build-pull",
        `pull/${state.pullRequestNumber}/head`,
        1,
        COMMIT_SHA,
        "pull_request",
        `github:pull:${REPOSITORY}:${state.pullRequestNumber}:${COMMIT_SHA}:delivery-pull`
      );
      state.roots.push(
        pullBuild,
        stage("build-pull-publish", pullBuild.id, "publish-context-release"),
        stage("build-pull-index", pullBuild.id, "index-context-release")
      );
      state.releases.unshift(release("release-pull", pullBuild.metadata.ref, COMMIT_SHA));
      return json({ number: state.pullRequestNumber }, 201);
    }
    if (url.pathname === `/repos/${REPOSITORY}/pulls/${state.pullRequestNumber}` && method === "PATCH") {
      assert.equal(body.state, "closed");
      state.pullRequestClosed = true;
      return json({ number: state.pullRequestNumber, state: "closed" });
    }
    if (url.pathname === `/repos/${REPOSITORY}/pulls/${state.pullRequestNumber}` && method === "GET") {
      return json({
        number: state.pullRequestNumber,
        state: state.pullRequestClosed ? "closed" : "open"
      });
    }
    if (url.pathname === `/repos/${REPOSITORY}/issues/comments/${state.commentId}` && method === "DELETE") {
      state.commentDeleted = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === `/repos/${REPOSITORY}/issues/comments/${state.commentId}` && method === "GET") {
      return state.commentDeleted ? json({ message: "Not Found" }, 404) : json({ id: state.commentId });
    }
    if (url.pathname === `/repos/${REPOSITORY}/issues/${state.issueNumber}` && method === "PATCH") {
      assert.equal(body.state, "closed");
      state.issueClosed = true;
      return json({ number: state.issueNumber, state: "closed" });
    }
    if (url.pathname === `/repos/${REPOSITORY}/issues/${state.issueNumber}` && method === "GET") {
      return json({
        number: state.issueNumber,
        state: state.issueClosed ? "closed" : "open"
      });
    }
    if (
      url.pathname === `/repos/${REPOSITORY}/git/refs/heads/${encodeURIComponent(acceptanceBranch)}` &&
      method === "DELETE"
    ) {
      state.branchDeleted = true;
      state.branchCreated = false;
      return new Response(null, { status: 204 });
    }
    return json({ error: `${method} ${url.pathname}` }, 404);
  };

  return { fetch, state };
}

function root(id, ref, refSequence, commitSha, trigger, requestKey) {
  return {
    id,
    type: "build-context",
    status: "done",
    metadata: {
      tenantId: TENANT,
      repository: REPOSITORY,
      ref,
      refSequence,
      ...(commitSha ? { commitSha } : {}),
      trigger,
      requestKey,
      githubInstallationId: OPERATIONAL_INSTALLATION_ID
    }
  };
}

function stage(id, parentTaskId, type) {
  return { id, parentTaskId, type, status: "done", metadata: {} };
}

function release(id, ref, commitSha) {
  return {
    id,
    repository: REPOSITORY,
    ref,
    commitSha,
    createdAt: NOW.toISOString(),
    publishedAt: NOW.toISOString(),
    completeness: "complete",
    contextStatus: "available"
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function headerValue(headers, name) {
  if (headers instanceof Headers) return headers.get(name) ?? "";
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : "";
}

function recordDelivery(state, input) {
  const delivery = {
    id: state.nextDeliveryId,
    guid: input.guid,
    delivered_at: NOW.toISOString(),
    redelivery: input.redelivery ?? false,
    event: input.event,
    ...(input.action === undefined ? {} : { action: input.action }),
    installation_id: OPERATIONAL_INSTALLATION_ID,
    repository_id: REPOSITORY_ID,
    status_code: input.statusCode,
    request: { payload: input.payload }
  };
  state.nextDeliveryId += 1;
  state.deliveries.push(delivery);
  return delivery;
}

function deliverySummary(delivery) {
  const summary = { ...delivery };
  delete summary.request;
  return summary;
}

function githubAppIdFromAuthorization(headers) {
  const authorization = headerValue(headers, "authorization");
  assert.match(authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  const payload = authorization.slice("Bearer ".length).split(".")[1];
  return Number(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).iss);
}
