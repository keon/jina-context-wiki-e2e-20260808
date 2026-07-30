#!/usr/bin/env node

import { randomUUID, sign as cryptoSign } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONTROLLED_REPOSITORY = "omxyz/jina-context-graph-e2e";
const REQUIRED_RELEASE_TASKS = new Set(["publish-context-release", "index-context-release"]);
const FIXTURE_INSTALLATION_PERMISSIONS = Object.freeze({
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read"
});
const INSTALLATION_TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;
const HELP = `Usage: context-production-trigger-e2e.mjs [options]

Required:
  --api-url URL                 Stable production API URL
  --tenant ID                  Production tenant ID
  --principal ID               Internal acceptance principal
  --repository OWNER/REPO      Controlled fixture repository
  --installation-id N          Operational GitHub App installation ID
  --fixture-installation-id N  Fixture-mutation GitHub App installation ID
  --confirm-repository NAME    Must exactly equal --repository
  --report PATH                Retained mode-0600 JSON report

Secrets are accepted only through the environment:
  INTERNAL_API_TOKEN                 Production internal API credential
  GITHUB_APP_ID                      Operational App ID used for delivery audit
  GITHUB_APP_PRIVATE_KEY             Operational App key used for delivery audit
  GITHUB_FIXTURE_APP_ID              Fixture App ID used only to mint mutation tokens
  GITHUB_FIXTURE_APP_PRIVATE_KEY     Fixture App key used only to mint mutation tokens

Optional:
  --use-github-token-override  Use GITHUB_TOKEN instead of minting (local testing only)
  --default-branch BRANCH      Default: repository metadata value
  --run-id ID                  Default: random UUID
  --timeout-ms N               Per-build timeout; default: 14400000 (4 hours)
  --poll-ms N                  Default: 10000
  --comment-quiet-ms N         Default: 30000
  --delivery-timeout-ms N      Default: 180000

The harness creates a unique ephemeral branch, one marker commit, one issue,
one issue comment, and one pull request in the controlled repository. It never
writes or force-pushes the default branch and never merges. It closes the PR
and issue, deletes the comment, and deletes only its exact unique branch.
`;

export async function runProductionTriggerAcceptance(options, dependencies = {}) {
  const config = normalizeOptions(options);
  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? delay;
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const actions = [];
  const violations = [];
  const cleanup = [];
  const resources = {
    branch: config.acceptanceBranch,
    branchCreated: false,
    issueNumber: undefined,
    commentId: undefined,
    pullRequestNumber: undefined
  };
  let repositoryMetadata;
  let mainSha;
  let initialRelease;
  let issueRelease;
  let commitRelease;
  let pullRequestRelease;
  let synchronizedCommitRelease;
  let synchronizedPullRequestRelease;
  let mutationCredential;

  const api = createJsonClient({
    fetchImpl,
    baseUrl: config.apiUrl,
    headers: {
      authorization: `Bearer ${config.internalToken}`,
      "x-jina-tenant-id": config.tenantId,
      "x-jina-principal-id": config.principalId
    },
    timeoutMs: config.requestTimeoutMs
  });
  const githubCredential = createFixtureGitHubClient({ fetchImpl, config, now });
  const github = githubCredential.client;
  mutationCredential = githubCredential.audit;

  try {
    repositoryMetadata = requiredObject(
      (await github(`/repos/${config.repository}`)).body,
      "GitHub repository metadata"
    );
    assertRepositoryMetadata(repositoryMetadata, config);
    const defaultBranch = config.defaultBranch ?? requiredString(repositoryMetadata.default_branch, "default branch");
    config.resolvedDefaultBranch = defaultBranch;
    mainSha = await readGitRefSha(github, config.repository, defaultBranch);
    await assertExclusiveFixture(github, config.repository);

    const collision = await github(
      `/repos/${config.repository}/git/ref/heads/${encodeURIComponent(config.acceptanceBranch)}`,
      { allowStatuses: [404] }
    );
    if (collision.status !== 404) {
      throw new Error(`refusing to reuse existing acceptance branch ${config.acceptanceBranch}`);
    }

    await api("/internal/context/access/sync", {
      method: "POST",
      body: { repositories: [config.repository], mode: "merge" }
    });
    const baselineRoots = await readRoots(api, config);
    const baselineReleases = await readReleases(api, config.repository);
    if (currentRelease(baselineReleases, config.acceptanceBranch)) {
      throw new Error(`fresh acceptance ref ${config.acceptanceBranch} already has a Context release`);
    }

    await github(`/repos/${config.repository}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${config.acceptanceBranch}`, sha: mainSha },
      expectedStatuses: [201]
    });
    resources.branchCreated = true;
    actions.push({
      name: "create_ephemeral_branch",
      expected: { contextBuilds: 0, sha: mainSha },
      observed: { branch: config.acceptanceBranch }
    });
    await assertNoNewScopedRoots(api, config, baselineRoots, config.commentQuietMs, sleep);

    const manualRequestKey = `production-trigger:${config.runId}:full-initialization`;
    const manualResponse = await api("/context/build", {
      method: "POST",
      body: {
        repository: config.repository,
        ref: config.acceptanceBranch,
        commitSha: mainSha,
        githubInstallationId: config.installationId,
        requestKey: manualRequestKey
      },
      expectedStatuses: [202]
    });
    const manualBuildId = requiredString(
      requiredObject(manualResponse.body.build, "manual build").id,
      "manual build id"
    );
    const manualRoot = await waitForExactRoot(
      api,
      config,
      baselineRoots,
      {
        id: manualBuildId,
        ref: config.acceptanceBranch,
        refSequence: nextRefSequence(baselineRoots, config.acceptanceBranch),
        commitSha: mainSha,
        trigger: "manual",
        requestKey: manualRequestKey
      },
      sleep
    );
    const manualReplay = await api("/context/build", {
      method: "POST",
      body: {
        repository: config.repository,
        ref: config.acceptanceBranch,
        commitSha: mainSha,
        githubInstallationId: config.installationId,
        requestKey: manualRequestKey
      },
      expectedStatuses: [200]
    });
    const replayBuildId = requiredString(
      requiredObject(manualReplay.body.build, "manual replay build").id,
      "manual replay build id"
    );
    if (manualReplay.body.duplicate !== true || replayBuildId !== manualBuildId) {
      throw new Error("manual full-initialization replay was not exactly idempotent");
    }
    await assertSingleRequestKeyRoot(api, config, manualRequestKey, manualBuildId);
    initialRelease = await waitForCompletedRelease(api, config, manualRoot, mainSha, undefined, sleep);
    actions.push({
      name: "full_initialization",
      expected: {
        trigger: "manual",
        requestKey: manualRequestKey,
        ref: config.acceptanceBranch,
        commitSha: mainSha,
        idempotentReplay: true,
        freshPriorRelease: true
      },
      observed: { build: manualRoot, release: releaseSummary(initialRelease) }
    });

    const rootsBeforeIssue = await readRoots(api, config);
    const mainReleaseBeforeIssue = currentRelease(
      await readReleases(api, config.repository),
      config.resolvedDefaultBranch
    );
    const issue = await github(`/repos/${config.repository}/issues`, {
      method: "POST",
      body: {
        title: `[Context trigger acceptance ${config.runId}] provider frontier`,
        body:
          `${config.marker}\n\n` +
          "This temporary issue verifies that a new provider record advances Context without changing source."
      },
      expectedStatuses: [201]
    });
    resources.issueNumber = requiredPositiveInteger(issue.body.number, "created issue number");
    const issueRequestKey = `github:issue:${config.repository}:${resources.issueNumber}`;
    const issueRoot = await waitForExactRoot(
      api,
      config,
      rootsBeforeIssue,
      {
        ref: config.resolvedDefaultBranch,
        refSequence: nextRefSequence(rootsBeforeIssue, config.resolvedDefaultBranch),
        trigger: "issue",
        requestKey: issueRequestKey,
        commitSha: null
      },
      sleep
    );
    await assertSingleRequestKeyRoot(api, config, issueRequestKey, issueRoot.id);
    const issueRedelivery = await verifyWebhookRedeliveryIdempotency(
      fetchImpl,
      api,
      config,
      {
        event: "issues",
        action: "opened",
        repositoryId: requiredPositiveInteger(repositoryMetadata.id, "repository id"),
        issueNumber: resources.issueNumber,
        notBefore: startedAt
      },
      now,
      sleep
    );

    const rootsBeforeComment = await readRoots(api, config);
    const commentStartedAt = now();
    const comment = await github(`/repos/${config.repository}/issues/${resources.issueNumber}/comments`, {
      method: "POST",
      body: {
        body:
          `${config.marker}\n\n` +
          "This temporary comment must be delivered and persisted without scheduling another Context build."
      },
      expectedStatuses: [201]
    });
    resources.commentId = requiredPositiveInteger(comment.body.id, "created issue comment id");
    const delivery = await waitForGitHubAppDelivery(
      fetchImpl,
      config,
      {
        event: "issue_comment",
        action: "created",
        repositoryId: requiredPositiveInteger(repositoryMetadata.id, "repository id"),
        commentId: resources.commentId,
        notBefore: commentStartedAt
      },
      sleep
    );
    await assertNoNewScopedRoots(api, config, rootsBeforeComment, config.commentQuietMs, sleep);
    actions.push({
      name: "issue_comment_noop",
      expected: { delivered: true, contextBuilds: 0 },
      observed: {
        issueNumber: resources.issueNumber,
        commentId: resources.commentId,
        delivery: deliverySummary(delivery)
      }
    });

    issueRelease = await waitForCompletedRelease(api, config, issueRoot, mainSha, mainReleaseBeforeIssue?.id, sleep);
    actions.push({
      name: "new_issue",
      expected: {
        trigger: "issue",
        requestKey: issueRequestKey,
        ref: config.resolvedDefaultBranch,
        commitSha: mainSha,
        providerOnlyFrontierAdvance: true
      },
      observed: {
        build: issueRoot,
        release: releaseSummary(issueRelease),
        redelivery: issueRedelivery
      }
    });

    const markerPath = `.context-trigger-acceptance/${config.runId}.md`;
    const rootsBeforeCommit = await readRoots(api, config);
    const commit = await github(`/repos/${config.repository}/contents/${markerPath}`, {
      method: "PUT",
      body: {
        message: `test: Context trigger acceptance ${config.runId}`,
        content: Buffer.from(
          `# Context trigger acceptance\n\n${config.marker}\n\nThis file exists only on ${config.acceptanceBranch}.\n`,
          "utf8"
        ).toString("base64"),
        branch: config.acceptanceBranch
      },
      expectedStatuses: [201]
    });
    const commitSha = requiredGitSha(requiredObject(commit.body.commit, "created commit").sha, "created commit sha");
    const markerBlobSha = requiredGitSha(
      requiredObject(commit.body.content, "created marker content").sha,
      "created marker blob sha"
    );
    const pushRoot = await waitForExactRoot(
      api,
      config,
      rootsBeforeCommit,
      {
        ref: config.acceptanceBranch,
        refSequence: manualRoot.refSequence + 1,
        commitSha,
        trigger: "push",
        requestKeyPattern: githubRequestKeyPattern(
          `github:push:${config.repository}:${config.acceptanceBranch}:${commitSha}:`
        )
      },
      sleep
    );
    await assertSingleBuildIdentity(api, config, pushRoot);
    const pushRedelivery = await verifyWebhookRedeliveryIdempotency(
      fetchImpl,
      api,
      config,
      {
        event: "push",
        repositoryId: requiredPositiveInteger(repositoryMetadata.id, "repository id"),
        ref: `refs/heads/${config.acceptanceBranch}`,
        commitSha,
        guid: deliveryGuid(pushRoot),
        notBefore: startedAt
      },
      now,
      sleep
    );
    commitRelease = await waitForCompletedRelease(api, config, pushRoot, commitSha, initialRelease.id, sleep);
    actions.push({
      name: "new_commit",
      expected: {
        trigger: "push",
        ref: config.acceptanceBranch,
        priorReleaseId: initialRelease.id,
        refSequence: manualRoot.refSequence + 1,
        incrementalFrontier: true
      },
      observed: {
        build: pushRoot,
        commitSha,
        release: releaseSummary(commitRelease),
        redelivery: pushRedelivery
      }
    });

    const rootsBeforePullRequest = await readRoots(api, config);
    const pullRequest = await github(`/repos/${config.repository}/pulls`, {
      method: "POST",
      body: {
        title: `[Context trigger acceptance ${config.runId}] marker change`,
        head: config.acceptanceBranch,
        base: config.resolvedDefaultBranch,
        body: `${config.marker}\n\nTemporary unmerged PR for production Context trigger acceptance.`,
        draft: false
      },
      expectedStatuses: [201]
    });
    resources.pullRequestNumber = requiredPositiveInteger(pullRequest.body.number, "created pull request number");
    const pullRef = `pull/${resources.pullRequestNumber}/head`;
    const pullRoot = await waitForExactRoot(
      api,
      config,
      rootsBeforePullRequest,
      {
        ref: pullRef,
        refSequence: nextRefSequence(rootsBeforePullRequest, pullRef),
        commitSha,
        trigger: "pull_request",
        requestKeyPattern: githubRequestKeyPattern(
          `github:pull:${config.repository}:${resources.pullRequestNumber}:${commitSha}:`
        )
      },
      sleep
    );
    await assertSingleBuildIdentity(api, config, pullRoot);
    const pullRedelivery = await verifyWebhookRedeliveryIdempotency(
      fetchImpl,
      api,
      config,
      {
        event: "pull_request",
        action: "opened",
        repositoryId: requiredPositiveInteger(repositoryMetadata.id, "repository id"),
        pullRequestNumber: resources.pullRequestNumber,
        commitSha,
        guid: deliveryGuid(pullRoot),
        notBefore: startedAt
      },
      now,
      sleep
    );
    pullRequestRelease = await waitForCompletedRelease(api, config, pullRoot, commitSha, undefined, sleep);
    actions.push({
      name: "new_pull_request",
      expected: {
        trigger: "pull_request",
        ref: pullRef,
        commitSha,
        exactHead: true
      },
      observed: {
        pullRequestNumber: resources.pullRequestNumber,
        build: pullRoot,
        release: releaseSummary(pullRequestRelease),
        redelivery: pullRedelivery
      }
    });

    const rootsBeforeSynchronize = await readRoots(api, config);
    const synchronizeStartedAt = now();
    const synchronizedCommit = await github(`/repos/${config.repository}/contents/${markerPath}`, {
      method: "PUT",
      body: {
        message: `test: synchronize Context trigger acceptance ${config.runId}`,
        content: Buffer.from(
          `# Context trigger acceptance\n\n${config.marker}\n\n` +
            `This second revision synchronizes pull request ${resources.pullRequestNumber}.\n`,
          "utf8"
        ).toString("base64"),
        branch: config.acceptanceBranch,
        sha: markerBlobSha
      },
      expectedStatuses: [200]
    });
    const synchronizedCommitSha = requiredGitSha(
      requiredObject(synchronizedCommit.body.commit, "synchronized commit").sha,
      "synchronized commit sha"
    );
    if (synchronizedCommitSha === commitSha) {
      throw new Error("pull request synchronization did not advance the exact head commit");
    }

    const synchronizedPushRefSequence = nextRefSequence(rootsBeforeSynchronize, config.acceptanceBranch);
    const synchronizedPullRefSequence = nextRefSequence(rootsBeforeSynchronize, pullRef);
    const synchronizedPushRoot = await waitForExactRoot(
      api,
      config,
      rootsBeforeSynchronize,
      {
        ref: config.acceptanceBranch,
        refSequence: synchronizedPushRefSequence,
        commitSha: synchronizedCommitSha,
        trigger: "push",
        requestKeyPattern: githubRequestKeyPattern(
          `github:push:${config.repository}:${config.acceptanceBranch}:${synchronizedCommitSha}:`
        )
      },
      sleep
    );
    const synchronizedPullRoot = await waitForExactRoot(
      api,
      config,
      rootsBeforeSynchronize,
      {
        ref: pullRef,
        refSequence: synchronizedPullRefSequence,
        commitSha: synchronizedCommitSha,
        trigger: "pull_request",
        requestKeyPattern: githubRequestKeyPattern(
          `github:pull:${config.repository}:${resources.pullRequestNumber}:${synchronizedCommitSha}:`
        )
      },
      sleep
    );
    await assertSingleBuildIdentity(api, config, synchronizedPushRoot);
    await assertSingleBuildIdentity(api, config, synchronizedPullRoot);

    const synchronizedPushRedelivery = await verifyWebhookRedeliveryIdempotency(
      fetchImpl,
      api,
      config,
      {
        event: "push",
        repositoryId: requiredPositiveInteger(repositoryMetadata.id, "repository id"),
        ref: `refs/heads/${config.acceptanceBranch}`,
        commitSha: synchronizedCommitSha,
        guid: deliveryGuid(synchronizedPushRoot),
        notBefore: synchronizeStartedAt
      },
      now,
      sleep
    );
    const synchronizedPullRedelivery = await verifyWebhookRedeliveryIdempotency(
      fetchImpl,
      api,
      config,
      {
        event: "pull_request",
        action: "synchronize",
        repositoryId: requiredPositiveInteger(repositoryMetadata.id, "repository id"),
        pullRequestNumber: resources.pullRequestNumber,
        commitSha: synchronizedCommitSha,
        guid: deliveryGuid(synchronizedPullRoot),
        notBefore: synchronizeStartedAt
      },
      now,
      sleep
    );

    synchronizedCommitRelease = await waitForCompletedRelease(
      api,
      config,
      synchronizedPushRoot,
      synchronizedCommitSha,
      commitRelease.id,
      sleep
    );
    synchronizedPullRequestRelease = await waitForCompletedRelease(
      api,
      config,
      synchronizedPullRoot,
      synchronizedCommitSha,
      pullRequestRelease.id,
      sleep
    );
    actions.push({
      name: "synchronize_commit",
      expected: {
        trigger: "push",
        ref: config.acceptanceBranch,
        commitSha: synchronizedCommitSha,
        priorReleaseId: commitRelease.id,
        refSequence: synchronizedPushRefSequence,
        incrementalFrontier: true
      },
      observed: {
        build: synchronizedPushRoot,
        release: releaseSummary(synchronizedCommitRelease),
        redelivery: synchronizedPushRedelivery
      }
    });
    actions.push({
      name: "synchronize_pull_request",
      expected: {
        trigger: "pull_request",
        action: "synchronize",
        ref: pullRef,
        commitSha: synchronizedCommitSha,
        priorReleaseId: pullRequestRelease.id,
        refSequence: synchronizedPullRefSequence,
        exactHead: true,
        incrementalFrontier: true
      },
      observed: {
        pullRequestNumber: resources.pullRequestNumber,
        build: synchronizedPullRoot,
        release: releaseSummary(synchronizedPullRequestRelease),
        redelivery: synchronizedPullRedelivery
      }
    });
  } catch (error) {
    violations.push({ code: "acceptance_failed", message: safeError(error) });
  } finally {
    await cleanupResource("pull_request", resources.pullRequestNumber, cleanup, violations, async () => {
      const closed = await github(`/repos/${config.repository}/pulls/${resources.pullRequestNumber}`, {
        method: "PATCH",
        body: { state: "closed" },
        expectedStatuses: [200]
      });
      if (closed.body.state !== "closed") throw new Error("pull request was not verified closed");
      const verified = await github(`/repos/${config.repository}/pulls/${resources.pullRequestNumber}`);
      if (verified.body.state !== "closed") throw new Error("pull request cleanup did not persist");
    });
    await cleanupResource("issue_comment", resources.commentId, cleanup, violations, async () => {
      await github(`/repos/${config.repository}/issues/comments/${resources.commentId}`, {
        method: "DELETE",
        expectedStatuses: [204, 404]
      });
      const verified = await github(`/repos/${config.repository}/issues/comments/${resources.commentId}`, {
        allowStatuses: [404]
      });
      if (verified.status !== 404) throw new Error("issue comment was not verified absent");
    });
    await cleanupResource("issue", resources.issueNumber, cleanup, violations, async () => {
      const closed = await github(`/repos/${config.repository}/issues/${resources.issueNumber}`, {
        method: "PATCH",
        body: { state: "closed" },
        expectedStatuses: [200]
      });
      if (closed.body.state !== "closed") throw new Error("issue was not verified closed");
      const verified = await github(`/repos/${config.repository}/issues/${resources.issueNumber}`);
      if (verified.body.state !== "closed") throw new Error("issue cleanup did not persist");
    });
    await cleanupResource(
      "branch",
      resources.branchCreated ? resources.branch : undefined,
      cleanup,
      violations,
      async () => {
        await github(`/repos/${config.repository}/git/refs/heads/${encodeURIComponent(resources.branch)}`, {
          method: "DELETE",
          expectedStatuses: [204, 404]
        });
        const verified = await github(
          `/repos/${config.repository}/git/ref/heads/${encodeURIComponent(resources.branch)}`,
          { allowStatuses: [404] }
        );
        if (verified.status !== 404) throw new Error("acceptance branch was not verified absent");
      }
    );
  }

  const finishedAt = now().toISOString();
  return {
    schemaVersion: "context-production-trigger-acceptance-v1",
    status: violations.length === 0 ? "passed" : "failed",
    startedAt,
    finishedAt,
    target: {
      apiUrl: config.apiUrl,
      tenantId: config.tenantId,
      principalId: config.principalId,
      repository: config.repository,
      repositoryId: repositoryMetadata?.id,
      operationalInstallationId: config.installationId,
      fixtureInstallationId: config.fixtureInstallationId,
      defaultBranch: config.resolvedDefaultBranch,
      mainSha,
      runId: config.runId
    },
    safety: {
      controlledRepository: config.allowedRepository,
      defaultBranchWrites: 0,
      forcePushes: 0,
      merges: 0,
      uniqueMarker: config.marker,
      cleanupAttempted: true
    },
    mutationCredential,
    resources,
    actions,
    releases: {
      fullInitialization: initialRelease ? releaseSummary(initialRelease) : undefined,
      issue: issueRelease ? releaseSummary(issueRelease) : undefined,
      commit: commitRelease ? releaseSummary(commitRelease) : undefined,
      pullRequest: pullRequestRelease ? releaseSummary(pullRequestRelease) : undefined,
      synchronizedCommit: synchronizedCommitRelease ? releaseSummary(synchronizedCommitRelease) : undefined,
      synchronizedPullRequest: synchronizedPullRequestRelease
        ? releaseSummary(synchronizedPullRequestRelease)
        : undefined
    },
    cleanup,
    violations
  };
}

function normalizeOptions(options) {
  const repository = requiredRepository(options.repository);
  const allowedRepository = requiredRepository(options.allowedRepository ?? CONTROLLED_REPOSITORY);
  if (repository !== allowedRepository) {
    throw new Error(`repository must equal controlled fixture ${allowedRepository}`);
  }
  if (requiredString(options.confirmRepository, "confirmRepository").toLowerCase() !== repository) {
    throw new Error("confirmRepository must exactly confirm the controlled repository");
  }
  const apiUrl = requiredString(options.apiUrl, "apiUrl").replace(/\/$/, "");
  if (!options.allowInsecureTestTarget && !/^https:\/\/[^/]+$/.test(apiUrl)) {
    throw new Error("apiUrl must be one stable HTTPS origin");
  }
  const runId = (options.runId?.trim().toLowerCase() || randomUUID()).replaceAll("_", "-");
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(runId)) {
    throw new Error("runId must contain 1..64 lowercase-safe characters");
  }
  const useGithubTokenOverride = options.useGithubTokenOverride === true;
  const githubAppId = requiredPositiveInteger(options.githubAppId, "githubAppId");
  const installationId = requiredPositiveInteger(options.installationId, "installationId");
  const fixtureInstallationId = requiredPositiveInteger(options.fixtureInstallationId, "fixtureInstallationId");
  if (fixtureInstallationId === installationId) {
    throw new Error("fixtureInstallationId must differ from the operational installationId");
  }
  const fixtureGithubAppId = useGithubTokenOverride
    ? optionalPositiveInteger(options.fixtureGithubAppId, "fixtureGithubAppId")
    : requiredPositiveInteger(options.fixtureGithubAppId, "fixtureGithubAppId");
  if (fixtureGithubAppId !== undefined && fixtureGithubAppId === githubAppId) {
    throw new Error("fixtureGithubAppId must differ from the operational githubAppId");
  }
  return {
    apiUrl,
    tenantId: requiredString(options.tenantId, "tenantId"),
    principalId: requiredString(options.principalId, "principalId"),
    internalToken: requiredSecret(options.internalToken, "internalToken"),
    useGithubTokenOverride,
    githubTokenOverride: useGithubTokenOverride
      ? requiredSecret(options.githubToken, "GITHUB_TOKEN override")
      : undefined,
    githubAppId,
    githubAppPrivateKey: normalizePrivateKey(requiredSecret(options.githubAppPrivateKey, "githubAppPrivateKey")),
    fixtureGithubAppId,
    fixtureGithubAppPrivateKey: useGithubTokenOverride
      ? options.fixtureGithubAppPrivateKey
        ? normalizePrivateKey(requiredSecret(options.fixtureGithubAppPrivateKey, "fixtureGithubAppPrivateKey"))
        : undefined
      : normalizePrivateKey(requiredSecret(options.fixtureGithubAppPrivateKey, "fixtureGithubAppPrivateKey")),
    repository,
    allowedRepository,
    installationId,
    fixtureInstallationId,
    confirmRepository: repository,
    defaultBranch: options.defaultBranch ? safeRef(options.defaultBranch, "defaultBranch") : undefined,
    resolvedDefaultBranch: undefined,
    runId,
    acceptanceBranch: `e2e/context-trigger-acceptance-${runId}`,
    marker: `jina-context-trigger-acceptance:${runId}`,
    timeoutMs: boundedInteger(options.timeoutMs ?? 14_400_000, "timeoutMs", 60_000, 21_600_000),
    pollMs: boundedInteger(options.pollMs ?? 10_000, "pollMs", 100, 60_000),
    commentQuietMs: boundedInteger(
      options.commentQuietMs ?? 30_000,
      "commentQuietMs",
      options.allowInsecureTestTarget ? 0 : 1_000,
      300_000
    ),
    deliveryTimeoutMs: boundedInteger(options.deliveryTimeoutMs ?? 180_000, "deliveryTimeoutMs", 10_000, 600_000),
    requestTimeoutMs: boundedInteger(options.requestTimeoutMs ?? 30_000, "requestTimeoutMs", 1_000, 120_000)
  };
}

function createJsonClient({ fetchImpl, baseUrl, headers, timeoutMs }) {
  return async (path, input = {}) => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: input.method ?? "GET",
      headers: {
        ...headers,
        ...(input.body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`${new URL(path, baseUrl).pathname} returned invalid JSON`);
      }
    }
    const expected = input.expectedStatuses ?? [200];
    const allowed = input.allowStatuses ?? [];
    if (![...expected, ...allowed].includes(response.status)) {
      throw new Error(`${new URL(path, baseUrl).pathname} failed with HTTP ${response.status}`);
    }
    return { status: response.status, body };
  };
}

function createFixtureGitHubClient({ fetchImpl, config, now }) {
  const audit = config.useGithubTokenOverride
    ? {
        source: "explicit_github_token_override",
        repository: config.repository,
        repositoryScopeVerified: false,
        permissionsVerified: false,
        mintCount: 0
      }
    : {
        source: "scoped_installation_access_token",
        repository: config.repository,
        repositoryScopeVerified: false,
        permissionsVerified: false,
        permissions: { ...FIXTURE_INSTALLATION_PERMISSIONS },
        mintCount: 0
      };
  let installationCredential;

  return {
    audit,
    client: async (path, input = {}) => {
      let token = config.githubTokenOverride;
      if (!config.useGithubTokenOverride) {
        const currentTime = now();
        if (
          !installationCredential ||
          Date.parse(installationCredential.expiresAt) - currentTime.getTime() <= INSTALLATION_TOKEN_REFRESH_WINDOW_MS
        ) {
          installationCredential = await mintScopedFixtureInstallationToken(fetchImpl, config, currentTime);
          audit.repositoryId = installationCredential.repositoryId;
          audit.expiresAt = installationCredential.expiresAt;
          audit.repositoryScopeVerified = true;
          audit.permissionsVerified = true;
          audit.mintCount += 1;
        }
        token = installationCredential.token;
      }
      const client = createJsonClient({
        fetchImpl,
        baseUrl: "https://api.github.com",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "jina-context-production-trigger-acceptance"
        },
        timeoutMs: config.requestTimeoutMs
      });
      return client(path, input);
    }
  };
}

async function mintScopedFixtureInstallationToken(fetchImpl, config, currentTime) {
  const [, repositoryName] = config.repository.split("/");
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${config.fixtureInstallationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...fixtureGithubAppHeaders(config),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        repositories: [repositoryName],
        permissions: FIXTURE_INSTALLATION_PERMISSIONS
      }),
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    }
  );
  if (response.status !== 201) {
    throw new Error(`scoped GitHub App installation token mint failed with HTTP ${response.status}`);
  }

  const body = requiredObject(await response.json(), "installation token response");
  if (body.repository_selection !== "selected") {
    throw new Error("scoped installation token was not repository-selection limited");
  }
  const repositories = requiredArray(body.repositories, "installation token repositories");
  if (repositories.length !== 1) {
    throw new Error("scoped installation token did not contain exactly one repository");
  }
  const repository = requiredObject(repositories[0], "installation token repository");
  const fullName = requiredRepository(repository.full_name);
  if (fullName !== config.repository) {
    throw new Error("scoped installation token repository did not match the controlled fixture");
  }

  const permissions = requiredObject(body.permissions, "installation token permissions");
  const expectedPermissionEntries = Object.entries(FIXTURE_INSTALLATION_PERMISSIONS).sort();
  const observedPermissionEntries = Object.entries(permissions)
    .map(([name, level]) => [name, String(level)])
    .sort();
  if (JSON.stringify(observedPermissionEntries) !== JSON.stringify(expectedPermissionEntries)) {
    throw new Error("scoped installation token permissions were not the exact required minimum");
  }

  const expiresAt = requiredString(body.expires_at, "installation token expiry");
  const expirationTime = Date.parse(expiresAt);
  if (
    !Number.isFinite(expirationTime) ||
    expirationTime <= currentTime.getTime() + 60_000 ||
    expirationTime > currentTime.getTime() + 65 * 60_000
  ) {
    throw new Error("scoped installation token expiry was outside the expected short-lived window");
  }

  return {
    token: requiredSecret(body.token, "installation token"),
    expiresAt: new Date(expirationTime).toISOString(),
    repositoryId: requiredPositiveInteger(repository.id, "installation token repository id")
  };
}

async function readRoots(api, config) {
  const response = await api("/board");
  return requiredArray(response.body.tasks, "Board tasks")
    .filter(isObject)
    .filter((task) => {
      const metadata = objectOrEmpty(task.metadata);
      return (
        task.type === "build-context" &&
        metadata.tenantId === config.tenantId &&
        String(metadata.repository).toLowerCase() === config.repository
      );
    })
    .map(rootSummary)
    .sort((left, right) => left.ref.localeCompare(right.ref) || left.refSequence - right.refSequence);
}

function rootSummary(task) {
  const metadata = requiredObject(task.metadata, "Board root metadata");
  return {
    id: requiredString(task.id, "Board root id"),
    status: requiredString(task.status, "Board root status"),
    ref: safeRef(metadata.ref, "Board root ref"),
    refSequence: requiredPositiveInteger(metadata.refSequence, "Board root refSequence"),
    trigger: requiredString(metadata.trigger, "Board root trigger"),
    requestKey: requiredString(metadata.requestKey, "Board root requestKey"),
    ...(typeof metadata.commitSha === "string"
      ? { commitSha: requiredGitSha(metadata.commitSha, "Board root commitSha") }
      : {}),
    ...(metadata.githubInstallationId === undefined
      ? {}
      : {
          githubInstallationId: requiredPositiveInteger(
            metadata.githubInstallationId,
            "Board root githubInstallationId"
          )
        })
  };
}

async function waitForExactRoot(api, config, before, expected, sleep) {
  const beforeIds = new Set(before.map((root) => root.id));
  const deadline = Date.now() + config.deliveryTimeoutMs;
  while (Date.now() < deadline) {
    const roots = await readRoots(api, config);
    const candidates = roots.filter((root) => !beforeIds.has(root.id) && rootMatches(root, expected));
    if (candidates.length === 1) {
      assertRoot(candidates[0], expected, config.installationId);
      return candidates[0];
    }
    if (candidates.length > 1) throw new Error(`trigger admitted ${candidates.length} matching Context roots`);
    await sleep(config.pollMs);
  }
  throw new Error(`timed out waiting for ${expected.trigger} Context admission on ${expected.ref}`);
}

function rootMatches(root, expected) {
  if (expected.id && root.id !== expected.id) return false;
  if (root.ref !== expected.ref || root.trigger !== expected.trigger) return false;
  if (expected.requestKey && root.requestKey !== expected.requestKey) return false;
  if (expected.requestKeyPattern && !expected.requestKeyPattern.test(root.requestKey)) return false;
  return expected.commitSha === null ? root.commitSha === undefined : root.commitSha === expected.commitSha;
}

function assertRoot(root, expected, installationId) {
  if (root.refSequence !== expected.refSequence) {
    throw new Error(
      `${expected.trigger} refSequence was ${root.refSequence}; expected exact frontier ${expected.refSequence}`
    );
  }
  if (root.githubInstallationId !== installationId) {
    throw new Error(`${expected.trigger} build did not retain the exact GitHub installation`);
  }
}

async function assertSingleRequestKeyRoot(api, config, requestKey, buildId) {
  const matching = (await readRoots(api, config)).filter((root) => root.requestKey === requestKey);
  if (matching.length !== 1 || matching[0].id !== buildId) {
    throw new Error(`request key ${requestKey} does not identify exactly one build`);
  }
}

async function assertSingleBuildIdentity(api, config, expected) {
  const matching = (await readRoots(api, config)).filter(
    (root) =>
      root.ref === expected.ref &&
      root.trigger === expected.trigger &&
      root.commitSha === expected.commitSha &&
      root.refSequence === expected.refSequence
  );
  if (matching.length !== 1 || matching[0].id !== expected.id) {
    throw new Error(`${expected.trigger} delivery did not identify exactly one build frontier`);
  }
}

async function assertNoNewScopedRoots(api, config, before, quietMs, sleep) {
  const beforeIds = new Set(before.map((root) => root.id));
  const deadline = Date.now() + quietMs;
  while (true) {
    const created = (await readRoots(api, config)).filter((root) => !beforeIds.has(root.id));
    if (created.length > 0) {
      throw new Error(`non-trigger action unexpectedly admitted ${created.length} Context build(s)`);
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(config.pollMs, Math.max(100, deadline - Date.now())));
  }
}

async function waitForCompletedRelease(api, config, root, expectedCommitSha, priorReleaseId, sleep) {
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    const roots = await readRoots(api, config);
    const current = roots.find((candidate) => candidate.id === root.id);
    if (!current) throw new Error(`Context build ${root.id} disappeared`);
    if (["failed", "canceled", "superseded"].includes(current.status)) {
      throw new Error(`Context build ${root.id} ended as ${current.status}`);
    }
    if (current.status === "done") {
      const board = await api("/board");
      const tasks = requiredArray(board.body.tasks, "Board tasks").filter(isObject);
      const descendants = contextDescendants(tasks, root.id);
      for (const requiredType of REQUIRED_RELEASE_TASKS) {
        if (!descendants.some((task) => task.type === requiredType && task.status === "done")) {
          throw new Error(`Context build ${root.id} lacks completed ${requiredType}`);
        }
      }
      const releases = await readReleases(api, config.repository);
      const release = currentRelease(releases, root.ref);
      if (
        release &&
        release.commitSha === expectedCommitSha &&
        release.contextStatus === "available" &&
        (!priorReleaseId || release.id !== priorReleaseId)
      ) {
        return release;
      }
    }
    await sleep(config.pollMs);
  }
  throw new Error(`Context build ${root.id} did not publish its exact release before timeout`);
}

function contextDescendants(tasks, rootId) {
  const ids = new Set([rootId]);
  const descendants = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (ids.has(task.id) || !ids.has(task.parentTaskId)) continue;
      ids.add(task.id);
      descendants.push(task);
      changed = true;
    }
  }
  return descendants;
}

async function readReleases(api, repository) {
  const response = await api(`/context/releases?repository=${encodeURIComponent(repository)}`);
  return requiredArray(response.body.releases, "Context releases")
    .filter(isObject)
    .map((release) => ({
      id: requiredString(release.id, "release id"),
      ref: safeRef(release.ref, "release ref"),
      commitSha: requiredGitSha(release.commitSha, "release commitSha"),
      contextStatus: requiredString(release.contextStatus, "release contextStatus")
    }));
}

function currentRelease(releases, ref) {
  return releases.find((release) => release.ref === ref);
}

async function readGitRefSha(github, repository, ref) {
  const response = await github(`/repos/${repository}/git/ref/heads/${encodeURIComponent(ref)}`);
  return requiredGitSha(requiredObject(response.body.object, "Git ref object").sha, "Git ref sha");
}

function assertRepositoryMetadata(value, config) {
  if (String(value.full_name).toLowerCase() !== config.repository) {
    throw new Error("GitHub repository metadata did not match the controlled repository");
  }
  if (value.archived === true || value.disabled === true) {
    throw new Error("controlled fixture repository is archived or disabled");
  }
  if (value.permissions && value.permissions.push !== true) {
    throw new Error("GitHub token lacks push permission on the controlled fixture repository");
  }
}

async function assertExclusiveFixture(github, repository) {
  const [branchesResponse, issuesResponse] = await Promise.all([
    github(`/repos/${repository}/branches?per_page=100`),
    github(`/repos/${repository}/issues?state=open&per_page=100`)
  ]);
  const activeBranches = requiredArray(branchesResponse.body, "repository branches")
    .filter(isObject)
    .map((branch) => String(branch.name))
    .filter((name) => name.startsWith("e2e/context-trigger-acceptance-"));
  const activeIssues = requiredArray(issuesResponse.body, "repository issues")
    .filter(isObject)
    .filter((issue) => !issue.pull_request)
    .filter((issue) => String(issue.title).startsWith("[Context trigger acceptance "));
  if (activeBranches.length > 0 || activeIssues.length > 0) {
    throw new Error(
      `controlled fixture is already in use (${activeBranches.length} acceptance branches, ${activeIssues.length} acceptance issues)`
    );
  }
}

async function waitForGitHubAppDelivery(fetchImpl, config, expected, sleep) {
  const deadline = Date.now() + config.deliveryTimeoutMs;
  const checked = new Set();
  while (Date.now() < deadline) {
    const deliveries = await listGitHubAppDeliveries(fetchImpl, config);
    for (const delivery of deliveries) {
      const id = requiredPositiveInteger(delivery.id, "GitHub App delivery id");
      if (
        checked.has(id) ||
        delivery.event !== expected.event ||
        (expected.action !== undefined && delivery.action !== expected.action) ||
        (expected.guid !== undefined && delivery.guid !== expected.guid) ||
        Boolean(delivery.redelivery) !== Boolean(expected.redelivery) ||
        Number(delivery.repository_id) !== expected.repositoryId ||
        Number(delivery.installation_id) !== config.installationId ||
        Date.parse(String(delivery.delivered_at)) < new Date(expected.notBefore).getTime() - 5_000
      ) {
        continue;
      }
      checked.add(id);
      const detail = await getGitHubAppDelivery(fetchImpl, config, id);
      const payload = requiredObject(requiredObject(detail.request, "delivery request").payload, "delivery payload");
      if (deliveryPayloadMatches(payload, expected)) {
        if (Number(detail.status_code) < 200 || Number(detail.status_code) >= 300) {
          throw new Error(`${expected.event} webhook delivery completed with HTTP ${detail.status_code}`);
        }
        return detail;
      }
    }
    await sleep(config.pollMs);
  }
  throw new Error(`GitHub App did not expose the exact ${expected.event} delivery; verify the App subscription`);
}

async function verifyWebhookRedeliveryIdempotency(fetchImpl, api, config, expected, now, sleep) {
  const original = await waitForGitHubAppDelivery(fetchImpl, config, { ...expected, redelivery: false }, sleep);
  const rootsBefore = await readRoots(api, config);
  const requestedAt = now();
  const response = await fetchImpl(
    `https://api.github.com/app/hook/deliveries/${requiredPositiveInteger(original.id, "delivery id")}/attempts`,
    {
      method: "POST",
      headers: githubAppHeaders(config),
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    }
  );
  if (response.status !== 202) {
    throw new Error(`GitHub App redelivery request failed with HTTP ${response.status}`);
  }
  const redelivery = await waitForGitHubAppDelivery(
    fetchImpl,
    config,
    {
      ...expected,
      guid: requiredString(original.guid, "delivery guid"),
      redelivery: true,
      notBefore: requestedAt
    },
    sleep
  );
  await assertNoNewScopedRoots(api, config, rootsBefore, config.commentQuietMs, sleep);
  return {
    original: deliverySummary(original),
    redelivery: deliverySummary(redelivery),
    exactBuildDelta: 0
  };
}

async function listGitHubAppDeliveries(fetchImpl, config) {
  const response = await fetchImpl("https://api.github.com/app/hook/deliveries?per_page=100", {
    headers: githubAppHeaders(config),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`GitHub App delivery inventory failed with HTTP ${response.status}`);
  return requiredArray(await response.json(), "GitHub App deliveries").filter(isObject);
}

async function getGitHubAppDelivery(fetchImpl, config, id) {
  const response = await fetchImpl(`https://api.github.com/app/hook/deliveries/${id}`, {
    headers: githubAppHeaders(config),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`GitHub App delivery detail failed with HTTP ${response.status}`);
  return requiredObject(await response.json(), "GitHub App delivery detail");
}

function githubAppHeaders(config) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${githubAppJwt(config.githubAppId, config.githubAppPrivateKey)}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "jina-context-production-trigger-acceptance"
  };
}

function fixtureGithubAppHeaders(config) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${githubAppJwt(config.fixtureGithubAppId, config.fixtureGithubAppPrivateKey)}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "jina-context-production-trigger-acceptance"
  };
}

function deliveryPayloadMatches(payload, expected) {
  if (
    expected.commentId !== undefined &&
    Number(requiredObject(payload.comment, "delivery comment").id) !== expected.commentId
  ) {
    return false;
  }
  if (
    expected.issueNumber !== undefined &&
    Number(requiredObject(payload.issue, "delivery issue").number) !== expected.issueNumber
  ) {
    return false;
  }
  if (expected.ref !== undefined && payload.ref !== expected.ref) return false;
  if (expected.commitSha !== undefined) {
    const observed =
      typeof payload.after === "string"
        ? payload.after
        : requiredObject(requiredObject(payload.pull_request, "delivery pull request").head, "pull request head").sha;
    if (observed !== expected.commitSha) return false;
  }
  if (expected.pullRequestNumber !== undefined && Number(payload.number) !== expected.pullRequestNumber) {
    return false;
  }
  return true;
}

function deliveryGuid(root) {
  const index = root.requestKey.lastIndexOf(":");
  if (index < 0 || index === root.requestKey.length - 1) {
    throw new Error(`${root.trigger} request key lacks a GitHub delivery GUID`);
  }
  return root.requestKey.slice(index + 1);
}

function githubAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: String(appId) }));
  const signingInput = `${header}.${payload}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function cleanupResource(kind, identifier, cleanup, violations, operation) {
  if (identifier === undefined || identifier === null || identifier === false) return;
  try {
    await operation();
    cleanup.push({ kind, identifier, status: "cleaned" });
  } catch (error) {
    cleanup.push({ kind, identifier, status: "failed", error: safeError(error) });
    violations.push({ code: "cleanup_failed", message: `${kind} ${identifier}: ${safeError(error)}` });
  }
}

function releaseSummary(release) {
  return {
    id: release.id,
    ref: release.ref,
    commitSha: release.commitSha,
    contextStatus: release.contextStatus
  };
}

function deliverySummary(delivery) {
  return {
    id: delivery.id,
    guid: delivery.guid,
    event: delivery.event,
    action: delivery.action,
    deliveredAt: delivery.delivered_at,
    statusCode: delivery.status_code,
    repositoryId: delivery.repository_id,
    installationId: delivery.installation_id
  };
}

function nextRefSequence(roots, ref) {
  return roots.filter((root) => root.ref === ref).reduce((maximum, root) => Math.max(maximum, root.refSequence), 0) + 1;
}

function githubRequestKeyPattern(prefix) {
  return new RegExp(`^${escapeRegExp(prefix)}[A-Za-z0-9._:-]+$`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePrivateKey(value) {
  const normalized = value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
  if (!normalized.includes("BEGIN") || !normalized.includes("PRIVATE KEY")) {
    throw new Error("githubAppPrivateKey is not a PEM private key");
  }
  return normalized;
}

function safeRef(value, label) {
  const ref = requiredString(value, label);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.endsWith("/") ||
    ref.endsWith(".")
  ) {
    throw new Error(`${label} is not a safe Git ref`);
  }
  return ref;
}

function requiredRepository(value) {
  const repository = requiredString(value, "repository").toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must be owner/name");
  }
  return repository;
}

function requiredGitSha(value, label) {
  const sha = requiredString(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${label} must be a full Git SHA`);
  return sha;
}

function requiredPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function optionalPositiveInteger(value, label) {
  return value === undefined || value === null || value === "" ? undefined : requiredPositiveInteger(value, label);
}

function boundedInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredSecret(value, label) {
  const secret = requiredString(value, label);
  if (secret.length < 16) throw new Error(`${label} is invalid`);
  return secret;
}

function requiredObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function objectOrEmpty(value) {
  return isObject(value) ? value : {};
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 1_000);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`unexpected argument ${argument}`);
    if (argument === "--use-github-token-override") {
      options.useGithubTokenOverride = true;
      continue;
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    const key = {
      "api-url": "apiUrl",
      tenant: "tenantId",
      principal: "principalId",
      repository: "repository",
      "installation-id": "installationId",
      "fixture-installation-id": "fixtureInstallationId",
      "confirm-repository": "confirmRepository",
      report: "report",
      "default-branch": "defaultBranch",
      "run-id": "runId",
      "timeout-ms": "timeoutMs",
      "poll-ms": "pollMs",
      "comment-quiet-ms": "commentQuietMs",
      "delivery-timeout-ms": "deliveryTimeoutMs"
    }[name];
    if (!key) throw new Error(`unknown option ${argument}`);
    options[key] = value;
  }
  return options;
}

async function retainReport(path, report) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(destination, 0o600);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const reportPath = requiredString(options.report, "report");
  const report = await runProductionTriggerAcceptance({
    ...options,
    internalToken: process.env.INTERNAL_API_TOKEN,
    githubToken: process.env.GITHUB_TOKEN,
    githubAppId: process.env.GITHUB_APP_ID,
    githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    fixtureGithubAppId: process.env.GITHUB_FIXTURE_APP_ID,
    fixtureGithubAppPrivateKey: process.env.GITHUB_FIXTURE_APP_PRIVATE_KEY,
    allowedRepository: process.env.JINA_TRIGGER_ACCEPTANCE_ALLOWED_REPOSITORY ?? CONTROLLED_REPOSITORY
  });
  await retainReport(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Production trigger acceptance failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
