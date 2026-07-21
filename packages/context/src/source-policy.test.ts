import assert from "node:assert/strict";
import { test } from "node:test";
import { isSourceAllowed } from "./source-policy.js";

const policy = { egressEnabled: true, allowlist: ["https://docs.example.com/approved"] };

test("source policy matches URL origins and path boundaries", () => {
  assert.equal(isSourceAllowed(policy, "https://docs.example.com/approved"), true);
  assert.equal(isSourceAllowed(policy, "https://docs.example.com/approved/guide"), true);
  assert.equal(isSourceAllowed(policy, "https://docs.example.com/approvedness"), false);
  assert.equal(isSourceAllowed(policy, "https://docs.example.com.evil/approved"), false);
  assert.equal(isSourceAllowed(policy, "javascript:alert(1)"), false);
});
