import assert from "node:assert/strict";
import test from "node:test";

import { defaultEnabledGraphNodeKinds, defaultHiddenGraphNodeKinds, partitionGraphNodeKinds } from "./node-filters.js";

test("advanced graph node kinds are hidden by default and grouped separately", () => {
  const kinds = ["Commit", "Engineer", "File", "Package", "Repository", "Symbol", "Team"];

  assert.deepEqual(partitionGraphNodeKinds(kinds), {
    primary: ["Commit", "File"],
    advanced: ["Engineer", "Package", "Repository", "Symbol", "Team"]
  });
  assert.deepEqual([...defaultEnabledGraphNodeKinds(kinds)], ["Commit", "File"]);
  assert.deepEqual([...defaultHiddenGraphNodeKinds(kinds)], ["Engineer", "Package", "Repository", "Symbol", "Team"]);
});
