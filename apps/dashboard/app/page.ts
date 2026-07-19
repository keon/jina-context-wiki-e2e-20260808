export function renderDashboardPage(apiUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jina board</title>
<style>
  :root {
    color-scheme: dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #090b10;
    color: #f4f5f7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 15% -10%, #17213d 0, transparent 32rem), #090b10; }
  button, a { font: inherit; }
  button { color: inherit; }
  .shell { max-width: 1500px; margin: 0 auto; padding: 2rem; }
  .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
  .eyebrow { margin: 0 0 .35rem; color: #8491aa; font-size: .7rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  h1 { margin: 0; font-size: 1.55rem; letter-spacing: -.03em; }
  #connection { display: flex; align-items: center; gap: .5rem; color: #9aa4b7; font-size: .78rem; }
  .pulse { width: .5rem; height: .5rem; border-radius: 50%; background: #3ddc97; box-shadow: 0 0 0 .25rem rgb(61 220 151 / 12%); }
  .pulse.offline { background: #ff6b6b; box-shadow: 0 0 0 .25rem rgb(255 107 107 / 12%); }
  .toolbar { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
  .toolbar button, .ghost-button {
    border: 1px solid #293044; border-radius: .55rem; background: #121722; padding: .48rem .72rem; cursor: pointer; font-size: .75rem;
  }
  .toolbar button:hover, .ghost-button:hover { border-color: #56627c; background: #181f2d; }
  .toolbar-label { color: #77839a; font-size: .72rem; margin-right: .15rem; }
  .page-nav { display: flex; gap: .35rem; margin-bottom: 1.25rem; border-bottom: 1px solid #202637; }
  .page-nav a { padding: .65rem .15rem .6rem; margin-right: 1rem; color: #78849a; text-decoration: none; font-size: .76rem; font-weight: 650; border-bottom: 2px solid transparent; }
  .page-nav a:hover { color: #c5ccda; }
  .page-nav a.active { color: #f1f3f7; border-bottom-color: #809cff; }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: .85rem; align-items: start; }
  .column { border: 1px solid #202637; border-radius: .8rem; background: rgb(15 19 28 / 78%); padding: .65rem; min-height: 10rem; }
  .column h2 { display: flex; justify-content: space-between; margin: .15rem .15rem .65rem; color: #8e99ad; font-size: .7rem; letter-spacing: .09em; text-transform: uppercase; }
  .count { display: grid; place-items: center; min-width: 1.25rem; height: 1.25rem; border-radius: 99px; background: #20283a; color: #c6cede; font-size: .65rem; }
  .card {
    width: 100%; border: 1px solid #2a3144; border-radius: .7rem; background: linear-gradient(145deg, #171c27, #121620);
    padding: .75rem; margin-bottom: .55rem; text-align: left; cursor: pointer; transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
  }
  .card:hover { transform: translateY(-1px); border-color: #5b6a88; background: #1a2030; }
  .card:focus-visible { outline: 2px solid #8ea8ff; outline-offset: 2px; }
  .card-title { display: block; font-size: .82rem; font-weight: 650; line-height: 1.35; }
  .card-meta { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .6rem; color: #838ea2; font-size: .66rem; }
  .chip { border: 1px solid #2d3548; border-radius: 99px; padding: .12rem .38rem; }
  .task-panel { border: 1px solid #202637; border-radius: .85rem; background: rgb(15 19 28 / 78%); overflow: hidden; }
  .task-panel-header { display: flex; align-items: center; justify-content: space-between; padding: .85rem 1rem; border-bottom: 1px solid #22293a; }
  .task-panel-header h2 { margin: 0; font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; color: #a5afc1; }
  .task-count { color: #748198; font-size: .7rem; }
  .task-list { display: grid; }
  .type-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 1rem; width: 100%;
    border-bottom: 1px solid #202738; padding: .9rem 1rem;
  }
  .type-row:last-child { border-bottom: 0; }
  .type-name { display: block; font: .8rem ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; color: #dce2ed; }
  .type-description { display: block; margin-top: .35rem; color: #8793a8; font-size: .72rem; line-height: 1.45; }
  .type-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .35rem; color: #8b97ac; font-size: .65rem; }
  .type-chip { border: 1px solid #30394d; border-radius: 99px; padding: .18rem .42rem; white-space: nowrap; }
  .superseded { opacity: .48; }
  .empty { padding: 1.5rem .5rem; color: #586277; text-align: center; font-size: .72rem; }
  .feed { margin-top: 1.4rem; border-top: 1px solid #1f2534; padding-top: 1rem; }
  .feed h2 { margin: 0 0 .6rem; font-size: .78rem; color: #8f9aaf; }
  #log { color: #68748a; font: .68rem/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }

  dialog { width: min(760px, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); padding: 0; border: 1px solid #30394e; border-radius: 1rem; background: #10141d; color: #f3f5f8; box-shadow: 0 2rem 6rem rgb(0 0 0 / 55%); }
  dialog::backdrop { background: rgb(3 5 9 / 72%); backdrop-filter: blur(5px); }
  .detail-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 1.2rem 1.35rem; border-bottom: 1px solid #262d3e; background: rgb(16 20 29 / 94%); backdrop-filter: blur(12px); }
  .detail-title { margin: .15rem 0 0; font-size: 1.15rem; line-height: 1.3; letter-spacing: -.02em; }
  .close { display: grid; place-items: center; width: 2rem; height: 2rem; border: 1px solid #30384b; border-radius: .5rem; background: #171c27; cursor: pointer; font-size: 1rem; }
  .detail-body { padding: 1.25rem 1.35rem 1.6rem; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: .55rem; margin-bottom: 1.25rem; }
  .summary-item { border: 1px solid #242c3e; border-radius: .65rem; background: #141923; padding: .62rem .7rem; }
  .label { display: block; margin-bottom: .25rem; color: #727f96; font-size: .62rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .value { display: block; font-size: .76rem; overflow-wrap: anywhere; }
  .status { display: inline-flex; align-items: center; gap: .35rem; font-weight: 700; }
  .status::before { content: ""; width: .42rem; height: .42rem; border-radius: 50%; background: #76839c; }
  .status-done::before { background: #3ddc97; }
  .status-in_progress::before, .status-queued::before { background: #71a7ff; }
  .status-failed::before, .status-canceled::before { background: #ff6b6b; }
  .status-blocked::before, .status-triage::before { background: #f4bd50; }
  .section { margin-top: 1.25rem; }
  .section h3 { margin: 0 0 .65rem; color: #aab3c4; font-size: .72rem; letter-spacing: .07em; text-transform: uppercase; }
  .relationship-list { display: grid; gap: .45rem; }
  .relationship {
    display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .65rem; width: 100%; border: 1px solid #272f42; border-radius: .65rem; background: #141923; padding: .62rem .7rem; text-align: left; cursor: pointer;
  }
  .relationship:hover { border-color: #596783; }
  .relation-direction { color: #71809a; font-size: .66rem; }
  .relation-title { font-size: .76rem; font-weight: 620; }
  .relation-type { color: #8290aa; font: .62rem ui-monospace, SFMono-Regular, Menlo, monospace; }
  .metadata { margin: 0; display: grid; grid-template-columns: minmax(110px, .35fr) minmax(0, 1fr); border: 1px solid #272f42; border-radius: .65rem; overflow: hidden; }
  .metadata dt, .metadata dd { margin: 0; padding: .52rem .65rem; border-bottom: 1px solid #232a3a; font-size: .7rem; overflow-wrap: anywhere; }
  .metadata dt { color: #77849a; background: #141923; }
  .metadata dd { color: #d6dbe5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .metadata dt:last-of-type, .metadata dd:last-of-type { border-bottom: 0; }
  .metadata a { color: #8eabff; }
  .timeline { position: relative; display: grid; gap: .55rem; }
  .event { border-left: 2px solid #303a50; padding: .2rem 0 .45rem .8rem; }
  .event-top { display: flex; justify-content: space-between; gap: 1rem; }
  .event-type { font-size: .73rem; font-weight: 650; }
  .event-time { color: #68758c; font-size: .62rem; white-space: nowrap; }
  .event-payload { margin: .35rem 0 0; color: #7e8aa0; font: .64rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty-detail { color: #68758c; font-size: .72rem; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (max-width: 640px) { .shell { padding: 1rem; } .topbar { flex-direction: column; } .type-row { grid-template-columns: 1fr; } .type-meta { justify-content: flex-start; } .detail-body, .detail-header { padding-left: 1rem; padding-right: 1rem; } }
</style>
</head>
<body>
<main class="shell">
  <header class="topbar">
    <div><p class="eyebrow">Review operations</p><h1 id="page-title">Jina board</h1></div>
    <div id="connection"><span class="pulse" id="connection-dot"></span><span id="connection-text">Connecting…</span></div>
  </header>
  <nav class="page-nav" aria-label="Dashboard pages">
    <a href="/" data-page="board">Board</a>
    <a href="/tasks" data-page="task-types">Task types</a>
  </nav>
  <section id="board-page">
    <div class="toolbar" id="toolbar">
      <span class="toolbar-label">Demo events</span>
      <button type="button" data-demo="pr">Open PR</button>
      <button type="button" data-demo="issue">Open issue</button>
      <button type="button" data-demo="push">Force-push PR #42</button>
    </div>
    <section class="columns" id="columns" aria-label="Task board"></section>
    <section class="feed"><h2>Recent board activity</h2><div id="log"></div></section>
  </section>
  <section id="task-types-page" hidden>
    <section class="task-panel" aria-labelledby="task-types-heading">
      <header class="task-panel-header"><h2 id="task-types-heading">Task types</h2><span class="task-count" id="task-type-count"></span></header>
      <div class="task-list" id="task-type-list" aria-label="Task type list"></div>
    </section>
  </section>
</main>

<dialog id="task-dialog" aria-labelledby="detail-title">
  <header class="detail-header">
    <div><p class="eyebrow" id="detail-eyebrow">Task details</p><h2 class="detail-title" id="detail-title"></h2></div>
    <button type="button" class="close" id="close-detail" aria-label="Close task details">×</button>
  </header>
  <div class="detail-body" id="detail-body"></div>
</dialog>

<script>
const API = ${JSON.stringify(apiUrl)};
let boardState = { tasks: [], dependencies: [], publications: [] };
let boardEvents = [];
let taskTypes = [];
let nextPr = 100;
let nextIssue = 200;

const columns = document.getElementById("columns");
const taskTypeList = document.getElementById("task-type-list");
const log = document.getElementById("log");
const dialog = document.getElementById("task-dialog");
const detailTitle = document.getElementById("detail-title");
const detailEyebrow = document.getElementById("detail-eyebrow");
const detailBody = document.getElementById("detail-body");

async function refresh() {
  try {
    const responses = await Promise.all([fetch(API + "/board"), fetch(API + "/events"), fetch(API + "/task-types")]);
    if (!responses[0].ok || !responses[1].ok || !responses[2].ok) throw new Error("API request failed");
    boardState = await responses[0].json();
    boardEvents = await responses[1].json();
    taskTypes = await responses[2].json();
    setConnection(true);
    renderPage();
    renderColumns();
    renderTaskTypes();
    renderLog();
    renderSelectedTask();
  } catch (error) {
    setConnection(false);
  }
}

function setConnection(online) {
  document.getElementById("connection-dot").classList.toggle("offline", !online);
  document.getElementById("connection-text").textContent = online ? "Live · " + API : "Cannot reach " + API;
}

function renderPage() {
  const showingTaskTypes = location.pathname === "/tasks";
  document.getElementById("board-page").hidden = showingTaskTypes;
  document.getElementById("task-types-page").hidden = !showingTaskTypes;
  document.getElementById("page-title").textContent = showingTaskTypes ? "Task types" : "Jina board";
  for (const link of document.querySelectorAll("[data-page]")) {
    link.classList.toggle("active", link.dataset.page === (showingTaskTypes ? "task-types" : "board"));
  }
}

function renderColumns() {
  columns.replaceChildren();
  const statuses = ["triage", "blocked", "queued", "in_progress", "done", "superseded", "failed", "canceled"];
  for (const status of statuses) {
    const items = boardState.tasks.filter(function(task) { return task.status === status; });
    if (items.length === 0 && !["triage", "queued", "in_progress", "done"].includes(status)) continue;
    const column = element("section", "column");
    const heading = element("h2");
    heading.append(document.createTextNode(humanize(status)), textElement("span", "count", String(items.length)));
    column.append(heading);
    if (items.length === 0) column.append(textElement("div", "empty", "No tasks"));
    for (const task of items) column.append(taskCard(task));
    columns.append(column);
  }
}

function taskCard(task) {
  const card = element("button", "card" + (task.status === "superseded" ? " superseded" : ""));
  card.type = "button";
  card.dataset.taskId = task.id;
  card.setAttribute("aria-label", "Open task: " + task.title + ", epoch " + (task.epoch ?? "none"));
  card.append(textElement("span", "card-title", task.title));
  const meta = element("span", "card-meta");
  meta.append(
    textElement("span", "chip", humanize(task.type)),
    textElement("span", "chip", "epoch " + (task.epoch ?? "–")),
    textElement("span", "chip", "attempt " + task.attempt)
  );
  card.append(meta);
  return card;
}

function renderTaskTypes() {
  taskTypeList.replaceChildren();
  document.getElementById("task-type-count").textContent = taskTypes.length + " types";
  for (const definition of taskTypes) {
    const row = element("article", "type-row");
    const copy = element("div");
    copy.append(textElement("span", "type-name", definition.type), textElement("span", "type-description", definition.description));
    const meta = element("div", "type-meta");
    meta.append(
      textElement("span", "type-chip", humanize(definition.kind)),
      textElement("span", "type-chip", humanize(definition.defaultAssigneeRole))
    );
    if (definition.dispatchTopic) meta.append(textElement("span", "type-chip", definition.dispatchTopic));
    row.append(copy, meta);
    taskTypeList.append(row);
  }
}

function renderSelectedTask() {
  const taskId = selectedTaskId();
  if (!taskId) {
    if (dialog.open) dialog.close();
    return;
  }
  const task = taskById(taskId);
  if (!task) return;
  detailTitle.textContent = task.title;
  detailEyebrow.textContent = humanize(task.type) + " · " + shortId(task.id);
  detailBody.replaceChildren();
  detailBody.append(summary(task));
  detailBody.append(relationshipSection(task));
  detailBody.append(metadataSection(task));
  detailBody.append(activitySection(task));
  if (!dialog.open) dialog.showModal();
}

function summary(task) {
  const grid = element("section", "summary-grid");
  grid.append(summaryItem("Status", humanize(task.status), "status status-" + task.status));
  grid.append(summaryItem("Assignee", humanize(task.assigneeRole)));
  grid.append(summaryItem("Attempt", String(task.attempt)));
  grid.append(summaryItem("Epoch", String(task.epoch ?? "–")));
  grid.append(summaryItem("Created", formatTime(task.createdAt)));
  grid.append(summaryItem("Updated", formatTime(task.updatedAt)));
  return grid;
}

function summaryItem(label, value, valueClass) {
  const item = element("div", "summary-item");
  item.append(textElement("span", "label", label), textElement("span", valueClass || "value", value));
  return item;
}

function relationshipSection(task) {
  const section = element("section", "section");
  section.append(textElement("h3", "", "Dependencies & relationships"));
  const list = element("div", "relationship-list");
  const relationships = [];
  if (task.parentTaskId) relationships.push({ direction: "Parent", taskId: task.parentTaskId, relationship: "parent" });
  for (const child of boardState.tasks.filter(function(item) { return item.parentTaskId === task.id; })) {
    relationships.push({ direction: "Child", taskId: child.id, relationship: "child" });
  }
  for (const dependency of boardState.dependencies || []) {
    if (dependency.taskId === task.id) relationships.push({ direction: "Depends on", taskId: dependency.dependsOnTaskId, relationship: dependency.relationship, required: dependency.required });
    if (dependency.dependsOnTaskId === task.id) relationships.push({ direction: "Required by", taskId: dependency.taskId, relationship: dependency.relationship, required: dependency.required });
  }
  if (relationships.length === 0) list.append(textElement("p", "empty-detail", "No task relationships."));
  for (const relationship of relationships) {
    const related = taskById(relationship.taskId);
    const row = element("button", "relationship");
    row.type = "button";
    row.dataset.taskId = relationship.taskId;
    row.append(
      textElement("span", "relation-direction", relationship.direction),
      textElement("span", "relation-title", related ? related.title : shortId(relationship.taskId)),
      textElement("span", "relation-type", relationship.relationship + (relationship.required ? " · required" : ""))
    );
    list.append(row);
  }
  section.append(list);
  return section;
}

function metadataSection(task) {
  const section = element("section", "section");
  section.append(textElement("h3", "", "Metadata"));
  const list = element("dl", "metadata");
  const entries = [
    ["Task ID", task.id], ["Dedupe key", task.dedupeKey], ["Required", String(task.required)],
    ["Dispatch topic", task.dispatchTopic || "–"]
  ].concat(Object.entries(task.metadata || {}).sort(function(a, b) { return a[0].localeCompare(b[0]); }));
  for (const entry of entries) {
    list.append(textElement("dt", "", humanize(entry[0])));
    const value = element("dd");
    if (typeof entry[1] === "string" && /^https:\\/\\//.test(entry[1])) {
      const link = textElement("a", "", entry[1]);
      link.href = entry[1]; link.target = "_blank"; link.rel = "noreferrer";
      value.append(link);
    } else {
      value.textContent = formatValue(entry[1]);
    }
    list.append(value);
  }
  section.append(list);
  return section;
}

function activitySection(task) {
  const section = element("section", "section");
  section.append(textElement("h3", "", "Comments & activity"));
  const timeline = element("div", "timeline");
  const events = boardEvents.filter(function(event) { return event.taskId === task.id; }).slice().reverse();
  if (events.length === 0) timeline.append(textElement("p", "empty-detail", "No comments or activity recorded."));
  for (const event of events) {
    const row = element("article", "event");
    const top = element("div", "event-top");
    top.append(textElement("span", "event-type", eventLabel(event)), textElement("time", "event-time", formatTime(event.at)));
    row.append(top);
    if (event.payload && Object.keys(event.payload).length > 0) row.append(textElement("pre", "event-payload", JSON.stringify(event.payload, null, 2)));
    timeline.append(row);
  }
  section.append(timeline);
  return section;
}

function eventLabel(event) {
  const labels = {
    "task.created": "Task created", "task.queued": "Queued for execution", "task.transitioned": "Status changed",
    "task.dependency_added": "Dependency linked", "run.step": "Run comment", "review.completed": "Review completed",
    "publish.completed": "Publication comment", "github.issue_opened": "GitHub issue received"
  };
  return labels[event.type] || humanize(event.type);
}

function renderLog() {
  log.textContent = boardEvents.slice(-12).reverse().map(function(event) {
    const task = event.taskId ? taskById(event.taskId) : null;
    return formatTime(event.at) + "  " + event.type + (task ? "  " + task.title : "");
  }).join("\\n");
}

function selectedTaskId() {
  const match = location.hash.match(/^#task=(.+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function openTask(taskId) { location.hash = "task=" + encodeURIComponent(taskId); }
function closeTask() {
  history.replaceState(null, "", location.pathname + location.search);
  if (dialog.open) dialog.close();
}
function taskById(taskId) { return boardState.tasks.find(function(task) { return task.id === taskId; }); }
function shortId(value) { return value.length > 34 ? value.slice(0, 18) + "…" + value.slice(-12) : value; }
function humanize(value) { return String(value).replace(/[._-]+/g, " ").replace(/\\b\\w/g, function(char) { return char.toUpperCase(); }); }
function formatTime(value) { return value ? new Date(value).toLocaleString() : "–"; }
function formatValue(value) { return typeof value === "object" ? JSON.stringify(value) : String(value ?? "–"); }
function element(tag, className) { const node = document.createElement(tag); if (className) node.className = className; return node; }
function textElement(tag, className, text) { const node = element(tag, className); node.textContent = text; return node; }

columns.addEventListener("click", function(event) {
  const card = event.target.closest("[data-task-id]");
  if (card) openTask(card.dataset.taskId);
});
detailBody.addEventListener("click", function(event) {
  const relationship = event.target.closest("[data-task-id]");
  if (relationship) openTask(relationship.dataset.taskId);
});
document.getElementById("close-detail").addEventListener("click", closeTask);
dialog.addEventListener("cancel", function(event) { event.preventDefault(); closeTask(); });
dialog.addEventListener("click", function(event) { if (event.target === dialog) closeTask(); });
window.addEventListener("hashchange", renderSelectedTask);
document.getElementById("toolbar").addEventListener("click", function(event) {
  const action = event.target.dataset.demo;
  if (action === "pr") postDemo({ repository: "omlabs/example", pullRequestNumber: ++nextPr, headSha: "sha-" + nextPr + "-1" });
  if (action === "issue") postDemo({ repository: "omlabs/example", issueNumber: ++nextIssue, title: "Demo issue " + nextIssue });
  if (action === "push") postDemo({ repository: "omlabs/example", pullRequestNumber: 42, headSha: "sha-42-" + Date.now().toString(36) });
});
async function postDemo(body) {
  await fetch(API + "/dev/webhooks/github", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await refresh();
}

refresh();
setInterval(refresh, 2500);
</script>
</body>
</html>`;
}
