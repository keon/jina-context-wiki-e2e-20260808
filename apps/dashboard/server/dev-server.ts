import { createServer } from "node:http";

/**
 * Dev dashboard: a single live board page against the api dev server.
 * The real dashboard (Next.js) replaces this when the product UI starts.
 */

const PORT = Number(process.env.PORT ?? 3000);
const API_URL = process.env.JINA_API_URL ?? "http://localhost:4000";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Jina board</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 2rem; }
  h1 { font-size: 1.2rem; }
  .toolbar { display: flex; gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  button { padding: .4rem .8rem; cursor: pointer; }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .75rem; }
  .column { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: .5rem; min-height: 8rem; }
  .column h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; margin: .25rem 0 .5rem; opacity: .7; }
  .card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 6px; padding: .4rem .5rem; margin-bottom: .4rem; font-size: .8rem; }
  .card .meta { opacity: .6; font-size: .7rem; }
  .superseded { opacity: .45; }
  #log { margin-top: 1.5rem; font-family: ui-monospace, monospace; font-size: .75rem; white-space: pre-wrap; opacity: .8; }
  #pubs { margin-top: 1rem; font-family: ui-monospace, monospace; font-size: .75rem; }
</style>
</head>
<body>
<h1>Jina board <span id="status" style="font-weight:normal;opacity:.6"></span></h1>
<div class="toolbar">
  <button onclick="openPr()">Webhook: open a new PR</button>
  <button onclick="openIssue()">Webhook: open a new issue</button>
  <button onclick="forcePush()">Webhook: force-push PR #42 (supersede epoch)</button>
</div>
<div class="columns" id="columns"></div>
<div id="pubs"></div>
<div id="log"></div>
<script>
const API = ${JSON.stringify(API_URL)};
const STATUSES = ["triage", "blocked", "queued", "in_progress", "done", "superseded", "failed", "canceled"];
let nextPr = 100;
let nextIssue = 200;

async function refresh() {
  try {
    const [board, events] = await Promise.all([
      fetch(API + "/board").then(r => r.json()),
      fetch(API + "/events").then(r => r.json())
    ]);
    document.getElementById("status").textContent = "· " + API;
    renderColumns(board.tasks);
    document.getElementById("pubs").textContent =
      board.publications.length ? "publications:\\n" + board.publications.map(p => "  " + p.key + " [" + p.status + "]").join("\\n") : "";
    document.getElementById("log").textContent =
      events.slice(-14).reverse().map(e => e.at + "  " + e.type + (e.taskId ? "  " + e.taskId.slice(0, 60) : "")).join("\\n");
  } catch (error) {
    document.getElementById("status").textContent = "· cannot reach " + API + " — is \`pnpm --filter @jina/api dev\` running?";
  }
}

function renderColumns(tasks) {
  const container = document.getElementById("columns");
  container.innerHTML = "";
  for (const status of STATUSES) {
    const items = tasks.filter(t => t.status === status);
    if (items.length === 0 && !["triage", "queued", "in_progress", "done"].includes(status)) continue;
    const column = document.createElement("div");
    column.className = "column";
    column.innerHTML = "<h2>" + status + " (" + items.length + ")</h2>";
    for (const task of items) {
      const card = document.createElement("div");
      card.className = "card" + (status === "superseded" ? " superseded" : "");
      const title = document.createElement("div");
      title.textContent = task.title;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = task.type + " · epoch " + (task.epoch ?? "-") +
        " · attempt " + task.attempt + " · " + task.assigneeRole;
      card.append(title, meta);
      column.appendChild(card);
    }
    container.appendChild(column);
  }
}

function openPr() {
  nextPr += 1;
  post({ repository: "omlabs/example", pullRequestNumber: nextPr, headSha: "sha-" + nextPr + "-1" });
}
function openIssue() {
  nextIssue += 1;
  post({ repository: "omlabs/example", issueNumber: nextIssue, title: "Demo issue " + nextIssue });
}
function forcePush() {
  post({ repository: "omlabs/example", pullRequestNumber: 42, headSha: "sha-42-" + Date.now().toString(36) });
}
async function post(body) {
  await fetch(API + "/dev/webhooks/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  refresh();
}

refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>`;

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE);
});

server.listen(PORT, () => {
  console.log(`jina dashboard dev server: http://localhost:${PORT}  (api: ${API_URL})`);
});
