import assert from "node:assert/strict";
import { test } from "node:test";
import { confidenceLabel, eventLabel, formatTime, formatValue, relativeTime, shortId } from "./format.ts";

test("formatTime renders the absence sentinel rather than leaking Invalid Date", () => {
  assert.equal(formatTime(undefined), "–");
  assert.equal(formatTime(null), "–");
  assert.equal(formatTime(""), "–");
  assert.equal(formatTime("2026-13-45"), "–");
  assert.equal(formatTime("not a timestamp"), "–");
  assert.notEqual(formatTime("2026-01-02T03:04:05Z"), "–");
});

test("relativeTime reports absence rather than NaN for an unparseable timestamp", () => {
  assert.equal(relativeTime(undefined), "Never");
  assert.equal(relativeTime(""), "Never");
  assert.equal(relativeTime("not a timestamp"), "–");
  assert.equal(relativeTime(new Date().toISOString()), "0s ago");
});

test("relativeTime never reports a negative age for a clock-skewed future timestamp", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(relativeTime(future), "0s ago");
});

test("formatValue distinguishes absent values from falsy ones", () => {
  assert.equal(formatValue(null), "–");
  assert.equal(formatValue(undefined), "–");
  assert.equal(formatValue(0), "0");
  assert.equal(formatValue(false), "false");
  assert.equal(formatValue(""), "");
  assert.equal(formatValue({ a: 1 }), '{"a":1}');
});

test("shortId only elides identifiers past the display budget", () => {
  const short = "abc123";
  assert.equal(shortId(short), short);
  const long = "a".repeat(40);
  const elided = shortId(long);
  assert.ok(elided.includes("…"));
  assert.ok(elided.length < long.length);
});

test("eventLabel falls back to a humanized type for unknown events", () => {
  assert.equal(eventLabel({ type: "task.created" }), "Task created");
  assert.equal(eventLabel({ type: "some.new_event" }), "Some New Event");
});

test("confidenceLabel clamps out-of-range values and rejects non-numbers", () => {
  assert.equal(confidenceLabel("high"), "Not provided");
  assert.equal(confidenceLabel(Number.NaN), "Not provided");
  assert.equal(confidenceLabel(1.5), "100% · 1.00");
  assert.equal(confidenceLabel(-2), "0% · 0.00");
});
