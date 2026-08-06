import assert from "node:assert/strict";
import { test } from "node:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { jsonResponse, renderComponent, renderWithQueryClient } from "../../testing/render.tsx";
import type { ContextRelease } from "../../lib/types.ts";
import { ContextSearch } from "./context-browser.tsx";
import { ContextPage, RepositoryPicker } from "./context-page.tsx";

function release(repository: string, id: string): ContextRelease {
  return {
    id,
    repository,
    ref: "main",
    commitSha: id.padEnd(40, "0"),
    createdAt: "2026-08-06T12:00:00.000Z",
    completeness: "complete",
    contextStatus: "available"
  };
}

test("repository picker gates the Wiki behind explicit card selection", () => {
  let selected = "";
  renderComponent(
    <RepositoryPicker
      repositories={[{ name: "daniel/ecommerce-dashboard", defaultBranch: "main" }]}
      onSelect={(repository) => {
        selected = repository;
      }}
    />
  );

  assert.equal(screen.getByRole("link", { name: /Add repo/ }).getAttribute("href"), "/integrations");
  fireEvent.click(screen.getByRole("button", { name: /ecommerce-dashboard/ }));
  assert.equal(selected, "daniel/ecommerce-dashboard");
});

test("wiki shows the repository picker when no workspace is available", () => {
  renderWithQueryClient(<ContextPage />);

  assert.equal(screen.getByRole("link", { name: /Add repo/ }).getAttribute("href"), "/integrations");
  assert.equal(screen.queryByText("No workspace selected"), null);
});

test("workspace search queries each repository release and labels merged results", async () => {
  const payments = release("acme/payments", "pay");
  const web = release("acme/web", "web");
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const repository = String(body.repository);
    const target = repository === payments.repository ? payments : web;
    return jsonResponse({
      release: target,
      query: body.query,
      results: [
        {
          documentId: `${target.id}-architecture`,
          logicalId: `architecture:${repository}:system`,
          revisionId: `${target.id}-revision`,
          title: repository === payments.repository ? "Payments architecture" : "Web architecture",
          score: repository === payments.repository ? 0.9 : 0.8,
          selectedNodeIds: [],
          excerpts: [`Architecture for ${repository}`],
          citations: []
        }
      ],
      retrieval: { method: "lexical_tree", selector: "test" }
    });
  };

  renderComponent(
    <ContextSearch
      release={payments}
      workspaceReleases={[payments, web]}
      apiBasePath="/api/context"
      onOpen={() => undefined}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "All repositories" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search Context Wiki" }), {
    target: { value: "architecture" }
  });
  fireEvent.click(screen.getByRole("button", { name: "Search all" }));

  await waitFor(() => {
    assert.equal(screen.getAllByText(/architecture$/i).length, 2);
  });
  assert.deepEqual(
    bodies.map((body) => body.repository).sort(),
    ["acme/payments", "acme/web"]
  );
  assert.match(document.body.textContent ?? "", /2 repositories/);
  assert.match(document.body.textContent ?? "", /acme\/payments/);
  assert.match(document.body.textContent ?? "", /acme\/web/);
});
