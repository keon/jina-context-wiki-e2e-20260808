import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDiffAnchors } from "./diff-anchors.js";

test("parseDiffAnchors records added, removed, and context diff lines", () => {
  const anchors = parseDiffAnchors(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 export function handler() {
-  return "old";
+  const value = "new";
+  return value;
 }
`);

  assert.equal(anchors.has("src/app.ts:RIGHT:1"), true);
  assert.equal(anchors.has("src/app.ts:LEFT:1"), true);
  assert.equal(anchors.has("src/app.ts:LEFT:2"), true);
  assert.equal(anchors.has("src/app.ts:RIGHT:2"), true);
  assert.equal(anchors.has("src/app.ts:RIGHT:3"), true);
});
