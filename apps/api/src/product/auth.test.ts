import assert from "node:assert/strict";
import { test } from "node:test";

import { callbackUrlFor } from "./auth.js";
import type { AppConfig } from "./config.js";
import { ApiError } from "./errors.js";

const CALLBACK_PATH = "/dashboard/integrations/openrouter/oauth/callback";

test("callbackUrlFor uses the canonical Clerk dashboard origin", () => {
  const config = {
    dashboardUrl: "https://app.example.com",
    auth: { mode: "clerk" },
  } as AppConfig;
  assert.equal(
    callbackUrlFor(config, CALLBACK_PATH),
    "https://app.example.com/api/dashboard/integrations/openrouter/oauth/callback",
  );
});

test("callbackUrlFor rejects non-Clerk and non-dashboard callback paths", () => {
  const disabled = { dashboardUrl: "https://app.example.com", auth: { mode: "disabled" } } as AppConfig;
  assert.throws(
    () => callbackUrlFor(disabled, CALLBACK_PATH),
    (error: unknown) => error instanceof ApiError && error.status === 500,
  );
  const clerk = { dashboardUrl: "https://app.example.com", auth: { mode: "clerk" } } as AppConfig;
  assert.throws(() => callbackUrlFor(clerk, "/auth/github/callback"), ApiError);
});
