#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import {
  LocalPageIndexClient,
  buildKnowledgeFilePrompt,
  documentPathFromFile,
  parseMarkdownDocument
} from "../packages/context-engine/dist/index.js";
import { LocalCodexKnowledgeDocumentGenerator } from "../packages/daytona/dist/index.js";

const execFileAsync = promisify(execFile);
const baselineDirectory = process.env.CONTEXT_BASELINE_DIR?.trim();
assert.ok(baselineDirectory, "CONTEXT_BASELINE_DIR must name a retained derive run");

process.env.CONTEXT_DERIVE_DOCUMENT_FILES = "true";
process.env.CONTEXT_CODEX_MODEL = process.env.CONTEXT_CODEX_MODEL?.trim() || "gpt-5.6-terra";
process.env.CONTEXT_CODEX_EFFORT = process.env.CONTEXT_CODEX_EFFORT?.trim() || "low";
process.env.CONTEXT_CODEX_AUTH = process.env.CONTEXT_CODEX_AUTH?.trim() || "session";
process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS =
  process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS?.trim() || "5";
process.env.JINA_KEEP_DERIVE_DIR = "true";

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function restoreNumberedBody(body) {
  return body
    .split("\n")
    .map((line) => line.replace(/^\d+\|/, ""))
    .join("\n");
}

function restoreBundle(serialized) {
  const checkpoint = serialized.checkpoint;
  const items = serialized.evidence.map((item) => ({
    evidenceId: item.evidenceId,
    title: item.title,
    body: item.numberedBody === undefined ? item.body : restoreNumberedBody(item.numberedBody),
    anchor: {
      tenantId: checkpoint.tenantId,
      repository: checkpoint.repository,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      contentDigest: item.contentDigest,
      ...(item.commitSha ? { commitSha: item.commitSha } : {}),
      ...(item.pathOrUrl ? { pathOrUrl: item.pathOrUrl } : {})
    },
    authorityClass: item.authorityClass,
    metadata: item.metadata ?? {}
  }));
  return {
    checkpoint,
    items,
    omittedCount: serialized.omittedCount,
    truncatedEvidenceIds: serialized.truncatedEvidenceIds,
    selectorVersion: serialized.selectorVersion,
    fingerprint: `replay:${checkpoint.evidenceFingerprint}`
  };
}

async function markdownFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  }
  await walk(directory);
  return files.sort();
}

function wordCount(body) {
  return body.trim() ? body.trim().split(/\s+/).length : 0;
}

async function catalogMetrics(directory) {
  const files = await markdownFiles(directory);
  const documents = await Promise.all(
    files.map(async (path) => {
      const body = await readFile(path, "utf8");
      const documentPath = documentPathFromFile(relative(directory, path));
      const parsed = parseMarkdownDocument(documentPath, body);
      return {
        path: relative(directory, path),
        title: parsed.title,
        body,
        words: wordCount(body),
        citations: parsed.evidenceLinks.length,
        providerCitations: parsed.evidenceLinks.filter((link) => link.providerUrl).length
      };
    })
  );
  return {
    documents,
    documentCount: documents.length,
    words: documents.reduce((sum, document) => sum + document.words, 0),
    citations: documents.reduce((sum, document) => sum + document.citations, 0),
    providerCitations: documents.reduce((sum, document) => sum + document.providerCitations, 0)
  };
}

function reportCatalog(catalog) {
  return {
    documentCount: catalog.documentCount,
    words: catalog.words,
    citations: catalog.citations,
    providerCitations: catalog.providerCitations,
    documents: catalog.documents.map(({ body: _body, ...document }) => document)
  };
}

function transcriptMetrics(text) {
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, turns: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "turn.completed" || !event.usage) continue;
      usage.turns += 1;
      usage.inputTokens += event.usage.input_tokens ?? 0;
      usage.cachedInputTokens += event.usage.cached_input_tokens ?? 0;
      usage.outputTokens += event.usage.output_tokens ?? 0;
    } catch {
      // Diagnostic lines are not necessarily JSON events.
    }
  }
  const timestamps = [...text.matchAll(/^(\d{4}-\d\d-\d\dT[^\s]+Z)/gm)].map((match) => Date.parse(match[1]));
  return {
    usage,
    observedDurationSeconds:
      timestamps.length < 2 ? undefined : Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1_000),
    collaborationCalls: (text.match(/"type":"collab_tool_call"/g) ?? []).length,
    collaborationFailures: (text.match(/collab spawn failed/g) ?? []).length
  };
}

async function pageIndexNodes(documents, checkpoint, generationId) {
  const workerPath = process.env.CONTEXT_PAGEINDEX_WORKER?.trim();
  if (!workerPath) return undefined;
  const client = new LocalPageIndexClient({
    python: process.env.CONTEXT_PAGEINDEX_PYTHON,
    workerPath,
    timeoutMs: 30_000
  });
  const probe = await client.probe();
  if (!probe.available) return { available: false, reason: probe.reason };
  const result = await client.build(
    {
      tenantId: checkpoint.tenantId,
      repository: checkpoint.repository,
      ref: checkpoint.ref,
      commitSha: checkpoint.commitSha,
      generationId,
      adapterVersion: "comparison",
      documents: documents.map((document) => ({
        id: document.path,
        title: document.title,
        body: document.body,
        anchors: [],
        aclFingerprint: checkpoint.aclFingerprint
      })),
      limits: { timeoutMs: 30_000, maxDocumentCharacters: 1_000_000, maxNodes: 10_000 }
    },
    AbortSignal.timeout(30_000)
  );
  return {
    available: true,
    adapter: `${result.adapterName}@${result.adapterVersion}`,
    nodes: result.nodes.length,
    roots: result.nodes.filter((node) => node.parentExternalId === undefined).length
  };
}

const serializedEvidence = await json(join(baselineDirectory, "derive-input/evidence.json"));
const manifest = await json(join(baselineDirectory, "derive-input/repository-manifest.json"));
const prior = await json(join(baselineDirectory, "derive-input/prior-knowledge.json"));
assert.equal(prior.length, 0, "comparison currently requires a full-initialization baseline");
const bundle = restoreBundle(serializedEvidence);
const baselineOutput = join(baselineDirectory, "derive-output");
const baselineCatalog = await catalogMetrics(baselineOutput);
const baselineTranscript = transcriptMetrics(await readFile(join(baselineDirectory, "transcript.log"), "utf8"));

const checkoutRoot = await mkdtemp(join(tmpdir(), "jina-orchestration-comparison-"));
const checkout = join(checkoutRoot, "repository");
let retainedDirectory;
const originalWarn = console.warn;
console.warn = (...values) => {
  if (values[0] === "knowledge_local_run_kept" && values[1]?.directory) retainedDirectory = values[1].directory;
  originalWarn(...values);
};

const progress = [];
const startedAt = Date.now();
let output;
try {
  await execFileAsync("git", ["clone", "--no-hardlinks", process.cwd(), checkout], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  await execFileAsync("git", ["-C", checkout, "checkout", "--detach", bundle.checkpoint.commitSha], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  output = await new LocalCodexKnowledgeDocumentGenerator().generate({
    prompt: buildKnowledgeFilePrompt(bundle, [], [`push:${bundle.checkpoint.commitSha}`]),
    bundle,
    repairErrors: [],
    budgetSeconds: Number(process.env.CONTEXT_COMPARISON_BUDGET_SECONDS ?? 1_200),
    workspace: {
      repositoryDirectory: checkout,
      manifest,
      priorKnowledge: [],
      resumedPages: []
    },
    onOrchestrationProgress: async (state) => {
      progress.push({
        observedAtSeconds: Math.round((Date.now() - startedAt) / 1_000),
        phase: state.phase,
        completeItems: state.items.filter((item) => item.status === "complete").length,
        terminalWorkers: state.workers.filter((worker) => ["complete", "failed"].includes(worker.status)).length,
        openBlockingGaps: state.gaps.filter((gap) => gap.severity === "blocking" && gap.status === "open").length
      });
    }
  });
} finally {
  console.warn = originalWarn;
  await rm(checkoutRoot, { recursive: true, force: true });
}

assert.ok(output?.orchestration, "orchestrated generation did not produce a valid plan");
const newDocuments = output.documents.map((document) => ({
  path:
    output.orchestration.items.find((item) => document.logicalId.endsWith(`:${documentPathFromFile(item.path)}`))
      ?.path ?? document.logicalId,
  title: document.title,
  body: document.bodyMarkdown,
  words: wordCount(document.bodyMarkdown),
  citations: document.citations.length,
  providerCitations: document.citations.filter((citation) =>
    ["issue", "pull_request", "observation", "document"].includes(citation.sourceType)
  ).length
}));
const newCatalog = {
  documents: newDocuments,
  documentCount: newDocuments.length,
  words: newDocuments.reduce((sum, document) => sum + document.words, 0),
  citations: newDocuments.reduce((sum, document) => sum + document.citations, 0),
  providerCitations: newDocuments.reduce((sum, document) => sum + document.providerCitations, 0)
};
const newTranscript =
  retainedDirectory === undefined
    ? undefined
    : transcriptMetrics(await readFile(join(retainedDirectory, "derive-state/transcript.log"), "utf8"));

const baselinePaths = new Set(baselineCatalog.documents.map((document) => document.path));
const newPaths = new Set(
  output.orchestration.items.filter((item) => item.status === "complete").map((item) => item.path)
);
const sharedPaths = [...newPaths].filter((path) => baselinePaths.has(path));
const expectedAreas = output.orchestration.areas.length;
const coveredAreas = output.orchestration.areas.filter((area) => area.status === "covered").length;
const requiredItems = output.orchestration.items.filter((item) => item.priority === "required");

const report = {
  repository: bundle.checkpoint.repository,
  checkpoint: bundle.checkpoint.commitSha,
  sameInput: {
    evidenceRecords: bundle.items.length,
    manifestEntries: manifest.length,
    selectorVersion: bundle.selectorVersion,
    sourceCompleteness: bundle.checkpoint.sourceCompleteness
  },
  baseline: {
    generator: "single-agent-v2",
    ...reportCatalog(baselineCatalog),
    transcript: baselineTranscript,
    pageIndex: await pageIndexNodes(baselineCatalog.documents, bundle.checkpoint, "baseline")
  },
  orchestrated: {
    generator: "agent-first-v9",
    durationSeconds: Math.round((Date.now() - startedAt) / 1_000),
    retainedDirectory,
    phase: output.orchestration.phase,
    completionReason: output.orchestration.completionReason,
    ...reportCatalog(newCatalog),
    plan: {
      subjects: output.orchestration.subjects.length,
      subjectKinds: [...new Set(output.orchestration.subjects.map((subject) => subject.kind))].sort(),
      historySignals: output.orchestration.subjects
        .flatMap((subject) => subject.signals)
        .filter((signal) => ["commit", "pull_request", "issue", "observation"].includes(signal.source)).length,
      items: output.orchestration.items.length,
      requiredResolved: requiredItems.filter((item) => ["complete", "unsupported"].includes(item.status)).length,
      requiredTotal: requiredItems.length,
      questionsAnswered: output.orchestration.subjects
        .flatMap((subject) => subject.questions)
        .filter((question) => ["answered", "unsupported"].includes(question.status)).length,
      questionsTotal: output.orchestration.subjects.flatMap((subject) => subject.questions).length,
      reviews: output.orchestration.reviews,
      areasCovered: coveredAreas,
      areasTotal: expectedAreas,
      workers: output.orchestration.workers,
      gaps: output.orchestration.gaps,
      checkpointsObserved: progress
    },
    transcript: newTranscript,
    pageIndex: await pageIndexNodes(newCatalog.documents, bundle.checkpoint, "orchestrated")
  },
  pathComparison: {
    shared: sharedPaths.sort(),
    baselineOnly: [...baselinePaths].filter((path) => !newPaths.has(path)).sort(),
    orchestratedOnly: [...newPaths].filter((path) => !baselinePaths.has(path)).sort()
  }
};

const reportPath = process.env.CONTEXT_COMPARISON_REPORT?.trim();
if (reportPath) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
