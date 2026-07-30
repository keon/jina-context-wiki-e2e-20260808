#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import {
  DeriveKnowledgeService,
  EvidenceFocusSelector,
  IngestEvidenceService,
  KnowledgeOutputValidator,
  LocalPageIndexClient,
  MemoryContextEngineStore,
  buildKnowledgeFilePrompt,
  buildKnowledgeRepairPrompt,
  parseContextOrchestrationState,
  repositoryAclFingerprint,
  selectPriorKnowledge
} from "../packages/context-engine/dist/index.js";
import { LocalCodexKnowledgeDocumentGenerator } from "../packages/daytona/dist/index.js";

const execFileAsync = promisify(execFile);
const targetRepository = process.env.CONTEXT_TARGET_REPO?.trim();
const providerEvidencePath = process.env.CONTEXT_PROVIDER_EVIDENCE?.trim();
const resumeDirectory = process.env.CONTEXT_RESUME_DERIVE_DIR?.trim();
const resumePlanDirectory = process.env.CONTEXT_RESUME_PLAN_DIR?.trim() || resumeDirectory;
assert.ok(targetRepository, "CONTEXT_TARGET_REPO must name a pinned local repository snapshot");
assert.ok(process.env.CONTEXT_PAGEINDEX_WORKER, "CONTEXT_PAGEINDEX_WORKER must name the local PageIndex worker");

const REPOSITORY = process.env.CONTEXT_REPOSITORY?.trim() || "omxyz/jina";
const TENANT =
  process.env.CONTEXT_TENANT?.trim() || `tenant-${REPOSITORY.replace(/[^a-z0-9]+/gi, "-")}-goal-evaluation`;
const REF = process.env.CONTEXT_REF?.trim() || "main";
const CREATED_AT = "2026-07-29T17:00:00.000Z";

process.env.CONTEXT_DERIVE_DOCUMENT_FILES = "true";
process.env.CONTEXT_CODEX_MODEL = process.env.CONTEXT_CODEX_MODEL?.trim() || "gpt-5.6-terra";
process.env.CONTEXT_CODEX_EFFORT = process.env.CONTEXT_CODEX_EFFORT?.trim() || "low";
process.env.CONTEXT_CODEX_AUTH = process.env.CONTEXT_CODEX_AUTH?.trim() || "session";
process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS =
  process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS?.trim() || "5";
process.env.CONTEXT_DERIVE_VERIFICATION_PASSES = process.env.CONTEXT_DERIVE_VERIFICATION_PASSES?.trim() || "3";
process.env.JINA_KEEP_DERIVE_DIR = "true";

async function git(args) {
  const { stdout } = await execFileAsync("git", ["-C", targetRepository, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout.trim();
}

async function filesAt(commitSha) {
  const paths = (await git(["ls-tree", "-r", "--name-only", commitSha])).split("\n").filter(Boolean);
  return Promise.all(
    paths.map(async (path) => ({
      path,
      blobSha: await git(["rev-parse", `${commitSha}:${path}`]),
      body: await git(["show", `${commitSha}:${path}`]),
      language: path.endsWith(".ts") || path.endsWith(".tsx") ? "typescript" : undefined
    }))
  );
}

async function commitMetadata(sha) {
  const [treeSha, parentLine, author, authoredAt, committedAt, message] = await Promise.all([
    git(["show", "-s", "--format=%T", sha]),
    git(["show", "-s", "--format=%P", sha]),
    git(["show", "-s", "--format=%an", sha]),
    git(["show", "-s", "--format=%aI", sha]),
    git(["show", "-s", "--format=%cI", sha]),
    git(["show", "-s", "--format=%B", sha])
  ]);
  return {
    treeSha,
    parentShas: parentLine ? parentLine.split(" ") : [],
    author,
    authoredAt,
    committedAt,
    message
  };
}

async function gitSnapshot(commitSha) {
  const commit = await commitMetadata(commitSha);
  const currentFiles = new Map((await filesAt(commitSha)).map((file) => [file.path, file.blobSha]));
  const priorFiles =
    commit.parentShas.length === 0
      ? new Map()
      : new Map((await filesAt(commit.parentShas[0])).map((file) => [file.path, file.blobSha]));
  const changes = [...new Set([...currentFiles.keys(), ...priorFiles.keys()])].sort().flatMap((path) => {
    const oldBlobSha = priorFiles.get(path);
    const newBlobSha = currentFiles.get(path);
    if (oldBlobSha === newBlobSha) return [];
    if (oldBlobSha === undefined) return [{ kind: "add", path, newBlobSha }];
    if (newBlobSha === undefined) return [{ kind: "delete", path, oldBlobSha }];
    return [{ kind: "modify", path, oldBlobSha, newBlobSha }];
  });
  const historyShas = (await git(["rev-list", "--max-count=50", commitSha])).split("\n").filter(Boolean);
  const history = await Promise.all(
    historyShas.map(async (sha) => ({
      sha,
      ...(await commitMetadata(sha))
    }))
  );
  return { commit, changes, history };
}

async function providerObservations() {
  if (!providerEvidencePath) return [];
  const serialized = JSON.parse(await readFile(providerEvidencePath, "utf8"));
  return serialized.evidence.flatMap((item) => {
    if (item.sourceType !== "observation" && item.sourceType !== "pull_request" && item.sourceType !== "issue") {
      return [];
    }
    try {
      const payload = JSON.parse(item.body);
      return [
        {
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          title: item.title,
          pathOrUrl: item.pathOrUrl,
          observedAt: payload.updated_at ?? payload.created_at ?? CREATED_AT,
          payload
        }
      ];
    } catch {
      return [];
    }
  });
}

function wordCount(body) {
  return body.trim() ? body.trim().split(/\s+/).length : 0;
}

async function pagesFromRunDirectory(directory) {
  if (!directory) return [];
  const root = join(directory, "derive-output");
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  }
  await walk(root);
  return Promise.all(
    files.sort().map(async (path) => {
      const bodyMarkdown = await readFile(path, "utf8");
      return {
        documentPath: relative(root, path).replace(/\.md$/, ""),
        title: /^#\s+(.+)$/m.exec(bodyMarkdown)?.[1]?.trim() ?? relative(root, path),
        bodyMarkdown
      };
    })
  );
}

async function resumedOrchestration() {
  if (!resumePlanDirectory) return undefined;
  try {
    const raw = JSON.parse(await readFile(join(resumePlanDirectory, "derive-state", "plan.json"), "utf8"));
    return parseContextOrchestrationState(raw, {
      repository: REPOSITORY,
      ref: REF,
      commitSha
    });
  } catch (error) {
    console.warn("goal_evaluation_resume_plan_ignored", {
      directory: resumePlanDirectory,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

const commitSha = await git(["rev-parse", "HEAD"]);
const store = new MemoryContextEngineStore();
const observations = await providerObservations();
const checkpoint = await new IngestEvidenceService(store).ingest({
  tenantId: TENANT,
  repository: REPOSITORY,
  ref: REF,
  refSequence: 1,
  commitSha,
  files: await filesAt(commitSha),
  observations,
  aclFingerprint: repositoryAclFingerprint(TENANT, REPOSITORY),
  observationFrontier: JSON.stringify({
    source: providerEvidencePath ? "retained-provider-evidence" : "git-only-evaluation",
    records: observations.length
  }),
  createdAt: CREATED_AT,
  sourceComplete: true,
  git: await gitSnapshot(commitSha)
});
const selector = new EvidenceFocusSelector(store);
const bundle = await selector.select(checkpoint.id);
const manifest = await store.listManifest(checkpoint.id);
const generator = new LocalCodexKnowledgeDocumentGenerator();
const basePrompt = buildKnowledgeFilePrompt(bundle, [], [`push:${commitSha}`]);
const deadline = Date.now() + Number(process.env.CONTEXT_GOAL_BUDGET_SECONDS ?? 1_800) * 1_000;
const initialResumedPages = await pagesFromRunDirectory(resumeDirectory);
const initialResumedOrchestration = await resumedOrchestration();
let retainedDirectory;
let output;
let committed;
let diagnostics = [];
const originalWarn = console.warn;
console.warn = (...values) => {
  if (values[0] === "knowledge_local_run_kept" && values[1]?.directory) retainedDirectory = values[1].directory;
  originalWarn(...values);
};
try {
  const maximumAttempts = Number(process.env.CONTEXT_GOAL_ATTEMPTS ?? 3);
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const remainingSeconds = Math.floor((deadline - Date.now()) / 1_000);
    if (remainingSeconds < 60) break;
    const resumedPages = attempt === 0 ? initialResumedPages : await pagesFromRunDirectory(retainedDirectory);
    const workspace = {
      repositoryDirectory: targetRepository,
      manifest,
      priorKnowledge: await selectPriorKnowledge(store, checkpoint),
      resumedPages,
      ...(attempt === 0 && initialResumedOrchestration
        ? { resumedOrchestration: initialResumedOrchestration }
        : attempt > 0 && output?.orchestration
          ? { resumedOrchestration: output.orchestration }
          : {})
    };
    output = await generator.generate({
      prompt: attempt === 0 ? basePrompt : buildKnowledgeRepairPrompt(basePrompt, diagnostics),
      bundle,
      repairErrors: diagnostics,
      budgetSeconds: remainingSeconds,
      workspace
    });
    committed = await new DeriveKnowledgeService(
      selector,
      {
        name: generator.name,
        version: `${generator.version}-goal-attempt-${attempt + 1}`,
        model: generator.model,
        async generate() {
          return output;
        }
      },
      store,
      new KnowledgeOutputValidator(store)
    ).derive(checkpoint.id, checkpoint.createdAt, undefined, 1);
    if (committed.status === "succeeded" && output.orchestration?.phase === "complete") break;
    diagnostics =
      committed.status === "failed"
        ? committed.diagnostics
        : [
            `The durable orchestration remains ${output.orchestration?.phase ?? "missing"}.`,
            output.orchestration?.completionReason ?? "No completion reason was recorded.",
            ...(output.orchestration?.gaps
              .filter((gap) => gap.status === "open")
              .map((gap) => `${gap.severity} gap ${gap.id}: ${gap.description}`) ?? [])
          ];
  }
} finally {
  console.warn = originalWarn;
}

assert.ok(output, "goal-driven derivation produced no output");
assert.ok(committed, "goal-driven derivation produced no committed run");
const pageIndex = new LocalPageIndexClient({
  python: process.env.CONTEXT_PAGEINDEX_PYTHON,
  workerPath: process.env.CONTEXT_PAGEINDEX_WORKER,
  timeoutMs: 60_000
});
const probe = await pageIndex.probe();
assert.equal(probe.available, true, probe.reason);
const tree = await pageIndex.build(
  {
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: REF,
    commitSha,
    generationId: "goal-driven-current-worktree",
    adapterVersion: "goal-evaluation",
    documents: output.documents.map((document) => ({
      id: document.logicalId,
      title: document.title,
      body: document.bodyMarkdown,
      anchors: [],
      aclFingerprint: checkpoint.aclFingerprint
    })),
    limits: { timeoutMs: 60_000, maxDocumentCharacters: 1_000_000, maxNodes: 20_000 }
  },
  AbortSignal.timeout(60_000)
);
const orchestration = output.orchestration;
const maintenanceQuestions = orchestration?.subjects.flatMap((subject) => subject.questions) ?? [];
const report = {
  repository: REPOSITORY,
  checkpoint: commitSha,
  targetRepository,
  retainedDirectory,
  model: generator.model,
  input: {
    manifestEntries: manifest.length,
    evidenceRecords: bundle.items.length,
    providerObservations: observations.length,
    sourceCompleteness: checkpoint.sourceCompleteness
  },
  derivation: {
    status: committed.status,
    diagnostics: committed.diagnostics,
    documents: output.documents.length,
    words: output.documents.reduce((sum, document) => sum + wordCount(document.bodyMarkdown), 0),
    citations: output.documents.reduce((sum, document) => sum + document.citations.length, 0),
    providerCitations: output.documents.reduce(
      (sum, document) =>
        sum +
        document.citations.filter((citation) =>
          ["issue", "pull_request", "observation", "document"].includes(citation.sourceType)
        ).length,
      0
    ),
    paths: output.documents.map((document) => `${document.logicalId.split(":").slice(2).join(":")}.md`).sort()
  },
  orchestration: orchestration
    ? {
        phase: orchestration.phase,
        completionReason: orchestration.completionReason,
        subjects: orchestration.subjects.length,
        subjectKinds: [...new Set(orchestration.subjects.map((subject) => subject.kind))].sort(),
        historySignals: orchestration.subjects
          .flatMap((subject) => subject.signals)
          .filter((signal) => ["commit", "pull_request", "issue", "observation"].includes(signal.source)).length,
        requiredResolved: orchestration.items.filter(
          (item) => item.priority === "required" && ["complete", "unsupported"].includes(item.status)
        ).length,
        requiredTotal: orchestration.items.filter((item) => item.priority === "required").length,
        questionsAnswered: maintenanceQuestions.filter((question) =>
          ["answered", "unsupported"].includes(question.status)
        ).length,
        questionsTotal: maintenanceQuestions.length,
        requiredQuestionsAnswered: maintenanceQuestions.filter(
          (question) => question.priority === "required" && ["answered", "unsupported"].includes(question.status)
        ).length,
        requiredQuestionsTotal: maintenanceQuestions.filter((question) => question.priority === "required").length,
        reviewsComplete: orchestration.reviews.filter((review) => review.status === "complete").length,
        reviewsTotal: orchestration.reviews.length,
        areasCovered: orchestration.areas.filter((area) => area.status === "covered").length,
        areasTotal: orchestration.areas.length,
        workers: orchestration.workers,
        gaps: orchestration.gaps
      }
    : undefined,
  pageIndex: {
    adapter: `${tree.adapterName}@${tree.adapterVersion}`,
    nodes: tree.nodes.length,
    roots: tree.nodes.filter((node) => node.parentExternalId === undefined).length
  }
};
const reportPath = process.env.CONTEXT_GOAL_REPORT?.trim();
if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
