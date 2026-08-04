import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COPY_CONFIRM_MS,
  codexConnectionAccepted,
  codexModalCanDismiss,
  connectedLabel,
  handshakeErrorAction,
} from "./codex-connect";

test("COPY_CONFIRM_MS is a ~2s confirmation window", () => {
  assert.equal(COPY_CONFIRM_MS, 2000);
});

test("connectedLabel appends the date when present, plain otherwise", () => {
  assert.equal(connectedLabel("Jul 8, 2026"), "Codex connected Jul 8, 2026");
  assert.equal(connectedLabel(null), "Codex connected");
  assert.equal(connectedLabel(""), "Codex connected"); // empty string is treated as absent
});

test("an active Codex sign-in cannot be dismissed accidentally", () => {
  assert.equal(codexModalCanDismiss(false, false), false);
  assert.equal(codexModalCanDismiss(true, true), false);
  assert.equal(codexModalCanDismiss(true, false), true);
});

test("a Codex credential save is accepted only when the API confirms a usable connection", () => {
  assert.equal(codexConnectionAccepted(true, false), true);
  assert.equal(codexConnectionAccepted(true, true), false);
  assert.equal(codexConnectionAccepted(false, false), false);
});

test("handshakeErrorAction: expired regenerates, everything else retries", () => {
  assert.deepEqual(handshakeErrorAction("expired"), { kind: "regenerate", label: "Generate a new code" });
  assert.deepEqual(handshakeErrorAction("denied"), { kind: "retry", label: "Try again" });
  assert.deepEqual(handshakeErrorAction("unreachable"), { kind: "retry", label: "Try again" });
  assert.deepEqual(handshakeErrorAction("start_failed"), { kind: "retry", label: "Try again" });
  assert.deepEqual(handshakeErrorAction("anything-unknown"), { kind: "retry", label: "Try again" });
});
