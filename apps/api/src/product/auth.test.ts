import assert from "node:assert/strict";
import { test } from "node:test";

import type { Context } from "hono";

import { callbackUrlFor } from "./auth.js";
import type { AppConfig } from "./config.js";
import { ApiError } from "./errors.js";

// callbackUrlFor only reads config.apiBaseUrl (and, on the dev fallback, the request url/host).
function configWith(apiBaseUrl: string | undefined): AppConfig {
  return { apiBaseUrl } as unknown as AppConfig;
}

function fakeContext(host = "attacker.example"): Context {
  return {
    req: {
      url: "http://internal-host:8080/auth/github/callback",
      header: (name: string) => (name === "host" ? host : undefined),
    },
  } as unknown as Context;
}

const CALLBACK_PATH = "/auth/github/callback";

test("callbackUrlFor derives the callback from the configured API base url (attacker Host ignored)", () => {
  const url = callbackUrlFor(fakeContext("attacker.example"), configWith("https://api.example.com"), CALLBACK_PATH);
  assert.equal(url, "https://api.example.com/auth/github/callback");
});

test("callbackUrlFor throws in production when API_BASE_URL is unset (no Host-header fallback) (FINDING 6b)", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () => callbackUrlFor(fakeContext(), configWith(undefined), CALLBACK_PATH),
      (error: unknown) => error instanceof ApiError && error.status === 500,
    );
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test("callbackUrlFor keeps the request-origin fallback outside production (local dev)", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const url = callbackUrlFor(fakeContext("localhost:8080"), configWith(undefined), CALLBACK_PATH);
    assert.equal(url, "http://localhost:8080/auth/github/callback");
  } finally {
    process.env.NODE_ENV = previous;
  }
});
