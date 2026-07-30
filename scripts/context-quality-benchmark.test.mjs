import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeContextQuality, publicEvidenceCitations } from "./context-quality-benchmark.mjs";

test("reconstructs the stable public citation identity contract", () => {
  const target = "src/server.ts#L10-L24";
  const citation = publicEvidenceCitations(
    "architecture.md",
    `[The handler](src/server.ts#L10-L24) calls the worker.`
  )[0];
  const expected = `cite_${sha256(`architecture\u0000${target}\u0000The handler calls the worker.\u00001`).slice(
    0,
    20
  )}`;

  assert.equal(citation.claimSpan, "The handler calls the worker.");
  assert.equal(citation.citationId, expected);
});

test("benchmark citation reconstruction ignores non-rendered Markdown links", () => {
  const citations = publicEvidenceCitations(
    "architecture.md",
    [
      "<!-- [hidden](src/hidden.ts#L1-L2) -->",
      "```md",
      "[example](src/example.ts#L1-L2)",
      "```",
      "`[inline](src/inline.ts#L1-L2)`",
      "![image](src/image.ts#L1-L2)",
      "\\[escaped](src/escaped.ts#L1-L2)",
      "[visible](src/visible.ts#L3-L4)"
    ].join("\n")
  );
  assert.deepEqual(
    citations.map((citation) => citation.path),
    ["src/visible.ts"]
  );
});

test("benchmark and runtime identity bind a link at sentence start to its own sentence", () => {
  const citation = publicEvidenceCitations(
    "architecture.md",
    "The queue accepts work. [The worker renews its lease](src/lease.ts#L20-L24) before expiry."
  )[0];
  assert.equal(citation.claimSpan, "The worker renews its lease before expiry.");
});

test("benchmark accepts code-formatted dynamic-route evidence labels", () => {
  const citation = publicEvidenceCitations(
    "architecture.md",
    "The dashboard route proxies requests. [`apps/dashboard/src/app/api/[...path]/route.ts#L6-L13`](apps/dashboard/src/app/api/[...path]/route.ts#L6-L13)"
  )[0];

  assert.deepEqual(
    {
      claimSpan: citation.claimSpan,
      target: citation.target,
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine
    },
    {
      claimSpan: "The dashboard route proxies requests.",
      target: "apps/dashboard/src/app/api/[...path]/route.ts#L6-L13",
      path: "apps/dashboard/src/app/api/[...path]/route.ts",
      startLine: 6,
      endLine: 13
    }
  );
});

test("benchmark normalizes a sandbox path-as-label citation through the runtime contract", () => {
  const citation = publicEvidenceCitations(
    "architecture.md",
    "The API rejects an unauthenticated request. [`../../repository/apps/api/src/server.ts:42-44`](../../repository/apps/api/src/server.ts:42-44)"
  )[0];

  assert.equal(citation.claim, "`apps/api/src/server.ts#L42-L44`");
  assert.equal(citation.claimSpan, "The API rejects an unauthenticated request.");
  assert.equal(citation.target, "apps/api/src/server.ts#L42-L44");
  assert.equal(citation.path, "apps/api/src/server.ts");
});

test("benchmark keeps adjacent and multiple trailing citations bound to their material claims", () => {
  const citations = publicEvidenceCitations(
    "architecture.md",
    [
      "The API accepts work. [`src/api.ts#L1-L3`](src/api.ts#L1-L3)",
      "The worker coordinates both stores. [`src/primary.ts#L4-L8`](src/primary.ts#L4-L8) [`src/secondary.ts#L9-L12`](src/secondary.ts#L9-L12)"
    ].join(" ")
  );

  assert.deepEqual(
    citations.map((citation) => citation.claimSpan),
    ["The API accepts work.", "The worker coordinates both stores.", "The worker coordinates both stores."]
  );
  assert.equal(new Set(citations.map((citation) => citation.citationId)).size, 3);
});

test("benchmark preserves runtime clause and table-cell citation bindings", () => {
  const citations = publicEvidenceCitations(
    "architecture.md",
    [
      "The API [rejects unauthenticated calls](src/auth.ts#L10-L14), while the worker [renews its lease](src/lease.ts#L20-L24).",
      "",
      "| API behavior | Worker behavior |",
      "| --- | --- |",
      "| Accepts requests. [`src/api.ts#L1-L3`](src/api.ts#L1-L3) | Renews leases. [`src/worker.ts#L4-L6`](src/worker.ts#L4-L6) |"
    ].join("\n")
  );

  assert.deepEqual(
    citations.map((citation) => citation.claimSpan),
    ["The API rejects unauthenticated calls", "the worker renews its lease.", "Accepts requests.", "Renews leases."]
  );
});

test("passes a complete, grounded, critic-verified context artifact", async () => {
  const directory = await fixture();
  const report = await analyzeContextQuality(directory);

  assert.equal(report.schemaVersion, "context-quality-benchmark-v3");
  assert.equal(report.result, "pass");
  assert.equal(report.metrics.taskAnswerability.requiredLatestPassRate, 1);
  assert.equal(report.metrics.taskAnswerability.completePagePassCoverage, 1);
  assert.equal(report.metrics.grounding.exactSourceCoverage, 1);
  assert.equal(report.metrics.citationAudit.totalCitations, 3);
  assert.equal(report.metrics.citationAudit.supportedCitations, 3);
  assert.equal(report.metrics.citationAudit.unsupportedCitations, 0);
  assert.equal(report.metrics.citationAudit.auditCoverage, 1);
  assert.equal(report.metrics.citationAudit.perPageCoverage.length, 2);
  assert.ok(report.metrics.citationAudit.perPageCoverage.every((page) => page.supportedCoverage === 1));
  assert.equal(report.metrics.hierarchy.contextCrosslinks, 1);
  assert.equal(report.metrics.diagrams.mermaidBlocks, 1);
  assert.equal(report.metrics.providerAndHistory.providerCoveredItems, 1);
  assert.deepEqual(report.violations, []);
});

test("fails parity when retained private citation-audit artifacts are missing", async () => {
  const directory = await fixture({ includeAudit: false });
  const report = await analyzeContextQuality(path.join(directory, "derive-output"));
  const codes = new Set(report.violations.map((entry) => entry.code));

  assert.equal(report.result, "fail");
  assert.equal(report.metrics.citationAudit.retainedRun, false);
  assert.equal(report.metrics.citationAudit.privateArtifactsPresent, false);
  assert.ok(codes.has("missing_citation_audit_input"));
  assert.ok(codes.has("missing_citation_audit_result"));
  assert.ok(codes.has("missing_citation_audit_checkpoint"));
  assert.ok(codes.has("missing_citation_audit_certification"));
});

test("direct derive-output input passes when its original sibling audit state is retained", async () => {
  const directory = await fixture();
  const report = await analyzeContextQuality(path.join(directory, "derive-output"));

  assert.equal(report.result, "pass");
  assert.equal(report.metrics.citationAudit.retainedRun, true);
  assert.equal(report.metrics.citationAudit.privateArtifactsPresent, true);
  assert.equal(report.metrics.citationAudit.supportedCoverage, 1);
});

test("fails when citation-audit input is tampered after its digest is recorded", async () => {
  const directory = await fixture();
  const auditInputPath = stagePath(directory, "citation-audit-input.json");
  const input = JSON.parse(await readFile(auditInputPath, "utf8"));
  input.references[0].label = "tampered claim";
  await writeFile(auditInputPath, `${JSON.stringify(input, null, 2)}\n`);

  const report = await analyzeContextQuality(directory);
  const codes = new Set(report.violations.map((entry) => entry.code));
  assert.equal(report.result, "fail");
  assert.ok(codes.has("citation_audit_input_digest_mismatch"));
  assert.ok(codes.has("citation_audit_reference_mismatch"));
});

test("fails when public Markdown changes after citation audit", async () => {
  const directory = await fixture();
  await writeFile(
    path.join(directory, "derive-output", "architecture.md"),
    `# Overview

## Request path

[The handler](src/server.ts#L10-L24) calls the worker. See [History](history.md).

[A newly documented retry](src/retry.ts#L4-L8) changes the public snapshot.

\`\`\`mermaid
flowchart LR
  API --> Worker
\`\`\`
`
  );

  const report = await analyzeContextQuality(directory);
  const codes = new Set(report.violations.map((entry) => entry.code));
  assert.equal(report.result, "fail");
  assert.ok(codes.has("citation_audit_public_snapshot_mismatch"));
  assert.ok(codes.has("citation_audit_reference_missing"));
  assert.ok(codes.has("citation_audit_result_missing"));
  assert.ok(codes.has("certification_public_snapshot_mismatch"));
});

test("allows uncited connective prose beside a supported core section claim", async () => {
  const directory = await fixture({
    overview: `# Overview

[The request enters through the handler](src/server.ts#L10-L24).

## Request path

[The handler](src/server.ts#L10-L24) calls the worker. The worker always retries three times.

\`\`\`mermaid
flowchart LR
  API --> Worker
\`\`\`
`
  });
  const report = await analyzeContextQuality(directory);
  const codes = new Set(report.violations.map((entry) => entry.code));

  assert.equal(codes.has("ungrounded_substantive_section"), false);
});

test("fails when exact citation-audit result bytes no longer match the checkpoint and certification", async () => {
  const directory = await fixture();
  const resultPath = stagePath(directory, "citation-audit.json");
  const audit = JSON.parse(await readFile(resultPath, "utf8"));
  audit.summary = "Tampered after checkpointing.";
  await writeFile(resultPath, `${JSON.stringify(audit, null, 2)}\n`);

  const report = await analyzeContextQuality(directory);
  const codes = new Set(report.violations.map((entry) => entry.code));
  assert.equal(report.result, "fail");
  assert.ok(codes.has("citation_audit_output_digest_mismatch"));
  assert.ok(codes.has("certification_citation_audit_digest_mismatch"));
});

test("fails parity when even a digest-bound citation audit has an unsupported verdict", async () => {
  const directory = await fixture();
  const resultPath = stagePath(directory, "citation-audit.json");
  const checkpointPath = stagePath(directory, "citation-audit.checkpoint.json");
  const certificationPath = stagePath(directory, "certification.json");
  const audit = JSON.parse(await readFile(resultPath, "utf8"));
  audit.results[0].verdict = "unsupported";
  audit.results[0].rationale = "The cited excerpt does not support the nearby assertion.";
  const auditText = `${JSON.stringify(audit, null, 2)}\n`;
  const auditDigest = sha256(auditText);
  await writeFile(resultPath, auditText);
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  checkpoint.outputDigest = auditDigest;
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  const certification = JSON.parse(await readFile(certificationPath, "utf8"));
  certification.citationAuditDigest = auditDigest;
  await writeFile(certificationPath, `${JSON.stringify(certification, null, 2)}\n`);

  const report = await analyzeContextQuality(directory);
  const codes = new Set(report.violations.map((entry) => entry.code));
  assert.equal(report.result, "fail");
  assert.equal(report.metrics.citationAudit.unsupportedCitations, 1);
  assert.ok(codes.has("unsupported_public_citation"));
  assert.ok(!codes.has("citation_audit_output_digest_mismatch"));
  assert.ok(!codes.has("certification_citation_audit_digest_mismatch"));
});

test("fails when a digest-bound audit covers one current citation more than once", async () => {
  const directory = await fixture();
  const resultPath = stagePath(directory, "citation-audit.json");
  const checkpointPath = stagePath(directory, "citation-audit.checkpoint.json");
  const certificationPath = stagePath(directory, "certification.json");
  const audit = JSON.parse(await readFile(resultPath, "utf8"));
  audit.results.push({ ...audit.results[0] });
  const auditText = `${JSON.stringify(audit, null, 2)}\n`;
  const auditDigest = sha256(auditText);
  await writeFile(resultPath, auditText);
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  checkpoint.outputDigest = auditDigest;
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  const certification = JSON.parse(await readFile(certificationPath, "utf8"));
  certification.citationAuditDigest = auditDigest;
  await writeFile(certificationPath, `${JSON.stringify(certification, null, 2)}\n`);

  const report = await analyzeContextQuality(directory);
  const codes = new Set(report.violations.map((entry) => entry.code));
  assert.equal(report.result, "fail");
  assert.ok(codes.has("citation_audit_result_count_mismatch"));
  assert.ok(codes.has("citation_audit_result_duplicate"));
});

test("fails the latest critic verdict, grounding, provider, and link contract", async () => {
  const directory = await fixture({
    overview: "# Overview\n\nSee [missing](missing.md).\n",
    history: "# History\n\n[The implementation](src/worker.ts#L20-L31) changed after an incident.\n",
    latestVerdict: "fail",
    latestGapIds: ["task-gap"],
    gapStatus: "open"
  });
  const report = await analyzeContextQuality(directory);
  const codes = new Set(report.violations.map((entry) => entry.code));

  assert.equal(report.result, "fail");
  assert.ok(codes.has("required_question_not_passed"));
  assert.ok(codes.has("untested_complete_page"));
  assert.ok(codes.has("ungrounded_document"));
  assert.ok(codes.has("broken_context_link"));
  assert.ok(codes.has("missing_required_provider_evidence"));
  assert.ok(codes.has("open_blocking_gap"));
});

test("compares incremental freshness only when a previous artifact is supplied", async () => {
  const previous = await fixture({ commitSha: "1111111111111111111111111111111111111111", mode: "initial" });
  const current = await fixture({ commitSha: "2222222222222222222222222222222222222222", mode: "incremental" });
  const report = await analyzeContextQuality(current, { previousPath: previous });

  assert.equal(report.result, "pass");
  assert.equal(report.metrics.incrementalFreshness.evaluated, true);
  assert.equal(report.metrics.incrementalFreshness.commitAdvanced, true);
});

test("accepts a new provider observation when an incremental issue build keeps the same commit", async () => {
  const commitSha = "1111111111111111111111111111111111111111";
  const previous = await fixture({ commitSha, mode: "initial", issueNumber: 7 });
  const current = await fixture({ commitSha, mode: "incremental", issueNumber: 8 });
  const report = await analyzeContextQuality(current, { previousPath: previous });

  assert.equal(report.result, "pass");
  assert.equal(report.metrics.incrementalFreshness.commitAdvanced, false);
  assert.equal(report.metrics.incrementalFreshness.providerEvidenceAdvanced, true);
});

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "context-quality-benchmark-"));
  const output = path.join(directory, "derive-output");
  await mkdir(output, { recursive: true });
  const overview =
    options.overview ??
    `# Overview

## Request path

[The handler](src/server.ts#L10-L24) calls the worker. See [History](history.md).

\`\`\`mermaid
flowchart LR
  API --> Worker
\`\`\`
`;
  const issueNumber = options.issueNumber ?? 7;
  const history =
    options.history ??
    `# History

## Incident

[The implementation](src/worker.ts#L20-L31) was corrected in [issue ${issueNumber}](https://github.com/acme/example/issues/${issueNumber}).
`;
  await writeFile(path.join(output, "architecture.md"), overview);
  await writeFile(path.join(output, "history.md"), history);

  const commitSha = options.commitSha ?? "2222222222222222222222222222222222222222";
  const latestVerdict = options.latestVerdict ?? "pass";
  const latestGapIds = options.latestGapIds ?? [];
  const gapStatus = options.gapStatus ?? "resolved";
  const plan = {
    version: 4,
    repository: "acme/example",
    ref: "main",
    commitSha,
    mode: options.mode ?? "initial",
    phase: "complete",
    subjects: [
      {
        id: "request-flow",
        kind: "flow",
        statement: "Requests cross the API and worker.",
        priority: "required",
        status: "covered",
        signals: [{ source: "code", reference: "src/server.ts" }],
        questions: [
          {
            id: "change-request-flow",
            question: "How should the request path be changed safely?",
            priority: "required",
            status: "answered",
            pageIds: ["architecture"]
          }
        ],
        pageIds: ["architecture"]
      },
      {
        id: "incident-history",
        kind: "history",
        statement: "Issue 7 explains a worker correction.",
        priority: "supporting",
        status: "covered",
        signals: [{ source: "issue", reference: `https://github.com/acme/example/issues/${issueNumber}` }],
        questions: [
          {
            id: "trace-incident",
            question: "What historical issue changed the worker?",
            priority: "supporting",
            status: "answered",
            pageIds: ["history"]
          }
        ],
        pageIds: ["history"]
      }
    ],
    items: [
      {
        id: "architecture",
        path: "architecture.md",
        title: "Overview",
        purpose: "Explain the request path.",
        priority: "required",
        status: "complete",
        scope: { paths: ["src/server.ts"], symbols: [] },
        questions: ["change-request-flow"],
        requiredEvidence: ["code"],
        dependencies: []
      },
      {
        id: "history",
        path: "history.md",
        title: "History",
        purpose: "Explain a material historical decision.",
        priority: "supporting",
        status: "complete",
        scope: { paths: ["src/worker.ts"], symbols: [] },
        questions: ["trace-incident"],
        requiredEvidence: ["code", "history", "provider"],
        dependencies: []
      }
    ],
    areas: [],
    workers: [],
    reviews: [
      {
        id: "critic-1",
        kind: "context_only",
        status: "complete",
        reviewer: "lead",
        results: [
          {
            questionId: "change-request-flow",
            verdict: latestVerdict,
            pageIds: ["architecture"],
            gapIds: latestGapIds,
            summary: "The page identifies the request path and implementation."
          },
          {
            questionId: "trace-incident",
            verdict: "pass",
            pageIds: ["history"],
            gapIds: [],
            summary: "The page identifies issue 7 and current implementation."
          }
        ],
        summary: "The public context answers both maintenance tasks."
      }
    ],
    gaps: [
      {
        id: "task-gap",
        severity: "blocking",
        description: "The request path is incomplete.",
        status: gapStatus,
        pageId: "architecture",
        resolution: gapStatus === "resolved" ? "The request path was documented." : undefined
      }
    ],
    completionReason: "All required questions passed review."
  };
  await writeFile(path.join(output, ".context-plan.json"), JSON.stringify(plan, null, 2));
  if (options.includeAudit !== false) {
    await writeCitationAuditArtifacts(
      directory,
      plan,
      new Map([
        ["architecture.md", overview],
        ["history.md", history]
      ])
    );
  }
  return directory;
}

async function writeCitationAuditArtifacts(directory, plan, markdownByPath) {
  const stages = path.join(directory, "derive-state", "agent-stages");
  await mkdir(stages, { recursive: true });
  const citations = [...markdownByPath].flatMap(([relativePath, markdown]) =>
    publicEvidenceCitations(relativePath, markdown)
  );
  const snapshot = plan.items
    .map((item) => {
      const body = markdownByPath.get(item.path);
      return body?.trim() ? `===== PAGE ${item.id} (${item.path}) =====\n${body.trim()}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const criticSnapshotDigest = sha256(snapshot);
  const publicDocumentSnapshot = [...markdownByPath]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, body]) => `===== DOCUMENT ${relativePath} =====\n${body}`)
    .join("\n\n");
  const publicSnapshotDigest = sha256(publicDocumentSnapshot);
  const references = citations.map((citation) => {
    const excerpt = citation.claimSpan;
    if (citation.providerUrl) {
      const providerKind = citation.providerUrl.includes("/pull/")
        ? "pull_request"
        : citation.providerUrl.includes("/commit/")
          ? "commit"
          : "issue";
      return {
        citationId: citation.citationId,
        documentPath: citation.documentPath,
        label: citation.claim,
        claimSpan: citation.claimSpan,
        target: citation.target,
        sourceType: providerKind,
        sourceId: citation.providerUrl.split("/").at(-1),
        contentDigest: sha256(excerpt),
        pathOrUrl: citation.providerUrl,
        jsonPointer: "",
        excerpt
      };
    }
    return {
      citationId: citation.citationId,
      documentPath: citation.documentPath,
      label: citation.claim,
      claimSpan: citation.claimSpan,
      target: citation.target,
      sourceType: "blob",
      sourceId: "a".repeat(40),
      contentDigest: sha256(excerpt),
      pathOrUrl: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine,
      excerpt
    };
  });
  const checkpointIdentity = {
    repository: plan.repository,
    ref: plan.ref,
    commitSha: plan.commitSha,
    evidenceFingerprint: "e".repeat(64),
    manifestFingerprint: "f".repeat(64)
  };
  const inputPayload = {
    version: 1,
    checkpoint: checkpointIdentity,
    publicSnapshotDigest,
    references
  };
  const inputDigest = sha256(JSON.stringify(inputPayload));
  await writeFile(
    stagePath(directory, "citation-audit-input.json"),
    `${JSON.stringify({ ...inputPayload, inputDigest }, null, 2)}\n`
  );

  const audit = {
    version: 1,
    inputDigest,
    publicSnapshotDigest,
    worker: { id: "citation-audit", summary: "Every current public claim was checked against its exact excerpt." },
    results: citations.map((citation) => ({
      citationId: citation.citationId,
      verdict: "supported",
      rationale: "The exact captured excerpt supports the nearby public assertion.",
      correction: null
    })),
    summary: "All current public citations are supported."
  };
  const auditText = `${JSON.stringify(audit, null, 2)}\n`;
  const auditDigest = sha256(auditText);
  await writeFile(stagePath(directory, "citation-audit.json"), auditText);
  await writeFile(
    stagePath(directory, "citation-audit.checkpoint.json"),
    `${JSON.stringify(
      {
        version: 1,
        stage: "citation-audit",
        repository: plan.repository,
        ref: plan.ref,
        commitSha: plan.commitSha,
        inputDigest,
        publicSnapshotDigest,
        outputDigest: auditDigest,
        citationIds: citations.map((citation) => citation.citationId),
        completedAt: "2026-01-01T00:00:00.000Z"
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    stagePath(directory, "certification.json"),
    `${JSON.stringify(
      {
        version: 1,
        workerId: "critic-pass-1",
        snapshotDigest: criticSnapshotDigest,
        taskCatalogDigest: "b".repeat(64),
        questionIds: ["change-request-flow", "trace-incident"],
        sourceChallengeDigest: "c".repeat(64),
        citationAuditDigest: auditDigest,
        certifiedAt: "2026-01-01T00:00:00.000Z"
      },
      null,
      2
    )}\n`
  );
}

function stagePath(directory, fileName) {
  return path.join(directory, "derive-state", "agent-stages", fileName);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
