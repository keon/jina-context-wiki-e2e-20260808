import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { handleGithubWebhook, verifyGithubSignature } from "./github.js";
import type { AppConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { parseJinaReviewCommand, type ReviewCommandGithub } from "./review-command.js";
import type { TriggerOptions } from "./trigger.js";
import { reviewTaskTriggerControl } from "./review-task-routing.js";

test("verifies GitHub sha256 signatures", () => {
  const secret = "test-secret";
  const body = '{"zen":"Keep it logically awesome."}';
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.doesNotThrow(() => verifyGithubSignature(secret, body, signature));
});

test("rejects invalid GitHub signatures", () => {
  assert.throws(
    () => verifyGithubSignature("test-secret", "{}", "sha256=deadbeef"),
    /signature mismatch/,
  );
});

test("ignores check_run requested actions without triggering a task", async () => {
  const trigger = new FakeTrigger();
  const body = JSON.stringify(checkRunPayload({ repositoryFullName: "omxyz/jina-simulation" }));

  const response = await handleGithubWebhook({
    config: testConfig(),
    trigger: trigger as never,
    headers: signedHeaders(body, "check_run"),
    rawBody: body,
  });

  assert.equal(response.accepted, false);
  assert.equal(response.event, "check_run");
  assert.equal(response.action, "requested_action");
  assert.equal(response.task_id, undefined);
  assert.equal(response.ignored_reason, "event is not used by this service");
  assert.equal(trigger.calls.length, 0);
});

test("ignores pull_request actions when review trigger task is disabled", async () => {
  const previousState = reviewTaskTriggerControl.enabled;
  reviewTaskTriggerControl.enabled = false;
  try {
    const trigger = new FakeTrigger();
    const body = JSON.stringify(pullRequestPayload({ action: "opened", repositoryFullName: "other/example" }));

    const response = await handleGithubWebhook({
      config: testConfig(),
      trigger: trigger as never,
      headers: signedHeaders(body, "pull_request"),
      rawBody: body,
    });

    assert.equal(response.accepted, false);
    assert.equal(response.event, "pull_request");
    assert.equal(response.action, "opened");
    assert.equal(response.task_id, undefined);
    assert.equal(response.ignored_reason, "review trigger task is disabled for repository");
    assert.equal(trigger.calls.length, 0);
  } finally {
    reviewTaskTriggerControl.enabled = previousState;
  }
});

test("triggers review task for the allowlisted repo while the default switch is disabled", async () => {
  const previousState = reviewTaskTriggerControl.enabled;
  reviewTaskTriggerControl.enabled = false;
  try {
    const trigger = new FakeTrigger();
    const body = JSON.stringify(pullRequestPayload({ action: "opened", repositoryFullName: "omxyz/jina-simulation" }));

    const response = await handleGithubWebhook({
      config: testConfig(),
      trigger: trigger as never,
      headers: signedHeaders(body, "pull_request"),
      rawBody: body,
    });

    assert.equal(response.accepted, true);
    assert.equal(response.event, "pull_request");
    assert.equal(response.action, "opened");
    assert.equal(response.task_id, "review");
    assert.equal(response.run_id, "run-1");
    assert.equal(trigger.calls.length, 1);
    assert.equal(trigger.calls[0]?.options.idempotencyKey, "review:456:123:42:head-sha-1:code_review");
    assert.equal(trigger.calls[0]?.options.concurrencyKey, "review:456:123:42:head-sha-1:code_review");
  } finally {
    reviewTaskTriggerControl.enabled = previousState;
  }
});

test("triggers review task when review trigger task is enabled", async () => {
  const previousState = reviewTaskTriggerControl.enabled;
  reviewTaskTriggerControl.enabled = true;
  try {
    const trigger = new FakeTrigger();
    const body = JSON.stringify(pullRequestPayload({ action: "opened", repositoryFullName: "other/example" }));

    const response = await handleGithubWebhook({
      config: testConfig(),
      trigger: trigger as never,
      headers: signedHeaders(body, "pull_request"),
      rawBody: body,
    });

    assert.equal(response.accepted, true);
    assert.equal(response.event, "pull_request");
    assert.equal(response.action, "opened");
    assert.equal(response.task_id, "review");
    assert.equal(response.run_id, "run-1");
    assert.equal(trigger.calls.length, 1);
  } finally {
    reviewTaskTriggerControl.enabled = previousState;
  }
});

test("synchronize triggers a review under the default every_commit mode", async () => {
  const previousState = reviewTaskTriggerControl.enabled;
  reviewTaskTriggerControl.enabled = true;
  try {
    const trigger = new FakeTrigger();
    const body = JSON.stringify(pullRequestPayload({ action: "synchronize", repositoryFullName: "other/example" }));
    const response = await handleGithubWebhook({
      config: testConfig(),
      trigger: trigger as never,
      headers: signedHeaders(body, "pull_request"),
      rawBody: body,
    });
    assert.equal(response.accepted, true);
    assert.equal(response.action, "synchronize");
    assert.equal(trigger.calls.length, 1);
  } finally {
    reviewTaskTriggerControl.enabled = previousState;
  }
});

test("manual_only blocks every automatic pull request review action", async () => {
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
    const trigger = new FakeTrigger();
    const body = JSON.stringify(pullRequestPayload({ action }));
    const response = await handleGithubWebhook({
      config: testConfig(),
      trigger: trigger as never,
      headers: signedHeaders(body, "pull_request"),
      rawBody: body,
      reviewTriggerModeForInstallation: async (installationId) => {
        assert.equal(installationId, 456);
        return "manual_only";
      },
    });

    assert.equal(response.accepted, false, action);
    assert.match(response.ignored_reason ?? "", /use @usejina in a pull request comment/, action);
    assert.equal(trigger.calls.length, 0, action);
  }
});

// FINDING 2: gateDispatch is advisory-only now — the webhook ALWAYS dispatches (enforcement moved to
// prepare, which blocks visibly). Even with billing present, a review with an exhausted balance still
// triggers the task; the block then happens at prepare.
test("triggers the review task even when the billing gate is advisory (FINDING 2: no dispatch-time block)", async () => {
  const trigger = new FakeTrigger();
  // Capture both args: the author login is threaded from the webhook payload so the dispatch billing
  // context can classify a BYOH author as "harness" (mirrors runtime credential precedence).
  const gateCalls: Array<{ installationId: number; authorLogin?: string }> = [];
  const billing = {
    async gateDispatch(installationId: number, authorLogin?: string): Promise<void> {
      gateCalls.push({ installationId, authorLogin });
    },
  } as unknown as Parameters<typeof handleGithubWebhook>[0]["billing"];
  const body = JSON.stringify(pullRequestPayload({ action: "opened", repositoryFullName: "omxyz/jina-simulation" }));

  const response = await handleGithubWebhook({
    config: testConfig(),
    trigger: trigger as never,
    headers: signedHeaders(body, "pull_request"),
    rawBody: body,
    billing,
  });

  assert.equal(response.accepted, true, "webhook dispatches regardless of billing");
  assert.equal(trigger.calls.length, 1, "the review task is triggered");
  assert.deepEqual(gateCalls, [{ installationId: 456, authorLogin: "alice" }], "gateDispatch gets the installation id and PR author login");
});

test("a standalone @usejina mention anywhere uses the remaining Markdown as instructions", () => {
  assert.deepEqual(parseJinaReviewCommand("\n@usejina\n\nFocus on auth.\nDo not review UI."), {
    instructions: "Focus on auth.\nDo not review UI.",
  });
  assert.deepEqual(parseJinaReviewCommand("@usejina"), {});
  assert.deepEqual(parseJinaReviewCommand("@usejina do another round of review. be strict"), {
    instructions: "do another round of review. be strict",
  });
  assert.deepEqual(parseJinaReviewCommand("Context first\n@usejina\nBe strict."), {
    instructions: "Context first\n\nBe strict.",
  });
  assert.equal(parseJinaReviewCommand("email usejina@usejina.com"), undefined);
  assert.equal(parseJinaReviewCommand("@usejina-bot review this"), undefined);
});

test("installation suspension and deletion dispatch lifecycle backfills", async () => {
  for (const action of ["suspended", "deleted"]) {
    const trigger = new FakeTrigger();
    const lifecycleUpdates: Array<{ installationId: number; lifecycle: string }> = [];
    const body = JSON.stringify({
      action,
      installation: {
        id: 456,
        account: { id: 12, login: "omxyz", type: "Organization" },
      },
      sender: { id: 7, login: "alice", type: "User" },
      repositories: [],
    });
    const response = await handleGithubWebhook({
      config: testConfig(),
      trigger: trigger as never,
      headers: signedHeaders(body, "installation"),
      rawBody: body,
      installationLifecycleUpdater: async (installationId, lifecycle) => {
        lifecycleUpdates.push({ installationId, lifecycle });
        return true;
      },
    });
    assert.equal(response.accepted, true, action);
    assert.equal(trigger.calls.length, 1, action);
    assert.equal(trigger.calls[0]?.payload.action, action);
    assert.equal(trigger.calls[0]?.payload.github_installation_id, 456);
    assert.deepEqual(lifecycleUpdates, [{ installationId: 456, lifecycle: action }]);
  }
});

test("manual_only still allows authorized @usejina PR comments", async () => {
  const trigger = new FakeTrigger();
  const github = new FakeReviewGithub();
  let modeLookups = 0;
  const body = JSON.stringify(commentPayload("issue_comment", "@usejina do another round of review. be strict"));
  const response = await handleGithubWebhook({
    config: testConfig(),
    trigger: trigger as never,
    headers: signedHeaders(body, "issue_comment"),
    rawBody: body,
    reviewCommandGithub: github,
    reviewTriggerModeForInstallation: async () => {
      modeLookups += 1;
      return "manual_only";
    },
  });

  assert.equal(response.accepted, true);
  assert.equal(modeLookups, 0);
  assert.equal(trigger.calls.length, 1);
  const call = trigger.calls[0]!;
  assert.equal(call.payload.review_instructions, "do another round of review. be strict");
  assert.equal(call.payload.source_event, "issue_comment");
  assert.equal(call.payload.trigger, "manual");
  assert.equal(call.options.idempotencyKey, "review:456:123:42:issue_comment:987");
  const commandTag = `manual-command:${Date.parse("2026-07-15T14:10:51Z")}:issue_comment:987`;
  assert.equal(call.payload.manual_command_tag, commandTag);
  assert.deepEqual(call.options.tags?.slice(-2), ["manual-pr:456:123:42", commandTag]);
});

test("redelivery of one comment stays idempotent after the PR head changes", async () => {
  const trigger = new FakeTrigger();
  const github = new FakeReviewGithub();
  const body = JSON.stringify(commentPayload("issue_comment", "@usejina"));
  const dispatch = () => handleGithubWebhook({
    config: testConfig(),
    trigger: trigger as never,
    headers: signedHeaders(body, "issue_comment"),
    rawBody: body,
    reviewCommandGithub: github,
  });

  github.headSha = "head-a";
  await dispatch();
  github.headSha = "head-b";
  await dispatch();

  assert.equal(trigger.calls[0]?.options.idempotencyKey, trigger.calls[1]?.options.idempotencyKey);
  assert.equal((trigger.calls[0]?.payload.pull_request as { head_sha: string }).head_sha, "head-a");
  assert.equal((trigger.calls[1]?.payload.pull_request as { head_sha: string }).head_sha, "head-b");
});

test("inline @usejina replies stay scoped to the parent Jina issue", async () => {
  const trigger = new FakeTrigger();
  const github = new FakeReviewGithub();
  github.parent = {
    user: { login: "jina-simulation[bot]", type: "Bot" },
    body: '<!-- jina:issue {"reviewRunId":"run-1","headSha":"manual-head","stage":"runtime","fingerprint":"retry","blocking":true} -->\n\n### Retry loses updates',
  };
  const body = JSON.stringify(commentPayload(
    "pull_request_review_comment",
    "@usejina\n\nUse the existing retry test.",
  ));
  const response = await handleGithubWebhook({
    config: testConfig(),
    trigger: trigger as never,
    headers: signedHeaders(body, "pull_request_review_comment"),
    rawBody: body,
    reviewCommandGithub: github,
  });

  assert.equal(response.accepted, true);
  assert.equal(trigger.calls[0]?.payload.review_instructions, [
    "Use the existing retry test.",
    "",
    "## Scope for this review",
    "This fixed scope takes precedence over conflicting guidance above.",
    'Review only the existing Jina issue titled: "Retry loses updates".',
    "Do not investigate or report unrelated issues.",
  ].join("\n"));
});

test("inline scope requires a valid issue marker from this GitHub App", async () => {
  const marker = (fingerprint: string) => JSON.stringify({
    reviewRunId: "run-1", headSha: "head", stage: "runtime", fingerprint, blocking: true,
  });
  for (const { parent, appSlug } of [
    { appSlug: "jina-simulation", parent: { user: { login: "other[bot]", type: "Bot" }, body: `<!-- jina:issue ${marker("retry")} -->\n### Other bot` } },
    { appSlug: "jina-simulation", parent: { user: { login: "jina-simulation[bot]", type: "Bot" }, body: "<!-- jina:issue NOT-JSON -->\n### Invalid marker" } },
    { appSlug: "jina-simulation", parent: { user: { login: "jina-simulation[bot]", type: "Bot" }, body: `<!-- jina:issue ${marker("")} -->\n### Empty fingerprint` } },
    { appSlug: undefined, parent: { user: { login: "jina-simulation[bot]", type: "Bot" }, body: `<!-- jina:issue ${marker("retry")} -->\n### Unconfigured app` } },
  ]) {
    const trigger = new FakeTrigger();
    const github = new FakeReviewGithub();
    github.parent = parent;
    github.appSlug = appSlug;
    const body = JSON.stringify(commentPayload("pull_request_review_comment", "@usejina\n\nUse retry tests."));
    await handleGithubWebhook({
      config: testConfig(), trigger: trigger as never, headers: signedHeaders(body, "pull_request_review_comment"),
      rawBody: body, reviewCommandGithub: github,
    });
    assert.equal(trigger.calls[0]?.payload.review_instructions, "Use retry tests.");
  }
});

test("an unavailable inline parent is ignored without failing the webhook", async () => {
  const trigger = new FakeTrigger();
  const github = new FakeReviewGithub();
  github.parentError = new ApiError(404, "parent missing");
  const body = JSON.stringify(commentPayload("pull_request_review_comment", "@usejina"));
  const response = await handleGithubWebhook({
    config: testConfig(), trigger: trigger as never, headers: signedHeaders(body, "pull_request_review_comment"),
    rawBody: body, reviewCommandGithub: github,
  });
  assert.equal(response.accepted, false);
  assert.match(response.ignored_reason ?? "", /parent review comment/);
  assert.equal(trigger.calls.length, 0);
});

test("over-limit @usejina instructions are rejected instead of partially applied", async () => {
  const trigger = new FakeTrigger();
  const body = JSON.stringify(commentPayload("issue_comment", `@usejina\n${"a".repeat(8_001)}`));
  const response = await handleGithubWebhook({
    config: testConfig(), trigger: trigger as never, headers: signedHeaders(body, "issue_comment"),
    rawBody: body, reviewCommandGithub: new FakeReviewGithub(),
  });
  assert.equal(response.accepted, false);
  assert.match(response.ignored_reason ?? "", /8,000/);
  assert.equal(trigger.calls.length, 0);
});

test("@usejina requires write permission", async () => {
  const trigger = new FakeTrigger();
  const github = new FakeReviewGithub();
  github.permission = { permission: "read" };
  const body = JSON.stringify(commentPayload("issue_comment", "@usejina"));
  const response = await handleGithubWebhook({
    config: testConfig(),
    trigger: trigger as never,
    headers: signedHeaders(body, "issue_comment"),
    rawBody: body,
    reviewCommandGithub: github,
  });

  assert.equal(response.accepted, false);
  assert.match(response.ignored_reason ?? "", /write access/);
  assert.equal(trigger.calls.length, 0);
});

class FakeTrigger {
  readonly calls: Array<{ taskIdentifier: string; payload: Record<string, unknown>; options: TriggerOptions }> = [];

  async triggerTask(taskIdentifier: string, payload: unknown, options: TriggerOptions) {
    this.calls.push({ taskIdentifier, payload: payload as Record<string, unknown>, options });
    return { id: `run-${this.calls.length}` };
  }
}

class FakeReviewGithub implements ReviewCommandGithub {
  appSlug: string | undefined = "jina-simulation";
  permission: Awaited<ReturnType<ReviewCommandGithub["getRepositoryPermission"]>> = { permission: "write" };
  parent: Awaited<ReturnType<ReviewCommandGithub["getReviewComment"]>> = {};
  parentError?: Error;
  headSha = "manual-head";

  async createInstallationAccessToken() { return "token"; }
  async getRepositoryPermission() { return this.permission; }
  async getReviewComment() {
    if (this.parentError) throw this.parentError;
    return this.parent;
  }
  async getPullRequest(_token: string, repository: string, number: number) {
    return {
      number,
      title: "Manual review",
      html_url: `https://github.com/${repository}/pull/${number}`,
      state: "open",
      user: { login: "pr-author" },
      head: { sha: this.headSha, ref: "feature" },
      base: { sha: "base-head", ref: "main" },
    };
  }
}

function commentPayload(event: "issue_comment" | "pull_request_review_comment", body: string) {
  const payload = {
    action: "created",
    installation: { id: 456 },
    repository: {
      id: 123,
      full_name: "omxyz/jina-simulation",
      name: "jina-simulation",
      owner: { login: "omxyz", id: 12, type: "Organization" },
      default_branch: "main",
      private: false,
    },
    issue: { number: 42, pull_request: { url: "https://api.github.com/pulls/42" } },
    pull_request: { number: 42 },
    comment: {
      id: 987,
      created_at: "2026-07-15T14:10:51Z",
      body,
      in_reply_to_id: event === "pull_request_review_comment" ? 876 : undefined,
      user: { login: "alice", type: "User" },
    },
  };
  return payload;
}

function pullRequestPayload(input: { action: string; repositoryFullName?: string }) {
  const repositoryFullName = input.repositoryFullName ?? "omxyz/jina-simulation";
  const [owner, name] = repositoryFullName.split("/");
  return {
    action: input.action,
    installation: { id: 456 },
    repository: {
      id: 123,
      full_name: repositoryFullName,
      name,
      owner: { login: owner, id: 12, type: "User" },
      default_branch: "main",
      private: false,
    },
    pull_request: {
      number: 42,
      title: "Add feature",
      html_url: "https://github.com/omxyz/jina-simulation/pull/42",
      draft: false,
      head: {
        sha: "head-sha-1",
        ref: "feature",
      },
      base: {
        sha: "base-sha-1",
        ref: "main",
      },
      user: {
        login: "alice",
      },
    },
  };
}

function signedHeaders(body: string, event: string): Headers {
  const secret = "test-secret";
  return new Headers({
    "x-github-event": event,
    "x-github-delivery": "delivery-1",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  });
}

function testConfig(): AppConfig {
  return {
    port: 0,
    githubWebhookSecret: "test-secret",
    internalApiToken: "internal-token",
    dashboardAllowedOrigins: "*",
    dashboardUrl: "https://dashboard.example.test",
    auth: {
      mode: "disabled",
      githubScopes: "read:user",
      sessionCookieName: "session",
      oauthStateCookieName: "oauth-state",
      cookieSecure: false,
      cookieSameSite: "Lax",
      sessionTtlSeconds: 3600,
    },
    trigger: {
      apiBaseUrl: "https://api.trigger.dev",
      secretKey: "tr_dev_test",
      backfillTaskId: "github-installation-backfill",
    },
    billing: {
      autumnApiUrl: "https://api.useautumn.com/v1",
      creditsFeatureId: "jina_credits",
      managedAiFeatureId: "managed_ai_access",
      enforce: "off",
    },
  };
}

function checkRunPayload(input: { repositoryFullName: string }) {
  const [owner, name] = input.repositoryFullName.split("/");
  return {
    action: "requested_action",
    requested_action: { identifier: "ignored_action" },
    check_run: {
      id: 987,
      name: "Jina Simulation",
      head_sha: "head-sha-1",
      pull_requests: [{ number: 42 }],
    },
    repository: {
      id: 123,
      full_name: input.repositoryFullName,
      name,
      owner: { login: owner },
    },
    installation: { id: 456 },
    sender: { login: "alice" },
  };
}
