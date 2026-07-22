import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidGitHubWebhookPayloadError, parseGitHubWebhook, verifyGitHubWebhookSignature } from "./webhooks.js";

test("verifies GitHub's published HMAC-SHA256 test vector", () => {
  const valid = verifyGitHubWebhookSignature(
    "It's a Secret to Everybody",
    Buffer.from("Hello, World!", "utf8"),
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
  );

  assert.equal(valid, true);
  assert.equal(verifyGitHubWebhookSignature("wrong", Buffer.from("Hello, World!"), "sha256=" + "0".repeat(64)), false);
});

test("parses an opened pull request delivery", () => {
  const parsed = parseGitHubWebhook(
    "pull_request",
    jsonBytes({
      action: "opened",
      number: 42,
      pull_request: {
        number: 42,
        title: "Make it work",
        html_url: "https://github.com/omlabs/example/pull/42",
        draft: false,
        user: { login: "octocat" },
        head: { sha: "abc123" }
      },
      repository: { id: 10, full_name: "omlabs/example" },
      installation: { id: 99 },
      sender: { login: "octocat" }
    })
  );

  assert.equal(parsed?.repository, "omlabs/example");
  assert.equal(parsed?.installationId, 99);
  assert.deepEqual(parsed?.event, {
    type: "pull_request.opened",
    pullRequestNumber: 42,
    headSha: "abc123",
    title: "Make it work",
    url: "https://github.com/omlabs/example/pull/42",
    authorLogin: "octocat",
    draft: false
  });
});

test("parses a newly opened issue and ignores non-open actions", () => {
  const payload = {
    action: "opened",
    issue: {
      number: 7,
      title: "Investigate flaky test",
      html_url: "https://github.com/omlabs/example/issues/7",
      user: { login: "hubot" }
    },
    repository: { id: 10, full_name: "omlabs/example" },
    installation: { id: 99 },
    sender: { login: "hubot" }
  };

  const parsed = parseGitHubWebhook("issues", jsonBytes(payload));
  assert.deepEqual(parsed?.event, {
    type: "issue.opened",
    issueNumber: 7,
    title: "Investigate flaky test",
    url: "https://github.com/omlabs/example/issues/7",
    authorLogin: "hubot"
  });
  assert.equal(parseGitHubWebhook("issues", jsonBytes({ ...payload, action: "labeled" })), undefined);
  assert.equal(parseGitHubWebhook("ping", jsonBytes({ zen: "Keep it logically awesome." })), undefined);
});

test("parses branch pushes for context graph intake", () => {
  const parsed = parseGitHubWebhook(
    "push",
    jsonBytes({
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      deleted: false,
      repository: { id: 10, full_name: "omlabs/example" },
      installation: { id: 99 },
      sender: { login: "octocat" }
    })
  );
  assert.deepEqual(parsed?.event, {
    type: "push",
    ref: "refs/heads/main",
    beforeSha: "a".repeat(40),
    headSha: "b".repeat(40),
    deleted: false
  });
});

test("rejects malformed actionable payloads", () => {
  assert.throws(
    () => parseGitHubWebhook("issues", jsonBytes({ action: "opened", repository: { full_name: "omlabs/example" } })),
    InvalidGitHubWebhookPayloadError
  );
});

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}
