import assert from "node:assert/strict";
import test from "node:test";

import {
  tenantAuthorizationErrorMessage,
  tenantAccessErrorMessage,
  WORKSPACE_DISCOVERY_ERROR_MESSAGE,
} from "./tenant-access-error";

test("workspace access errors preserve the server explanation and give a recovery path", () => {
  const message = tenantAccessErrorMessage({
    error: "This Clerk account is linked to a different Jina account",
  });

  assert.match(message, /linked to a different Jina account/);
  assert.match(message, /Sign out and back in/);
  assert.match(message, /Clerk email and connected GitHub account/);
});

test("workspace access errors use safe guidance for malformed responses", () => {
  const message = tenantAccessErrorMessage({ detail: "internal diagnostics" });

  assert.match(message, /could not verify workspace access/);
  assert.doesNotMatch(message, /internal diagnostics/);
  assert.match(message, /Sign out and back in/);
});

test("transient discovery failures explain that access remains protected", () => {
  assert.match(WORKSPACE_DISCOVERY_ERROR_MESSAGE, /could not load your workspaces/);
  assert.match(WORKSPACE_DISCOVERY_ERROR_MESSAGE, /still protected/);
  assert.match(WORKSPACE_DISCOVERY_ERROR_MESSAGE, /try again/);
});

test("a Clerk/API 401 becomes a recoverable session error instead of permanent loading", () => {
  const message = tenantAuthorizationErrorMessage(401, "clerk");

  assert.match(message ?? "", /Clerk sign-in is active/);
  assert.match(message ?? "", /could not validate the matching API session/);
  assert.match(message ?? "", /sign out and back in/);
  assert.equal(tenantAuthorizationErrorMessage(401, "github"), null);
});
