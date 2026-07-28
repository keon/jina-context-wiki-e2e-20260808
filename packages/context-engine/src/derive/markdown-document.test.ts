import assert from "node:assert/strict";
import test from "node:test";

import { documentPathFromFile, parseMarkdownDocument, resolveDocumentLink } from "./markdown-document.js";
import { evidenceSupportsClaim, verifyMarkdownCatalog } from "./markdown-verifier.js";
import { mapMarkdownCatalog } from "./markdown-catalog.js";
import { markdownCatalogToOutput } from "./markdown-output.js";
import { validateLogicalId } from "../domain/knowledge.js";
import type { EvidenceRecord } from "../domain/evidence.js";

const outbox = [
  "export async function claim() {",
  "  // lease expiry releases the row",
  "  return db.query(RELEASE);",
  "}"
].join("\n");

function record(body: string): EvidenceRecord {
  return { body, anchor: { sourceType: "blob", sourceId: "b".repeat(40) } } as unknown as EvidenceRecord;
}

const inputs = {
  evidenceByPath: new Map([["packages/db/src/outbox.ts", record(outbox)]]),
  documentPaths: new Set(["runbooks/stalled-publication", "components/api"]),
  resolveDocumentLink
};

test("both kinds of reference are ordinary Markdown links", () => {
  const parsed = parseMarkdownDocument(
    "components/api",
    [
      "# API server",
      "",
      "The claim path releases work when a lease expires:",
      "[lease expiry releases the row](packages/db/src/outbox.ts#L2-L3).",
      "",
      "See [Diagnose a stalled publication](../runbooks/stalled-publication.md).",
      ""
    ].join("\n")
  );

  // The title comes from the document, so a reader and the index agree on it.
  assert.equal(parsed.title, "API server");
  assert.deepEqual(parsed.evidenceLinks, [
    { claim: "lease expiry releases the row", path: "packages/db/src/outbox.ts", startLine: 2, endLine: 3 }
  ]);
  assert.deepEqual(parsed.documentLinks, [
    { text: "Diagnose a stalled publication", target: "../runbooks/stalled-publication.md" }
  ]);
});

test("a single-line anchor is a range of one, as GitHub writes it", () => {
  const parsed = parseMarkdownDocument("x", "[a claim of length](a/b.ts#L7)");
  assert.deepEqual(parsed.evidenceLinks, [{ claim: "a claim of length", path: "a/b.ts", startLine: 7, endLine: 7 }]);
});

test("links that name nothing citable are left as prose", () => {
  const parsed = parseMarkdownDocument(
    "x",
    "[an ordinary link](https://example.com) and [a bare path](src/thing.ts) and [backwards](a.ts#L9-L2)"
  );
  assert.deepEqual(parsed.evidenceLinks, []);
  assert.deepEqual(parsed.documentLinks, []);
});

test("a document's path is its identity, and relative links resolve against it", () => {
  assert.equal(documentPathFromFile("runbooks/stalled-publication.md"), "runbooks/stalled-publication");
  assert.equal(resolveDocumentLink("components/api", "../runbooks/x.md"), "runbooks/x");
  assert.equal(resolveDocumentLink("components/api", "./other.md"), "components/other");
  assert.equal(resolveDocumentLink("components/api", "sibling.md#a-heading"), "components/sibling");
  // A link that climbs out of the catalog cannot name a document in it.
  assert.equal(resolveDocumentLink("api", "../../escape.md"), undefined);
});

test("a claim must occur in the range it cites, which is what makes it checkable", () => {
  assert.equal(evidenceSupportsClaim("lease expiry releases the row", outbox), true);
  // Whitespace and case do not matter; fabrication does.
  assert.equal(evidenceSupportsClaim("LEASE   expiry  releases the row", outbox), true);
  assert.equal(evidenceSupportsClaim("retries three times with backoff", outbox), false);
  // Too short to mean anything: a three-character claim matches almost any file.
  assert.equal(evidenceSupportsClaim("row", outbox), false);
});

test("the catalog reports unsupported references without refusing to publish", () => {
  const documents = [
    parseMarkdownDocument(
      "components/api",
      [
        "# API",
        "[lease expiry releases the row](packages/db/src/outbox.ts#L2-L3)",
        "[retries three times with backoff](packages/db/src/outbox.ts#L2-L3)",
        "[a claim about a file that moved](packages/db/src/gone.ts#L1-L2)",
        "[out of range entirely](packages/db/src/outbox.ts#L900-L901)",
        "[a link to nowhere](../runbooks/missing.md)",
        "[a real one](../runbooks/stalled-publication.md)"
      ].join("\n\n")
    )
  ];

  const result = verifyMarkdownCatalog(documents, inputs);

  assert.equal(result.supported, 1);
  assert.deepEqual(
    result.problems.map((problem) => problem.reason),
    ["claim-absent", "unknown-path", "invalid-range", "unknown-document"]
  );
  // A wiki is useful with a broken link in it: the catalog still lands, and the
  // share a reader can trust is recorded per document.
  assert.equal(result.supportedByDocument.get("components/api"), 1);
});

test("diagnostics survive as ordinary sections, so diagnose still retrieves them as a set", () => {
  const parsed = parseMarkdownDocument(
    "runbooks/stalled-publication",
    [
      "# Diagnose a stalled publication",
      "",
      "Publication stops advancing when a barrier is incomplete.",
      "",
      "## Symptoms",
      "",
      "- Publication does not advance",
      "- The outbox age keeps climbing",
      "",
      "## Likely causes",
      "",
      "- A required projector barrier is incomplete",
      "",
      "## Checks",
      "",
      "- Inspect the barrier and [lease expiry releases the row](packages/db/src/outbox.ts#L2-L3)",
      "",
      "## Recovery",
      "",
      "- Replay the idempotent projector delivery",
      "",
      "## Notes",
      "",
      "- Not a diagnostic group, so this is left alone"
    ].join("\n")
  );

  assert.deepEqual(
    parsed.diagnostics.symptoms.map((statement) => statement.text),
    ["Publication does not advance", "The outbox age keeps climbing"]
  );
  // The heading words people actually use, not one exact spelling.
  assert.deepEqual(
    parsed.diagnostics.causes.map((statement) => statement.text),
    ["A required projector barrier is incomplete"]
  );
  assert.deepEqual(
    parsed.diagnostics.fixes.map((statement) => statement.text),
    ["Replay the idempotent projector delivery"]
  );

  // A statement reads as its sentence, with link syntax stripped, while the
  // evidence it cites stays attached and verifiable.
  const check = parsed.diagnostics.checks[0]!;
  assert.equal(check.text, "Inspect the barrier and lease expiry releases the row");
  assert.deepEqual(check.evidence, [
    { claim: "lease expiry releases the row", path: "packages/db/src/outbox.ts", startLine: 2, endLine: 3 }
  ]);

  // A section that is not a diagnostic group contributes nothing to them.
  assert.equal(
    Object.values(parsed.diagnostics)
      .flat()
      .some((statement) => statement.text.includes("left alone")),
    false
  );
});

test("prose under a diagnostic heading is context, not a retrieval unit", () => {
  const parsed = parseMarkdownDocument(
    "runbooks/x",
    ["## Symptoms", "", "This paragraph explains the shape of the failure.", "", "- The actual symptom"].join("\n")
  );
  assert.deepEqual(
    parsed.diagnostics.symptoms.map((statement) => statement.text),
    ["The actual symptom"]
  );
});

test("a document with no diagnostic sections has empty groups rather than missing ones", () => {
  const parsed = parseMarkdownDocument("components/api", "# API\n\nJust prose.\n");
  assert.deepEqual(parsed.diagnostics, { symptoms: [], causes: [], checks: [], fixes: [] });
});

test("the folder is the kind and the path is the identity", () => {
  const documents = [
    parseMarkdownDocument("architecture", "# Architecture\n\nHow the system fits together.\n"),
    parseMarkdownDocument("runbooks/stalled-publication", "# Stalled publication\n\nWhat to do.\n"),
    parseMarkdownDocument("runbooks/deploy/rollback", "# Roll back a deploy\n\nSteps.\n"),
    parseMarkdownDocument("flows/pull-request-review", "# PR review flow\n\nThe happy path.\n"),
    parseMarkdownDocument("patterns/retry-with-backoff", "# Retry with backoff\n\nSeen repeatedly.\n"),
    parseMarkdownDocument("components/api", "# API\n\nServes routes.\n")
  ];

  const { entries, problems } = mapMarkdownCatalog(documents, "omxyz/jina");
  assert.deepEqual(problems, []);
  assert.deepEqual(
    entries.map((entry) => entry.logicalId),
    [
      "repository:omxyz/jina:architecture",
      "runbook:omxyz/jina:stalled-publication",
      // A subject may itself be a path, which the existing patterns allow.
      "runbook:omxyz/jina:deploy/rollback",
      "flow:omxyz/jina:pull-request-review",
      "pattern:omxyz/jina:retry-with-backoff",
      "component:omxyz/jina:api"
    ]
  );

  // Every generated identifier satisfies the validation that already exists, so
  // the catalog lands in the current schema without a migration.
  for (const entry of entries) {
    validateLogicalId(entry.kind, entry.logicalId, "omxyz/jina");
  }
});

test("the lead paragraph is the summary, so the file needs no separate field", () => {
  const document = parseMarkdownDocument(
    "components/api",
    "# API server\n\nServes the [context routes](apps/api/src/server.ts#L1-L2) for a tenant.\n\nMore detail.\n"
  );
  const [entry] = mapMarkdownCatalog([document], "omxyz/jina").entries;
  assert.equal(entry?.title, "API server");
  // The heading is not the summary, and link syntax does not leak into it.
  assert.equal(entry?.summary, "Serves the context routes for a tenant.");
});

test("a repository organises its wiki its own way, and the folders survive", () => {
  // Nothing here is a kind this engine knows. It is how an editor is actually
  // structured, and the catalog should reflect that rather than flatten it.
  const documents = [
    parseMarkdownDocument("extensions/host/activation-events", "# Activation events\n\nWhen an extension wakes.\n"),
    parseMarkdownDocument("editor-core/text-buffer", "# Text buffer\n\nThe piece tree.\n"),
    parseMarkdownDocument("language-servers/protocol", "# LSP\n\nHow servers talk.\n")
  ];
  const { entries, problems } = mapMarkdownCatalog(documents, "microsoft/vscode");
  assert.deepEqual(problems, []);
  assert.deepEqual(
    entries.map((entry) => entry.logicalId),
    [
      "topic:microsoft/vscode:extensions/host/activation-events",
      "topic:microsoft/vscode:editor-core/text-buffer",
      "topic:microsoft/vscode:language-servers/protocol"
    ]
  );
  // The whole path is the subject, so the folders are still folders downstream.
  assert.deepEqual(new Set(entries.map((entry) => entry.kind)), new Set(["topic"]));
  for (const entry of entries) {
    validateLogicalId(entry.kind, entry.logicalId, "microsoft/vscode");
  }
});

test("a recognised folder still tags its kind, because retrieval can use it", () => {
  const { entries } = mapMarkdownCatalog(
    [parseMarkdownDocument("runbooks/stalled-publication", "# Stalled")],
    "omxyz/jina"
  );
  // The folder is dropped from the subject, because the kind already carries it.
  assert.equal(entries[0]?.kind, "runbook");
  assert.equal(entries[0]?.logicalId, "runbook:omxyz/jina:stalled-publication");
});

test("only a file that cannot be identified at all is reported", () => {
  const { entries, problems } = mapMarkdownCatalog(
    [parseMarkdownDocument("runbooks", "# Bare"), parseMarkdownDocument("issues/not-a-number", "# Issue")],
    "omxyz/jina"
  );
  assert.deepEqual(entries, []);
  assert.deepEqual(
    problems.map((problem) => problem.reason),
    ["empty-subject", "unsupported-identifier"]
  );
});

const manifestFor = (paths: readonly string[]) =>
  paths.map((path, index) => ({
    tenantId: "t",
    repository: "omxyz/jina",
    ref: "main",
    commitSha: "a".repeat(40),
    path,
    blobSha: String(index).repeat(40),
    contentDigest: "d".repeat(64),
    contentAvailable: true,
    executable: false
  }));

test("an inline link becomes a citation, resolved through the checkpoint manifest", () => {
  const document = parseMarkdownDocument(
    "runbooks/stalled-publication",
    [
      "# Stalled publication",
      "",
      "Publication stops when a barrier is incomplete.",
      "",
      "## Symptoms",
      "- Publication does not advance and [lease expiry releases the row](packages/db/src/outbox.ts#L2-L3)",
      "",
      "## Fixes",
      "- Replay the delivery, since [lease expiry releases the row](packages/db/src/outbox.ts#L2-L3)"
    ].join("\n")
  );

  const { output, problems } = markdownCatalogToOutput(
    [document],
    "omxyz/jina",
    manifestFor(["packages/db/src/outbox.ts"])
  );
  assert.deepEqual(problems, []);
  const [entry] = output.documents;

  // The link's path resolved to the blob it names at this checkpoint, which is
  // what makes the claim checkable rather than merely written down.
  assert.equal(entry?.citations.length, 1);
  assert.equal(entry?.citations[0]?.sourceType, "blob");
  assert.equal(entry?.citations[0]?.sourceId, "0".repeat(40));
  assert.equal(entry?.citations[0]?.claim, "lease expiry releases the row");
  // The same range cited twice is one citation, referenced twice.
  assert.deepEqual(entry?.structuredSummary.diagnostics.symptoms[0]?.citationOrdinals, [1]);
  assert.deepEqual(entry?.structuredSummary.diagnostics.fixes[0]?.citationOrdinals, [1]);
  // Scope is grounded in what was actually cited.
  assert.deepEqual(entry?.scope.paths, ["packages/db/src/outbox.ts"]);
  // The body is the Markdown as written; nothing rewrote it to carry markers.
  assert.match(entry.bodyMarkdown, /^# Stalled publication/);
});

test("a page moved to retired is a deletion, not a document", () => {
  const { output } = markdownCatalogToOutput(
    [parseMarkdownDocument("architecture", "# Architecture\n\n[the outbox row](packages/db/src/outbox.ts#L2-L3)\n")],
    "omxyz/jina",
    manifestFor(["packages/db/src/outbox.ts"]),
    undefined,
    ["components/atlas-access-service"]
  );
  // Under the file contract an untouched page is carried forward, so a deletion
  // has to be stated. It must not come back as a page named for the folder.
  assert.deepEqual(
    output.retiredDocuments?.map((entry) => entry.logicalId),
    ["component:omxyz/jina:atlas-access-service"]
  );
  assert.deepEqual(
    output.documents.map((entry) => entry.logicalId),
    ["repository:omxyz/jina:architecture"]
  );
});

test("a page nothing supports is withheld rather than published unverifiable", () => {
  const { output, problems } = markdownCatalogToOutput(
    [
      parseMarkdownDocument("components/api", "# API\n\nJust prose, no references.\n"),
      parseMarkdownDocument("components/db", "# DB\n\n[a claim about a file](does/not/exist.ts#L1-L2)\n")
    ],
    "omxyz/jina",
    manifestFor(["packages/db/src/outbox.ts"])
  );
  assert.deepEqual(output.documents, []);
  // A withheld page is only actionable if the report says what it cited, so the
  // unusable link is named rather than merely counted.
  assert.equal(problems.find((problem) => problem.reason === "unknown-path")?.target, "does/not/exist.ts#L1-L2");
  assert.deepEqual(problems.map((problem) => problem.reason).sort(), [
    "no-citable-evidence",
    "no-citable-evidence",
    "unknown-path"
  ]);
});

test("a diagnostic statement with no resolved evidence is left out of the group", () => {
  const document = parseMarkdownDocument(
    "runbooks/x",
    [
      "# X",
      "",
      "## Symptoms",
      "- An uncited observation",
      "- A cited one, because [lease expiry releases the row](packages/db/src/outbox.ts#L2-L3)"
    ].join("\n")
  );
  const { output } = markdownCatalogToOutput([document], "omxyz/jina", manifestFor(["packages/db/src/outbox.ts"]));
  // The schema requires an ordinal, and padding the group with uncited prose
  // would make the diagnostics less trustworthy, not more complete.
  assert.deepEqual(
    output.documents[0]?.structuredSummary.diagnostics.symptoms.map((statement) => statement.text),
    ["A cited one, because lease expiry releases the row"]
  );
});
