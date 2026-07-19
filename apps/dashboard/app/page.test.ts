import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboardPage } from "./page.js";

test("dashboard page renders clickable task detail affordances", () => {
  const html = renderDashboardPage("https://api.example.test");

  assert.match(html, /data-task-id/);
  assert.match(html, /href="\/" data-page="board"/);
  assert.match(html, /href="\/tasks" data-page="task-types"/);
  assert.match(html, /href="\/ontology" data-page="ontology"/);
  assert.match(html, /aria-label="Task board"/);
  assert.match(html, /aria-label="Task type list"/);
  assert.match(html, /function renderColumns/);
  assert.match(html, /function renderTaskTypes/);
  assert.match(html, /function renderOntology/);
  assert.match(html, /aria-label="Repository ontology graph"/);
  assert.doesNotMatch(html, /function renderTaskList/);
  assert.match(html, /Dependencies & relationships/);
  assert.match(html, /Comments & activity/);
  assert.match(html, /#task=/);
  assert.match(html, /https:\/\/api\.example\.test/);

  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});
