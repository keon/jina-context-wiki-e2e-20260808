import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanupTransientPath, type CleanupWarning } from "./utils.js";

test("cleanupTransientPath removes with retrying recursive force options", async () => {
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];

  const warning = await cleanupTransientPath("/tmp/review-workspace", "test_workspace", {
    remove: async (path, options) => {
      calls.push({ path, options });
    }
  });

  assert.equal(warning, undefined);
  assert.deepEqual(calls, [
    {
      path: "/tmp/review-workspace",
      options: {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      }
    }
  ]);
});

test("cleanupTransientPath swallows cleanup failure and returns a structured warning", async () => {
  const emitted: CleanupWarning[] = [];
  const error = new Error("directory not empty") as NodeJS.ErrnoException;
  error.code = "ENOTEMPTY";

  const warning = await cleanupTransientPath("/tmp/stubborn-workspace", "test_workspace", {
    remove: async () => {
      throw error;
    },
    warn: (value) => {
      emitted.push(value);
    }
  });

  assert.deepEqual(warning, {
    event: "temp_workspace_cleanup_failed_nonfatal",
    label: "test_workspace",
    path: "/tmp/stubborn-workspace",
    code: "ENOTEMPTY",
    message: "directory not empty",
    maxRetries: 5,
    retryDelay: 200
  });
  assert.deepEqual(emitted, [warning]);
});

test("cleanup failure in finally does not replace a successful result", async () => {
  const runWithCleanup = async (): Promise<{ ok: true }> => {
    try {
      return { ok: true };
    } finally {
      await cleanupTransientPath("/tmp/stubborn-workspace", "test_workspace", {
        remove: async () => {
          throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
        },
        warn: () => undefined
      });
    }
  };

  assert.deepEqual(await runWithCleanup(), { ok: true });
});
