import assert from "node:assert/strict";
import test from "node:test";

import { jinaIssueMarker, parseJinaIssueMarker } from "./github-review-threads.js";

test("round-trips Jina issue markers", () => {
  const marker = jinaIssueMarker({
    reviewRunId: "run-1",
    headSha: "abc123",
    stage: "runtime",
    fingerprint: "finding-1",
  });

  assert.deepEqual(parseJinaIssueMarker(`${marker}\n\n### Finding`), {
    reviewRunId: "run-1",
    headSha: "abc123",
    stage: "runtime",
    fingerprint: "finding-1",
    blocking: true,
  });
});

test("ignores comments without Jina issue markers", () => {
  assert.equal(parseJinaIssueMarker("plain comment"), undefined);
});
