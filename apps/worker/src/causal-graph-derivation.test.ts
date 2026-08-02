import assert from "node:assert/strict";
import test from "node:test";
import { ISSUE_GRAPH_STAGE_SCHEMA, issueGraphPrompt } from "./causal-graph-derivation.js";

test("causal graph derivation contract requires exhaustive candidate disposition", () => {
  assert.ok(ISSUE_GRAPH_STAGE_SCHEMA.required.includes("candidateDispositions"));
  assert.deepEqual(ISSUE_GRAPH_STAGE_SCHEMA.properties.candidateDispositions.items.required, [
    "commitSha",
    "disposition",
    "issueKeys",
    "reason"
  ]);
});

test("causal graph prompt enforces recall, lifecycle evidence, and one agentic run", () => {
  const prompt = issueGraphPrompt("omxyz/jina", "main", "/input/history.json", "/input/ledger.json", 15);
  assert.match(prompt, /at least 15 distinct issues/);
  assert.match(prompt, /every ledger entry/i);
  assert.match(prompt, /For at least 3 issues/);
  assert.match(prompt, /one agentic derivation run/);
  assert.match(prompt, /deterministically creates commit CAUSED_BY edges/);
  assert.doesNotMatch(prompt, /Prefer fewer/);
});
