import assert from "node:assert/strict";
import test from "node:test";

import {
  ancestorPaths,
  buildContextTree,
  categoryLabel,
  documentSubject,
} from "./context-tree";
import type { ContextDocumentSummary } from "./context-tree";

function doc(
  logicalId: string,
  kind: string,
  overrides: Partial<ContextDocumentSummary> = {},
): ContextDocumentSummary {
  return {
    id: `kr_${logicalId}`,
    releaseId: "rel_test",
    logicalId,
    repository: "omxyz/jina",
    kind,
    title: logicalId,
    summary: "",
    reviewStatus: "generated",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("the subject is everything after the kind and repository, which both contain separators", () => {
  // The repository contains a slash and some subjects contain colons, so a naive
  // split on ":" would truncate them.
  assert.equal(
    documentSubject("component:omxyz/jina:api/server"),
    "api/server",
  );
  assert.equal(
    documentSubject("decision:omxyz/jina:auth:token-format#3"),
    "auth:token-format#3",
  );
  assert.equal(
    documentSubject("repository:omxyz/jina:architecture"),
    "architecture",
  );
  assert.equal(documentSubject("malformed"), "malformed");
});

test("documents nest by repository, then category, then the subject's path", () => {
  const tree = buildContextTree([
    doc("component:omxyz/jina:api/server", "component"),
    doc("component:omxyz/jina:api/worker", "component"),
    doc("component:omxyz/jina:db", "component"),
    doc("repository:omxyz/jina:architecture", "architecture"),
  ]);

  assert.deepEqual(
    tree.map((node) => node.name),
    ["omxyz/jina"],
  );
  const repository = tree[0]!;
  // Architecture leads, because the ordering is deliberate rather than alphabetical.
  assert.deepEqual(
    repository.children.map((node) => node.name),
    ["architecture", "component"],
  );

  const components = repository.children.find(
    (node) => node.name === "component",
  )!;
  // `api/` became a folder holding two documents; `db` is a document beside it.
  assert.deepEqual(
    components.children.map((node) => `${node.kind}:${node.name}`),
    ["folder:api", "document:db"],
  );
  const api = components.children[0]!;
  assert.deepEqual(
    api.children.map((node) => node.name),
    ["server", "worker"],
  );
  assert.equal(api.documentCount, 2);
  assert.equal(repository.documentCount, 4);
});

test("two repositories stay separate", () => {
  const tree = buildContextTree([
    doc("component:omxyz/jina:api", "component"),
    doc("component:omxyz/other:api", "component", {
      repository: "omxyz/other",
    }),
  ]);
  assert.deepEqual(
    tree.map((node) => node.name),
    ["omxyz/jina", "omxyz/other"],
  );
  assert.equal(tree[0]?.documentCount, 1);
  assert.equal(tree[1]?.documentCount, 1);
});

test("only the newest revision of a logical document appears", () => {
  // The listing is newest-first, so the first one seen for a leaf wins.
  const tree = buildContextTree([
    doc("component:omxyz/jina:api", "component", {
      id: "kr_new",
      createdAt: "2026-02-01T00:00:00.000Z",
    }),
    doc("component:omxyz/jina:api", "component", {
      id: "kr_old",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ]);
  const components = tree[0]!.children[0]!;
  assert.equal(components.children.length, 1);
  assert.equal(components.children[0]?.document?.id, "kr_new");
  assert.equal(tree[0]?.documentCount, 1);
});

test("a commit-shaped change subject is shortened for reading", () => {
  const sha = "a".repeat(40);
  const tree = buildContextTree([
    doc(`change:omxyz/jina:${sha}`, "change_summary"),
  ]);
  const changes = tree[0]!.children[0]!;
  assert.equal(changes.children[0]?.name, sha.slice(0, 8));
  // The document itself keeps the full identifier.
  assert.equal(
    changes.children[0]?.document?.logicalId,
    `change:omxyz/jina:${sha}`,
  );
});

test("categories read as words rather than engine identifiers", () => {
  assert.equal(categoryLabel("change_summary"), "Changes");
  assert.equal(categoryLabel("issue_explanation"), "Issues");
  assert.equal(categoryLabel("something_new"), "something new");
});

test("ancestor paths reveal a selected document, and survive slashes in a segment", () => {
  // Repository names contain a slash, so paths are NUL-joined; splitting on "/"
  // would invent an "omxyz" ancestor that is not a node.
  const tree = buildContextTree([
    doc("component:omxyz/jina:api/server", "component"),
  ]);
  const repository = tree[0]!;
  const category = repository.children[0]!;
  const folder = category.children[0]!;
  const document = folder.children[0]!;

  assert.deepEqual(ancestorPaths(document.path), [
    repository.path,
    category.path,
    folder.path,
  ]);
  assert.equal(repository.name, "omxyz/jina");
});

test("a repository's own folders render as folders, without a category above them", () => {
  // These arrive as `topic` because the repository chose the structure, and the
  // structure is in the path.
  const tree = buildContextTree([
    doc("topic:microsoft/vscode:extensions/host/activation-events", "topic", {
      repository: "microsoft/vscode",
    }),
    doc("topic:microsoft/vscode:extensions/host/lifecycle", "topic", {
      repository: "microsoft/vscode",
    }),
    doc("topic:microsoft/vscode:editor-core/text-buffer", "topic", {
      repository: "microsoft/vscode",
    }),
  ]);

  const repository = tree[0]!;
  // No "Topic" level: the first thing under the repository is a real folder.
  assert.deepEqual(
    repository.children.map((node) => `${node.kind}:${node.name}`),
    ["folder:editor-core", "folder:extensions"],
  );
  const extensions = repository.children.find(
    (node) => node.name === "extensions",
  )!;
  const host = extensions.children[0]!;
  assert.equal(host.name, "host");
  assert.deepEqual(
    host.children.map((node) => node.name),
    ["activation-events", "lifecycle"],
  );
  assert.equal(repository.documentCount, 3);
});

test("a recognised kind still groups, because it says something the path does not", () => {
  const tree = buildContextTree([
    doc("runbook:omxyz/jina:stalled-publication", "runbook"),
    doc("topic:omxyz/jina:pipeline/stages", "topic"),
  ]);
  const repository = tree[0]!;
  assert.deepEqual(
    repository.children.map((node) => `${node.kind}:${node.name}`),
    ["category:runbook", "folder:pipeline"],
  );
});
