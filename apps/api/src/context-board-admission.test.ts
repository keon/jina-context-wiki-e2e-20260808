import assert from "node:assert/strict";
import test from "node:test";
import { applyCommand, createEmptyBoardState, findTask, transitionBoardTask } from "@jina/board";
import { contextBoardTaskTypes, createContextBoardBuild } from "@jina/context-engine";
import { parseGitHubWebhook, type GitHubWebhookEvent } from "@jina/github";
import { admitContextBoardBuild, latestContextBoardFollowup } from "./context-board-admission.js";

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
  const push = github(createEmptyBoardState(), pushEvent(pushSha), "delivery-push");
  assert.equal(push.outcome, "created");
  assertScope(push, {
    ref: "main",
    requestKey: `github:push:omxyz/jina:main:${pushSha}:delivery-push`,
    commitSha: pushSha,
    refSequence: 1,
    trigger: "push"
  });
  const opened = github(createEmptyBoardState(), prEvent("pull_request.opened", 17, prHeadOne), "delivery-pr-open");
  assert.equal(opened.outcome, "created");
  assertScope(opened, {
    ref: "pull/17/head",
    requestKey: `github:pull:omxyz/jina:17:${prHeadOne}:delivery-pr-open`,
    commitSha: prHeadOne,
    refSequence: 1,
    trigger: "pull_request"
  });
  const synchronized = github(opened.state, prEvent("pull_request.synchronize", 17, prHeadTwo), "delivery-pr-sync");
  assert.equal(synchronized.outcome, "deferred");
  assert.deepEqual(synchronized.scope, {
    tenantId: TENANT,
    repository: "omxyz/jina",
    ref: "pull/17/head",
    requestKey: `github:pull:omxyz/jina:17:${prHeadTwo}:delivery-pr-sync`,
    commitSha: prHeadTwo,
    githubInstallationId: INSTALLATION,
    trigger: "pull_request"
  });

  const issue = github(
    createEmptyBoardState(),
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
      key: "context/tenants/tenant-1/repositories/omxyz/jina/builds/task_prior/context-release/cr_prior.json",
      contentType: "application/json",
      bytes: 1,
      sha256: "3".repeat(64)
    }
  };
  const completed = transitionBoardTask(first.state, first.build.buildTaskId, "done", LATER);
  const incremental = admitContextBoardBuild(completed, {
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
  assert.deepEqual(buildTask(incremental).metadata.priorRelease, {
    ...priorRelease,
    contract: "page-oriented",
    schemaRevision: 1
  });

  assert.throws(
    () =>
      admitContextBoardBuild(completed, {
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

test("same-delivery replay is idempotent while later commits coalesce behind the running build", () => {
  const oldHead = "5".repeat(40);
  const newHead = "6".repeat(40);
  const nextHead = "7".repeat(40);
  const old = github(createEmptyBoardState(), pushEvent(oldHead), "delivery-old");
  assert.equal(old.outcome, "created");
  const newer = github(old.state, pushEvent(newHead), "delivery-new");
  assert.equal(newer.outcome, "deferred");

  const delayedReplay = github(newer.state, pushEvent(oldHead), "delivery-old");
  assert.equal(delayedReplay.outcome, "duplicate");
  assert.equal(delayedReplay.refSequence, 1);
  assert.strictEqual(delayedReplay.state, newer.state);

  const rollback = github(delayedReplay.state, pushEvent(oldHead), "delivery-rollback");
  assert.equal(rollback.outcome, "deferred");

  const next = github(rollback.state, pushEvent(nextHead), "delivery-next");
  assert.equal(next.outcome, "deferred");
  assert.equal(next.state.events.filter((event) => event.type === "context.build_followup_requested").length, 1);
  const completed = transitionBoardTask(next.state, old.build.buildTaskId, "done", LATER);
  assert.equal(latestContextBoardFollowup(completed, old.build.buildTaskId)?.commitSha, nextHead);

  const otherRef = github(next.state, pushEvent("8".repeat(40), "refs/heads/other"), "delivery-other-ref");
  assert.equal(otherRef.outcome, "ignored");
  assert.strictEqual(otherRef.state, next.state);
});

test("GitHub idempotency keys are independently scoped by repository and authoritative default ref", () => {
  const headSha = "b".repeat(40);
  const repositoryA = "Example/Repo-A";
  const repositoryB = "example/repo-b";

  const mainA = github(createEmptyBoardState(), pushEvent(headSha), "delivery-main-a", "main", repositoryA);
  assert.equal(mainA.outcome, "created");
  assert.equal(mainA.scope.requestKey, `github:push:example/repo-a:main:${headSha}:delivery-main-a`);
  assert.equal(mainA.scope.refSequence, 1);

  const releaseA = github(
    createEmptyBoardState(),
    pushEvent(headSha, "refs/heads/release"),
    "delivery-release-a",
    "release",
    repositoryA
  );
  assert.equal(releaseA.outcome, "created");
  assert.equal(releaseA.scope.requestKey, `github:push:example/repo-a:release:${headSha}:delivery-release-a`);
  assert.equal(releaseA.scope.refSequence, 1);

  const mainB = github(createEmptyBoardState(), pushEvent(headSha), "delivery-main-b", "main", repositoryB);
  assert.equal(mainB.outcome, "created");
  assert.equal(mainB.scope.requestKey, `github:push:example/repo-b:main:${headSha}:delivery-main-b`);
  assert.equal(mainB.scope.refSequence, 1);
  const issueA = github(
    createEmptyBoardState(),
    { type: "issue.opened", issueNumber: 12, title: "Repository A issue" },
    "delivery-issue-a",
    "main",
    repositoryA
  );
  assert.equal(issueA.outcome, "created");
  assert.equal(issueA.scope.requestKey, "github:issue:example/repo-a:12");
  assert.equal(issueA.scope.refSequence, 1);

  const issueB = github(
    createEmptyBoardState(),
    { type: "issue.opened", issueNumber: 12, title: "Repository B issue" },
    "delivery-issue-b",
    "main",
    repositoryB
  );
  assert.equal(issueB.outcome, "created");
  assert.equal(issueB.scope.requestKey, "github:issue:example/repo-b:12");
  assert.equal(issueB.scope.refSequence, 1);

  const pullA = github(
    createEmptyBoardState(),
    prEvent("pull_request.opened", 23, headSha),
    "delivery-pull-a",
    "main",
    repositoryA
  );
  assert.equal(pullA.outcome, "created");
  assert.equal(pullA.scope.requestKey, `github:pull:example/repo-a:23:${headSha}:delivery-pull-a`);
  assert.equal(pullA.scope.refSequence, 1);
  const pullB = github(
    createEmptyBoardState(),
    prEvent("pull_request.opened", 23, headSha),
    "delivery-pull-b",
    "main",
    repositoryB
  );
  assert.equal(pullB.outcome, "created");
  assert.equal(pullB.scope.requestKey, `github:pull:example/repo-b:23:${headSha}:delivery-pull-b`);
  assert.equal(pullB.scope.refSequence, 1);
});

test("PR synchronizations queue the newest head without canceling the running predecessor", () => {
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
  assert.equal(synchronized.outcome, "deferred");
  assert.equal(findTask(synchronized.state, opened.build.buildTaskId)?.status, "triage");

  const replay = github(
    synchronized.state,
    prEvent("pull_request.synchronize", 41, secondHead),
    "delivery-pr-synchronize"
  );
  assert.equal(replay.outcome, "deferred");
  assert.strictEqual(replay.state, synchronized.state);

  const rollback = github(replay.state, prEvent("pull_request.synchronize", 41, firstHead), "delivery-pr-rollback");
  assert.equal(rollback.outcome, "deferred");
  const completed = transitionBoardTask(rollback.state, opened.build.buildTaskId, "done", LATER);
  assert.equal(latestContextBoardFollowup(completed, opened.build.buildTaskId)?.commitSha, firstHead);
});

test("one repository keeps independent refs queued while coalescing each ref to its newest commit", () => {
  const first = github(createEmptyBoardState(), pushEvent("1".repeat(40)), "delivery-main-first");
  assert.equal(first.outcome, "created");

  const main = github(first.state, pushEvent("2".repeat(40)), "delivery-main-second");
  assert.equal(main.outcome, "deferred");
  const pull = github(main.state, prEvent("pull_request.opened", 61, "3".repeat(40)), "delivery-pr-open");
  assert.equal(pull.outcome, "deferred");
  const newestMain = github(pull.state, pushEvent("4".repeat(40)), "delivery-main-newest");
  assert.equal(newestMain.outcome, "deferred");

  const queued = newestMain.state.events.filter((event) => event.type === "context.build_followup_requested");
  assert.equal(queued.length, 2);
  assert.deepEqual(queued.map((event) => (event.payload?.followup as { ref: string; commitSha: string }).ref).sort(), [
    "main",
    "pull/61/head"
  ]);
  assert.equal(
    (
      queued.find((event) => (event.payload?.followup as { ref: string }).ref === "main")?.payload?.followup as {
        commitSha: string;
      }
    ).commitSha,
    "4".repeat(40)
  );

  const completed = transitionBoardTask(newestMain.state, first.build.buildTaskId, "done", LATER);
  assert.equal(latestContextBoardFollowup(completed, first.build.buildTaskId)?.commitSha, "3".repeat(40));
});

test("an invested default-ref build retains only the newest follow-up until it becomes terminal", () => {
  const first = github(createEmptyBoardState(), pushEvent("7".repeat(40)), "delivery-push-first");
  assert.equal(first.outcome, "created");
  const active = transitionBoardTask(first.state, first.build.buildTaskId, "in_progress", NOW);

  const second = github(active, pushEvent("8".repeat(40)), "delivery-push-second");
  assert.equal(second.outcome, "deferred");
  assert.equal(second.activeBuildTaskId, first.build.buildTaskId);
  assert.equal(findTask(second.state, first.build.buildTaskId)?.status, "in_progress");
  assert.equal(second.state.tasks.filter((task) => task.type === contextBoardTaskTypes.build).length, 1);

  const newest = github(second.state, pushEvent("9".repeat(40)), "delivery-push-newest");
  assert.equal(newest.outcome, "deferred");
  assert.equal(
    newest.state.events.filter(
      (event) => event.taskId === first.build.buildTaskId && event.type === "context.build_followup_requested"
    ).length,
    1
  );
  const completed = transitionBoardTask(newest.state, first.build.buildTaskId, "done", LATER);
  const followup = latestContextBoardFollowup(completed, first.build.buildTaskId);
  assert.equal(followup?.commitSha, "9".repeat(40));

  const promoted = admitContextBoardBuild(completed, { source: "followup", ...followup, now: LATER });
  assert.equal(promoted.outcome, "created");
  assert.equal(promoted.scope.refSequence, 2);
  assert.equal(promoted.scope.commitSha, "9".repeat(40));
  assert.equal(latestContextBoardFollowup(promoted.state, first.build.buildTaskId), undefined);
});

test("a burst of deferred pushes occupies one bounded follow-up slot", () => {
  const first = github(createEmptyBoardState(), pushEvent("7".repeat(40)), "delivery-burst-first");
  assert.equal(first.outcome, "created");
  let state = transitionBoardTask(first.state, first.build.buildTaskId, "in_progress", NOW);
  const baselineBytes = Buffer.byteLength(JSON.stringify(state));
  let expectedCommit = "";
  for (let index = 1; index <= 1_000; index += 1) {
    expectedCommit = index.toString(16).padStart(40, "0");
    const deferred = github(state, pushEvent(expectedCommit), `delivery-burst-${index}`);
    assert.equal(deferred.outcome, "deferred");
    state = deferred.state;
  }
  assert.equal(
    state.events.filter(
      (event) => event.taskId === first.build.buildTaskId && event.type === "context.build_followup_requested"
    ).length,
    1
  );
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < baselineBytes + 4_096);
  const completed = transitionBoardTask(state, first.build.buildTaskId, "done", LATER);
  assert.equal(latestContextBoardFollowup(completed, first.build.buildTaskId)?.commitSha, expectedCommit);
});

test("a recoverable failed build retains its follow-up until checkpoint repair publishes", () => {
  const first = github(createEmptyBoardState(), pushEvent("7".repeat(40)), "delivery-repair-first");
  assert.equal(first.outcome, "created");
  const active = transitionBoardTask(first.state, first.build.buildTaskId, "in_progress", NOW);
  const deferred = github(active, pushEvent("8".repeat(40)), "delivery-repair-followup");
  assert.equal(deferred.outcome, "deferred");

  const failedSnapshot = transitionBoardTask(
    transitionBoardTask(deferred.state, first.build.snapshotTaskId, "in_progress", NOW),
    first.build.snapshotTaskId,
    "failed",
    LATER
  );
  const failed = transitionBoardTask(failedSnapshot, first.build.buildTaskId, "failed", LATER);

  assert.equal(findTask(failed, first.build.buildTaskId)?.status, "failed");
  assert.equal(latestContextBoardFollowup(failed, first.build.buildTaskId), undefined);
  assert.equal(
    failed.events.filter((event) => event.type === "context.build_followup_requested").length,
    1,
    "the newest follow-up must remain durably attached to the recoverable predecessor"
  );

  const newer = github(failed, pushEvent("9".repeat(40)), "delivery-repair-newer-followup");
  assert.equal(newer.outcome, "deferred");
  assert.equal(newer.activeBuildTaskId, first.build.buildTaskId);
  assert.equal(newer.state.tasks.filter((task) => task.type === contextBoardTaskTypes.build).length, 1);
  assert.equal(
    newer.state.events.filter((event) => event.type === "context.build_followup_requested").length,
    1,
    "a commit arriving after recoverable failure must replace the retained follow-up instead of growing a queue"
  );
  assert.equal(
    newer.state.events.find((event) => event.type === "context.build_followup_requested")?.payload?.commitSha,
    "9".repeat(40)
  );
});

test("a completed newer build retires an older recoverable failure for the same ref", () => {
  const first = github(createEmptyBoardState(), pushEvent("7".repeat(40)), "delivery-recovery-old");
  assert.equal(first.outcome, "created");
  const failedSnapshot = transitionBoardTask(
    transitionBoardTask(first.state, first.build.snapshotTaskId, "in_progress", NOW),
    first.build.snapshotTaskId,
    "failed",
    LATER
  );
  const failed = transitionBoardTask(failedSnapshot, first.build.buildTaskId, "failed", LATER);
  const newer = createContextBoardBuild(failed, {
    tenantId: TENANT,
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 2,
    requestKey: "manual:newer-completed",
    commitSha: "8".repeat(40),
    githubInstallationId: INSTALLATION,
    trigger: "manual",
    now: LATER
  });
  const completed = transitionBoardTask(newer.state, newer.buildTaskId, "done", LATER);

  const admitted = admitContextBoardBuild(completed, {
    source: "manual",
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: "main",
    requestKey: "manual:after-completion",
    commitSha: "9".repeat(40),
    githubInstallationId: INSTALLATION,
    now: LATER
  });

  assert.equal(admitted.outcome, "created");
  assert.equal(admitted.scope.refSequence, 3);
});

test("an unrecoverable failed build releases its queued successor instead of deadlocking the repository", () => {
  const first = github(createEmptyBoardState(), pushEvent("7".repeat(40)), "delivery-terminal-first");
  assert.equal(first.outcome, "created");
  const deferred = github(first.state, pushEvent("8".repeat(40)), "delivery-terminal-followup");
  assert.equal(deferred.outcome, "deferred");
  const failed = transitionBoardTask(deferred.state, first.build.buildTaskId, "failed", LATER);

  assert.equal(latestContextBoardFollowup(failed, first.build.buildTaskId)?.commitSha, "8".repeat(40));
});

test("a deadline-interrupted build retains its follow-up even though its resume anchor is canceled", () => {
  const first = github(createEmptyBoardState(), pushEvent("7".repeat(40)), "delivery-deadline-first");
  assert.equal(first.outcome, "created");
  const active = transitionBoardTask(first.state, first.build.buildTaskId, "in_progress", NOW);
  const deferred = github(active, pushEvent("8".repeat(40)), "delivery-deadline-followup");
  assert.equal(deferred.outcome, "deferred");
  const diagnosed = applyCommand(
    deferred.state,
    {
      command: "CommentTask",
      taskId: first.build.buildTaskId,
      eventType: "context.build_time_budget_exceeded.failed",
      payload: { failureCategory: "build_time_budget_exceeded", reason: "execution budget reached" }
    },
    { actor: { type: "system", id: "test" }, now: LATER }
  );
  assert.equal(diagnosed.accepted, true);
  const failed = transitionBoardTask(diagnosed.state, first.build.buildTaskId, "failed", LATER);
  assert.equal(findTask(failed, first.build.snapshotTaskId)?.status, "canceled");
  assert.equal(latestContextBoardFollowup(failed, first.build.buildTaskId), undefined);

  const newer = github(failed, pushEvent("9".repeat(40)), "delivery-deadline-newer");
  assert.equal(newer.outcome, "deferred");
  assert.equal(newer.activeBuildTaskId, first.build.buildTaskId);
  assert.equal(newer.state.tasks.filter((task) => task.type === contextBoardTaskTypes.build).length, 1);
});

test("a new delivery after predecessor completion stays queued until promotion binds the published seed", () => {
  const first = github(createEmptyBoardState(), pushEvent("7".repeat(40)), "delivery-stale-first");
  assert.equal(first.outcome, "created");
  const active = transitionBoardTask(first.state, first.build.buildTaskId, "in_progress", NOW);
  const deferred = github(active, pushEvent("8".repeat(40)), "delivery-stale-followup");
  assert.equal(deferred.outcome, "deferred");

  const completed = transitionBoardTask(deferred.state, first.build.buildTaskId, "done", LATER);
  const newer = github(completed, pushEvent("9".repeat(40)), "delivery-newer-build");
  assert.equal(newer.outcome, "deferred");

  const followup = latestContextBoardFollowup(newer.state, first.build.buildTaskId);
  assert.equal(followup?.commitSha, "9".repeat(40));
  const promoted = admitContextBoardBuild(newer.state, { source: "followup", ...followup, now: LATER });
  assert.equal(promoted.outcome, "created");
  assert.equal(promoted.scope.refSequence, 2);
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

test("a push to a non-default branch does not duplicate its pull-request Context build", () => {
  const ignored = github(
    createEmptyBoardState(),
    pushEvent("7".repeat(40), "refs/heads/codex/context-fix"),
    "delivery-feature-push",
    "main"
  );
  assert.equal(ignored.outcome, "ignored");
  assert.equal(ignored.state.tasks.length, 0);
  assert.equal(ignored.state.outbox.length, 0);
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
