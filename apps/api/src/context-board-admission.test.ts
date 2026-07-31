import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyBoardState, findTask, leaseNextOutboxMessage, transitionBoardTask } from "@jina/board";
import { contextBoardTaskTypes } from "@jina/context-engine";
import { parseGitHubWebhook, type GitHubWebhookEvent } from "@jina/github";
import { admitContextBoardBuild } from "./context-board-admission.js";

const NOW = "2026-07-29T21:00:00.000Z";
const LATER = "2026-07-29T21:01:00.000Z";
const TENANT = "tenant-1";
const REPOSITORY = "OmXYZ/Jina";
const INSTALLATION = 314;

test("manual admission creates the board root atomically with authoritative scope", () => {
  const commitSha = "A".repeat(40);
  const admitted = admitContextBoardBuild(createEmptyBoardState(), {
    source: "manual",
    tenantId: ` ${TENANT} `,
    repository: REPOSITORY,
    ref: "release",
    requestKey: " manual:release ",
    commitSha,
    githubInstallationId: INSTALLATION,
    derivationDetail: "thorough",
    derivationBudgetSeconds: 900,
    now: NOW
  });

  assert.equal(admitted.outcome, "created");
  assert.equal(admitted.state.tasks.length, 3);
  assert.equal(admitted.scope.refSequence, 1);
  assert.equal(admitted.scope.repository, "omxyz/jina");
  const build = findTask(admitted.state, admitted.build.buildTaskId)!;
  assert.equal(build.type, contextBoardTaskTypes.build);
  assert.deepEqual(
    {
      tenantId: build.metadata.tenantId,
      repository: build.metadata.repository,
      ref: build.metadata.ref,
      requestKey: build.metadata.requestKey,
      commitSha: build.metadata.commitSha,
      githubInstallationId: build.metadata.githubInstallationId,
      refSequence: build.metadata.refSequence,
      derivationDetail: build.metadata.derivationDetail,
      derivationBudgetSeconds: build.metadata.derivationBudgetSeconds,
      trigger: build.metadata.trigger
    },
    {
      tenantId: TENANT,
      repository: "omxyz/jina",
      ref: "release",
      requestKey: "manual:release",
      commitSha: commitSha.toLowerCase(),
      githubInstallationId: INSTALLATION,
      refSequence: 1,
      derivationDetail: "thorough",
      derivationBudgetSeconds: 900,
      trigger: "manual"
    }
  );
  assert.equal(admitted.state.outbox.length, 1);
  assert.equal(admitted.state.outbox[0]?.topic, "run-context-input-snapshot");
});

test("push, PR opened/synchronize, and issue opened map to provider-idempotent board scopes", () => {
  const pushSha = "1".repeat(40);
  const prHeadOne = "2".repeat(40);
  const prHeadTwo = "3".repeat(40);
  let state = createEmptyBoardState();

  const push = github(state, pushEvent(pushSha, "refs/heads/release"), "delivery-push");
  assert.equal(push.outcome, "created");
  assertScope(push, {
    ref: "release",
    requestKey: `github:push:omxyz/jina:release:${pushSha}:delivery-push`,
    commitSha: pushSha,
    refSequence: 1,
    trigger: "push"
  });
  state = push.state;

  const opened = github(state, prEvent("pull_request.opened", 17, prHeadOne), "delivery-pr-open");
  assert.equal(opened.outcome, "created");
  assertScope(opened, {
    ref: "pull/17/head",
    requestKey: `github:pull:omxyz/jina:17:${prHeadOne}:delivery-pr-open`,
    commitSha: prHeadOne,
    refSequence: 1,
    trigger: "pull_request"
  });
  state = opened.state;

  const synchronized = github(state, prEvent("pull_request.synchronize", 17, prHeadTwo), "delivery-pr-sync");
  assert.equal(synchronized.outcome, "created");
  assertScope(synchronized, {
    ref: "pull/17/head",
    requestKey: `github:pull:omxyz/jina:17:${prHeadTwo}:delivery-pr-sync`,
    commitSha: prHeadTwo,
    refSequence: 2,
    trigger: "pull_request"
  });
  state = synchronized.state;

  const issue = github(
    state,
    { type: "issue.opened", issueNumber: 91, title: "Document recovery" },
    "delivery-issue",
    "trunk"
  );
  assert.equal(issue.outcome, "created");
  assertScope(issue, {
    ref: "trunk",
    requestKey: "github:issue:omxyz/jina:91",
    refSequence: 1,
    trigger: "issue"
  });
  assert.equal(buildTask(issue).metadata.commitSha, undefined);
});

test("same GitHub delivery and manual request replay create no board work and retain the original sequence", () => {
  const headSha = "4".repeat(40);
  const first = github(createEmptyBoardState(), pushEvent(headSha), "delivery-1");
  assert.equal(first.outcome, "created");
  const taskCount = first.state.tasks.length;
  const outboxCount = first.state.outbox.length;

  const duplicateDelivery = github(first.state, pushEvent(headSha), "delivery-1");
  assert.equal(duplicateDelivery.outcome, "duplicate");
  assert.equal("build" in duplicateDelivery, false);
  assert.strictEqual(duplicateDelivery.state, first.state);
  assert.equal(duplicateDelivery.refSequence, 1);
  assert.equal(duplicateDelivery.state.tasks.length, taskCount);
  assert.equal(duplicateDelivery.state.outbox.length, outboxCount);

  const manual = admitContextBoardBuild(createEmptyBoardState(), {
    source: "manual",
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: "main",
    requestKey: "manual:replay",
    now: NOW
  });
  assert.equal(manual.outcome, "created");
  const manualReplay = admitContextBoardBuild(manual.state, {
    source: "manual",
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: "main",
    requestKey: "manual:replay",
    now: LATER
  });
  assert.equal(manualReplay.outcome, "duplicate");
  assert.strictEqual(manualReplay.state, manual.state);
  assert.equal(manualReplay.refSequence, 1);
});

test("admission binds only a prior published release for the exact tenant, repository, and ref", () => {
  const first = admitContextBoardBuild(createEmptyBoardState(), {
    source: "manual",
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: "main",
    requestKey: "manual:first",
    commitSha: "1".repeat(40),
    now: NOW
  });
  assert.equal(first.outcome, "created");
  const priorRelease = {
    version: 1 as const,
    tenantId: TENANT,
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    commitSha: "1".repeat(40),
    releaseId: "cr_prior",
    publicSnapshotDigest: "2".repeat(64),
    releaseArtifact: {
      uri: "file:///prior.json",
      key: "context-v2/tenants/tenant-1/repositories/omxyz/jina/builds/task_prior/context-release/cr_prior.json",
      contentType: "application/json",
      bytes: 1,
      sha256: "3".repeat(64)
    }
  };
  const incremental = admitContextBoardBuild(first.state, {
    source: "manual",
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: "main",
    requestKey: "manual:provider-only",
    commitSha: priorRelease.commitSha,
    priorRelease,
    now: LATER
  });
  assert.equal(incremental.outcome, "created");
  assert.equal(incremental.scope.refSequence, 2);
  assert.deepEqual(buildTask(incremental).metadata.priorRelease, priorRelease);

  assert.throws(
    () =>
      admitContextBoardBuild(first.state, {
        source: "manual",
        tenantId: TENANT,
        repository: REPOSITORY,
        ref: "release",
        requestKey: "manual:wrong-ref",
        priorRelease,
        now: LATER
      }),
    /prior Context release does not precede the exact build scope/
  );
});

test("same-delivery replay is idempotent while a distinct-delivery rollback advances the ref", () => {
  const oldHead = "5".repeat(40);
  const newHead = "6".repeat(40);
  const nextHead = "7".repeat(40);
  const old = github(createEmptyBoardState(), pushEvent(oldHead), "delivery-old");
  assert.equal(old.outcome, "created");
  const newer = github(old.state, pushEvent(newHead), "delivery-new");
  assert.equal(newer.outcome, "created");
  assert.equal(newer.scope.refSequence, 2);

  const delayedReplay = github(newer.state, pushEvent(oldHead), "delivery-old");
  assert.equal(delayedReplay.outcome, "duplicate");
  assert.equal(delayedReplay.refSequence, 1);
  assert.strictEqual(delayedReplay.state, newer.state);

  const rollback = github(delayedReplay.state, pushEvent(oldHead), "delivery-rollback");
  assert.equal(rollback.outcome, "created");
  assert.equal(rollback.scope.refSequence, 3);
  assert.notEqual(rollback.build.buildTaskId, old.build.buildTaskId);

  const next = github(rollback.state, pushEvent(nextHead), "delivery-next");
  assert.equal(next.outcome, "created");
  assert.equal(next.scope.refSequence, 4);

  const otherRef = github(next.state, pushEvent("8".repeat(40), "refs/heads/other"), "delivery-other-ref");
  assert.equal(otherRef.outcome, "created");
  assert.equal(otherRef.scope.refSequence, 1);
});

test("GitHub idempotency keys are independently scoped by repository and push ref", () => {
  const headSha = "b".repeat(40);
  const repositoryA = "Example/Repo-A";
  const repositoryB = "example/repo-b";
  let state = createEmptyBoardState();

  const mainA = github(state, pushEvent(headSha), "delivery-main-a", "main", repositoryA);
  assert.equal(mainA.outcome, "created");
  assert.equal(mainA.scope.requestKey, `github:push:example/repo-a:main:${headSha}:delivery-main-a`);
  assert.equal(mainA.scope.refSequence, 1);
  state = mainA.state;

  const releaseA = github(state, pushEvent(headSha, "refs/heads/release"), "delivery-release-a", "main", repositoryA);
  assert.equal(releaseA.outcome, "created");
  assert.equal(releaseA.scope.requestKey, `github:push:example/repo-a:release:${headSha}:delivery-release-a`);
  assert.equal(releaseA.scope.refSequence, 1);
  state = releaseA.state;

  const mainB = github(state, pushEvent(headSha), "delivery-main-b", "main", repositoryB);
  assert.equal(mainB.outcome, "created");
  assert.equal(mainB.scope.requestKey, `github:push:example/repo-b:main:${headSha}:delivery-main-b`);
  assert.equal(mainB.scope.refSequence, 1);
  state = mainB.state;

  const issueA = github(
    state,
    { type: "issue.opened", issueNumber: 12, title: "Repository A issue" },
    "delivery-issue-a",
    "main",
    repositoryA
  );
  assert.equal(issueA.outcome, "created");
  assert.equal(issueA.scope.requestKey, "github:issue:example/repo-a:12");
  assert.equal(issueA.scope.refSequence, 2);
  state = issueA.state;

  const issueB = github(
    state,
    { type: "issue.opened", issueNumber: 12, title: "Repository B issue" },
    "delivery-issue-b",
    "main",
    repositoryB
  );
  assert.equal(issueB.outcome, "created");
  assert.equal(issueB.scope.requestKey, "github:issue:example/repo-b:12");
  assert.equal(issueB.scope.refSequence, 2);
  state = issueB.state;

  const pullA = github(state, prEvent("pull_request.opened", 23, headSha), "delivery-pull-a", "main", repositoryA);
  assert.equal(pullA.outcome, "created");
  assert.equal(pullA.scope.requestKey, `github:pull:example/repo-a:23:${headSha}:delivery-pull-a`);
  assert.equal(pullA.scope.refSequence, 1);
  state = pullA.state;

  const pullB = github(state, prEvent("pull_request.opened", 23, headSha), "delivery-pull-b", "main", repositoryB);
  assert.equal(pullB.outcome, "created");
  assert.equal(pullB.scope.requestKey, `github:pull:example/repo-b:23:${headSha}:delivery-pull-b`);
  assert.equal(pullB.scope.refSequence, 1);
  assert.equal(pullB.state.tasks.length, 7 * 3);
});

test("a distinct PR synchronize delivery advances even when the head returns to an earlier SHA", () => {
  const firstHead = "c".repeat(40);
  const secondHead = "d".repeat(40);
  const opened = github(createEmptyBoardState(), prEvent("pull_request.opened", 41, firstHead), "delivery-pr-open");
  assert.equal(opened.outcome, "created");
  assert.equal(opened.scope.refSequence, 1);

  const synchronized = github(
    opened.state,
    prEvent("pull_request.synchronize", 41, secondHead),
    "delivery-pr-synchronize"
  );
  assert.equal(synchronized.outcome, "created");
  assert.equal(synchronized.scope.refSequence, 2);

  const replay = github(
    synchronized.state,
    prEvent("pull_request.synchronize", 41, secondHead),
    "delivery-pr-synchronize"
  );
  assert.equal(replay.outcome, "duplicate");
  assert.equal(replay.refSequence, 2);
  assert.strictEqual(replay.state, synchronized.state);

  const rollback = github(replay.state, prEvent("pull_request.synchronize", 41, firstHead), "delivery-pr-rollback");
  assert.equal(rollback.outcome, "created");
  assert.equal(rollback.scope.refSequence, 3);
  assert.notEqual(rollback.build.buildTaskId, opened.build.buildTaskId);
});

test("a newer PR commit cancels older queued work while replay leaves the newest build active", () => {
  const first = github(
    createEmptyBoardState(),
    prEvent("pull_request.opened", 52, "1".repeat(40)),
    "delivery-pr-52-open"
  );
  assert.equal(first.outcome, "created");

  const newer = github(first.state, prEvent("pull_request.synchronize", 52, "2".repeat(40)), "delivery-pr-52-sync");
  assert.equal(newer.outcome, "created");
  assert.deepEqual(newer.supersededBuildTaskIds, [first.build.buildTaskId]);
  assert.equal(findTask(newer.state, first.build.buildTaskId)?.status, "canceled");
  assert.equal(findTask(newer.state, first.build.graphTaskId)?.status, "canceled");
  assert.equal(findTask(newer.state, first.build.snapshotTaskId)?.status, "canceled");
  assert.equal(findTask(newer.state, newer.build.buildTaskId)?.status, "triage");
  assert.equal(findTask(newer.state, newer.build.snapshotTaskId)?.status, "queued");

  const staleMessage = newer.state.outbox.find((message) => message.taskId === first.build.snapshotTaskId);
  assert.equal(staleMessage?.status, "dispatched");
  assert.equal(
    leaseNextOutboxMessage(newer.state, {
      topics: ["run-context-input-snapshot"],
      taskIds: [first.build.snapshotTaskId],
      leaseId: "lease-stale",
      writeFenceToken: "fence-stale",
      now: LATER,
      expiresAt: "2026-07-29T21:02:00.000Z"
    }),
    undefined
  );
  const supersededEvent = newer.state.events.find(
    (event) => event.taskId === first.build.buildTaskId && event.type === "context.build_superseded.failed"
  );
  assert.deepEqual(supersededEvent?.payload, {
    actor: "context-build-admission",
    failureCategory: "build_superseded",
    reason: "superseded by a newer pull request commit",
    supersededByBuildTaskId: newer.build.buildTaskId
  });

  const replay = github(newer.state, prEvent("pull_request.synchronize", 52, "2".repeat(40)), "delivery-pr-52-sync");
  assert.equal(replay.outcome, "duplicate");
  assert.strictEqual(replay.state, newer.state);
  assert.equal(findTask(replay.state, newer.build.buildTaskId)?.status, "triage");
});

test("a newer PR commit retires an active lease and preserves unrelated or terminal builds", () => {
  const first = github(
    createEmptyBoardState(),
    prEvent("pull_request.opened", 61, "3".repeat(40)),
    "delivery-pr-61-open"
  );
  assert.equal(first.outcome, "created");
  const unrelated = github(first.state, prEvent("pull_request.opened", 62, "4".repeat(40)), "delivery-pr-62-open");
  assert.equal(unrelated.outcome, "created");
  const otherRepository = github(
    unrelated.state,
    prEvent("pull_request.opened", 61, "4".repeat(40)),
    "delivery-pr-61-other-repository",
    "main",
    "example/other"
  );
  assert.equal(otherRepository.outcome, "created");
  const otherTenant = github(
    otherRepository.state,
    prEvent("pull_request.opened", 61, "4".repeat(40)),
    "delivery-pr-61-other-tenant",
    "main",
    REPOSITORY,
    "tenant-2"
  );
  assert.equal(otherTenant.outcome, "created");
  const leased = leaseNextOutboxMessage(otherTenant.state, {
    topics: ["run-context-input-snapshot"],
    taskIds: [first.build.snapshotTaskId],
    leaseId: "lease-active",
    writeFenceToken: "fence-active",
    now: NOW,
    expiresAt: "2026-07-29T21:02:00.000Z"
  });
  assert.ok(leased);
  const active = transitionBoardTask(leased.state, first.build.snapshotTaskId, "in_progress", NOW);

  const newer = github(active, prEvent("pull_request.synchronize", 61, "5".repeat(40)), "delivery-pr-61-sync");
  assert.equal(newer.outcome, "created");
  assert.equal(findTask(newer.state, first.build.snapshotTaskId)?.status, "canceled");
  const retired = newer.state.outbox.find((message) => message.taskId === first.build.snapshotTaskId);
  assert.equal(retired?.status, "dispatched");
  assert.equal(retired?.dispatchedLeaseId, "lease-active");
  assert.equal(findTask(newer.state, unrelated.build.buildTaskId)?.status, "triage");
  assert.equal(findTask(newer.state, otherRepository.build.buildTaskId)?.status, "triage");
  assert.equal(findTask(newer.state, otherTenant.build.buildTaskId)?.status, "triage");

  const newest = github(newer.state, prEvent("pull_request.synchronize", 61, "6".repeat(40)), "delivery-pr-61-newest");
  assert.equal(newest.outcome, "created");
  assert.deepEqual(newest.supersededBuildTaskIds, [newer.build.buildTaskId]);
  assert.equal(findTask(newest.state, first.build.buildTaskId)?.status, "canceled");
  assert.equal(findTask(newest.state, unrelated.build.buildTaskId)?.status, "triage");
  assert.equal(findTask(newest.state, otherRepository.build.buildTaskId)?.status, "triage");
  assert.equal(findTask(newest.state, otherTenant.build.buildTaskId)?.status, "triage");
  assert.equal(findTask(newest.state, newest.build.buildTaskId)?.status, "triage");
});

test("same-commit PR deliveries and non-PR admissions do not supersede builds", () => {
  const head = "7".repeat(40);
  const opened = github(createEmptyBoardState(), prEvent("pull_request.opened", 71, head), "delivery-pr-71-open");
  assert.equal(opened.outcome, "created");
  const sameCommit = github(opened.state, prEvent("pull_request.synchronize", 71, head), "delivery-pr-71-same-commit");
  assert.equal(sameCommit.outcome, "created");
  assert.deepEqual(sameCommit.supersededBuildTaskIds, []);
  assert.equal(findTask(sameCommit.state, opened.build.buildTaskId)?.status, "triage");

  const pushed = github(sameCommit.state, pushEvent("8".repeat(40)), "delivery-push-newer");
  assert.equal(pushed.outcome, "created");
  assert.deepEqual(pushed.supersededBuildTaskIds, []);
  assert.equal(findTask(pushed.state, opened.build.buildTaskId)?.status, "triage");
  assert.equal(findTask(pushed.state, sameCommit.build.buildTaskId)?.status, "triage");
});

test("comments, reviews, labels, edits, closes, deleted pushes, and tag pushes create no Context build", () => {
  const unsupported = [
    ["issue_comment", { action: "created" }],
    ["pull_request_review", { action: "submitted" }],
    ["pull_request_review_comment", { action: "created" }],
    ["issues", providerPayload("labeled")],
    ["issues", providerPayload("edited")],
    ["issues", providerPayload("closed")],
    ["pull_request", providerPayload("labeled")],
    ["pull_request", providerPayload("edited")],
    ["pull_request", providerPayload("closed")]
  ] as const;

  let state = createEmptyBoardState();
  for (const [eventName, payload] of unsupported) {
    const parsed = parseGitHubWebhook(eventName, Buffer.from(JSON.stringify(payload)));
    assert.equal(parsed, undefined);
    const ignored = github(state, undefined, `delivery-${eventName}`);
    assert.equal(ignored.outcome, "ignored");
    assert.equal("build" in ignored, false);
    assert.strictEqual(ignored.state, state);
    state = ignored.state;
  }

  for (const event of [{ ...pushEvent("9".repeat(40)), deleted: true }, pushEvent("a".repeat(40), "refs/tags/v1")]) {
    const ignored = github(state, event, "delivery-ignored-push");
    assert.equal(ignored.outcome, "ignored");
    assert.strictEqual(ignored.state, state);
  }
  assert.equal(state.tasks.length, 0);
  assert.equal(state.outbox.length, 0);
});

test("issue admission requires the authoritative default branch", () => {
  assert.throws(
    () =>
      admitContextBoardBuild(createEmptyBoardState(), {
        source: "github",
        tenantId: TENANT,
        repository: REPOSITORY,
        githubInstallationId: INSTALLATION,
        deliveryId: "delivery-issue",
        event: { type: "issue.opened", issueNumber: 4, title: "Missing default branch" },
        now: NOW
      }),
    /authoritative default branch/
  );
});

test("request-key collisions fail closed across repository, ref, commit, and installation scope", () => {
  const first = admitContextBoardBuild(createEmptyBoardState(), {
    source: "manual",
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: "main",
    requestKey: "manual:collision",
    commitSha: "b".repeat(40),
    githubInstallationId: INSTALLATION,
    now: NOW
  });
  assert.equal(first.outcome, "created");

  for (const mismatch of [
    { repository: "other/repository", ref: "main", commitSha: "b".repeat(40), githubInstallationId: INSTALLATION },
    { repository: REPOSITORY, ref: "release", commitSha: "b".repeat(40), githubInstallationId: INSTALLATION },
    { repository: REPOSITORY, ref: "main", commitSha: "c".repeat(40), githubInstallationId: INSTALLATION },
    { repository: REPOSITORY, ref: "main", commitSha: "b".repeat(40), githubInstallationId: INSTALLATION + 1 }
  ]) {
    assert.throws(
      () =>
        admitContextBoardBuild(first.state, {
          source: "manual",
          tenantId: TENANT,
          requestKey: "manual:collision",
          now: LATER,
          ...mismatch
        }),
      /request key is already bound to a different scope/
    );
  }

  const otherTenant = admitContextBoardBuild(first.state, {
    source: "manual",
    tenantId: "tenant-2",
    repository: REPOSITORY,
    ref: "main",
    requestKey: "manual:collision",
    commitSha: "b".repeat(40),
    githubInstallationId: INSTALLATION,
    now: LATER
  });
  assert.equal(otherTenant.outcome, "created");
  assert.equal(otherTenant.scope.refSequence, 1);
});

function github(
  state: ReturnType<typeof createEmptyBoardState>,
  event: GitHubWebhookEvent | undefined,
  deliveryId: string,
  defaultBranch = "main",
  repository = REPOSITORY,
  tenantId = TENANT
) {
  return admitContextBoardBuild(state, {
    source: "github",
    tenantId,
    repository,
    githubInstallationId: INSTALLATION,
    deliveryId,
    ...(event ? { event } : {}),
    defaultBranch,
    now: NOW
  });
}

function pushEvent(headSha: string, ref = "refs/heads/main"): GitHubWebhookEvent {
  return { type: "push", ref, headSha, deleted: false };
}

function prEvent(
  type: "pull_request.opened" | "pull_request.synchronize",
  pullRequestNumber: number,
  headSha: string
): GitHubWebhookEvent {
  return { type, pullRequestNumber, headSha };
}

function assertScope(
  result: ReturnType<typeof github>,
  expected: {
    readonly ref: string;
    readonly requestKey: string;
    readonly commitSha?: string;
    readonly refSequence: number;
    readonly trigger: string;
  }
): void {
  assert.equal(result.outcome, "created");
  const task = buildTask(result);
  assert.equal(task.metadata.ref, expected.ref);
  assert.equal(task.metadata.requestKey, expected.requestKey);
  assert.equal(task.metadata.commitSha, expected.commitSha);
  assert.equal(task.metadata.refSequence, expected.refSequence);
  assert.equal(task.metadata.trigger, expected.trigger);
  assert.equal(task.metadata.tenantId, TENANT);
  assert.equal(task.metadata.repository, "omxyz/jina");
  assert.equal(task.metadata.githubInstallationId, INSTALLATION);
}

function buildTask(result: ReturnType<typeof github>) {
  assert.equal(result.outcome, "created");
  return findTask(result.state, result.build.buildTaskId)!;
}

function providerPayload(action: string): Record<string, unknown> {
  return {
    action,
    repository: {
      full_name: REPOSITORY,
      default_branch: "main",
      owner: { id: 1, login: "omxyz", type: "Organization" }
    },
    installation: { id: INSTALLATION }
  };
}
