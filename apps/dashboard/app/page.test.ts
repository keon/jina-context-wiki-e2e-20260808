import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboardPage } from "./page.js";

test("dashboard page renders clickable task detail affordances", () => {
  const html = renderDashboardPage("https://api.example.test");

  assert.match(html, /data-task-id/);
  assert.match(html, /aria-label="Task list"/);
  assert.match(html, /function renderTaskList/);
  assert.doesNotMatch(html, /function renderColumns/);
  assert.match(html, /Dependencies & relationships/);
  assert.match(html, /Comments & activity/);
  assert.match(html, /#task=/);
  assert.match(html, /https:\/\/api\.example\.test/);

  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});
