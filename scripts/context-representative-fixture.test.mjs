import assert from "node:assert/strict";
import test from "node:test";
import {
  captureGithubProviderHistory,
  parseFixtureCaptureArguments,
  sanitizeIssuePayload,
  sanitizePullRequestPayload,
  sanitizeRepositoryPayload
} from "./context-representative-fixture.mjs";

function response(value, { link = null, remaining = "57" } = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      etag: '"fixture-etag"',
      ...(link ? { link } : {}),
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": remaining
    }
  });
}

test("fixture capture arguments are bounded and do not accept credential flags", () => {
  const parsed = parseFixtureCaptureArguments(
    [
      "--",
      "--repository",
      "VectifyAI/PageIndex",
      "--ref",
      "main",
      "--slug",
      "pageindex",
      "--history-limit",
      "100",
      "--issue-limit",
      "25",
      "--pull-request-limit",
      "30",
      "--provider-page-limit",
      "2"
    ],
    {}
  );
  assert.equal(parsed.repository, "VectifyAI/PageIndex");
  assert.equal(parsed.ref, "main");
  assert.equal(parsed.slug, "pageindex");
  assert.equal(parsed.historyLimit, 100);
  assert.equal(parsed.issueLimit, 25);
  assert.equal(parsed.pullRequestLimit, 30);
  assert.equal(parsed.providerPageLimit, 2);
  assert.equal(parsed.githubToken, undefined);
  assert.throws(
    () =>
      parseFixtureCaptureArguments(
        [
          "--repository",
          "VectifyAI/PageIndex",
          "--ref",
          "main",
          "--slug",
          "pageindex",
          "--token",
          "must-not-enter-command-history"
        ],
        {}
      ),
    /Unknown option: --token/
  );
  assert.throws(
    () =>
      parseFixtureCaptureArguments(
        ["--repository", "VectifyAI/PageIndex", "--ref", "main", "--slug", "pageindex", "--issue-limit", "501"],
        {}
      ),
    /issue limit must be an integer between 0 and 500/
  );
});

test("provider payload sanitizers retain research facts and discard incidental secrets", () => {
  const common = {
    number: 7,
    title: "Bound the provider capture",
    body: "Capture the recent history.",
    state: "open",
    user: { login: "octocat", token: "nested-secret" },
    labels: [{ name: "quality", color: "00ff00", description: "not retained" }],
    html_url: "https://github.com/example/repo/issues/7",
    created_at: "2026-07-30T00:00:00Z",
    updated_at: "2026-07-30T01:00:00Z",
    temp_clone_token: "response-secret",
    authorization: "response-secret"
  };
  const repository = sanitizeRepositoryPayload({
    id: 1,
    full_name: "example/repo",
    default_branch: "main",
    private: false,
    html_url: "https://github.com/example/repo",
    clone_url: "https://response-secret@example.com/example/repo.git",
    temp_clone_token: "response-secret"
  });
  const issue = sanitizeIssuePayload(common);
  const pull = sanitizePullRequestPayload({
    ...common,
    html_url: "https://github.com/example/repo/pull/7",
    head: {
      ref: "feature",
      sha: "a".repeat(40),
      repo: { full_name: "contributor/repo", clone_url: "https://response-secret@example.com/repo.git" }
    },
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "example/repo" } }
  });
  const serialized = JSON.stringify({ repository, issue, pull });
  assert.doesNotMatch(serialized, /response-secret|nested-secret|authorization|temp_clone_token|clone_url/);
  assert.equal(issue.user.login, "octocat");
  assert.deepEqual(issue.labels, [{ name: "quality", color: "00ff00" }]);
  assert.equal(pull.head.repository, "contributor/repo");
});

test("GitHub capture is bounded, filters PRs from issues, and never persists its token", async () => {
  const credential = "fixture-api-credential";
  const requests = [];
  const issue = {
    number: 11,
    title: "Real issue",
    body: "Issue body",
    state: "open",
    user: { login: "issue-author" },
    labels: [],
    html_url: "https://github.com/Example/Fixture/issues/11",
    created_at: "2026-07-29T00:00:00Z",
    updated_at: "2026-07-30T00:00:00Z"
  };
  const issueShapedPull = {
    ...issue,
    number: 12,
    title: "PR returned by issues endpoint",
    pull_request: { url: "https://api.github.com/repos/Example/Fixture/pulls/12" }
  };
  const pull = {
    ...issue,
    number: 12,
    title: "Real pull request",
    html_url: "https://github.com/Example/Fixture/pull/12",
    draft: false,
    head: { ref: "feature", sha: "a".repeat(40), repo: { full_name: "Example/Fork" } },
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "Example/Fixture" } }
  };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url: url.toString(), authorization: init.headers.Authorization });
    if (url.pathname === "/repos/Example/Fixture") {
      return response({
        id: 123,
        full_name: "Example/Fixture",
        html_url: "https://github.com/Example/Fixture",
        private: false,
        visibility: "public",
        archived: false,
        disabled: false,
        default_branch: "main",
        language: "TypeScript",
        temp_clone_token: credential
      });
    }
    if (url.pathname.endsWith("/issues")) return response([issue, issueShapedPull]);
    if (url.pathname.endsWith("/pulls")) return response([pull]);
    throw new Error(`Unexpected request: ${url}`);
  };

  const captured = await captureGithubProviderHistory({
    repository: "Example/Fixture",
    issueLimit: 2,
    pullRequestLimit: 2,
    pageLimit: 1,
    token: credential,
    fetchImpl,
    capturedAt: "2026-07-30T02:00:00.000Z"
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.authorization === `Bearer ${credential}`));
  assert.deepEqual(
    captured.evidence.observations.map((item) => item.sourceType),
    ["observation", "issue", "pull_request"]
  );
  assert.equal(captured.metadata.capture.issueRecordsThatWerePullRequests, 1);
  assert.equal(captured.metadata.capture.commentsRetained, false);
  assert.equal(captured.metadata.capture.authenticationSource, "environment");
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(credential));
  assert.ok(captured.metadata.capture.issuesPages.every((page) => !("headers" in page) && !("authorization" in page)));
});
