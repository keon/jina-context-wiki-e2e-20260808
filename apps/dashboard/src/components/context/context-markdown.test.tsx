import assert from "node:assert/strict";
import { test } from "node:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderComponent } from "../../testing/render.tsx";
import type { ContextCatalogDocument, ContextRelease } from "../../lib/types.ts";
import { ContextMarkdown } from "./context-markdown.tsx";

const release: ContextRelease = {
  id: "release-1",
  repository: "acme/api",
  ref: "main",
  commitSha: "a".repeat(40),
  createdAt: "2026-08-07T12:00:00.000Z",
  completeness: "complete",
  contextStatus: "available"
};

const catalogDocument: ContextCatalogDocument = {
  id: "architecture",
  logicalId: "architecture:acme/api:system",
  revisionId: "revision-1",
  title: "Architecture",
  summary: "System architecture",
  citations: []
};

test("invalid Mermaid stays inside a compact fallback instead of injecting an error diagram", async () => {
  const source = "graph TD\nA -->";
  renderComponent(
    <ContextMarkdown
      bodyMarkdown={`\`\`\`mermaid\n${source}\n\`\`\``}
      release={release}
      document={catalogDocument}
      documents={[catalogDocument]}
      onOpen={() => undefined}
    />
  );

  await waitFor(() => assert.ok(screen.getByLabelText("Diagram unavailable")), { timeout: 5_000 });

  assert.equal(document.body.querySelector("svg"), null);
  assert.doesNotMatch(document.body.textContent ?? "", /syntax error in text/i);

  const summary = screen.getByText("Show diagram source");
  const details = summary.closest("details");
  assert.equal(details?.hasAttribute("open"), false);

  fireEvent.click(summary);
  assert.equal(details?.hasAttribute("open"), true);
  assert.equal(screen.getByLabelText("Diagram unavailable").querySelector("code")?.textContent, source);
});
