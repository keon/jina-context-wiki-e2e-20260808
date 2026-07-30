import assert from "node:assert/strict";
import test from "node:test";

import {
  documentPathFromFile,
  markdownEvidenceSections,
  normalizeMarkdownEvidenceTargets,
  parseMarkdownDocument,
  resolveDocumentLink
} from "./markdown-document.js";
import { evidenceSupportsClaim, verifyMarkdownCatalog } from "./markdown-verifier.js";
import { mapMarkdownCatalog } from "./markdown-catalog.js";
import { markdownCatalogToOutput } from "./markdown-output.js";
import type { ContextOrchestrationState } from "./orchestration.js";
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

function publicEvidenceShape(
  links: ReturnType<typeof parseMarkdownDocument>["evidenceLinks"]
): Omit<(typeof links)[number], "citationId" | "claimSpan">[] {
  return links.map(({ citationId: _citationId, claimSpan: _claimSpan, ...link }) => link);
}

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
  assert.deepEqual(publicEvidenceShape(parsed.evidenceLinks), [
    { claim: "lease expiry releases the row", path: "packages/db/src/outbox.ts", startLine: 2, endLine: 3 }
  ]);
  assert.match(parsed.evidenceLinks[0]?.citationId ?? "", /^cite_[a-f0-9]{20}$/);
  assert.equal(
    parsed.evidenceLinks[0]?.claimSpan,
    "The claim path releases work when a lease expires: lease expiry releases the row."
  );
  assert.deepEqual(parsed.documentLinks, [
    { text: "Diagnose a stalled publication", target: "../runbooks/stalled-publication.md" }
  ]);
});

test("normalizes agent source locations to repository-relative GitHub line links", () => {
  const source = [
    "[relative quote](../../repository/packages/db/src/store.ts:12-18)",
    "[absolute quote](/tmp/derive/repository/apps/api/src/server.ts:42)",
    "[portable quote](../../../../repository/additional/0/apps/worker/src/server.ts#L120-L126)",
    "[portable absolute](/workspace/repository/additional/0/packages/board/src/reducer.ts#L30)",
    "[portable stage relative](additional/0/apps/api/src/server.ts#L50-L52)",
    "[root quote](packages/github/src/webhooks.ts:91-94)",
    "[provider title](https://github.com/omxyz/jina/pull/161)"
  ].join("\n");
  const normalized = normalizeMarkdownEvidenceTargets(source);
  assert.equal(
    normalized,
    [
      "[relative quote](packages/db/src/store.ts#L12-L18)",
      "[absolute quote](apps/api/src/server.ts#L42)",
      "[portable quote](apps/worker/src/server.ts#L120-L126)",
      "[portable absolute](packages/board/src/reducer.ts#L30)",
      "[portable stage relative](apps/api/src/server.ts#L50-L52)",
      "[root quote](packages/github/src/webhooks.ts#L91-L94)",
      "[provider title](https://github.com/omxyz/jina/pull/161)"
    ].join("\n")
  );
  const parsed = parseMarkdownDocument("architecture", source);
  assert.deepEqual(publicEvidenceShape(parsed.evidenceLinks), [
    { claim: "relative quote", path: "packages/db/src/store.ts", startLine: 12, endLine: 18 },
    { claim: "absolute quote", path: "apps/api/src/server.ts", startLine: 42, endLine: 42 },
    { claim: "portable quote", path: "apps/worker/src/server.ts", startLine: 120, endLine: 126 },
    { claim: "portable absolute", path: "packages/board/src/reducer.ts", startLine: 30, endLine: 30 },
    { claim: "portable stage relative", path: "apps/api/src/server.ts", startLine: 50, endLine: 52 },
    { claim: "root quote", path: "packages/github/src/webhooks.ts", startLine: 91, endLine: 94 },
    { claim: "provider title", providerUrl: "https://github.com/omxyz/jina/pull/161" }
  ]);
});

test("natural labels do not relocate a semantically correct source target", () => {
  const source = "[the request is rejected](apps/api/src/server.ts#L42-L44)";
  assert.equal(normalizeMarkdownEvidenceTargets(source), source);
});

test("normalization preserves a sandbox path-as-label link as a trailing citation marker", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The API rejects an unauthenticated request. [`../../repository/apps/api/src/server.ts:42-44`](../../repository/apps/api/src/server.ts:42-44)"
  );
  assert.match(parsed.bodyMarkdown, /\[`apps\/api\/src\/server\.ts#L42-L44`]\(apps\/api\/src\/server\.ts#L42-L44\)/);
  assert.equal(parsed.evidenceLinks[0]?.claimSpan, "The API rejects an unauthenticated request.");
  assert.equal(parsed.materialClaims[0]?.citationIds.length, 1);
});

test("claim spans isolate independently cited clauses and table cells", () => {
  const prose = parseMarkdownDocument(
    "architecture",
    "The API [rejects unauthenticated calls](apps/api/src/auth.ts#L10-L14), while the worker [renews its lease](apps/worker/src/lease.ts#L20-L24)."
  );
  assert.deepEqual(
    prose.evidenceLinks.map((link) => link.claimSpan),
    ["The API rejects unauthenticated calls", "the worker renews its lease."]
  );
  const table = parseMarkdownDocument(
    "architecture",
    "| API | [Rejects unauthenticated calls](apps/api/src/auth.ts#L10-L14) | [Runs on port 3000](apps/api/src/server.ts#L8-L9) |"
  );
  assert.deepEqual(
    table.evidenceLinks.map((link) => link.claimSpan),
    ["Rejects unauthenticated calls", "Runs on port 3000"]
  );
});

test("a citation at a new sentence binds that sentence rather than the prior one", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The queue accepts work. [The worker renews its lease](apps/worker/src/lease.ts#L20-L24) before expiry."
  );
  assert.equal(parsed.evidenceLinks[0]?.claimSpan, "The worker renews its lease before expiry.");
});

test("inline-code punctuation does not split a cited prose assertion", () => {
  const parsed = parseMarkdownDocument(
    "admin/access",
    "[The package test command targets `lib/*.test.ts`](apps/admin/package.json#L5-L11)."
  );
  assert.equal(parsed.evidenceLinks[0]?.claimSpan, "The package test command targets lib/*.test.ts.");
  assert.deepEqual(
    parsed.materialClaims
      .filter((claim) => claim.classification === "material")
      .map((claim) => ({ text: claim.text, citations: claim.citationIds.length })),
    [{ text: "The package test command targets lib/*.test.ts.", citations: 1 }]
  );
});

test("citation-only links immediately after a sentence bind the preceding material claim", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The worker renews its lease before expiry. [apps/worker/src/lease.ts#L20-L24](apps/worker/src/lease.ts#L20-L24)"
  );
  const citation = parsed.evidenceLinks[0];
  assert.ok(citation);
  assert.equal(parsed.evidenceLinks[0]?.claimSpan, "The worker renews its lease before expiry.");
  assert.deepEqual(
    parsed.materialClaims.filter((claim) => claim.classification === "material").map((claim) => claim.citationIds),
    [[citation.citationId]]
  );
});

test("code-formatted path citations bind the preceding material claim", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The worker renews its lease before expiry. [`apps/worker/src/lease.ts#L20-L24`](apps/worker/src/lease.ts#L20-L24)"
  );
  const citation = parsed.evidenceLinks[0];
  assert.ok(citation);
  assert.equal(citation.claimSpan, "The worker renews its lease before expiry.");
});

test("code-formatted dynamic-route paths remain valid trailing citations", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The dashboard route proxies requests. [`apps/dashboard/src/app/api/[...path]/route.ts#L6-L13`](apps/dashboard/src/app/api/[...path]/route.ts#L6-L13)"
  );
  const citation = parsed.evidenceLinks[0];
  assert.ok(citation);
  assert.deepEqual(
    {
      claimSpan: citation.claimSpan,
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine
    },
    {
      claimSpan: "The dashboard route proxies requests.",
      path: "apps/dashboard/src/app/api/[...path]/route.ts",
      startLine: 6,
      endLine: 13
    }
  );
});

test("Markdown-escaped dynamic-route labels remain valid trailing citations", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The dashboard route proxies requests. [`apps/dashboard/src/app/api/\\[...path\\]/route.ts#L6-L13`](apps/dashboard/src/app/api/[...path]/route.ts#L6-L13)"
  );
  const citation = parsed.evidenceLinks[0];
  assert.ok(citation);
  assert.equal(citation.claimSpan, "The dashboard route proxies requests.");
  assert.equal(citation.path, "apps/dashboard/src/app/api/[...path]/route.ts");
  assert.deepEqual(
    parsed.materialClaims.filter((claim) => claim.classification === "material").map((claim) => claim.citationIds),
    [[citation.citationId]]
  );
});

test("a trailing path citation binds the complete preceding sentence across clause boundaries", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The worker accepts jobs; it renews its lease before expiry. [`apps/worker/src/lease.ts#L20-L24`](apps/worker/src/lease.ts#L20-L24)"
  );
  const citation = parsed.evidenceLinks[0];
  assert.ok(citation);
  assert.equal(citation.claimSpan, "The worker accepts jobs; it renews its lease before expiry.");
  assert.deepEqual(
    parsed.materialClaims.filter((claim) => claim.classification === "material").map((claim) => claim.citationIds),
    [[citation.citationId]]
  );
});

test("separately cited clauses keep their trailing source markers isolated", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The API accepts work [`apps/api/src/server.ts#L20-L24`](apps/api/src/server.ts#L20-L24); the worker renews its lease. [`apps/worker/src/lease.ts#L30-L34`](apps/worker/src/lease.ts#L30-L34)"
  );
  assert.deepEqual(
    parsed.evidenceLinks.map((citation) => citation.claimSpan),
    ["The API accepts work", "the worker renews its lease."]
  );
  assert.deepEqual(
    parsed.materialClaims
      .filter((claim) => claim.classification === "material")
      .map((claim) => claim.citationIds.length),
    [1, 1]
  );
});

test("adjacent trailing citations bind their own sentences without consuming source-label punctuation", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    [
      "The API accepts work. [`apps/api/src/server.ts#L20-L24`](apps/api/src/server.ts#L20-L24)",
      "The worker renews its lease. [`apps/worker/src/lease.ts#L30-L34`](apps/worker/src/lease.ts#L30-L34)"
    ].join(" ")
  );
  assert.deepEqual(
    parsed.evidenceLinks.map((citation) => citation.claimSpan),
    ["The API accepts work.", "The worker renews its lease."]
  );
  assert.deepEqual(
    parsed.materialClaims
      .filter((claim) => claim.classification === "material")
      .map((claim) => claim.citationIds.length),
    [1, 1]
  );
});

test("multiple trailing source markers bind the same claim and do not become prose", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The worker coordinates both stores. [`src/primary.ts#L4-L8`](src/primary.ts#L4-L8) [`src/secondary.ts#L9-L12`](src/secondary.ts#L9-L12)"
  );
  assert.deepEqual(
    parsed.evidenceLinks.map((citation) => citation.claimSpan),
    ["The worker coordinates both stores.", "The worker coordinates both stores."]
  );
  assert.deepEqual(
    parsed.materialClaims
      .filter((claim) => claim.classification === "material")
      .map((claim) => ({
        text: claim.text,
        citations: claim.citationIds.length
      })),
    [{ text: "The worker coordinates both stores.", citations: 2 }]
  );
});

test("a trailing source marker before sentence punctuation leaves a clean claim span", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The worker renews its lease [`apps/worker/src/lease.ts#L20-L24`](apps/worker/src/lease.ts#L20-L24)."
  );
  assert.equal(parsed.evidenceLinks[0]?.claimSpan, "The worker renews its lease.");
  assert.equal(parsed.materialClaims[0]?.text, "The worker renews its lease.");
});

test("a fully linked natural-language claim remains distinct from the preceding sentence", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    "The queue accepts work. [The worker renews its lease before expiry.](apps/worker/src/lease.ts#L20-L24)"
  );
  const citation = parsed.evidenceLinks[0];
  assert.ok(citation);
  assert.equal(citation.claimSpan, "The worker renews its lease before expiry.");
  assert.deepEqual(
    parsed.materialClaims.filter((claim) => claim.classification === "material").map((claim) => claim.citationIds),
    [[], [citation.citationId]]
  );
});

test("natural and citation-only provider links retain their distinct binding semantics", () => {
  const providerUrl = "https://github.com/omxyz/jina/issues/91";
  const parsed = parseMarkdownDocument(
    "history/regression",
    [
      "The initial report was incomplete.",
      `[The issue records the administrator deletion regression.](${providerUrl})`,
      `The follow-up identifies the affected upgrade. [\`${providerUrl}\`](${providerUrl})`
    ].join(" ")
  );
  assert.deepEqual(
    parsed.evidenceLinks.map((citation) => ({
      claimSpan: citation.claimSpan,
      providerUrl: citation.providerUrl
    })),
    [
      {
        claimSpan: "The issue records the administrator deletion regression.",
        providerUrl
      },
      {
        claimSpan: "The follow-up identifies the affected upgrade.",
        providerUrl
      }
    ]
  );
  assert.deepEqual(
    parsed.materialClaims
      .filter((claim) => claim.classification === "material")
      .map((claim) => claim.citationIds.length),
    [0, 1, 1]
  );
});

test("trailing table citations cannot cross cell boundaries", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    [
      "| Component | Entry behavior | Worker behavior |",
      "| --- | --- | --- |",
      "| runtime | Accepts requests. [`src/api.ts#L1-L3`](src/api.ts#L1-L3) | Renews leases. [`src/worker.ts#L4-L6`](src/worker.ts#L4-L6) |"
    ].join("\n")
  );
  assert.deepEqual(
    parsed.evidenceLinks.map((citation) => citation.claimSpan),
    ["Accepts requests.", "Renews leases."]
  );
});

test("citation identities are stable and distinguish repeated links", () => {
  const source = [
    "- [the lease branch](packages/db/src/outbox.ts#L2-L3)",
    "- [the lease branch](packages/db/src/outbox.ts#L2-L3)"
  ].join("\n");
  const first = parseMarkdownDocument("runbooks/x", source).evidenceLinks.map((link) => link.citationId);
  const second = parseMarkdownDocument("runbooks/x", source).evidenceLinks.map((link) => link.citationId);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 2);
});

test("only rendered Markdown links become public evidence citations", () => {
  const source = [
    "<!-- [hidden](src/hidden.ts#L1-L2) -->",
    "",
    "```md",
    "[example](src/example.ts#L1-L2)",
    "```",
    "",
    "`[inline](src/inline.ts#L1-L2)`",
    "",
    "![diagram](src/image.ts#L1-L2)",
    "",
    "\\[escaped](src/escaped.ts#L1-L2)",
    "",
    "[rendered evidence](src/rendered.ts#L3-L4)"
  ].join("\n");
  const parsed = parseMarkdownDocument("architecture", source);
  assert.deepEqual(
    parsed.evidenceLinks.map((link) => link.path),
    ["src/rendered.ts"]
  );
});

test("material claim inventory covers sentences, clauses, list items, and table cells", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    [
      "# Cache",
      "",
      "The cache [removes expired entries](src/cache.ts#L1-L3). It uses a map without a citation.",
      "",
      "See [Architecture](components/architecture.md).",
      "",
      "- [Reads are cached](src/cache.ts#L4-L6), but writes invalidate them.",
      "",
      "| Mode | Behavior |",
      "| --- | --- |",
      "| strict | [Rejects stale values](src/cache.ts#L7-L8) |"
    ].join("\n")
  );

  assert.deepEqual(
    parsed.materialClaims.map(({ text, kind, classification, citationIds, summary }) => ({
      text,
      kind,
      classification,
      citations: citationIds.length,
      summary
    })),
    [
      {
        text: "The cache removes expired entries.",
        kind: "sentence",
        classification: "material",
        citations: 1,
        summary: true
      },
      {
        text: "It uses a map without a citation.",
        kind: "sentence",
        classification: "material",
        citations: 0,
        summary: true
      },
      {
        text: "See Architecture.",
        kind: "sentence",
        classification: "navigation",
        citations: 0,
        summary: false
      },
      {
        text: "Reads are cached",
        kind: "list_item",
        classification: "material",
        citations: 1,
        summary: false
      },
      {
        text: "writes invalidate them.",
        kind: "list_item",
        classification: "material",
        citations: 0,
        summary: false
      },
      { text: "Mode", kind: "table_cell", classification: "non_factual", citations: 0, summary: false },
      { text: "Behavior", kind: "table_cell", classification: "non_factual", citations: 0, summary: false },
      { text: "strict", kind: "table_cell", classification: "material", citations: 0, summary: false },
      {
        text: "Rejects stale values",
        kind: "table_cell",
        classification: "material",
        citations: 1,
        summary: false
      }
    ]
  );
  assert.ok(parsed.materialClaims.every((claim) => /^claim_[a-f0-9]{20}$/.test(claim.claimId)));
});

test("section grounding requires core evidence without requiring every explanatory claim to be cited", () => {
  const sections = markdownEvidenceSections(
    [
      "# Runtime",
      "",
      "[The runtime creates its server](src/server.ts#L1-L3). More connective explanation follows.",
      "",
      "## Grounded control flow",
      "",
      "[The entry point creates the server](src/server.ts#L1-L3). This sentence explains why the flow matters.",
      "",
      "### Ungrounded failure behavior",
      "",
      "The worker retries every failure forever.",
      "",
      "## Maintenance questions",
      "",
      "What should change when a retry class is added?",
      "",
      "## Navigation",
      "",
      "See [Architecture](architecture.md)."
    ].join("\n")
  );

  assert.deepEqual(
    sections.map(({ heading, substantiveClaimCount, citationIds }) => ({
      heading,
      substantiveClaimCount,
      citations: citationIds.length
    })),
    [
      { heading: "Grounded control flow", substantiveClaimCount: 3, citations: 1 },
      { heading: "Ungrounded failure behavior", substantiveClaimCount: 1, citations: 0 },
      { heading: "Maintenance questions", substantiveClaimCount: 0, citations: 0 },
      { heading: "Navigation", substantiveClaimCount: 0, citations: 0 }
    ]
  );
});

test("table navigation is classified per cell rather than exempting factual row labels", () => {
  const parsed = parseMarkdownDocument(
    "architecture",
    [
      "| Change or incident | Read next |",
      "| --- | --- |",
      "| Signed delivery and tenant binding | [GitHub intake](api/github-intake.md) |",
      "| [The worker retries every failure forever](architecture.md) | [Architecture](architecture.md) |",
      "| strict | [Rejects stale values](src/cache.ts#L7-L8) |"
    ].join("\n")
  );

  assert.deepEqual(
    parsed.materialClaims.map(({ text, classification, citationIds }) => ({
      text,
      classification,
      citations: citationIds.length
    })),
    [
      { text: "Change or incident", classification: "non_factual", citations: 0 },
      { text: "Read next", classification: "non_factual", citations: 0 },
      { text: "Signed delivery and tenant binding", classification: "material", citations: 0 },
      { text: "GitHub intake", classification: "navigation", citations: 0 },
      { text: "The worker retries every failure forever", classification: "material", citations: 0 },
      { text: "Architecture", classification: "navigation", citations: 0 },
      { text: "strict", classification: "material", citations: 0 },
      { text: "Rejects stale values", classification: "material", citations: 1 }
    ]
  );
});

test("constrained document-navigation prose is non-material without hiding adjacent factual claims", () => {
  const parsed = parseMarkdownDocument(
    "dashboard/proxy-security-policy",
    [
      "Read this alongside [the dashboard routes and data contracts](application-routes-and-data.md), [the API authentication and context boundary](../api/authentication-and-context-boundary.md), and [the repository architecture](../architecture.md).",
      "",
      "For more context, see [the worker runtime](../workers/runtime.md).",
      "",
      "[System architecture](../architecture.md) · [worker runtime](../workers/runtime.md)",
      "",
      "[The worker retries every failure forever](../architecture.md)",
      "",
      "See [The worker retries every failure forever](../architecture.md).",
      "",
      "Read this alongside [the architecture](../architecture.md) because the worker retries every failure forever.",
      "",
      "See [the architecture](../architecture.md) for a worker that retries every failure forever."
    ].join("\n")
  );

  assert.deepEqual(
    parsed.materialClaims.map(({ text, classification }) => ({ text, classification })),
    [
      {
        text: "Read this alongside the dashboard routes and data contracts, the API authentication and context boundary",
        classification: "navigation"
      },
      { text: "the repository architecture.", classification: "navigation" },
      { text: "For more context, see the worker runtime.", classification: "navigation" },
      { text: "System architecture · worker runtime", classification: "navigation" },
      { text: "The worker retries every failure forever", classification: "material" },
      { text: "See The worker retries every failure forever.", classification: "material" },
      {
        text: "Read this alongside the architecture because the worker retries every failure forever.",
        classification: "material"
      },
      {
        text: "See the architecture for a worker that retries every failure forever.",
        classification: "material"
      }
    ]
  );
});

test("linked engineering titles may use parent-path terms and split questions remain non-factual", () => {
  const parsed = parseMarkdownDocument(
    "shared/policy-and-kernel-contracts",
    [
      "- [Board state machine](../board/state-machine.md)",
      "- [PostgreSQL concurrency, outbox, and recovery](../postgres/concurrency-outbox-and-recovery.md)",
      "- Should a guard use estimated charges, actual charges, or both?",
      "",
      "How should plan admission, execution start, and dynamic-child creation differ?",
      "",
      "Question: Where should an operator record the selected policy?",
      "",
      "Maintenance question: When changing a policy, which tests should move with it?",
      "",
      "For a new service, what access posture, liveness behavior, and release summary should maintainers review?"
    ].join("\n")
  );

  assert.deepEqual(
    parsed.materialClaims.map(({ text, classification }) => ({ text, classification })),
    [
      { text: "Board state machine", classification: "navigation" },
      { text: "PostgreSQL concurrency, outbox", classification: "navigation" },
      { text: "recovery", classification: "navigation" },
      { text: "Should a guard use estimated charges, actual charges", classification: "non_factual" },
      { text: "both?", classification: "non_factual" },
      { text: "How should plan admission, execution start", classification: "non_factual" },
      { text: "dynamic-child creation differ?", classification: "non_factual" },
      { text: "Question: Where should an operator record the selected policy?", classification: "non_factual" },
      {
        text: "Maintenance question: When changing a policy",
        classification: "non_factual"
      },
      { text: "which tests should move with it?", classification: "non_factual" },
      {
        text: "For a new service",
        classification: "non_factual"
      },
      { text: "what access posture, liveness behavior", classification: "non_factual" },
      { text: "release summary should maintainers review?", classification: "non_factual" }
    ]
  );
});

test("common engineering subtitles remain navigation without exempting arbitrary linked facts", () => {
  const parsed = parseMarkdownDocument(
    "api/authentication-and-context-boundary",
    [
      "Navigation:",
      "",
      "Related pages:",
      "",
      "- [MCP and Repository Context Query API](mcp-and-query-api.md)",
      "- [Board State Machine and Dependency Semantics](../board/state-machine.md)",
      "- [Worker Lease, Renewal, and Write Fencing](../worker/lease-and-fencing.md)",
      "- [GitHub Delivery Intake and Workflow Planning](github-delivery-intake.md)",
      "- [Admin Access and Tenant Context Operations](../admin/access-and-context-operations.md)",
      "",
      "Navigation: [Architecture](../architecture.md), [PostgreSQL tenancy and schema](../postgres/tenancy-schema-and-roles.md), and [Shared policy and kernel contracts](../shared/policy-and-kernel-contracts.md).",
      "",
      "Related pages: [MCP and query API](mcp-and-query-api.md) and [board state machine](../board/state-machine.md).",
      "- [The worker retries every failure forever](../worker/lease-and-fencing.md)"
    ].join("\n")
  );

  assert.deepEqual(
    parsed.materialClaims.map(({ text, classification }) => ({ text, classification })),
    [
      { text: "Navigation:", classification: "navigation" },
      { text: "Related pages:", classification: "navigation" },
      { text: "MCP and Repository Context Query API", classification: "navigation" },
      { text: "Board State Machine and Dependency Semantics", classification: "navigation" },
      { text: "Worker Lease, Renewal", classification: "navigation" },
      { text: "Write Fencing", classification: "navigation" },
      { text: "GitHub Delivery Intake and Workflow Planning", classification: "navigation" },
      { text: "Admin Access and Tenant Context Operations", classification: "navigation" },
      {
        text: "Navigation: Architecture, PostgreSQL tenancy and schema",
        classification: "navigation"
      },
      { text: "Shared policy and kernel contracts.", classification: "navigation" },
      {
        text: "Related pages: MCP and query API and board state machine.",
        classification: "navigation"
      },
      { text: "The worker retries every failure forever", classification: "material" }
    ]
  );
});

test("declarative premises cannot hide inside a trailing question", () => {
  const parsed = parseMarkdownDocument(
    "operations/retry-policy",
    [
      "The worker retries every failure forever; what should change when a retry class is added?",
      "",
      "The worker retries every failure forever?",
      "",
      "Why does the worker retry a failed operation?",
      "",
      "Given that the worker has a lease, how should retries, failures, and recovery change?"
    ].join("\n")
  );

  assert.deepEqual(
    parsed.materialClaims.map(({ text, classification }) => ({ text, classification })),
    [
      { text: "The worker retries every failure forever", classification: "material" },
      { text: "what should change when a retry class is added?", classification: "non_factual" },
      { text: "The worker retries every failure forever?", classification: "material" },
      { text: "Why does the worker retry a failed operation?", classification: "non_factual" },
      { text: "Given that the worker has a lease", classification: "material" },
      { text: "how should retries, failures", classification: "non_factual" },
      { text: "recovery change?", classification: "non_factual" }
    ]
  );
});

test("a single-line anchor is a range of one, as GitHub writes it", () => {
  const parsed = parseMarkdownDocument("x", "[a claim of length](a/b.ts#L7)");
  assert.deepEqual(publicEvidenceShape(parsed.evidenceLinks), [
    { claim: "a claim of length", path: "a/b.ts", startLine: 7, endLine: 7 }
  ]);
});

test("a Markdown source file with line anchors is evidence rather than a context-document link", () => {
  const parsed = parseMarkdownDocument("x", "[an exact source claim](README.md#L3-L3)");
  assert.deepEqual(publicEvidenceShape(parsed.evidenceLinks), [
    { claim: "an exact source claim", path: "README.md", startLine: 3, endLine: 3 }
  ]);
  assert.deepEqual(parsed.documentLinks, []);
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

test("the deterministic catalog verifier validates reference structure without judging semantics", () => {
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

  assert.equal(result.supported, 2);
  assert.deepEqual(
    result.problems.map((problem) => problem.reason),
    ["unknown-path", "invalid-range", "unknown-document"]
  );
  // Context is useful with a broken document link in it: the catalog still lands, and the
  // share a reader can trust is recorded per document.
  assert.equal(result.supportedByDocument.get("components/api"), 2);
});

test("an overbroad source range is rejected even when it contains the visible claim", () => {
  const body = Array.from({ length: 121 }, (_, index) =>
    index === 60 ? "export function durableCheckpoint() {}" : `// source line ${index + 1}`
  ).join("\n");
  const document = parseMarkdownDocument(
    "components/checkpoint",
    "# Checkpoint\n\n[durableCheckpoint](src/checkpoint.ts#L1-L121)\n"
  );
  const result = verifyMarkdownCatalog([document], {
    evidenceByPath: new Map([["src/checkpoint.ts", record(body)]]),
    documentPaths: new Set(["components/checkpoint"]),
    resolveDocumentLink
  });
  assert.equal(result.supported, 0);
  assert.equal(result.problems[0]?.reason, "invalid-range");
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
  assert.deepEqual(publicEvidenceShape(check.evidence), [
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

test("a repository organises its context its own way, and the folders survive", () => {
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
      "Publication stops when [lease expiry releases the row](packages/db/src/outbox.ts#L2-L3).",
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
    manifestFor(["packages/db/src/outbox.ts"]),
    undefined,
    [],
    [],
    {
      items: [
        {
          path: "runbooks/stalled-publication.md",
          scope: { symbols: ["claim", "RELEASE"] }
        }
      ]
    } as unknown as ContextOrchestrationState
  );
  assert.deepEqual(problems, []);
  const [entry] = output.documents;

  // The link's path resolved to the blob it names at this checkpoint, which is
  // what makes the claim checkable rather than merely written down.
  assert.equal(entry?.citations.length, 3);
  assert.equal(entry?.citations[0]?.sourceType, "blob");
  assert.equal(entry?.citations[0]?.sourceId, "0".repeat(40));
  assert.equal(entry?.citations[0]?.claim, "lease expiry releases the row");
  // Every public link has a stable citation identity, even when two links point
  // at the same source range.
  assert.deepEqual(entry?.summaryCitationOrdinals, [1]);
  assert.deepEqual(entry?.structuredSummary.diagnostics.symptoms[0]?.citationOrdinals, [2]);
  assert.deepEqual(entry?.structuredSummary.diagnostics.fixes[0]?.citationOrdinals, [3]);
  // Scope is grounded in what was actually cited.
  assert.deepEqual(entry?.scope.paths, ["packages/db/src/outbox.ts"]);
  assert.deepEqual(entry?.scope.symbols, ["claim", "RELEASE"]);
  // The body is the Markdown as written; nothing rewrote it to carry markers.
  assert.match(entry.bodyMarkdown, /^# Stalled publication/);
});

test("natural-label conversion stores an exact source anchor without rewriting public Markdown", () => {
  const body =
    "# Authentication\n\nThe API [rejects unauthenticated calls](apps/api/src/auth.ts#L10-L14) before dispatch.\n";
  const { output, problems } = markdownCatalogToOutput(
    [parseMarkdownDocument("components/authentication", body)],
    "omxyz/jina",
    manifestFor(["apps/api/src/auth.ts"]),
    () => "if (!principal) return unauthorized();",
    [],
    [],
    undefined,
    { naturalEvidenceLabels: true }
  );
  assert.deepEqual(problems, []);
  assert.equal(output.documents[0]?.bodyMarkdown, body);
  assert.equal(output.documents[0]?.citations[0]?.claim, "if (!principal) return unauthorized();");
  assert.match(output.documents[0]?.citations[0]?.citationId ?? "", /^cite_[a-f0-9]{20}$/);
  assert.equal(output.documents[0]?.citations[0]?.claimSpan, "The API rejects unauthenticated calls before dispatch.");
});

test("a natural GitHub issue link resolves to an immutable provider record and exact JSON pointer", () => {
  const claim = "Administrators cannot delete resources after the authorization dependency upgrade.";
  const document = parseMarkdownDocument(
    "components/issue-handling",
    `# Administrator deletion regression\n\n[${claim}](https://github.com/omxyz/jina/issues/91)\n`
  );
  const { output, problems } = markdownCatalogToOutput([document], "omxyz/jina", manifestFor([]), undefined, [
    {
      body: JSON.stringify({
        number: 91,
        title: "Administrators cannot delete resources",
        body: claim,
        state: "closed"
      }),
      anchor: {
        tenantId: "t",
        repository: "omxyz/jina",
        sourceType: "issue",
        sourceId: "github:issue:omxyz/jina#91",
        contentDigest: "d".repeat(64),
        commitSha: "a".repeat(40),
        pathOrUrl: "https://github.com/omxyz/jina/issues/91",
        observedAt: "2026-07-29T00:00:00.000Z"
      }
    }
  ]);
  assert.deepEqual(problems, []);
  assert.equal(output.documents[0]?.citations[0]?.sourceType, "issue");
  assert.equal(output.documents[0]?.citations[0]?.sourceId, "github:issue:omxyz/jina#91");
  assert.equal(output.documents[0]?.citations[0]?.jsonPointer, "/body");
  assert.deepEqual(output.documents[0]?.scope.paths, []);
  assert.deepEqual(output.documents[0]?.scope.issues, ["https://github.com/omxyz/jina/issues/91"]);
});

test("a pull request URL does not alias a discussion comment URL with a fragment", () => {
  const document = parseMarkdownDocument(
    "history/github-app",
    "# GitHub App migration\n\n[PR 112 introduced installation tokens.](https://github.com/omxyz/jina/pull/112)\n"
  );
  const common = {
    tenantId: "t",
    repository: "omxyz/jina",
    commitSha: "a".repeat(40),
    observedAt: "2026-07-29T00:00:00.000Z"
  };
  const { output, problems } = markdownCatalogToOutput(
    [document],
    "omxyz/jina",
    manifestFor([]),
    undefined,
    [
      {
        body: JSON.stringify({ body: "A discussion comment." }),
        anchor: {
          ...common,
          sourceType: "observation",
          sourceId: "github:issue_comment:omxyz/jina:5052550985",
          contentDigest: "c".repeat(64),
          pathOrUrl: "https://github.com/omxyz/jina/pull/112#issuecomment-5052550985"
        }
      },
      {
        body: JSON.stringify({ number: 112, title: "GitHub App migration" }),
        anchor: {
          ...common,
          sourceType: "pull_request",
          sourceId: "github:pull_request:omxyz/jina#112",
          contentDigest: "d".repeat(64),
          pathOrUrl: "https://github.com/omxyz/jina/pull/112"
        }
      }
    ],
    [],
    undefined,
    { naturalEvidenceLabels: true }
  );

  assert.deepEqual(problems, []);
  assert.equal(output.documents[0]?.citations[0]?.sourceType, "pull_request");
  assert.equal(output.documents[0]?.citations[0]?.sourceId, "github:pull_request:omxyz/jina#112");
});

test("provider link claims obey the final validator's minimum evidentiary length", () => {
  const document = parseMarkdownDocument(
    "components/provider-state",
    "# Issue\n\nThe issue remains [open](https://github.com/omxyz/jina/issues/91).\n"
  );
  const { output, problems } = markdownCatalogToOutput([document], "omxyz/jina", manifestFor([]), undefined, [
    {
      body: JSON.stringify({ number: 91, state: "open" }),
      anchor: {
        tenantId: "t",
        repository: "omxyz/jina",
        sourceType: "issue",
        sourceId: "github:issue:omxyz/jina#91",
        contentDigest: "d".repeat(64),
        commitSha: "a".repeat(40),
        pathOrUrl: "https://github.com/omxyz/jina/issues/91",
        observedAt: "2026-07-29T00:00:00.000Z"
      }
    }
  ]);
  assert.deepEqual(output.documents, []);
  assert.equal(problems[0]?.reason, "claim-absent");
  assert.equal(problems[0]?.claim, "The issue remains open.");
});

test("a page moved to retired is a deletion, not a document", () => {
  const { output } = markdownCatalogToOutput(
    [parseMarkdownDocument("architecture", "# Architecture\n\n[the outbox row](packages/db/src/outbox.ts#L2-L3)\n")],
    "omxyz/jina",
    manifestFor(["packages/db/src/outbox.ts"]),
    undefined,
    [],
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
  assert.deepEqual(problems.map((problem) => problem.reason).sort(), ["no-citable-evidence", "unknown-path"]);
});

test("a stabilized page that ends mid-sentence is withheld for targeted repair", () => {
  const { output, problems } = markdownCatalogToOutput(
    [
      parseMarkdownDocument(
        "context/runtime",
        "# Context runtime\n\n[the outbox row](packages/db/src/outbox.ts#L2-L3).\n\n- The worker dispatches"
      )
    ],
    "omxyz/jina",
    manifestFor(["packages/db/src/outbox.ts"])
  );
  assert.deepEqual(output.documents, []);
  assert.deepEqual(problems, [{ documentPath: "context/runtime", reason: "incomplete-document" }]);
});

test("a grounded diagnostic section may retain uncited connective observations", () => {
  const document = parseMarkdownDocument(
    "runbooks/x",
    [
      "# X",
      "",
      "[Lease expiry is the primary recovery signal](packages/db/src/outbox.ts#L2-L3).",
      "",
      "## Symptoms",
      "- An uncited observation",
      "- A cited one, because [lease expiry releases the row](packages/db/src/outbox.ts#L2-L3)"
    ].join("\n")
  );
  const { output, problems } = markdownCatalogToOutput(
    [document],
    "omxyz/jina",
    manifestFor(["packages/db/src/outbox.ts"])
  );
  assert.equal(output.documents.length, 1);
  assert.deepEqual(problems, []);
  assert.equal(output.documents[0]?.structuredSummary.diagnostics.symptoms.length, 1);
});
