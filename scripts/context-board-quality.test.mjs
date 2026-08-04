import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  PAGEINDEX_OSS_ADAPTER_NAME,
  PAGEINDEX_OSS_SOURCE_DIGEST,
  PAGEINDEX_OSS_SOURCE_PIN,
  boardContextPublicationInputDigest,
  boardContextReleaseId,
  contextPublicSnapshotDigest,
  fingerprint,
  markdownEvidenceSections,
  parseMarkdownDocument
} from "../packages/context-engine/dist/index.js";
import { evaluateBoardContextQuality } from "./context-board-quality.mjs";

const execFileAsync = promisify(execFile);

test("passes a complete Board-native immutable release", async () => {
  const fixture = await boardFixture();
  const report = await evaluateBoardContextQuality({
    artifactRoot: fixture.root,
    buildId: fixture.buildId
  });

  assert.equal(report.schemaVersion, "context-board-quality-v2");
  assert.equal(report.result, "pass", JSON.stringify(report.violations, null, 2));
  assert.equal(report.metrics.release.pageCount, 2);
  assert.equal(report.metrics.gates.latestSourceChallengeVerdict, "pass");
  assert.equal(report.metrics.maintenanceTasks.latestPassRate, 1);
  assert.equal(report.metrics.maintenanceTasks.pageUsageCoverage, 1);
  assert.equal(report.metrics.citationAudits.supportedCoverage, 1);
  assert.equal(report.metrics.publicPages.architectureReachablePages, 2);
  assert.equal(report.metrics.providerAndHistory.applicable, true);
  assert.equal(report.metrics.providerAndHistory.covered, true);
  assert.equal(report.metrics.pageIndex.sourcePinned, true);
});

test("fails hard when the latest critic stops using a published page", async () => {
  const fixture = await boardFixture();
  const evaluationPath = fixture.files.get("gate-evaluation/task-evaluation-0.json");
  const evaluation = JSON.parse(await readFile(evaluationPath, "utf8"));
  evaluation.result.review.results[1].pageIds = ["architecture"];
  evaluation.result.attempts[1].pageIds = ["architecture"];
  await writeFile(evaluationPath, JSON.stringify(evaluation));

  const report = await evaluateBoardContextQuality({
    artifactRoot: fixture.root,
    buildId: fixture.buildId
  });
  const codes = new Set(report.violations.map((entry) => entry.code));

  assert.equal(report.result, "fail");
  assert.ok(codes.has("artifact_reference_digest_mismatch"));
  assert.ok(codes.has("public_page_not_used_by_task"));
});

test("rejects a PageIndex tree that no longer represents the certified release", async () => {
  const fixture = await boardFixture();
  const treePath = fixture.files.get(`pageindex-tree/${fixture.releaseId}.json`);
  const tree = JSON.parse(await readFile(treePath, "utf8"));
  tree.nodes.pop();
  tree.representedDocuments.pop();
  await writeFile(treePath, JSON.stringify(tree));

  const report = await evaluateBoardContextQuality({
    artifactRoot: fixture.root,
    buildId: fixture.buildId
  });
  const codes = new Set(report.violations.map((entry) => entry.code));

  assert.equal(report.result, "fail");
  assert.ok(codes.has("pageindex_incomplete_documents"));
  assert.ok(codes.has("pageindex_document_missing"));
  assert.ok(codes.has("pageindex_digest_mismatch"));
});

test("rejects private orchestration files linked from a public page", async () => {
  const fixture = await boardFixture({ privateLink: true });
  const report = await evaluateBoardContextQuality({
    artifactRoot: fixture.root,
    buildId: fixture.buildId
  });
  const codes = new Set(report.violations.map((entry) => entry.code));

  assert.equal(report.result, "fail");
  assert.ok(codes.has("private_artifact_link"));
});

test("scans only the requested build subtree", async () => {
  const fixture = await boardFixture();
  const unrelated = path.join(
    fixture.root,
    "context",
    "tenants",
    "other",
    "repositories",
    "broken",
    "repo",
    "builds",
    "unrelated",
    "context-release"
  );
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, "release.json"), "{invalid");

  const report = await evaluateBoardContextQuality({
    artifactRoot: fixture.root,
    buildId: fixture.buildId
  });

  assert.equal(report.result, "pass", JSON.stringify(report.violations, null, 2));
  assert.ok(!report.violations.some((entry) => entry.code === "artifact_invalid_json"));
});

test("accepts an advanced incremental commit and reports document freshness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jina-board-quality-incremental-"));
  const previous = await boardFixture({
    root,
    buildId: "build-previous",
    refSequence: 1,
    commitSha: "1".repeat(40)
  });
  const current = await boardFixture({
    root,
    buildId: "build-current",
    refSequence: 2,
    commitSha: "2".repeat(40)
  });
  const report = await evaluateBoardContextQuality({
    artifactRoot: root,
    buildId: current.buildId,
    previousBuildId: previous.buildId
  });

  assert.equal(report.result, "pass", JSON.stringify(report.violations, null, 2));
  assert.equal(report.metrics.incrementalFreshness.evaluated, true);
  assert.equal(report.metrics.incrementalFreshness.commitAdvanced, true);
  assert.equal(report.metrics.incrementalFreshness.frontierAdvanced, true);
  assert.deepEqual(report.metrics.incrementalFreshness.unchangedDocuments, ["architecture.md", "flows/request.md"]);
});

test("fails an incremental comparison whose commit and provider frontier did not advance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jina-board-quality-stale-"));
  const previous = await boardFixture({
    root,
    buildId: "build-previous",
    refSequence: 1,
    commitSha: "1".repeat(40)
  });
  const current = await boardFixture({
    root,
    buildId: "build-current",
    refSequence: 2,
    commitSha: "1".repeat(40)
  });
  const report = await evaluateBoardContextQuality({
    artifactRoot: root,
    buildId: current.buildId,
    previousBuildId: previous.buildId
  });

  assert.equal(report.result, "fail");
  assert.ok(report.violations.some((entry) => entry.code === "incremental_frontier_not_advanced"));
});

test("CLI help is available without artifact arguments", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/context-board-quality.mjs", "--help"]);
  assert.match(stdout, /--artifact-root PATH/);
  assert.match(stdout, /--previous-build BUILD_ID/);
});

test("CLI emits JSON and exits nonzero for a hard deficit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jina-board-quality-empty-"));
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/context-board-quality.mjs",
      "--artifact-root",
      root,
      "--build",
      "missing"
    ]),
    (error) => {
      const report = JSON.parse(error.stdout);
      assert.equal(report.result, "fail");
      assert.ok(report.violations.some((entry) => entry.code === "build_not_found"));
      return true;
    }
  );
});

test("CLI accepts the pnpm argument separator before documented artifact arguments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jina-board-quality-pnpm-separator-"));
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/context-board-quality.mjs",
      "--",
      "--artifact-root",
      root,
      "--build",
      "missing"
    ]),
    (error) => {
      const report = JSON.parse(error.stdout);
      assert.equal(report.result, "fail");
      assert.ok(report.violations.some((entry) => entry.code === "build_not_found"));
      assert.doesNotMatch(error.stderr, /Unknown option: --/);
      return true;
    }
  );
});

async function boardFixture(options = {}) {
  const root = options.root ?? (await mkdtemp(path.join(tmpdir(), "jina-board-quality-fixture-")));
  const buildId = options.buildId ?? "build-current";
  const refSequence = options.refSequence ?? 1;
  const commitSha = options.commitSha ?? "1".repeat(40);
  const tenantId = "tenant-quality";
  const repository = "acme/sample";
  const ref = "main";
  const buildDirectory = path.join(
    root,
    "context",
    "tenants",
    encodeURIComponent(tenantId),
    "repositories",
    "acme",
    "sample",
    "builds",
    encodeURIComponent(buildId)
  );
  const files = new Map();
  const put = async (kind, name, value) => {
    const content = JSON.stringify(value);
    const target = path.join(buildDirectory, kind, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    files.set(`${kind}/${name}`, target);
    return {
      uri: `file://${target}`,
      key: [
        "context",
        "tenants",
        encodeURIComponent(tenantId),
        "repositories",
        "acme",
        "sample",
        "builds",
        encodeURIComponent(buildId),
        kind,
        name
      ].join("/"),
      contentType: "application/json",
      bytes: Buffer.byteLength(content),
      sha256: sha256(content)
    };
  };

  const source = ["export function handleRequest(): number {", "  return 200;", "}"].join("\n");
  const blobSha = "a".repeat(40);
  const issueUrl = "https://github.com/acme/sample/issues/7";
  const observationPayload = { number: 7, title: "Keep explicit request status", state: "closed" };
  const snapshot = {
    version: 1,
    tenantId,
    repository,
    ref,
    refSequence,
    commitSha,
    files: [
      {
        path: "src/server.ts",
        blobSha,
        body: source,
        executable: false,
        contentOmitted: false,
        entryType: "file"
      }
    ],
    observations: [
      {
        sourceType: "issue",
        sourceId: "github:issue:acme/sample#7",
        title: "Keep explicit request status",
        payload: observationPayload,
        pathOrUrl: issueUrl,
        observedAt: "2026-07-29T12:00:00.000Z",
        metadata: { provider: "github", number: 7 }
      }
    ],
    git: {
      commit: {
        treeSha: "b".repeat(40),
        parentShas: [],
        message: "Add request handler"
      },
      changes: [{ kind: "add", path: "src/server.ts", newBlobSha: blobSha }],
      history: [
        {
          sha: commitSha,
          treeSha: "b".repeat(40),
          parentShas: [],
          message: "Add request handler"
        }
      ]
    },
    aclFingerprint: "acl-quality",
    observationFrontier: JSON.stringify({
      commitSha,
      issues: { observed: 1, latest: 7 }
    }),
    createdAt: "2026-07-29T12:00:00.000Z",
    sourceComplete: true
  };
  const snapshotRef = await put("evidence-snapshot", "snapshot.json", snapshot);
  const questions = [
    {
      id: taskId("How does a request enter the handler?"),
      question: "How does a request enter the handler?",
      pageId: "architecture"
    },
    {
      id: taskId("Why does the request path return an explicit status?"),
      question: "Why does the request path return an explicit status?",
      pageId: "request-flow"
    }
  ];
  const researchPlanRef = await put("research-plan", "research-plan.json", {
    version: 1,
    plan: {
      version: 1,
      assignments: [
        {
          id: "request-runtime",
          objective: "Understand request execution and its history.",
          reason: "The request handler is the public runtime boundary.",
          focusPaths: ["src/server.ts"],
          questions: questions.map((question) => question.question)
        }
      ]
    },
    snapshotArtifact: snapshotRef
  });
  const publication = {
    version: 1,
    plan: {
      version: 1,
      hierarchyRationale: "Architecture leads to the detailed request flow.",
      pages: [
        {
          id: "architecture",
          path: "architecture.md",
          title: "Architecture",
          purpose: "Orient maintainers to the request boundary.",
          sourceAssignmentIds: ["request-runtime"],
          maintenanceQuestions: [questions[0].question],
          coverageAreas: ["src"],
          requiredTopics: ["request entry"],
          diagram: "none",
          dependencies: []
        },
        {
          id: "request-flow",
          path: "flows/request.md",
          title: "Request flow",
          purpose: "Explain request control flow and the historical issue decision.",
          sourceAssignmentIds: ["request-runtime"],
          maintenanceQuestions: [questions[1].question],
          coverageAreas: ["src"],
          requiredTopics: ["request flow", "history decision"],
          diagram: "none",
          dependencies: ["architecture"]
        }
      ],
      writers: [
        {
          id: "writer-runtime",
          objective: "Document the request runtime.",
          pageIds: ["architecture", "request-flow"]
        }
      ],
      excludedAreas: []
    },
    researchPlanArtifact: researchPlanRef,
    researchReportArtifacts: [],
    snapshotArtifact: snapshotRef
  };
  const publicationRef = await put("publication-plan", "publication-plan.json", publication);
  const markdownByPath = new Map([
    [
      "architecture.md",
      [
        "# Architecture",
        "",
        "[The request enters `handleRequest` and returns its status](src/server.ts#L1-L3).",
        "",
        "[Request flow](flows/request.md).",
        ...(options.privateLink ? ["", "[Open worker state](.workers/status.json)."] : [])
      ].join("\n")
    ],
    [
      "flows/request.md",
      [
        "# Request flow",
        "",
        "[`handleRequest` returns status 200](src/server.ts#L1-L3).",
        "",
        "[Issue #7 records why the explicit status remains](https://github.com/acme/sample/issues/7)."
      ].join("\n")
    ]
  ]);
  const pageRefs = [];
  for (const [documentPath, bodyMarkdown] of markdownByPath) {
    const title = documentPath === "architecture.md" ? "Architecture" : "Request flow";
    const pageRef = await put("context-page", `${safeName(documentPath)}.json`, {
      version: 1,
      documentPath,
      title,
      bodyMarkdown,
      publicationPlanArtifact: publicationRef,
      snapshotArtifact: snapshotRef
    });
    pageRefs.push(pageRef);
    const inventory = citationInventory(documentPath, bodyMarkdown, snapshot);
    if (!options.privateLink) assert.deepEqual(inventory.structuralProblems, []);
    const publicSnapshotDigest = sha256(`${documentPath}\0${bodyMarkdown}`);
    const inputPayload = {
      version: 1,
      checkpoint: { repository, ref, commitSha },
      publicSnapshotDigest,
      references: inventory.references,
      structuralProblems: inventory.structuralProblems
    };
    const inputDigest = sha256(JSON.stringify(inputPayload));
    await put("citation-audit", `${safeName(documentPath)}.json`, {
      version: 1,
      pageArtifact: pageRef,
      snapshotArtifact: snapshotRef,
      publicSnapshotDigest,
      inputDigest,
      references: inventory.references,
      structuralProblems: inventory.structuralProblems,
      audit: {
        version: 1,
        inputDigest,
        publicSnapshotDigest,
        worker: {
          id: `citation-audit-${safeName(documentPath)}`,
          summary: "Every exact fixture citation is supported."
        },
        results: inventory.references.map((reference) => ({
          citationId: reference.citationId,
          verdict: "supported",
          rationale: "The exact captured excerpt supports the rendered assertion.",
          correction: null
        })),
        summary: "Every fixture citation passed."
      }
    });
  }

  const releasePages = [...markdownByPath].map(([documentPath, bodyMarkdown], pageIndex) => {
    const document = parseMarkdownDocument(documentPath.replace(/\.md$/i, ""), bodyMarkdown);
    const revisionId = `kr_${pageIndex}_${commitSha.slice(0, 12)}_${buildId}`;
    return {
      documentPath,
      title: document.title,
      bodyMarkdown,
      bodySha256: sha256(bodyMarkdown),
      revisionId,
      citations: document.evidenceLinks.map((link, citationIndex) => {
        const observation = snapshot.observations[0];
        return {
          id: `kc_${pageIndex}_${citationIndex}_${buildId}`,
          revisionId,
          ordinal: citationIndex,
          claim: link.claim,
          citationId: link.citationId,
          claimSpan: link.claimSpan,
          anchor: link.path
            ? {
                tenantId,
                repository,
                sourceType: "blob",
                sourceId: blobSha,
                contentDigest: sha256(source),
                commitSha,
                pathOrUrl: link.path,
                startLine: link.startLine,
                endLine: link.endLine
              }
            : {
                tenantId,
                repository,
                sourceType: observation.sourceType,
                sourceId: observation.sourceId,
                contentDigest: sha256(JSON.stringify(observation.payload)),
                commitSha,
                pathOrUrl: observation.pathOrUrl,
                jsonPointer: "",
                observedAt: observation.observedAt
              }
        };
      })
    };
  });
  releasePages.sort((left, right) => left.documentPath.localeCompare(right.documentPath));
  const publicSnapshotDigest = contextPublicSnapshotDigest(releasePages);
  const pageArtifactRefs = releasePages.map((releasePage) => {
    const index = [...markdownByPath.keys()].indexOf(releasePage.documentPath);
    return pageRefs[index];
  });
  const sourceChallengeRef = await put("gate-evaluation", "source-challenge-0.json", {
    version: 1,
    gate: "source-challenge",
    verdict: "pass",
    publicSnapshotDigest,
    blockingGapCount: 0,
    publicationPlanArtifact: publicationRef,
    pageArtifacts: pageArtifactRefs,
    result: {
      version: 1,
      inputDigest: "c".repeat(64),
      publicSnapshotDigest,
      worker: { id: "source-challenge-0", summary: "No material subjects are omitted." },
      acceptedTaskIds: questions.map((question) => question.id),
      addedTasks: [],
      omittedSubjects: [],
      summary: "The public context covers the material source surfaces."
    }
  });
  const taskCatalog = questions
    .map((question) => ({
      id: question.id,
      question: question.question,
      priority: "required"
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const taskCatalogDigest = sha256(JSON.stringify(taskCatalog, null, 2));
  const taskEvaluationResult = {
    snapshotDigest: publicSnapshotDigest,
    taskCatalogDigest,
    worker: { id: "critic-context-0", summary: "Both maintenance tasks are answerable." },
    review: {
      id: "review-fixture",
      kind: "context_only",
      status: "complete",
      workerId: "critic-context-0",
      reviewer: "subagent",
      results: questions.map((question) => ({
        questionId: question.id,
        verdict: "pass",
        pageIds: [question.pageId],
        gapIds: [],
        summary: "The context names the entry point, flow, verification, and rationale."
      }))
    },
    gaps: [],
    attempts: questions.map((question) => ({
      questionId: question.id,
      pageIds: [question.pageId],
      headings: [question.pageId === "architecture" ? "Architecture" : "Request flow"],
      entrypoints: ["handleRequest"],
      importantSymbols: ["handleRequest"],
      changePlan: ["Update handleRequest and its focused tests."],
      controlFlow: ["The function returns the explicit response status."],
      state: [],
      invariants: ["The returned status remains explicit."],
      configuration: [],
      verification: ["Run the request handler test."],
      failureTriage: ["Inspect the returned status."],
      blockingUnknowns: []
    }))
  };
  const taskEvaluationRef = await put("gate-evaluation", "task-evaluation-0.json", {
    version: 1,
    gate: "task-evaluation",
    verdict: "pass",
    publicSnapshotDigest,
    blockingGapCount: 0,
    publicationPlanArtifact: publicationRef,
    pageArtifacts: pageArtifactRefs,
    result: taskEvaluationResult
  });
  const certificationRef = await put("certification", "certification.json", {
    version: 1,
    verdict: "certified",
    publicSnapshotDigest,
    publicationPlanArtifact: publicationRef,
    pageArtifacts: pageArtifactRefs,
    sourceChallengeArtifact: sourceChallengeRef,
    taskEvaluationArtifact: taskEvaluationRef
  });
  const releaseScope = {
    tenantId,
    repository,
    ref,
    refSequence,
    commitSha,
    buildId
  };
  const checkpointId = `ec_${commitSha.slice(0, 20)}_${refSequence}`;
  const publicationInputDigest = boardContextPublicationInputDigest({
    scope: releaseScope,
    certificationArtifact: certificationRef,
    publicationPlanArtifact: publicationRef,
    checkpointId,
    publicSnapshotDigest,
    pages: releasePages.map((page) => ({
      documentPath: page.documentPath,
      bodySha256: page.bodySha256,
      revisionId: page.revisionId,
      citationIds: page.citations.map((citation) => citation.id)
    }))
  });
  const releaseId = boardContextReleaseId(publicationInputDigest);
  const release = {
    version: 1,
    release: {
      releaseId,
      tenantId,
      repository,
      ref,
      refSequence,
      commitSha,
      checkpointId,
      buildId,
      publishedAt: "2026-07-29T12:30:00.000Z"
    },
    certificationArtifact: certificationRef,
    publicationPlanArtifact: publicationRef,
    publicSnapshotDigest,
    publicationInputDigest,
    pages: releasePages
  };
  await put("context-release", `${releaseId}.json`, release);

  const nodes = releasePages.map((page, index) => ({
    externalId: `node-${index + 1}`,
    documentId: page.revisionId,
    title: page.title,
    summary: `PageIndex root for ${page.title}.`,
    depth: 1,
    preorderStart: 1,
    preorderEnd: 1,
    anchors: [
      ...new Map(page.citations.map((citation) => [fingerprint(citation.anchor), citation.anchor])).values()
    ].sort((left, right) => fingerprint(left).localeCompare(fingerprint(right)))
  }));
  const treeDigest = fingerprint(nodes);
  const inputDigest = "d".repeat(64);
  const buildDigest = fingerprint({
    version: 1,
    releaseId,
    publicSnapshotDigest,
    inputDigest,
    treeDigest,
    adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
    adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
    sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
    sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
  });
  const representedDocuments = releasePages.map((page) => ({
    documentId: page.revisionId,
    documentPath: page.documentPath,
    title: page.title,
    rootCount: 1,
    nodeCount: 1,
    maxDepth: 1
  }));
  await put("pageindex-tree", `${releaseId}.json`, {
    version: 1,
    release: {
      ...release.release,
      publicSnapshotDigest,
      publicationInputDigest
    },
    source: {
      adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
      adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
      sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
      sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
    },
    representedDocuments,
    metrics: {
      documentCount: releasePages.length,
      representedDocumentCount: representedDocuments.length,
      rootCount: nodes.length,
      nodeCount: nodes.length,
      maxDepth: 1,
      documentCharacters: releasePages.reduce((total, page) => total + page.bodyMarkdown.length, 0),
      inputDigest,
      treeDigest,
      buildDigest
    },
    nodes,
    diagnostics: []
  });
  return { root, buildId, buildDirectory, files, releaseId };
}

function citationInventory(documentPath, bodyMarkdown, snapshot) {
  const document = parseMarkdownDocument(documentPath.replace(/\.md$/i, ""), bodyMarkdown);
  const structuralProblems = [];
  const references = document.evidenceLinks.map((link) => {
    if (link.providerUrl) {
      const observation = snapshot.observations.find((candidate) => candidate.pathOrUrl === link.providerUrl);
      const body = JSON.stringify(observation.payload);
      return {
        citationId: link.citationId,
        documentPath,
        label: link.claim,
        claimSpan: link.claimSpan,
        target: link.providerUrl,
        sourceType: observation.sourceType,
        sourceId: observation.sourceId,
        contentDigest: sha256(body),
        pathOrUrl: observation.pathOrUrl,
        jsonPointer: "",
        excerpt: body
      };
    }
    const file = snapshot.files.find((candidate) => candidate.path === link.path);
    const lines = file.body.split(/\r?\n/);
    return {
      citationId: link.citationId,
      documentPath,
      label: link.claim,
      claimSpan: link.claimSpan,
      target: `${link.path}#L${link.startLine}${link.endLine === link.startLine ? "" : `-L${link.endLine}`}`,
      sourceType: "blob",
      sourceId: file.blobSha,
      contentDigest: sha256(file.body),
      pathOrUrl: link.path,
      startLine: link.startLine,
      endLine: link.endLine,
      excerpt: lines.slice(link.startLine - 1, link.endLine).join("\n")
    };
  });
  const knownIds = new Set(document.evidenceLinks.map((link) => link.citationId));
  const groundedSummary = document.materialClaims
    .filter((claim) => claim.summary && claim.classification === "material")
    .flatMap((claim) => claim.citationIds)
    .some((citationId) => knownIds.has(citationId));
  if (!groundedSummary) structuralProblems.push("ungrounded lead summary");
  for (const section of markdownEvidenceSections(bodyMarkdown)) {
    if (section.substantiveClaimCount > 0 && section.citationIds.length === 0) {
      structuralProblems.push(`ungrounded section: ${section.heading}`);
    }
  }
  return { references, structuralProblems };
}

function taskId(question) {
  return `task-${sha256(question.trim().replace(/\s+/g, " ").toLowerCase()).slice(0, 20)}`;
}

function safeName(documentPath) {
  return documentPath
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
