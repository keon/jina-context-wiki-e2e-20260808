import assert from "node:assert/strict";
import { test } from "node:test";
import { mermaidFences, replaceMermaidFences } from "./context-wiki-mermaid-fences.js";

test("unclosed Mermaid fences extend to EOF", () => {
  const markdown = "intro\n~~~mermaid\nflowchart LR\nA -->";
  assert.deepEqual(
    mermaidFences(markdown).map(({ source, markdown }) => ({ source, markdown })),
    [{ source: "flowchart LR\nA -->", markdown: "~~~mermaid\nflowchart LR\nA -->" }]
  );
});

test("Mermaid-looking examples inside another fenced block remain inert", () => {
  const markdown = "````md\n~~~mermaid\nflowchart LR\nA --> B\n~~~\n````\n";
  assert.equal(mermaidFences(markdown).length, 0);
});

test("blockquote and list container Mermaid nodes use the rendered CommonMark source", () => {
  const markdown = [
    "> ~~~mermaid",
    "> flowchart LR",
    "> A --> B",
    "> ~~~",
    "",
    "- diagram",
    "  ```mermaid",
    "  sequenceDiagram",
    "  A->>B: call",
    "  ```"
  ].join("\n");
  assert.deepEqual(
    mermaidFences(markdown).map((fence) => fence.source),
    ["flowchart LR\nA --> B", "sequenceDiagram\nA->>B: call"]
  );
});

test("replacement preserves the closing-line separator before adjacent prose", () => {
  const markdown = "~~~mermaid\nflowchart LR\nA -->\n~~~\nFollowing paragraph";
  assert.equal(
    replaceMermaidFences(markdown, () => "REPLACED"),
    "REPLACED\nFollowing paragraph"
  );
});

test("closing markers match their character and are at least as long as the opening marker", () => {
  const markdown = [
    "~~~~mermaid",
    "flowchart LR",
    "A --> B",
    "~~~",
    "B --> C",
    "~~~~~",
    "```mermaid",
    "sequenceDiagram",
    "A->>B: call",
    "````"
  ].join("\n");
  assert.deepEqual(
    mermaidFences(markdown).map((fence) => fence.source),
    ["flowchart LR\nA --> B\n~~~\nB --> C", "sequenceDiagram\nA->>B: call"]
  );
});
