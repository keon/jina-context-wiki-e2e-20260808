import assert from "node:assert/strict";
import { test } from "node:test";
import { statusTone } from "./status-tone.ts";

test("a failed status is never styled as anything but a failure", () => {
  assert.equal(statusTone("failed"), "bad");
  assert.equal(statusTone("FAILED"), "bad");
  assert.equal(statusTone(" failed "), "bad");
  assert.equal(statusTone("error"), "bad");
  assert.equal(statusTone("cancelled"), "bad");
});

test("healthy and in-flight statuses read differently from each other", () => {
  assert.equal(statusTone("complete"), "ok");
  assert.equal(statusTone("published"), "ok");
  assert.equal(statusTone("running"), "info");
  assert.equal(statusTone("active"), "info");
  assert.notEqual(statusTone("complete"), statusTone("running"));
});

test("an unrecognised status stays neutral rather than being coloured healthy", () => {
  // Colouring an unknown value green on an operations page would assert
  // something the data does not support.
  assert.equal(statusTone("something-new-from-the-api"), undefined);
  assert.equal(statusTone(""), undefined);
  assert.equal(statusTone(null), undefined);
  assert.equal(statusTone(undefined), undefined);
});
