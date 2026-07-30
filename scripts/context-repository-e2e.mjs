#!/usr/bin/env node

import { readFile, readdir, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DeriveKnowledgeService,
  EvidenceFocusSelector,
  IndexContextService,
  IngestEvidenceService,
  KnowledgeOutputValidator,
  LocalPageIndexClient,
  MemoryContextEngineStore,
  PageIndexHierarchyAdapter,
  buildKnowledgeFilePrompt,
  buildKnowledgeRepairPrompt,
  documentPathFromFile,
  parseContextOrchestrationState,
  repositoryAclFingerprint,
  selectPriorKnowledge
} from "../packages/context-engine/dist/index.js";
import { LocalCodexKnowledgeDocumentGenerator } from "../packages/daytona/dist/index.js";
import { analyzeContextQuality } from "./context-quality-benchmark.mjs";
import {
  collectRepositoryInput,
  createPinnedRepositoryCheckout,
  resolveRepositoryHead
} from "./context-repository-input.mjs";
import {
  agentStageDirectoryForAttempt,
  allocateAttemptBudget,
  withScopedAgentStageResume
} from "./context-repository-run-control.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIRECTORY = dirname(SCRIPT_DIRECTORY);
const SCHEMA_VERSION = "context-repository-e2e-v1";

function usage() {
  return `Usage:
  pnpm evaluate:context-repository -- --repo-dir PATH --repository OWNER/NAME [options]
  node scripts/context-repository-e2e.mjs PATH OWNER/NAME [options]

Required:
  --repo-dir PATH              Local Git worktree; immutable input is exact HEAD.
  --repository OWNER/NAME      Canonical repository identity used by Context.

Options:
  --ref NAME                   Context ref name (default: main).
  --history-limit N            Commit records to ingest, 1-500 (default: 50).
  --max-file-bytes N           Maximum text blob size (default: 2097152).
  --budget-seconds N           Total Codex wall-clock budget (default: 3600).
  --attempts N                 Complete/repair attempts, 1-5 (default: 2).
  --first-attempt-share N      Initial budget share, 0.5-0.9 (default: 0.7).
  --model NAME                 Codex model (default: gpt-5.6-terra).
  --effort LEVEL               Codex reasoning effort (default: low).
  --auth session|api-key       Codex authentication source (default: session).
  --provider-evidence PATH     Optional retained evidence.json with issues/PRs.
  --resume-run PATH            Resume private stages/pages from a retained run.
  --pageindex-worker PATH      Self-hosted PageIndex worker.py.
  --pageindex-python PATH      Python executable for the worker.
  --pageindex-source-root PATH Pinned VectifyAI/PageIndex checkout.
  --report PATH                Also write the JSON report to this path.
  --help                       Show this help.

Environment equivalents use CONTEXT_TARGET_REPO, CONTEXT_REPOSITORY,
CONTEXT_REF, CONTEXT_HISTORY_LIMIT, CONTEXT_MAX_FILE_BYTES,
CONTEXT_REPOSITORY_BUDGET_SECONDS, CONTEXT_REPOSITORY_ATTEMPTS,
CONTEXT_REPOSITORY_FIRST_ATTEMPT_SHARE, CONTEXT_CODEX_MODEL,
CONTEXT_CODEX_EFFORT, CONTEXT_CODEX_AUTH,
CONTEXT_PROVIDER_EVIDENCE, CONTEXT_RESUME_DERIVE_DIR,
CONTEXT_PAGEINDEX_WORKER,
CONTEXT_PAGEINDEX_PYTHON, PAGEINDEX_SOURCE_ROOT, and
CONTEXT_REPOSITORY_REPORT.
`;
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function number(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeRepository(value) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) {
    throw new Error("repository must have the form owner/name");
  }
  return normalized;
}

function optionValue(args, index, inlineValue, name) {
  if (inlineValue !== undefined) return { value: inlineValue, consumed: 0 };
  if (args[index + 1] === undefined) throw new Error(`${name} requires a value`);
  return { value: args[index + 1], consumed: 1 };
}

export function parseRepositoryHarnessArguments(args, environment = process.env) {
  const values = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    // pnpm forwards its conventional option separator to scripts in some
    // versions. It separates the package command from harness arguments; it is
    // not itself a harness option.
    if (argument === "--") continue;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    if (name === "--help") {
      values.help = true;
      continue;
    }
    const supported = new Map([
      ["--repo-dir", "repositoryDirectory"],
      ["--repository", "repository"],
      ["--ref", "ref"],
      ["--history-limit", "historyLimit"],
      ["--max-file-bytes", "maxFileBytes"],
      ["--budget-seconds", "budgetSeconds"],
      ["--attempts", "attempts"],
      ["--first-attempt-share", "firstAttemptShare"],
      ["--model", "model"],
      ["--effort", "effort"],
      ["--auth", "auth"],
      ["--provider-evidence", "providerEvidencePath"],
      ["--resume-run", "resumeRunDirectory"],
      ["--pageindex-worker", "pageIndexWorker"],
      ["--pageindex-python", "pageIndexPython"],
      ["--pageindex-source-root", "pageIndexSourceRoot"],
      ["--report", "reportPath"]
    ]);
    const key = supported.get(name);
    if (!key) throw new Error(`Unknown option: ${name}`);
    const resolved = optionValue(args, index, inlineValue, name);
    values[key] = resolved.value;
    index += resolved.consumed;
  }

  const repositoryDirectory = values.repositoryDirectory ?? positional[0] ?? environment.CONTEXT_TARGET_REPO;
  const repository = values.repository ?? positional[1] ?? environment.CONTEXT_REPOSITORY;
  if (!values.help && !repositoryDirectory) throw new Error("--repo-dir is required");
  if (!values.help && !repository) throw new Error("--repository is required");
  const auth = values.auth ?? environment.CONTEXT_CODEX_AUTH ?? "session";
  if (!["session", "api-key"].includes(auth)) throw new Error("--auth must be session or api-key");
  const budgetSeconds = integer(
    values.budgetSeconds ?? environment.CONTEXT_REPOSITORY_BUDGET_SECONDS ?? "3600",
    "budget seconds",
    60,
    86_400
  );
  const attempts = integer(values.attempts ?? environment.CONTEXT_REPOSITORY_ATTEMPTS ?? "2", "attempts", 1, 5);
  if (budgetSeconds < attempts * 60) {
    throw new Error("budget seconds must reserve at least 60 seconds for every attempt");
  }
  return {
    help: values.help === true,
    repositoryDirectory,
    repository: repository ? normalizeRepository(repository) : undefined,
    ref: values.ref ?? environment.CONTEXT_REF ?? "main",
    historyLimit: integer(values.historyLimit ?? environment.CONTEXT_HISTORY_LIMIT ?? "50", "history limit", 1, 500),
    maxFileBytes: integer(
      values.maxFileBytes ?? environment.CONTEXT_MAX_FILE_BYTES ?? String(2 * 1024 * 1024),
      "max file bytes",
      1,
      Number.MAX_SAFE_INTEGER
    ),
    budgetSeconds,
    attempts,
    firstAttemptShare: number(
      values.firstAttemptShare ?? environment.CONTEXT_REPOSITORY_FIRST_ATTEMPT_SHARE ?? "0.7",
      "first attempt share",
      0.5,
      0.9
    ),
    model: values.model ?? environment.CONTEXT_CODEX_MODEL ?? "gpt-5.6-terra",
    effort: values.effort ?? environment.CONTEXT_CODEX_EFFORT ?? "low",
    auth,
    providerEvidencePath: values.providerEvidencePath ?? environment.CONTEXT_PROVIDER_EVIDENCE,
    resumeRunDirectory: values.resumeRunDirectory ?? environment.CONTEXT_RESUME_DERIVE_DIR,
    pageIndexWorker:
      values.pageIndexWorker ??
      environment.CONTEXT_PAGEINDEX_WORKER ??
      join(WORKSPACE_DIRECTORY, "services/pageindex-worker/worker.py"),
    pageIndexPython: values.pageIndexPython ?? environment.CONTEXT_PAGEINDEX_PYTHON ?? "python3",
    pageIndexSourceRoot: values.pageIndexSourceRoot ?? environment.PAGEINDEX_SOURCE_ROOT,
    reportPath: values.reportPath ?? environment.CONTEXT_REPOSITORY_REPORT
  };
}

function restoreNumberedBody(body) {
  return body
    .split("\n")
    .map((line) => line.replace(/^\d+\|/, ""))
    .join("\n");
}

async function providerObservations(path, createdAt) {
  if (!path) return [];
  const serialized = JSON.parse(await readFile(path, "utf8"));
  const items = Array.isArray(serialized) ? serialized : (serialized.evidence ?? serialized.observations ?? []);
  if (!Array.isArray(items)) throw new Error("provider evidence must be an array or contain evidence/observations");
  return items.flatMap((item) => {
    const sourceType = item.sourceType ?? item.anchor?.sourceType;
    if (!["observation", "pull_request", "issue", "document"].includes(sourceType)) return [];
    const body =
      typeof item.body === "string"
        ? item.body
        : typeof item.numberedBody === "string"
          ? restoreNumberedBody(item.numberedBody)
          : undefined;
    let payload = item.payload;
    if (payload === undefined && body !== undefined) {
      try {
        payload = JSON.parse(body);
      } catch {
        payload = body;
      }
    }
    const sourceId = item.sourceId ?? item.anchor?.sourceId;
    if (typeof sourceId !== "string" || !sourceId.trim()) return [];
    const pathOrUrl = item.pathOrUrl ?? item.anchor?.pathOrUrl;
    const observedAt =
      item.observedAt ??
      item.anchor?.observedAt ??
      (payload && typeof payload === "object" ? (payload.updated_at ?? payload.created_at) : undefined) ??
      createdAt;
    return [
      {
        sourceType,
        sourceId,
        title: typeof item.title === "string" && item.title.trim() ? item.title : sourceId,
        payload: payload ?? "",
        ...(typeof pathOrUrl === "string" ? { pathOrUrl } : {}),
        observedAt,
        ...(item.authorityClass ? { authorityClass: item.authorityClass } : {}),
        ...(item.metadata && typeof item.metadata === "object" ? { metadata: item.metadata } : {})
      }
    ];
  });
}

async function pagesFromRunDirectory(directory) {
  if (!directory) return [];
  const root = join(directory, "derive-output");
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith(".")) files.push(path);
    }
  }
  await walk(root);
  return Promise.all(
    files.sort().map(async (path) => {
      const bodyMarkdown = await readFile(path, "utf8");
      return {
        documentPath: relative(root, path).replaceAll("\\", "/").replace(/\.md$/, ""),
        title: /^#\s+(.+)$/m.exec(bodyMarkdown)?.[1]?.trim() ?? relative(root, path),
        bodyMarkdown
      };
    })
  );
}

async function orchestrationFromRun(directory, repository, ref, commitSha) {
  if (!directory) return undefined;
  try {
    const value = JSON.parse(await readFile(join(directory, "derive-state", "plan.json"), "utf8"));
    return parseContextOrchestrationState(value, { repository, ref, commitSha });
  } catch {
    return undefined;
  }
}

function wordCount(body) {
  return body.trim() ? body.trim().split(/\s+/).length : 0;
}

function orchestrationMetrics(orchestration, runDirectory) {
  const questions = orchestration.subjects.flatMap((subject) => subject.questions);
  const completedReviews = orchestration.reviews.filter((review) => review.status === "complete");
  const latestResult = new Map(
    completedReviews.flatMap((review) => review.results.map((result) => [result.questionId, result]))
  );
  return {
    planPath: join(runDirectory, "derive-state", "plan.json"),
    phase: orchestration.phase,
    mode: orchestration.mode,
    completionReason: orchestration.completionReason,
    subjects: {
      total: orchestration.subjects.length,
      required: orchestration.subjects.filter((subject) => subject.priority === "required").length,
      covered: orchestration.subjects.filter((subject) => subject.status === "covered").length,
      kinds: [...new Set(orchestration.subjects.map((subject) => subject.kind))].sort(),
      historySignals: orchestration.subjects
        .flatMap((subject) => subject.signals)
        .filter((signal) => ["commit", "pull_request", "issue", "observation"].includes(signal.source)).length
    },
    pages: {
      total: orchestration.items.length,
      complete: orchestration.items.filter((item) => item.status === "complete").length,
      required: orchestration.items.filter((item) => item.priority === "required").length
    },
    questions: {
      total: questions.length,
      required: questions.filter((question) => question.priority === "required").length,
      answered: questions.filter((question) => question.status === "answered").length,
      latestPasses: questions.filter((question) => latestResult.get(question.id)?.verdict === "pass").length
    },
    workers: orchestration.workers,
    reviews: {
      total: orchestration.reviews.length,
      complete: completedReviews.length,
      results: completedReviews.reduce((sum, review) => sum + review.results.length, 0),
      passingResults: completedReviews.reduce(
        (sum, review) => sum + review.results.filter((result) => result.verdict === "pass").length,
        0
      )
    },
    areas: {
      total: orchestration.areas.length,
      covered: orchestration.areas.filter((area) => area.status === "covered").length
    },
    gaps: orchestration.gaps
  };
}

function outputPath(document, orchestration) {
  return (
    orchestration.items.find((item) => document.logicalId.endsWith(`:${documentPathFromFile(item.path)}`))?.path ??
    document.logicalId
  );
}

async function emitReport(report, reportPath) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    const destination = resolve(reportPath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, serialized);
  }
  process.stdout.write(serialized);
}

class HarnessFailure extends Error {
  constructor(message, report) {
    super(message);
    this.report = report;
  }
}

export async function runRepositoryHarness(options) {
  const startedAt = new Date().toISOString();
  const state = {
    repository: options.repository,
    ref: options.ref,
    sourceRepository: resolve(options.repositoryDirectory),
    commitSha: undefined,
    runDirectories: [],
    attempts: [],
    quality: undefined
  };
  let checkout;
  const originalWarn = console.warn;
  console.warn = (...values) => {
    if (values[0] === "knowledge_local_run_kept" && values[1]?.directory) {
      state.runDirectories.push(values[1].directory);
    }
    originalWarn(...values);
  };
  try {
    const repositoryDirectory = await realpath(options.repositoryDirectory);
    const commitSha = await resolveRepositoryHead(repositoryDirectory);
    state.sourceRepository = repositoryDirectory;
    state.commitSha = commitSha;
    const collectedInput = await collectRepositoryInput({
      repositoryDirectory,
      commitSha,
      historyLimit: options.historyLimit,
      maxFileBytes: options.maxFileBytes
    });
    checkout = await createPinnedRepositoryCheckout(repositoryDirectory, commitSha);
    const createdAt = new Date().toISOString();
    const observations = await providerObservations(options.providerEvidencePath, createdAt);
    const tenantId = `sample-${options.repository.replace(/[^a-z0-9]+/gi, "-")}`;
    const store = new MemoryContextEngineStore();
    const checkpoint = await new IngestEvidenceService(store).ingest({
      tenantId,
      repository: options.repository,
      ref: options.ref,
      refSequence: 1,
      commitSha,
      files: collectedInput.files,
      observations,
      aclFingerprint: repositoryAclFingerprint(tenantId, options.repository),
      observationFrontier: JSON.stringify({
        source: options.providerEvidencePath ? "retained-provider-evidence" : "git-only",
        records: observations.length,
        historyLimit: options.historyLimit
      }),
      createdAt,
      sourceComplete: true,
      git: collectedInput.git
    });
    const selector = new EvidenceFocusSelector(store);
    const bundle = await selector.select(checkpoint.id);
    const manifest = await store.listManifest(checkpoint.id);
    const deadline = Date.now() + options.budgetSeconds * 1000;
    const initialResumeDirectory = options.resumeRunDirectory ? await realpath(options.resumeRunDirectory) : undefined;
    let diagnostics = [];
    let output;
    let committed;
    let finalRunDirectory;

    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      const remainingSeconds = Math.floor((deadline - Date.now()) / 1000);
      if (remainingSeconds < 60) {
        diagnostics = [`Total derivation budget exhausted before attempt ${attempt}.`];
        break;
      }
      const attemptBudgetSeconds = allocateAttemptBudget({
        attempt,
        totalAttempts: options.attempts,
        totalBudgetSeconds: options.budgetSeconds,
        remainingSeconds,
        firstAttemptShare: options.firstAttemptShare
      });
      if (attemptBudgetSeconds < 60) {
        diagnostics = [`Total derivation budget exhausted before attempt ${attempt}.`];
        break;
      }
      const priorRunDirectory = state.runDirectories.at(-1) ?? (attempt === 1 ? initialResumeDirectory : undefined);
      const resumedAgentStageDirectory =
        attempt === 1 && priorRunDirectory
          ? join(priorRunDirectory, "derive-state", "agent-stages")
          : agentStageDirectoryForAttempt(attempt, priorRunDirectory);
      const resumedPages = await pagesFromRunDirectory(priorRunDirectory);
      const resumedOrchestration = await orchestrationFromRun(
        priorRunDirectory,
        options.repository,
        options.ref,
        commitSha
      );
      const priorKnowledge = await selectPriorKnowledge(store, checkpoint);
      const basePrompt = buildKnowledgeFilePrompt(bundle, priorKnowledge, [`push:${commitSha}`]);
      const generator = new LocalCodexKnowledgeDocumentGenerator();
      const attemptRecord = {
        attempt,
        startedAt: new Date().toISOString(),
        budgetSeconds: attemptBudgetSeconds,
        resumedPages: resumedPages.length,
        resumedAgentStageDirectory,
        status: "running"
      };
      state.attempts.push(attemptRecord);
      try {
        output = await withScopedAgentStageResume(resumedAgentStageDirectory, () =>
          generator.generate({
            prompt: attempt === 1 ? basePrompt : buildKnowledgeRepairPrompt(basePrompt, diagnostics),
            bundle,
            repairErrors: diagnostics,
            budgetSeconds: attemptBudgetSeconds,
            workspace: {
              repositoryDirectory: checkout.checkoutDirectory,
              manifest,
              priorKnowledge,
              resumedPages,
              ...(resumedOrchestration ? { resumedOrchestration } : {})
            }
          })
        );
      } catch (error) {
        attemptRecord.status = "generation_failed";
        attemptRecord.error = error instanceof Error ? error.message : String(error);
        diagnostics = [attemptRecord.error];
        continue;
      }
      finalRunDirectory = state.runDirectories.at(-1);
      if (!finalRunDirectory) {
        attemptRecord.status = "run_not_retained";
        diagnostics = ["Local Codex derivation did not report a retained run directory."];
        continue;
      }
      if (!output?.orchestration || output.orchestration.phase !== "complete") {
        attemptRecord.status = "incomplete";
        diagnostics = [
          `Orchestration is ${output?.orchestration?.phase ?? "missing"}, not complete.`,
          output?.orchestration?.completionReason ?? "No completion reason was recorded.",
          ...(output?.orchestration?.gaps
            ?.filter((gap) => gap.status === "open")
            .map((gap) => `${gap.severity} gap ${gap.id}: ${gap.description}`) ?? [])
        ];
        attemptRecord.diagnostics = diagnostics;
        continue;
      }

      const quality = await analyzeContextQuality(finalRunDirectory);
      state.quality = quality;
      if (!quality.hardContractPass) {
        attemptRecord.status = "quality_failed";
        diagnostics = quality.violations.map((violation) => `${violation.code}: ${violation.message}`);
        attemptRecord.diagnostics = diagnostics;
        continue;
      }
      try {
        await new KnowledgeOutputValidator(store).validate({
          output,
          checkpointId: checkpoint.id,
          generatorName: generator.name,
          generatorVersion: generator.version,
          model: generator.model,
          promptVersion: "context-repository-e2e-preflight",
          createdAt,
          inlineCitations: true
        });
      } catch (error) {
        attemptRecord.status = "citation_validation_failed";
        diagnostics = Array.isArray(error?.diagnostics)
          ? error.diagnostics
          : [error instanceof Error ? error.message : String(error)];
        attemptRecord.diagnostics = diagnostics;
        continue;
      }

      committed = await new DeriveKnowledgeService(
        selector,
        {
          name: generator.name,
          version: `${generator.version}-repository-harness-${attempt}`,
          model: generator.model,
          async generate() {
            return output;
          }
        },
        store,
        new KnowledgeOutputValidator(store)
      ).derive(checkpoint.id, createdAt, undefined, 1);
      if (committed.status !== "succeeded" || committed.revisionIds.length !== output.documents.length) {
        attemptRecord.status = "commit_failed";
        diagnostics =
          committed.status === "failed"
            ? committed.diagnostics
            : [`Context committed ${committed.revisionIds.length} of ${output.documents.length} generated documents.`];
        attemptRecord.diagnostics = diagnostics;
        continue;
      }
      attemptRecord.status = "passed";
      attemptRecord.documents = output.documents.length;
      break;
    }

    if (
      !output?.orchestration ||
      output.orchestration.phase !== "complete" ||
      !committed ||
      committed.status !== "succeeded" ||
      !state.quality?.hardContractPass ||
      !finalRunDirectory
    ) {
      throw new Error(diagnostics.join("; ") || "Derivation did not reach all acceptance gates.");
    }

    const pageIndex = new LocalPageIndexClient({
      python: options.pageIndexPython,
      workerPath: options.pageIndexWorker,
      timeoutMs: 60_000
    });
    const probe = await pageIndex.probe();
    if (!probe.available) throw new Error(`Self-hosted PageIndex is unavailable: ${probe.reason ?? "unknown reason"}`);
    const release = await new IndexContextService(store, new PageIndexHierarchyAdapter(pageIndex)).index(
      checkpoint.id,
      new Date().toISOString(),
      undefined,
      "complete"
    );
    if (
      release.status !== "published" ||
      release.capabilities.derivedKnowledge !== "available" ||
      release.capabilities.hierarchy !== "available"
    ) {
      throw new Error(
        `Release failed closed: status=${release.status}, derived=${release.capabilities.derivedKnowledge}, hierarchy=${release.capabilities.hierarchy}`
      );
    }
    const projection = await store.getGeneration(release.id);
    if (!projection) throw new Error(`Published release ${release.id} could not be read back`);
    if (projection.documents.length !== committed.revisionIds.length) {
      throw new Error(
        `Release contains ${projection.documents.length} documents for ${committed.revisionIds.length} committed revisions`
      );
    }

    const revisions = await store.listCheckpointRevisions(tenantId, options.repository, checkpoint.id);
    const documentMetrics = await Promise.all(
      revisions.map(async (revision) => {
        const citations = await store.listCitations(revision.id);
        return {
          logicalId: revision.logicalId,
          path: outputPath(revision, output.orchestration),
          title: revision.title,
          kind: revision.kind,
          revisionId: revision.id,
          words: wordCount(revision.bodyMarkdown),
          citations: citations.length,
          sourceCitations: citations.filter((citation) => citation.anchor.sourceType === "blob").length,
          historyCitations: citations.filter((citation) =>
            ["commit", "pull_request", "issue", "observation"].includes(citation.anchor.sourceType)
          ).length,
          distinctSourcePaths: [
            ...new Set(
              citations
                .filter((citation) => citation.anchor.sourceType === "blob")
                .map((citation) => citation.anchor.pathOrUrl)
                .filter(Boolean)
            )
          ].sort()
        };
      })
    );
    documentMetrics.sort((left, right) => left.path.localeCompare(right.path));
    const adapters = [
      ...new Set(projection.hierarchyNodes.map((node) => `${node.adapterName}@${node.adapterVersion}`))
    ];
    const finishedAt = new Date().toISOString();
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "passed",
      repository: options.repository,
      ref: options.ref,
      commitSha,
      sourceRepository: repositoryDirectory,
      retainedRunDirectory: finalRunDirectory,
      outputDirectory: join(finalRunDirectory, "derive-output"),
      allRunDirectories: state.runDirectories,
      startedAt,
      finishedAt,
      durationSeconds: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000),
      configuration: {
        model: options.model.replace(/^openai\//, ""),
        effort: options.effort,
        auth: options.auth,
        totalBudgetSeconds: options.budgetSeconds,
        maximumAttempts: options.attempts,
        firstAttemptShare: options.firstAttemptShare,
        historyLimit: options.historyLimit,
        maxFileBytes: options.maxFileBytes,
        pageIndexWorker: resolve(options.pageIndexWorker),
        pageIndexPython: options.pageIndexPython,
        pageIndexSourceRoot: options.pageIndexSourceRoot ? resolve(options.pageIndexSourceRoot) : undefined
      },
      input: {
        checkpointId: checkpoint.id,
        sourceCompleteness: checkpoint.sourceCompleteness,
        manifestEntries: manifest.length,
        contentAvailableFiles: manifest.filter((entry) => entry.contentAvailable).length,
        contentOmittedEntries: manifest.filter((entry) => !entry.contentAvailable).length,
        evidenceRecords: bundle.items.length,
        commitHistoryRecords: collectedInput.git.history.length,
        headChanges: collectedInput.git.changes.length,
        providerObservations: observations.length
      },
      derivation: {
        runId: committed.id,
        status: committed.status,
        revisionCount: committed.revisionIds.length,
        documents: documentMetrics,
        totals: {
          documents: documentMetrics.length,
          words: documentMetrics.reduce((sum, document) => sum + document.words, 0),
          citations: documentMetrics.reduce((sum, document) => sum + document.citations, 0),
          sourceCitations: documentMetrics.reduce((sum, document) => sum + document.sourceCitations, 0),
          historyCitations: documentMetrics.reduce((sum, document) => sum + document.historyCitations, 0)
        },
        attempts: state.attempts
      },
      orchestration: orchestrationMetrics(output.orchestration, finalRunDirectory),
      quality: {
        result: state.quality.result,
        hardContractPass: state.quality.hardContractPass,
        metrics: state.quality.metrics,
        violations: state.quality.violations
      },
      release: {
        generationId: release.id,
        status: release.status,
        fingerprint: release.fingerprint,
        capabilities: release.capabilities,
        projectorStatuses: release.projectorStatuses,
        documents: projection.documents.length,
        fragments: projection.fragments.length,
        exactEntries: projection.exactIndex.length
      },
      tree: {
        adapters,
        nodes: projection.hierarchyNodes.length,
        roots: projection.hierarchyNodes.filter((node) => node.parentId === undefined).length,
        maximumDepth: Math.max(0, ...projection.hierarchyNodes.map((node) => node.depth)),
        representedDocuments: new Set(projection.hierarchyNodes.map((node) => node.documentId)).size
      }
    };
  } catch (error) {
    throw new HarnessFailure(error instanceof Error ? error.message : String(error), {
      schemaVersion: SCHEMA_VERSION,
      status: "failed",
      repository: state.repository,
      ref: state.ref,
      commitSha: state.commitSha,
      sourceRepository: state.sourceRepository,
      retainedRunDirectory: state.runDirectories.at(-1),
      allRunDirectories: state.runDirectories,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempts: state.attempts,
      ...(state.quality
        ? {
            quality: {
              result: state.quality.result,
              hardContractPass: state.quality.hardContractPass,
              metrics: state.quality.metrics,
              violations: state.quality.violations
            }
          }
        : {}),
      error: {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Error"
      }
    });
  } finally {
    console.warn = originalWarn;
    if (checkout) await rm(checkout.root, { recursive: true, force: true });
  }
}

async function main() {
  let options;
  try {
    options = parseRepositoryHarnessArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    process.env.CONTEXT_DERIVE_DOCUMENT_FILES = "true";
    process.env.CONTEXT_CODEX_MODEL = options.model;
    process.env.CONTEXT_CODEX_EFFORT = options.effort;
    process.env.CONTEXT_CODEX_AUTH = options.auth;
    process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS =
      process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS?.trim() || "5";
    process.env.CONTEXT_DERIVE_VERIFICATION_PASSES = process.env.CONTEXT_DERIVE_VERIFICATION_PASSES?.trim() || "3";
    process.env.JINA_KEEP_DERIVE_DIR = "true";
    process.env.CONTEXT_PAGEINDEX_WORKER = options.pageIndexWorker;
    process.env.CONTEXT_PAGEINDEX_PYTHON = options.pageIndexPython;
    if (options.pageIndexSourceRoot) process.env.PAGEINDEX_SOURCE_ROOT = options.pageIndexSourceRoot;
    const report = await runRepositoryHarness(options);
    await emitReport(report, options.reportPath);
  } catch (error) {
    const report =
      error instanceof HarnessFailure
        ? error.report
        : {
            schemaVersion: SCHEMA_VERSION,
            status: "failed",
            error: { message: error instanceof Error ? error.message : String(error) }
          };
    await emitReport(report, options?.reportPath);
    process.stderr.write(`context_repository_e2e_failed: ${report.error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
