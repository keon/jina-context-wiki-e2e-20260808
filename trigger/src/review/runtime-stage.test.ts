import assert from "node:assert/strict";
import { test } from "node:test";

import {
  codexHarnessReconnectRequired,
  degradedRunStageError,
  postRuntimeUsage,
  providerFailureCategory,
  providerQuotaReason,
} from "./runtime-stage.js";
import type { UsageRecord } from "../daytona/openrouter-proxy.js";

const usageRecords: UsageRecord[] = [
  { operation: "planner", request_seq: 1, cost: "0.01", raw_usage: {} },
];

const baseInput = {
  reviewRunId: "run-1",
  triggerRunId: "trigger-1",
  sandboxId: "sandbox-1",
  keySource: "managed" as const,
  usageRecords,
};

test("postRuntimeUsage returns no fallback when the usage post succeeds", async () => {
  let calls = 0;
  const fallback = await postRuntimeUsage(baseInput, {
    post: async () => {
      calls += 1;
      return { ok: true };
    },
    sleep: async () => {},
  });

  assert.equal(calls, 1);
  assert.equal(fallback, undefined);
});

test("postRuntimeUsage retries and returns the records as a fallback after 3 failures", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fallback = await postRuntimeUsage(baseInput, {
    post: async () => {
      calls += 1;
      throw new Error("usage post failed");
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  // Three attempts were made, with backoff waits only between them (not after the last).
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1_000, 3_000]);
  assert.deepEqual(fallback, {
    stage: "runtime",
    sandbox_id: "sandbox-1",
    key_source: "managed",
    usage_records: usageRecords,
  });
});

test("postRuntimeUsage recovers on a later attempt without a fallback", async () => {
  let calls = 0;
  const fallback = await postRuntimeUsage(baseInput, {
    post: async () => {
      calls += 1;
      if (calls < 2) {
        throw new Error("transient");
      }
      return { ok: true };
    },
    sleep: async () => {},
  });

  assert.equal(calls, 2);
  assert.equal(fallback, undefined);
});

test("degradedRunStageError fails the stage when every model call failed (all 402s)", () => {
  // attempted > 0 and succeeded === 0: the review published a fallback that
  // validated nothing, so the stage must fail so billing waives the run. The
  // review is still published and usage still posted upstream of this decision.
  const error = degradedRunStageError({ attempted: 4, succeeded: 0 });
  assert.equal(typeof error, "string");
  assert.match(error ?? "", /all 4 model call\(s\) failed/);
});

test("degradedRunStageError keeps the stage billable on partial success", () => {
  // At least one model call returned output, so the run is a real (if partial)
  // review and stays completed/billed, exactly as today.
  assert.equal(degradedRunStageError({ attempted: 4, succeeded: 1 }), undefined);
  assert.equal(degradedRunStageError({ attempted: 4, succeeded: 4 }), undefined);
});

test("degradedRunStageError leaves zero-attempt runs unaffected", () => {
  // Summary-only / harness paths make no captured model calls; they are not
  // degraded and must stay completed.
  assert.equal(degradedRunStageError({ attempted: 0, succeeded: 0 }), undefined);
  assert.equal(degradedRunStageError(undefined), undefined);
});

test("codexHarnessReconnectRequired recognizes permanent native Codex auth failures", () => {
  assert.equal(
    codexHarnessReconnectRequired("harness", "auth error code: token_expired; please sign in again"),
    true,
  );
  assert.equal(
    codexHarnessReconnectRequired(
      "harness",
      "ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because you have since logged out or signed in to another account.",
    ),
    true,
  );
});

test("codexHarnessReconnectRequired ignores gateway and transient failures", () => {
  assert.equal(codexHarnessReconnectRequired("managed", "401 token_expired"), false);
  assert.equal(codexHarnessReconnectRequired("user", "codex_login::auth::manager: Failed to refresh token"), false);
  assert.equal(
    codexHarnessReconnectRequired("harness", "codex_login::auth::manager: Failed to refresh token: network unavailable"),
    false,
  );
  assert.equal(codexHarnessReconnectRequired("harness", "PR text mentioned token_expired"), false);
  assert.equal(codexHarnessReconnectRequired("harness", "request timed out"), false);
  assert.equal(codexHarnessReconnectRequired("harness", undefined), false);
});

test("providerFailureCategory separates actionable model-provider failures from repository errors", () => {
  assert.equal(providerFailureCategory("You have 0 weighted tokens left; usage limit resets later"), "quota");
  assert.equal(providerFailureCategory("401 invalid API key"), "authentication");
  assert.equal(providerFailureCategory("unknown model openai/missing"), "model");
  assert.equal(providerFailureCategory("OpenRouter upstream service unavailable"), "availability");
  assert.equal(providerFailureCategory("git checkout failed: missing ref"), undefined);
  assert.equal(providerQuotaReason("You have 0 weighted tokens left; usage limit resets later"), "exhausted");
  assert.equal(providerQuotaReason("429 too many requests"), "rate_limit");
});

test("postRuntimeUsage skips the post entirely when there are no usage records", async () => {
  let calls = 0;
  const fallback = await postRuntimeUsage(
    { ...baseInput, usageRecords: [] },
    {
      post: async () => {
        calls += 1;
        return {};
      },
      sleep: async () => {},
    },
  );

  assert.equal(calls, 0);
  assert.equal(fallback, undefined);
});
