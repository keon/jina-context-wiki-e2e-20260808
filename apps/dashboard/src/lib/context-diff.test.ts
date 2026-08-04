import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextDiffResponse, ContextRelease } from "./types.ts";
import { isCurrentContextDiff, resolveContextDiffReleaseId } from "./context-diff.ts";

function release(id: string): ContextRelease {
  return {
    id,
    repository: "omxyz/jina",
    ref: "main",
    commitSha: id.padEnd(40, "0"),
    createdAt: "2026-08-04T12:00:00.000Z",
    completeness: "complete",
    contextStatus: "available"
  };
}

function diff(fromId: string, toId: string): ContextDiffResponse {
  return {
    from: release(fromId),
    to: release(toId),
    added: [],
    removed: [],
    changed: [],
    unchanged: []
  };
}

test("wiki polling preserves the selected comparison and rendered diff while release identities stay current", () => {
  const candidateIds = ["older", "oldest"];
  assert.equal(resolveContextDiffReleaseId("oldest", candidateIds), "oldest");
  assert.equal(isCurrentContextDiff(diff("oldest", "current"), "current", candidateIds), true);
});

test("wiki comparison resets only when its selected or target release is no longer current", () => {
  assert.equal(resolveContextDiffReleaseId("removed", ["older"]), "older");
  assert.equal(isCurrentContextDiff(diff("removed", "current"), "current", ["older"]), false);
  assert.equal(isCurrentContextDiff(diff("older", "previous"), "current", ["older"]), false);
});
