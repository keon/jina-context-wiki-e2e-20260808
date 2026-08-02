import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCodexConnectTelemetry } from "./codex-connect-telemetry.js";

test("parseCodexConnectTelemetry accepts the privacy-safe connection fields", () => {
  assert.deepEqual(parseCodexConnectTelemetry({
    event: "flow_failed",
    flow_id: "flow_12345678",
    stage: "poll",
    reason: "openai_unreachable",
    http_status: 503,
    elapsed_ms: 12_345,
    attempt: 6,
    visibility: "hidden",
  }), {
    event: "flow_failed",
    flow_id: "flow_12345678",
    stage: "poll",
    reason: "openai_unreachable",
    http_status: 503,
    elapsed_ms: 12_345,
    attempt: 6,
    visibility: "hidden",
  });
});

test("parseCodexConnectTelemetry rejects arbitrary fields that could carry secrets", () => {
  const parsed = parseCodexConnectTelemetry({
    event: "user_code_received",
    flow_id: "flow_12345678",
    user_code: "SECRET-CODE",
    device_auth_id: "secret-device-id",
  });
  assert.deepEqual(parsed, { event: "user_code_received", flow_id: "flow_12345678" });
  assert.throws(() => parseCodexConnectTelemetry({ event: "made_up", flow_id: "flow_12345678" }));
  assert.throws(() => parseCodexConnectTelemetry({ event: "flow_failed", flow_id: "short" }));
  assert.throws(() => parseCodexConnectTelemetry({
    event: "flow_failed",
    flow_id: "flow_12345678",
    reason: "token was SECRET",
  }));
});
