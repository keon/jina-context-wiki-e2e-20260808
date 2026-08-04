import assert from "node:assert/strict";
import { test } from "node:test";

import { listIssueComments, listPullRequestReviews, listReviewComments } from "./github.js";

test("listReviewComments paginates PR review comments", async () => {
  const calls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse(
      calls.length === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `comment-${index + 1}` }))
        : [{ id: 101, body: "comment-101" }]
    );
  };

  try {
    const comments = await listReviewComments({
      token: "token",
      repository: { owner: "acme", name: "repo", fullName: "acme/repo" },
      pullRequestNumber: 42
    });

    assert.equal(comments.length, 101);
    assert.match(calls[0] ?? "", /comments\?per_page=100&page=1$/);
    assert.match(calls[1] ?? "", /comments\?per_page=100&page=2$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("listPullRequestReviews paginates PR reviews", async () => {
  const calls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse(
      calls.length === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `review-${index + 1}` }))
        : []
    );
  };

  try {
    const reviews = await listPullRequestReviews({
      token: "token",
      repository: { owner: "acme", name: "repo", fullName: "acme/repo" },
      pullRequestNumber: 42
    });

    assert.equal(reviews.length, 100);
    assert.match(calls[0] ?? "", /reviews\?per_page=100&page=1$/);
    assert.match(calls[1] ?? "", /reviews\?per_page=100&page=2$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("listIssueComments paginates issue comments", async () => {
  const calls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse(
      calls.length === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `issue-comment-${index + 1}` }))
        : [{ id: 101, body: "<!-- jina-simulation:review-progress {} -->" }]
    );
  };

  try {
    const comments = await listIssueComments({
      token: "token",
      repository: { owner: "acme", name: "repo", fullName: "acme/repo" },
      issueNumber: 42
    });

    assert.equal(comments.length, 101);
    assert.match(calls[0] ?? "", /comments\?per_page=100&page=1$/);
    assert.match(calls[1] ?? "", /comments\?per_page=100&page=2$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  } as Response;
}
