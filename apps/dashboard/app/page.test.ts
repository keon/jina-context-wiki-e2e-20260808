import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboardPage } from "./page.js";

test("dashboard page renders clickable task detail affordances", () => {
  const html = renderDashboardPage("https://api.example.test");

  assert.match(html, /data-task-id/);
  assert.match(html, /href="\/" data-page="board"/);
  assert.match(html, /href="\/history" data-page="history"/);
  assert.match(html, /href="\/tasks" data-page="task-types"/);
  assert.match(html, /href="\/ontology" data-page="ontology"/);
  assert.match(html, /aria-label="Task board"/);
  assert.match(html, /aria-label="Task type list"/);
  assert.match(html, /function renderColumns/);
  assert.match(html, /function partitionBoardTasks/);
  assert.match(html, /latestRequestByScope/);
  assert.match(html, /showingHistory \? partition\.history : partition\.current/);
  assert.match(html, /function renderTaskTypes/);
  assert.match(html, /function taskTypeDependencyGroups/);
  assert.match(html, /Depends on/);
  assert.match(html, /Required by/);
  assert.match(html, /workflow: /);
  assert.match(html, /function renderOntology/);
  assert.match(html, /if \(showingOntology\)/);
  assert.match(html, /aria-label="Repository ontology graph"/);
  assert.match(html, /Ask with citations/);
  assert.match(html, /function renderIssueTrace/);
  assert.match(html, /function appendTraceCitations/);
  assert.match(html, /Causal evidence:/);
  assert.match(html, /was caused by/);
  assert.match(html, /No verified pull request or commit relationship has been asserted/);
  assert.match(html, /\/ontology\/ask/);
  assert.match(html, /function renderContextResults/);
  assert.doesNotMatch(html, /function renderTaskList/);
  assert.match(html, /Dependencies & relationships/);
  assert.match(html, /Comments & activity/);
  assert.match(html, /#task=/);
  assert.match(html, /https:\/\/api\.example\.test/);

  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));

  const partitionSource = script.match(/function partitionBoardTasks\(tasks\) \{[\s\S]+?\n\}\n\nfunction renderColumns/)?.[0]
    .replace(/\n\nfunction renderColumns$/, "");
  assert.ok(partitionSource);
  const partition = new Function(`${partitionSource}; return partitionBoardTasks;`)() as (tasks: unknown[]) => {
    current: Array<{ id: string }>;
    history: Array<{ id: string }>;
  };
  const result = partition([
    { id: "old-root", type: "ontology_build", status: "failed", createdAt: "2026-01-01", metadata: { tenantId: "t", repository: "o/r", ref: "main", requestKey: "old" } },
    { id: "old-project", type: "ontology_project", status: "canceled", createdAt: "2026-01-01", metadata: { tenantId: "t", repository: "o/r", ref: "main", requestKey: "old" } },
    { id: "new-root", type: "ontology_build", status: "done", createdAt: "2026-01-02", metadata: { tenantId: "t", repository: "o/r", ref: "main", requestKey: "new" } },
    { id: "new-project", type: "ontology_project", status: "done", createdAt: "2026-01-02", metadata: { tenantId: "t", repository: "o/r", ref: "main", requestKey: "new" } },
    { id: "old-review", type: "review_pass", status: "superseded", createdAt: "2026-01-01", metadata: {} },
    { id: "issue", type: "issue_triage", status: "triage", createdAt: "2026-01-02", metadata: {} }
  ]);
  assert.deepEqual(result.current.map((task) => task.id), ["new-root", "new-project", "issue"]);
  assert.deepEqual(result.history.map((task) => task.id), ["old-root", "old-project", "old-review"]);
});
