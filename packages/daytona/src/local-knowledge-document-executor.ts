import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  CONTEXT_ORCHESTRATION_RELATIVE_PATH,
  KNOWLEDGE_AGENT_EVIDENCE_PATH,
  KNOWLEDGE_AGENT_MANIFEST_PATH,
  KNOWLEDGE_AGENT_OUTPUT_DIR,
  KNOWLEDGE_AGENT_PRIOR_PATH,
  KNOWLEDGE_AGENT_STATE_DIR,
  documentPathFromFile,
  derivationProgressDocumentPath,
  markdownEvidenceSections,
  markdownCatalogToOutput,
  normalizeMarkdownEvidenceTargets,
  parseMarkdownDocument,
  repositoryContextAreas,
  serializeKnowledgeEvidence,
  type ContextOrchestrationState,
  type MarkdownOutputProblem,
  type KnowledgeDocumentGenerationInput,
  type KnowledgeDocumentGenerator,
  type ParsedMarkdownDocument
} from "@jina/context-engine";
import {
  AGENT_KNOWLEDGE_CODEX_ARGS,
  KNOWLEDGE_AGENT_DEVELOPER_INSTRUCTIONS,
  KNOWLEDGE_AGENT_STAGE_DEVELOPER_INSTRUCTIONS,
  type AgentStageReceipt,
  type HostCheckedMarkdownOutputConversion,
  checkpointReferenceVerifier,
  deadlineAwarePrompt,
  documentFileName,
  improvesHostCheckedOutput,
  keepsPartialCatalog,
  readContextOrchestration,
  requireDurableOrchestration,
  runBudgetSeconds,
  validatePrivateCheckpointArchive,
  withAgentStageReceiptDiagnostics,
  withCollaborationTranscriptDiagnostics,
  withHostCheckedOrchestration
} from "./knowledge-document-executor.js";
import {
  CITATION_AUDIT_STAGE_SCHEMA,
  CRITIC_STAGE_SCHEMA,
  DOCUMENTATION_STAGE_SCHEMA,
  RESEARCH_STAGE_SCHEMA,
  SOURCE_CHALLENGE_STAGE_SCHEMA,
  citationAuditRepairPrompt,
  citationAuditReferenceGroups,
  citationAuditCertificationDiagnostic,
  citationAuditStagePrompt,
  criticIntegrationPrompt,
  criticStagePrompt,
  documentationPageWorkUnits,
  documentationPlannerPrompt,
  documentationPlannerRepairPrompt,
  documentationWriterPrompt,
  draftingStagePrompt,
  parseCitationAuditStageResult,
  parseCriticStageResult,
  parseDocumentationStagePlan,
  parseResearchStagePlan,
  parseSourceChallengeStageResult,
  researchPlannerPrompt,
  researchWorkerPrompt,
  sourceChallengePromotionDiagnostics,
  sourceChallengeStagePrompt,
  stageReceiptsJson,
  type CitationAuditReference,
  type CitationAuditStageResult,
  type DocumentationPageWorkUnit,
  type SourceChallengeStageResult
} from "./local-agent-stages.js";

const execFileAsync = promisify(execFile);

export type DocumentationWorkUnitStatus = "pending" | "working" | "verified" | "failed";

export interface DocumentationWorkUnitCheckpoint extends DocumentationPageWorkUnit {
  readonly status: DocumentationWorkUnitStatus;
  readonly attempts: number;
  readonly inputDigest: string;
  readonly outputDigest?: string;
  readonly auditDigest?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export interface DocumentationWorkLedger {
  readonly version: 1;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly planDigest: string;
  readonly status: "planned" | "working" | "partial" | "complete";
  readonly units: readonly DocumentationWorkUnitCheckpoint[];
  readonly updatedAt: string;
}

export async function retryCitationAuditFormat<T>(options: {
  readonly id: string;
  readonly attempts: number;
  readonly run: (attempt: number, priorDiagnostic: string) => Promise<unknown>;
  readonly parse: (value: unknown) => T;
}): Promise<T> {
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) {
    throw new Error("citation audit format attempts must be a positive integer");
  }
  let diagnostic = "";
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const value = await options.run(attempt, diagnostic);
    try {
      return options.parse(value);
    } catch (error) {
      diagnostic = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      if (attempt === options.attempts) {
        throw new Error(
          `citation audit ${options.id} remained invalid after ${options.attempts} attempts: ${diagnostic}`,
          { cause: error }
        );
      }
    }
  }
  throw new Error(`citation audit ${options.id} did not return a result`);
}

/**
 * The same derivation, run directly on this machine.
 *
 * The Daytona executor exists for containment of untrusted repositories, and it
 * earns that by shipping everything to a cloud sandbox: the repository archive,
 * the prompt, and -- under the chatgpt provider -- the operator's own session
 * tokens. On a developer's stack iterating against a repository they already
 * trust, that trade buys little and costs startup time, an upload of their
 * credentials, and a network dependency.
 *
 * Here the process runs on the host under Codex's own OS sandbox: the checkout
 * stays read-only, one directory is writable, and the session never leaves the
 * machine because it is never sent anywhere -- Codex reads it from the same
 * place the CLI does. Chosen only by CONTEXT_EXECUTOR=local, never inferred,
 * and deliberately not offered as a production path.
 *
 * Retries for transient provider failures are left to the model CLI itself.
 */
export class LocalCodexKnowledgeDocumentGenerator implements KnowledgeDocumentGenerator {
  readonly name = "local-codex";
  readonly version = "agentic-knowledge-documents-v9";
  readonly model: string;

  constructor() {
    const configured = process.env.CONTEXT_CODEX_MODEL?.trim();
    this.model = (configured || "gpt-5.6-terra").replace(/^openai\//, "");
  }

  async generate(input: KnowledgeDocumentGenerationInput): Promise<unknown> {
    if (process.env.CONTEXT_DERIVE_DOCUMENT_FILES !== "true") {
      throw new Error("the local executor supports only the document-file contract");
    }
    if (!input.workspace) throw new Error("checkpoint-pinned repository workspace is required for agentic derivation");
    const root = await mkdtemp(join(tmpdir(), "jina-local-derive-"));
    const outputDir = join(root, "derive-output");
    const stateDir = join(root, "derive-state");
    const inputDir = join(root, "derive-input");
    const repositoryDir = join(root, "repository");
    const transcriptPath = join(stateDir, "transcript.log");
    try {
      await mkdir(outputDir, { recursive: true });
      await mkdir(join(stateDir, "retired"), { recursive: true });
      await mkdir(inputDir, { recursive: true });
      await Promise.all([
        writeFile(join(inputDir, "evidence.json"), serializeKnowledgeEvidence(input.bundle)),
        writeFile(join(inputDir, "repository-manifest.json"), JSON.stringify(input.workspace.manifest)),
        writeFile(join(inputDir, "prior-knowledge.json"), JSON.stringify(input.workspace.priorKnowledge)),
        cp(input.workspace.repositoryDirectory, repositoryDir, { recursive: true, verbatimSymlinks: true })
      ]);
      await makeTreeReadOnly(repositoryDir);
      // Prior pages first, then a stopped attempt's newer checkpoint over them,
      // exactly as the remote executor seeds its sandbox.
      for (const prior of input.workspace.priorKnowledge) {
        const revision = prior.revision as unknown as Record<string, unknown>;
        if (typeof revision.bodyMarkdown !== "string" || typeof revision.logicalId !== "string") continue;
        const target = join(outputDir, documentFileName(revision.logicalId));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, revision.bodyMarkdown);
      }
      for (const resumed of input.workspace.resumedPages ?? []) {
        const documentPath = derivationProgressDocumentPath(resumed.documentPath);
        const target = join(outputDir, `${documentPath}.md`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, resumed.bodyMarkdown);
      }
      if (input.workspace.resumedOrchestration) {
        await writeFile(
          join(stateDir, CONTEXT_ORCHESTRATION_RELATIVE_PATH),
          `${JSON.stringify(input.workspace.resumedOrchestration, null, 2)}\n`
        );
      }
      if (input.workspace.resumedPrivateState?.byteLength) {
        validatePrivateCheckpointArchive(input.workspace.resumedPrivateState);
        const archivePath = join(root, "resumed-private-checkpoint.tar.gz");
        await writeFile(archivePath, input.workspace.resumedPrivateState);
        try {
          await execFileAsync("tar", ["-xzf", archivePath, "-C", stateDir]);
        } finally {
          await rm(archivePath, { force: true }).catch(() => undefined);
        }
      }

      // The prompt arrives with the sandbox's well-known paths baked in, because
      // the API that built it cannot know where this machine keeps a temp dir.
      // Rewriting the constants is blunt and honest: if a path changes shape,
      // the very next local run fails loudly at the first file the agent opens.
      const prompt = deadlineAwarePrompt({
        ...input,
        prompt: [
          input.prompt,
          `The checkpoint repository is read-only at ${repositoryDir}. Run repository inspection commands from that directory (for example, cd there first), but keep evidence-link targets relative to its root. Your Codex project root is the derivation workspace so apply_patch can edit the output and state directories.`
        ].join("\n\n")
      })
        .replaceAll(KNOWLEDGE_AGENT_EVIDENCE_PATH, "derive-input/evidence.json")
        .replaceAll(KNOWLEDGE_AGENT_MANIFEST_PATH, "derive-input/repository-manifest.json")
        .replaceAll(KNOWLEDGE_AGENT_PRIOR_PATH, "derive-input/prior-knowledge.json")
        .replaceAll(KNOWLEDGE_AGENT_OUTPUT_DIR, "derive-output")
        .replaceAll(KNOWLEDGE_AGENT_STATE_DIR, "derive-state");
      const promptPath = join(root, "prompt.txt");
      await writeFile(promptPath, prompt);

      const budgetSeconds = runBudgetSeconds(input);
      // Only what the run needs reaches it: the path to find codex, a home for
      // it to find the session, and a key when a key is the provider. The rest
      // of the worker's environment -- database URLs, internal tokens -- is
      // exactly what an agent must never see.
      const environment: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? homedir(),
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        ...(process.env.CONTEXT_CODEX_AUTH === "api-key" && process.env.OPENAI_API_KEY
          ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
          : {})
      };
      const secrets = [environment.OPENAI_API_KEY].filter((value): value is string => Boolean(value));
      const commandFor = (
        inputPromptPath: string,
        outputTranscriptPath: string,
        options: {
          readonly outputLastMessagePath?: string;
          readonly outputSchemaPath?: string;
          readonly appendTranscript?: boolean;
          readonly readOnly?: boolean;
          readonly workingDirectory?: string;
          readonly additionalDirectories?: readonly string[];
          readonly writableDirectories?: readonly string[];
          readonly stageScoped?: boolean;
        } = {}
      ): string =>
        [
          quote(process.env.CODEX_BINARY?.trim() || "codex"),
          "exec",
          "--json",
          // Codex collaboration resolves workers through the persisted parent
          // thread. `--ephemeral` can remove that parent before spawn lookup.
          ...(options.stageScoped
            ? AGENT_KNOWLEDGE_CODEX_ARGS.filter((argument) => argument !== "--enable multi_agent")
            : AGENT_KNOWLEDGE_CODEX_ARGS),
          ...(options.stageScoped ? ["--disable multi_agent"] : []),
          ...(options.additionalDirectories ?? []).map((directory) => `--add-dir ${quote(directory)}`),
          options.readOnly
            ? "--sandbox read-only"
            : `--sandbox workspace-write -c ${quote(
                `sandbox_workspace_write.writable_roots=${JSON.stringify(
                  options.writableDirectories ?? [outputDir, stateDir]
                )}`
              )}`,
          `-c developer_instructions=${quote(
            options.stageScoped ? KNOWLEDGE_AGENT_STAGE_DEVELOPER_INSTRUCTIONS : KNOWLEDGE_AGENT_DEVELOPER_INSTRUCTIONS
          )}`,
          `-C ${quote(options.workingDirectory ?? root)}`,
          `-m ${quote(this.model)}`,
          `-c model_context_window=${positiveInt(process.env.CONTEXT_CODEX_CONTEXT_TOKENS, 64_000)}`,
          `-c model_auto_compact_token_limit=${positiveInt(process.env.CONTEXT_CODEX_COMPACT_TOKENS, 48_000)}`,
          `-c model_reasoning_effort=${quote(process.env.CONTEXT_CODEX_EFFORT?.trim() || "low")}`,
          `-c model_verbosity=${quote(process.env.CONTEXT_CODEX_VERBOSITY?.trim() || "high")}`,
          ...(options.outputSchemaPath ? [`--output-schema ${quote(options.outputSchemaPath)}`] : []),
          ...(options.outputLastMessagePath ? [`--output-last-message ${quote(options.outputLastMessagePath)}`] : []),
          `< ${quote(inputPromptPath)} ${options.appendTranscript ? ">>" : ">"} ${quote(outputTranscriptPath)} 2>&1`
        ].join(" ");

      const runStartedAt = Date.now();
      const progress = startLocalProgressReporting(outputDir, stateDir, input, secrets);
      let run: Awaited<ReturnType<typeof runCodex>>;
      let stageFailure: Error | undefined;
      try {
        if (process.env.CONTEXT_AGENT_STAGES === "false") {
          run = await runCodex(commandFor(promptPath, transcriptPath), environment, budgetSeconds);
        } else {
          run = await this.runAgentStages({
            input,
            basePrompt: prompt,
            root,
            repositoryDir,
            outputDir,
            stateDir,
            inputDir,
            transcriptPath,
            environment,
            budgetSeconds,
            runStartedAt,
            commandFor
          });
        }
      } catch (error) {
        stageFailure = error instanceof Error ? error : new Error(String(error));
        run = { exitCode: 1, timedOut: false };
      } finally {
        await progress.stop();
      }

      const failure =
        stageFailure ??
        (run.exitCode === 0
          ? undefined
          : new Error(
              run.timedOut
                ? `local codex run exceeded its ${budgetSeconds}s budget`
                : `local codex run exited with ${run.exitCode}: ${redact(await tail(transcriptPath, 2_000), secrets)}`
            ));

      let collected = await this.collect(outputDir, stateDir, input, secrets, repositoryDir);
      if (!failure) {
        const verificationPasses = positiveInt(process.env.CONTEXT_DERIVE_VERIFICATION_PASSES, 3);
        for (let pass = 1; pass <= verificationPasses; pass += 1) {
          const failedLinks = collected.problems.filter(repairableDocumentProblem);
          const orchestrationDiagnostics = collected.orchestrationDiagnostics;
          if (failedLinks.length === 0 && orchestrationDiagnostics.length === 0) break;
          const remainingSeconds = Math.floor(budgetSeconds - (Date.now() - runStartedAt) / 1_000) - 10;
          if (remainingSeconds < 30) break;
          const repairPromptPath = join(root, "repair-prompt.txt");
          await writeFile(
            repairPromptPath,
            citationRepairPrompt(
              "derive-output",
              "derive-state",
              "repository",
              failedLinks,
              orchestrationDiagnostics,
              pass
            )
          );
          const repairedRun = await runCodex(
            commandFor(repairPromptPath, transcriptPath, { appendTranscript: true, stageScoped: true }),
            environment,
            Math.min(remainingSeconds, 300)
          );
          if (repairedRun.exitCode !== 0) break;
          const repaired = await this.collect(outputDir, stateDir, input, secrets, repositoryDir);
          if (!improvesHostCheckedOutput(collected, repaired)) break;
          console.warn("knowledge_verification_repair", {
            repository: input.bundle.checkpoint.repository,
            pass,
            failedBefore: failedLinks.length,
            failedAfter: repaired.problems.filter(repairableDocumentProblem).length,
            orchestrationBefore: orchestrationDiagnostics.length,
            orchestrationAfter: repaired.orchestrationDiagnostics.length,
            citationsBefore: citationCount(collected),
            citationsAfter: citationCount(repaired)
          });
          collected = repaired;
        }
      }
      const { output, problems } = collected;
      if (problems.length > 0) console.warn("knowledge_markdown_problems", { problems: problems.slice(0, 50) });
      if (!failure) return requireDurableOrchestration(collected);
      if (!keepsPartialCatalog(output.documents.length)) {
        console.warn("knowledge_generation_empty", {
          reason: failure.message,
          repository: input.bundle.checkpoint.repository,
          transcript: redact(await tail(transcriptPath, 4_000), secrets)
        });
        throw failure;
      }
      console.warn("knowledge_generation_truncated", {
        reason: failure.message,
        documents: output.documents.length,
        repository: input.bundle.checkpoint.repository
      });
      return output;
    } finally {
      if (process.env.JINA_KEEP_DERIVE_DIR === "true") {
        console.warn("knowledge_local_run_kept", { directory: root });
      } else {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async runAgentStages(options: {
    readonly input: KnowledgeDocumentGenerationInput;
    readonly basePrompt: string;
    readonly root: string;
    readonly repositoryDir: string;
    readonly outputDir: string;
    readonly stateDir: string;
    readonly inputDir: string;
    readonly transcriptPath: string;
    readonly environment: Record<string, string>;
    readonly budgetSeconds: number;
    readonly runStartedAt: number;
    readonly commandFor: (
      promptPath: string,
      transcriptPath: string,
      options?: {
        readonly outputLastMessagePath?: string;
        readonly outputSchemaPath?: string;
        readonly appendTranscript?: boolean;
        readonly readOnly?: boolean;
        readonly workingDirectory?: string;
        readonly additionalDirectories?: readonly string[];
        readonly writableDirectories?: readonly string[];
        readonly stageScoped?: boolean;
      }
    ) => string;
  }): Promise<Awaited<ReturnType<typeof runCodex>>> {
    const {
      input,
      basePrompt,
      root,
      repositoryDir,
      outputDir,
      stateDir,
      inputDir,
      transcriptPath,
      environment,
      budgetSeconds,
      runStartedAt,
      commandFor
    } = options;
    const stagesDir = join(stateDir, "agent-stages");
    const workersDir = join(stagesDir, "workers");
    const receiptsPath = join(stagesDir, "receipts.json");
    await mkdir(workersDir, { recursive: true });
    const receipts: AgentStageReceipt[] = [];
    await writeFile(receiptsPath, stageReceiptsJson(receipts));

    const remainingSeconds = (): number =>
      Math.max(0, Math.floor(budgetSeconds - (Date.now() - runStartedAt) / 1_000) - 10);
    const runStage = async (stage: {
      readonly id: string;
      readonly prompt: string;
      readonly maximumSeconds: number;
      readonly schema?: unknown;
      readonly useMainTranscript?: boolean;
      readonly appendMainTranscript?: boolean;
      readonly readOnlyResearch?: boolean;
      readonly contextOnly?: boolean;
      readonly workingDirectory?: string;
      readonly additionalDirectories?: readonly string[];
      readonly writableDirectories?: readonly string[];
    }): Promise<{ readonly run: Awaited<ReturnType<typeof runCodex>>; readonly resultPath: string }> => {
      const available = remainingSeconds();
      if (available < 30) throw new Error(`agent stage ${stage.id} could not start with only ${available}s remaining`);
      const stageSeconds = Math.min(available, stage.maximumSeconds);
      const finishBy = new Date(Date.now() + Math.max(15, stageSeconds - 15) * 1_000).toISOString();
      const promptPath = join(stagesDir, `${stage.id}.prompt.txt`);
      const resultPath = join(stagesDir, `${stage.id}.result.txt`);
      const stageTranscriptPath = stage.useMainTranscript
        ? transcriptPath
        : join(stagesDir, `${stage.id}.transcript.log`);
      const schemaPath = stage.schema ? join(stagesDir, `${stage.id}.schema.json`) : undefined;
      await writeFile(
        promptPath,
        [
          stage.prompt,
          `This stage is terminated shortly after ${finishBy}. Finish inspection early enough to return the requested final report before that time. A partial but truthful report is preferable to losing all completed research at the deadline.`
        ].join("\n\n")
      );
      if (schemaPath) await writeFile(schemaPath, `${JSON.stringify(stage.schema, null, 2)}\n`);
      const run = await runCodex(
        commandFor(promptPath, stageTranscriptPath, {
          outputLastMessagePath: resultPath,
          ...(schemaPath ? { outputSchemaPath: schemaPath } : {}),
          ...(stage.appendMainTranscript ? { appendTranscript: true } : {}),
          ...(stage.readOnlyResearch || stage.contextOnly ? { readOnly: true } : {}),
          workingDirectory:
            stage.workingDirectory ?? (stage.contextOnly ? outputDir : stage.readOnlyResearch ? repositoryDir : root),
          additionalDirectories: stage.additionalDirectories ?? (stage.contextOnly ? [] : [repositoryDir, inputDir]),
          ...(stage.writableDirectories ? { writableDirectories: stage.writableDirectories } : {}),
          stageScoped: true
        }),
        environment,
        stageSeconds
      );
      if (run.exitCode !== 0) {
        throw new Error(
          run.timedOut
            ? `agent stage ${stage.id} exceeded its ${stageSeconds}s budget`
            : `agent stage ${stage.id} exited with ${run.exitCode}: ${await tail(stageTranscriptPath, 2_000)}`
        );
      }
      return { run, resultPath };
    };
    const runCitationAuditBatch = async (options: {
      readonly id: string;
      readonly workerId: string;
      readonly references: readonly CitationAuditReference[];
      readonly inputDigest: string;
      readonly publicSnapshotDigest: string;
      readonly maximumSeconds: number;
    }): Promise<CitationAuditStageResult> => {
      const citationIds = options.references.map((reference) => reference.citationId);
      const formatAttempts = positiveInt(process.env.CONTEXT_CITATION_AUDIT_FORMAT_ATTEMPTS, 2);
      return retryCitationAuditFormat<CitationAuditStageResult>({
        id: options.id,
        attempts: formatAttempts,
        run: async (formatAttempt, diagnostic) => {
          const basePrompt = citationAuditStagePrompt({
            workerId: options.workerId,
            repository: input.bundle.checkpoint.repository,
            repositoryDirectory: repositoryDir,
            evidencePath: join(inputDir, "evidence.json"),
            references: options.references,
            inputDigest: options.inputDigest,
            publicSnapshotDigest: options.publicSnapshotDigest
          });
          const audit = await runStage({
            id: formatAttempt === 1 ? options.id : `${options.id}-format-retry-${formatAttempt}`,
            prompt: diagnostic
              ? [
                  basePrompt,
                  `The prior audit response was rejected by the host: ${diagnostic}`,
                  `Return every one of these citation IDs exactly once and no other IDs: ${citationIds.join(", ")}. Preserve the supplied digests and worker ID exactly.`
                ].join("\n\n")
              : basePrompt,
            maximumSeconds: options.maximumSeconds,
            schema: CITATION_AUDIT_STAGE_SCHEMA,
            readOnlyResearch: true
          });
          return JSON.parse(await readFile(audit.resultPath, "utf8")) as unknown;
        },
        parse: (value) =>
          parseCitationAuditStageResult(value, {
            workerId: options.workerId,
            inputDigest: options.inputDigest,
            publicSnapshotDigest: options.publicSnapshotDigest,
            citationIds
          })
      });
    };

    const resumeStageDir =
      process.env.CONTEXT_RESUME_AGENT_STAGE_DIR?.trim() ??
      (input.workspace?.resumedPrivateState?.byteLength ? stagesDir : undefined);
    const resumableStageDir =
      resumeStageDir && isAbsolute(resumeStageDir)
        ? await matchingAgentStageCheckpoint(resumeStageDir, input)
        : undefined;
    const researchPlan = resumableStageDir
      ? parseResearchStagePlan(JSON.parse(await readFile(join(resumableStageDir, "research-plan.json"), "utf8")))
      : await (async (): Promise<ReturnType<typeof parseResearchStagePlan>> => {
          const planner = await runStage({
            id: "research-planner",
            prompt: researchPlannerPrompt({
              repository: input.bundle.checkpoint.repository,
              repositoryDirectory: repositoryDir,
              manifestPath: join(inputDir, "repository-manifest.json"),
              evidencePath: join(inputDir, "evidence.json")
            }),
            maximumSeconds: positiveInt(process.env.CONTEXT_RESEARCH_PLANNER_SECONDS, 240),
            schema: RESEARCH_STAGE_SCHEMA,
            readOnlyResearch: true
          });
          return parseResearchStagePlan(JSON.parse(await readFile(planner.resultPath, "utf8")));
        })();
    const researchPlanPath = join(stagesDir, "research-plan.json");
    await writeFile(researchPlanPath, `${JSON.stringify(researchPlan, null, 2)}\n`);

    const workerRuns = await mapWithConcurrency(
      researchPlan.assignments,
      positiveInt(process.env.CONTEXT_RESEARCH_CONCURRENCY, 3),
      async (assignment) => {
        const resumedResultPath = resumableStageDir
          ? join(resumableStageDir, `research-${assignment.id}.result.txt`)
          : undefined;
        const resumedReport = resumedResultPath ? await readFile(resumedResultPath, "utf8").catch(() => "") : "";
        const report = resumedReport.trim()
          ? resumedReport.trim()
          : (
              await readFile(
                (
                  await runStage({
                    id: `research-${assignment.id}`,
                    prompt: researchWorkerPrompt({
                      repository: input.bundle.checkpoint.repository,
                      repositoryDirectory: repositoryDir,
                      evidencePath: join(inputDir, "evidence.json"),
                      assignment
                    }),
                    maximumSeconds: positiveInt(process.env.CONTEXT_RESEARCH_WORKER_SECONDS, 600),
                    readOnlyResearch: true
                  })
                ).resultPath,
                "utf8"
              )
            ).trim();
        if (report.length < 200)
          throw new Error(`research worker ${assignment.id} returned an empty or shallow report`);
        if (resumedReport.trim()) {
          await writeFile(join(stagesDir, `research-${assignment.id}.result.txt`), `${report}\n`);
        }
        const reportPath = join(workersDir, `${assignment.id}.md`);
        await writeFile(reportPath, `${report}\n`);
        return { assignment, report, reportPath };
      }
    );
    for (const { assignment } of workerRuns) {
      receipts.push({ id: assignment.id, role: "research", status: "complete" });
    }
    await writeFile(receiptsPath, stageReceiptsJson(receipts));

    const researchPackets = Object.fromEntries(workerRuns.map(({ assignment, report }) => [assignment.id, report]));
    const repositoryAreas = repositoryContextAreas(input.workspace?.manifest ?? []);
    const resumedDocumentationPlanText = resumableStageDir
      ? await readFile(join(resumableStageDir, "documentation-plan.json"), "utf8").catch(() =>
          readFile(join(resumableStageDir, "documentation-planner.result.txt"), "utf8").catch(() => "")
        )
      : "";
    let documentationPlanCandidate = resumedDocumentationPlanText.trim();
    if (!documentationPlanCandidate) {
      documentationPlanCandidate = await readFile(
        (
          await runStage({
            id: "documentation-planner",
            prompt: documentationPlannerPrompt({
              repository: input.bundle.checkpoint.repository,
              repositoryAreas,
              researchPlan,
              researchPackets
            }),
            maximumSeconds: positiveInt(process.env.CONTEXT_DOCUMENTATION_PLANNER_SECONDS, 600),
            schema: DOCUMENTATION_STAGE_SCHEMA,
            readOnlyResearch: true
          })
        ).resultPath,
        "utf8"
      );
    }
    let documentationPlan: ReturnType<typeof parseDocumentationStagePlan> | undefined;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      try {
        documentationPlan = parseDocumentationStagePlan(JSON.parse(documentationPlanCandidate), {
          researchAssignments: researchPlan.assignments,
          repositoryAreas
        });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        const diagnostic = error instanceof Error ? error.message : String(error);
        const repair = await runStage({
          id: `documentation-planner-repair-${attempt + 1}`,
          prompt: documentationPlannerRepairPrompt({
            repository: input.bundle.checkpoint.repository,
            repositoryAreas,
            researchPlan,
            invalidPlan: documentationPlanCandidate,
            diagnostic
          }),
          maximumSeconds: positiveInt(process.env.CONTEXT_DOCUMENTATION_PLANNER_SECONDS, 600),
          schema: DOCUMENTATION_STAGE_SCHEMA,
          readOnlyResearch: true
        });
        documentationPlanCandidate = await readFile(repair.resultPath, "utf8");
      }
    }
    if (!documentationPlan) throw new Error("documentation planner did not produce a valid plan");
    const documentationPlanPath = join(stagesDir, "documentation-plan.json");
    await writeFile(documentationPlanPath, `${JSON.stringify(documentationPlan, null, 2)}\n`);

    const documentationPlanDigest = sha256Text(JSON.stringify(documentationPlan));
    const pageWorkUnits = documentationPageWorkUnits(documentationPlan);
    const workLedgerPath = join(stagesDir, "documentation-work-ledger.json");
    const workUnitStateDir = join(stagesDir, "documentation-work-units");
    await mkdir(workUnitStateDir, { recursive: true });
    const workUnitInputDigest = (unit: DocumentationPageWorkUnit): string => {
      const page = documentationPlan.pages.find((candidate) => candidate.id === unit.pageId);
      if (!page) throw new Error(`documentation work unit ${unit.id} names unknown page ${unit.pageId}`);
      return sha256Text(
        JSON.stringify({
          unit,
          page,
          packets: Object.fromEntries(
            [...new Set(page.sourceAssignmentIds)]
              .sort()
              .map((assignmentId) => [assignmentId, researchPackets[assignmentId]])
          )
        })
      );
    };
    let workLedger =
      (resumableStageDir
        ? await readDocumentationWorkLedger(join(resumableStageDir, "documentation-work-ledger.json"), {
            repository: input.bundle.checkpoint.repository,
            ref: input.bundle.checkpoint.ref,
            commitSha: input.bundle.checkpoint.commitSha,
            planDigest: documentationPlanDigest,
            units: pageWorkUnits.map((unit) => ({ ...unit, inputDigest: workUnitInputDigest(unit) }))
          })
        : undefined) ??
      createDocumentationWorkLedger({
        repository: input.bundle.checkpoint.repository,
        ref: input.bundle.checkpoint.ref,
        commitSha: input.bundle.checkpoint.commitSha,
        planDigest: documentationPlanDigest,
        units: pageWorkUnits.map((unit) => ({ ...unit, inputDigest: workUnitInputDigest(unit) }))
      });
    await writeJsonAtomically(workLedgerPath, workLedger);
    let ledgerUpdate = Promise.resolve();
    const updateWorkUnit = async (
      id: string,
      update: (current: DocumentationWorkUnitCheckpoint) => DocumentationWorkUnitCheckpoint
    ): Promise<void> => {
      ledgerUpdate = ledgerUpdate.then(async () => {
        const units = workLedger.units.map((unit) => (unit.id === id ? update(unit) : unit));
        if (!units.some((unit) => unit.id === id)) throw new Error(`unknown documentation work unit ${id}`);
        const status = documentationWorkLedgerStatus(units);
        workLedger = { ...workLedger, status, units, updatedAt: new Date().toISOString() };
        await writeJsonAtomically(workLedgerPath, workLedger);
      });
      await ledgerUpdate;
    };

    const verifyPageUnit = async (options: {
      readonly unit: DocumentationPageWorkUnit;
      readonly pageOutputDir: string;
      readonly pageWorkDir: string;
    }): Promise<string> => {
      const { unit, pageOutputDir, pageWorkDir } = options;
      await normalizePublicContext(pageOutputDir);
      let problems = (await publicMarkdownProblems(pageOutputDir, input)).filter(repairableDocumentProblem);
      for (let pass = 1; pass <= 3 && problems.length > 0; pass += 1) {
        const beforeDigest = sha256Text(await publicDocumentSnapshot(pageOutputDir));
        const beforeProblems = sha256Text(JSON.stringify(problems));
        await runStage({
          id: `${unit.id}-structural-repair-${pass}`,
          prompt: citationRepairPrompt(pageOutputDir, stateDir, repositoryDir, problems, [], pass),
          maximumSeconds: positiveInt(process.env.CONTEXT_SOURCE_LINK_REPAIR_SECONDS, 600),
          workingDirectory: pageWorkDir,
          additionalDirectories: [repositoryDir, inputDir],
          writableDirectories: [pageOutputDir]
        });
        await normalizePublicContext(pageOutputDir);
        const repaired = (await publicMarkdownProblems(pageOutputDir, input)).filter(repairableDocumentProblem);
        const afterDigest = sha256Text(await publicDocumentSnapshot(pageOutputDir));
        const afterProblems = sha256Text(JSON.stringify(repaired));
        problems = repaired;
        if (afterDigest === beforeDigest && afterProblems === beforeProblems) break;
      }
      if (problems.length > 0) {
        throw new Error(`documentation work unit ${unit.id} has ${problems.length} invalid evidence claims`);
      }

      const unitCheckpointDir = join(workUnitStateDir, unit.id);
      await mkdir(unitCheckpointDir, { recursive: true });
      const repairPasses = positiveInt(process.env.CONTEXT_PAGE_CITATION_REPAIR_PASSES, 4);
      for (let attempt = 1; attempt <= repairPasses + 1; attempt += 1) {
        const publicSnapshotDigest = sha256Text(await publicDocumentSnapshot(pageOutputDir));
        const references = await citationAuditReferences(pageOutputDir, repositoryDir, input);
        const inputPayload = citationAuditInputPayload(input, publicSnapshotDigest, references);
        const inputDigest = sha256Text(JSON.stringify(inputPayload));
        const auditInputPath = join(unitCheckpointDir, "citation-audit-input.json");
        await writeJsonAtomically(auditInputPath, { ...inputPayload, inputDigest });
        const workerId = `citation-audit-${unit.pageId}`;
        const expected = {
          workerId,
          inputDigest,
          publicSnapshotDigest,
          citationIds: references.map((reference) => reference.citationId)
        };
        const batchResults = await mapWithConcurrency(
          citationAuditBatches(references),
          positiveInt(process.env.CONTEXT_PAGE_CITATION_AUDIT_CONCURRENCY, 2),
          (batch, batchIndex): Promise<CitationAuditStageResult> =>
            runCitationAuditBatch({
              id: `${unit.id}-citation-audit-${attempt}-${batchIndex + 1}`,
              workerId,
              references: batch,
              inputDigest,
              publicSnapshotDigest,
              maximumSeconds: process.env.CONTEXT_CITATION_AUDIT_SECONDS
                ? positiveInt(process.env.CONTEXT_CITATION_AUDIT_SECONDS, 600)
                : Math.min(600, Math.max(240, 120 + batch.length * 4))
            })
        );
        let result = parseCitationAuditStageResult(
          {
            version: 1,
            inputDigest,
            publicSnapshotDigest,
            worker: {
              id: workerId,
              summary: batchResults
                .map((batch) => batch.worker.summary)
                .join(" ")
                .slice(0, 2_000)
            },
            results: batchResults.flatMap((batch) => batch.results),
            summary: batchResults
              .map((batch) => batch.summary)
              .join(" ")
              .slice(0, 4_000)
          },
          expected
        );
        result = await discardInvalidCitationAuditCorrections(result, references, repositoryDir, input);
        const resultText = `${JSON.stringify(result, null, 2)}\n`;
        const resultPath = join(unitCheckpointDir, "citation-audit.json");
        const auditDigest = sha256Text(resultText);
        await writeFile(resultPath, resultText);
        await writeJsonAtomically(join(unitCheckpointDir, "citation-audit.checkpoint.json"), {
          version: 1,
          stage: workerId,
          repository: input.bundle.checkpoint.repository,
          ref: input.bundle.checkpoint.ref,
          commitSha: input.bundle.checkpoint.commitSha,
          inputDigest,
          publicSnapshotDigest,
          outputDigest: auditDigest,
          citationIds: references.map((reference) => reference.citationId),
          completedAt: new Date().toISOString()
        });
        const unsupported = result.results.filter((candidate) => candidate.verdict === "unsupported");
        if (unsupported.length === 0) return auditDigest;
        if (attempt > repairPasses) {
          throw new Error(
            `documentation work unit ${unit.id} still has ${unsupported.length} unsupported citations after repair`
          );
        }
        await runStage({
          id: `${unit.id}-citation-repair-${attempt}`,
          prompt: citationAuditRepairPrompt({
            repositoryDirectory: repositoryDir,
            outputDirectory: pageOutputDir,
            auditInputPath,
            auditResultPath: resultPath,
            unsupportedCitationIds: unsupported.map((candidate) => candidate.citationId)
          }),
          maximumSeconds: positiveInt(process.env.CONTEXT_CITATION_REPAIR_SECONDS, 600),
          workingDirectory: pageWorkDir,
          additionalDirectories: [repositoryDir, inputDir, unitCheckpointDir],
          writableDirectories: [pageOutputDir]
        });
        await normalizePublicContext(pageOutputDir);
        let repairedProblems = (await publicMarkdownProblems(pageOutputDir, input)).filter(repairableDocumentProblem);
        for (let pass = 1; pass <= 2 && repairedProblems.length > 0; pass += 1) {
          await runStage({
            id: `${unit.id}-post-citation-structural-repair-${attempt}-${pass}`,
            prompt: citationRepairPrompt(pageOutputDir, stateDir, repositoryDir, repairedProblems, [], pass),
            maximumSeconds: positiveInt(process.env.CONTEXT_SOURCE_LINK_REPAIR_SECONDS, 600),
            workingDirectory: pageWorkDir,
            additionalDirectories: [repositoryDir, inputDir],
            writableDirectories: [pageOutputDir]
          });
          await normalizePublicContext(pageOutputDir);
          repairedProblems = (await publicMarkdownProblems(pageOutputDir, input)).filter(repairableDocumentProblem);
        }
        if (repairedProblems.length > 0) {
          throw new Error(
            `documentation work unit ${unit.id} citation repair introduced ${repairedProblems.length} invalid claims`
          );
        }
      }
      throw new Error(`documentation work unit ${unit.id} did not produce a supported citation audit`);
    };

    const writerSettlements = await settledMapWithConcurrency(
      pageWorkUnits,
      positiveInt(process.env.CONTEXT_DOCUMENTATION_CONCURRENCY, 3),
      async (unit) => {
        const page = documentationPlan.pages.find((candidate) => candidate.id === unit.pageId);
        if (!page) throw new Error(`documentation work unit ${unit.id} names unknown page ${unit.pageId}`);
        const inputDigest = workUnitInputDigest(unit);
        const checkpointBeforeStart = workLedger.units.find((candidate) => candidate.id === unit.id);
        const pageWorkDir = join(root, "documentation-work", unit.id);
        const pageOutputDir = join(pageWorkDir, "derive-output");
        const resumableRoot = resumableStageDir ? join(resumableStageDir, "..", "..") : undefined;
        const resumableDraft =
          resumableRoot &&
          checkpointBeforeStart?.inputDigest === inputDigest &&
          (checkpointBeforeStart.status === "failed" ||
            checkpointBeforeStart.status === "working" ||
            (checkpointBeforeStart.status === "pending" && checkpointBeforeStart.attempts > 0))
            ? await readFile(
                join(resumableRoot, "documentation-work", unit.id, "derive-output", unit.path),
                "utf8"
              ).catch(() => "")
            : "";
        await rm(pageWorkDir, { recursive: true, force: true });
        await mkdir(pageOutputDir, { recursive: true });
        await updateWorkUnit(unit.id, (current) => {
          const { lastError: _lastError, ...rest } = current;
          return {
            ...rest,
            status: "working",
            attempts: current.attempts + 1,
            updatedAt: new Date().toISOString()
          };
        });
        try {
          const resumedOutputDir = resumableRoot ? join(resumableRoot, "derive-output") : undefined;
          const mayRecoverCheckpoint =
            checkpointBeforeStart?.inputDigest === inputDigest &&
            (checkpointBeforeStart.status === "verified" || checkpointBeforeStart.attempts > 0);
          let existing = mayRecoverCheckpoint ? resumableDraft : "";
          if (mayRecoverCheckpoint && !recoverableDocumentationPage(unit.path, existing)) {
            existing = await readFile(join(outputDir, unit.path), "utf8").catch(() => "");
          }
          if (mayRecoverCheckpoint && !recoverableDocumentationPage(unit.path, existing) && resumedOutputDir) {
            existing = await readFile(join(resumedOutputDir, unit.path), "utf8").catch(() => existing);
          }
          const resumedUnitCheckpointDir = resumableStageDir
            ? join(resumableStageDir, "documentation-work-units", unit.id)
            : undefined;
          const auditCheckpointDirectory =
            resumedUnitCheckpointDir &&
            (await readFile(join(resumedUnitCheckpointDir, "citation-audit.json"), "utf8").catch(() => ""))
              ? resumedUnitCheckpointDir
              : join(workUnitStateDir, unit.id);
          if (
            checkpointBeforeStart?.status === "verified" &&
            checkpointBeforeStart.inputDigest === inputDigest &&
            checkpointBeforeStart.outputDigest === sha256Text(existing) &&
            checkpointBeforeStart.auditDigest &&
            (await documentationWorkUnitAuditMatches({
              checkpointDirectory: auditCheckpointDirectory,
              auditDigest: checkpointBeforeStart.auditDigest,
              outputDirectory: resumedOutputDir ?? outputDir,
              unit,
              repositoryDirectory: repositoryDir,
              input
            }))
          ) {
            await mkdir(dirname(join(outputDir, unit.path)), { recursive: true });
            await writeFile(join(outputDir, unit.path), existing);
            if (auditCheckpointDirectory !== join(workUnitStateDir, unit.id)) {
              await cp(auditCheckpointDirectory, join(workUnitStateDir, unit.id), { recursive: true });
            }
            await updateWorkUnit(unit.id, (current) => ({
              ...current,
              status: "verified",
              updatedAt: new Date().toISOString()
            }));
            return;
          }

          let recovered = false;
          if (recoverableDocumentationPage(unit.path, existing)) {
            await mkdir(dirname(join(pageOutputDir, unit.path)), { recursive: true });
            await writeFile(join(pageOutputDir, unit.path), existing);
            recovered = true;
          } else {
            const pageWriter = {
              id: unit.id,
              objective: unit.objective,
              pageIds: [unit.pageId]
            };
            await runStage({
              id: unit.id,
              prompt: documentationWriterPrompt({
                repository: input.bundle.checkpoint.repository,
                repositoryDirectory: repositoryDir,
                outputDirectory: pageOutputDir,
                writer: pageWriter,
                plan: documentationPlan,
                researchPackets
              }),
              maximumSeconds: positiveInt(process.env.CONTEXT_DOCUMENTATION_WRITER_SECONDS, 1_200),
              workingDirectory: pageWorkDir,
              additionalDirectories: [repositoryDir, inputDir],
              writableDirectories: [pageOutputDir]
            });
          }
          await assertOnlyDocumentationWorkUnitPage(pageOutputDir, unit.path);
          const body = await readFile(join(pageOutputDir, unit.path), "utf8").catch(() => "");
          if (!body.trim()) throw new Error(`documentation work unit ${unit.id} did not write ${unit.path}`);
          const auditDigest = await verifyPageUnit({ unit, pageOutputDir, pageWorkDir });
          const verifiedBody = await readFile(join(pageOutputDir, unit.path), "utf8");
          const outputDigest = sha256Text(verifiedBody);
          await mkdir(dirname(join(outputDir, unit.path)), { recursive: true });
          await writeFile(join(outputDir, unit.path), verifiedBody);
          await writeJsonAtomically(join(workUnitStateDir, unit.id, "receipt.json"), {
            version: 1,
            id: unit.id,
            role: "writer",
            status: "complete",
            pageIds: [unit.pageId],
            inputDigest,
            outputDigest,
            auditDigest,
            recoveredFromCheckpoint: recovered,
            completedAt: new Date().toISOString()
          });
          await updateWorkUnit(unit.id, (current) => {
            const { lastError: _lastError, ...rest } = current;
            return {
              ...rest,
              status: "verified",
              outputDigest,
              auditDigest,
              updatedAt: new Date().toISOString()
            };
          });
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
          await updateWorkUnit(unit.id, (current) => ({
            ...current,
            status: "failed",
            lastError: message,
            updatedAt: new Date().toISOString()
          }));
          throw error;
        }
      }
    );
    const writerFailure = writerSettlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected"
    );
    if (writerFailure) throw writerFailure.reason;
    await normalizePublicContext(outputDir);

    let citationProblems = await publicMarkdownProblems(outputDir, input);
    for (let pass = 1; pass <= 3 && citationProblems.some(repairableDocumentProblem); pass += 1) {
      const before = citationProblems.filter(repairableDocumentProblem).length;
      await runStage({
        id: `source-link-repair-${pass}`,
        prompt: citationRepairPrompt(
          "derive-output",
          "derive-state",
          "repository",
          citationProblems.filter(repairableDocumentProblem),
          [],
          pass
        ),
        maximumSeconds: positiveInt(process.env.CONTEXT_SOURCE_LINK_REPAIR_SECONDS, 600),
        useMainTranscript: true,
        appendMainTranscript: true
      });
      await normalizePublicContext(outputDir);
      citationProblems = await publicMarkdownProblems(outputDir, input);
      const after = citationProblems.filter(repairableDocumentProblem).length;
      if (after >= before) break;
    }
    const unresolvedCitationProblems = citationProblems.filter(repairableDocumentProblem);
    if (unresolvedCitationProblems.length > 0) {
      throw new Error(
        `public context still has ${unresolvedCitationProblems.length} invalid evidence links after source repair`
      );
    }

    const draftPrompt = draftingStagePrompt({
      basePrompt,
      researchPlanPath,
      documentationPlanPath,
      workerReportPaths: workerRuns.map((worker) => worker.reportPath),
      receiptPath: receiptsPath
    });
    const draft = await runStage({
      id: "draft",
      prompt: draftPrompt,
      maximumSeconds: positiveInt(process.env.CONTEXT_DRAFT_SECONDS, 720),
      useMainTranscript: true
    });
    await normalizePublicContext(outputDir);

    const criticPasses = positiveInt(process.env.CONTEXT_CRITIC_PASSES, 3);
    let latestRun = draft.run;
    const validOrchestration = async (stageLabel: string): Promise<ContextOrchestrationState> => {
      await normalizePublicContext(outputDir);
      let lastError = "orchestration plan is missing";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const state = await readContextOrchestration(stateDir, input);
          if (state) return state;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        const repaired = await runStage({
          id: `contract-repair-${stageLabel}-${attempt}`,
          prompt: [
            basePrompt,
            `This is a pre-critic contract repair. The host rejected derive-state/plan.json after ${stageLabel}: ${lastError}`,
            "Continue from the existing derive-output pages and derive-state plan; do not restart research. Repair the version-4 plan in place. Every subject, including an unsupported or deferred history subject, must contain at least one concrete maintenance question. Keep the phase reviewing or partial because no new context-only critic has run.",
            "Do not edit public Markdown during plan-contract repair. Citation validity is a separate host-gated stage, and changing page bytes here would invalidate its checkpoint.",
            "Preserve every receipt-backed research or source-challenge worker. Do not invent a critic worker, review, result, or passing verdict. Use only relative derive-output and derive-state paths for writes."
          ].join("\n\n"),
          maximumSeconds: positiveInt(process.env.CONTEXT_CONTRACT_REPAIR_SECONDS, 360),
          useMainTranscript: true,
          appendMainTranscript: true
        });
        latestRun = repaired.run;
      }
      try {
        const finalState = await readContextOrchestration(stateDir, input);
        if (finalState) return finalState;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      throw new Error(`draft contract remains invalid after repair: ${lastError}`);
    };

    const citationAuditWorkerId = "citation-audit";
    const ensureCitationAudit = async (
      orchestration: ContextOrchestrationState,
      stageLabel: string
    ): Promise<{
      readonly result: CitationAuditStageResult;
      readonly digest: string;
      readonly resultPath: string;
      readonly publicSnapshotDigest: string;
    }> => {
      const repairPasses = positiveInt(process.env.CONTEXT_CITATION_AUDIT_REPAIR_PASSES, 3);
      for (let attempt = 1; attempt <= repairPasses + 1; attempt += 1) {
        const publicSnapshotDigest = sha256Text(await publicDocumentSnapshot(outputDir));
        const references = await citationAuditReferences(outputDir, repositoryDir, input);
        const inputPayload = citationAuditInputPayload(input, publicSnapshotDigest, references);
        const inputDigest = sha256Text(JSON.stringify(inputPayload));
        const auditInputPath = join(stagesDir, "citation-audit-input.json");
        await writeFile(auditInputPath, `${JSON.stringify({ ...inputPayload, inputDigest }, null, 2)}\n`);
        const expected = {
          workerId: citationAuditWorkerId,
          inputDigest,
          publicSnapshotDigest,
          citationIds: references.map((reference) => reference.citationId)
        };
        const resultPath = join(stagesDir, "citation-audit.json");
        const checkpointPath = join(stagesDir, "citation-audit.checkpoint.json");
        const resumeDirectories = [stagesDir, ...(attempt === 1 && resumableStageDir ? [resumableStageDir] : [])];
        let result: CitationAuditStageResult | undefined;
        for (const directory of resumeDirectories) {
          const candidateText = await readFile(join(directory, "citation-audit.json"), "utf8").catch(() => "");
          const candidateCheckpoint = await readFile(join(directory, "citation-audit.checkpoint.json"), "utf8")
            .then(
              (text) =>
                JSON.parse(text) as {
                  readonly inputDigest?: string;
                  readonly publicSnapshotDigest?: string;
                  readonly outputDigest?: string;
                }
            )
            .catch(() => undefined);
          if (
            !candidateText ||
            candidateCheckpoint?.inputDigest !== inputDigest ||
            candidateCheckpoint.publicSnapshotDigest !== publicSnapshotDigest ||
            candidateCheckpoint.outputDigest !== sha256Text(candidateText)
          ) {
            continue;
          }
          result = await Promise.resolve()
            .then(() => parseCitationAuditStageResult(JSON.parse(candidateText), expected))
            .catch(() => undefined);
          if (result) break;
        }
        if (!result) {
          const batches = citationAuditBatches(references);
          const batchResults = await mapWithConcurrency(
            batches,
            positiveInt(process.env.CONTEXT_CITATION_AUDIT_CONCURRENCY, 3),
            (batch, batchIndex): Promise<CitationAuditStageResult> =>
              runCitationAuditBatch({
                id: `${citationAuditWorkerId}-${stageLabel}-${attempt}-batch-${batchIndex + 1}`,
                workerId: citationAuditWorkerId,
                references: batch,
                inputDigest,
                publicSnapshotDigest,
                maximumSeconds: process.env.CONTEXT_CITATION_AUDIT_SECONDS
                  ? positiveInt(process.env.CONTEXT_CITATION_AUDIT_SECONDS, 600)
                  : Math.min(900, Math.max(300, 180 + batch.length * 4))
              })
          );
          result = {
            version: 1,
            inputDigest,
            publicSnapshotDigest,
            worker: {
              id: citationAuditWorkerId,
              summary: batchResults
                .map((batch) => batch.worker.summary)
                .join(" ")
                .slice(0, 2_000)
            },
            results: batchResults.flatMap((batch) => batch.results),
            summary: batchResults
              .map((batch) => batch.summary)
              .join(" ")
              .slice(0, 4_000)
          };
          result = parseCitationAuditStageResult(result, expected);
        }
        result = await discardInvalidCitationAuditCorrections(result, references, repositoryDir, input);
        const resultText = `${JSON.stringify(result, null, 2)}\n`;
        const digest = sha256Text(resultText);
        await writeFile(resultPath, resultText);
        await writeFile(
          checkpointPath,
          `${JSON.stringify(
            {
              version: 1,
              stage: citationAuditWorkerId,
              repository: input.bundle.checkpoint.repository,
              ref: input.bundle.checkpoint.ref,
              commitSha: input.bundle.checkpoint.commitSha,
              inputDigest,
              publicSnapshotDigest,
              outputDigest: digest,
              citationIds: references.map((reference) => reference.citationId),
              completedAt: new Date().toISOString()
            },
            null,
            2
          )}\n`
        );
        if (!receipts.some((receipt) => receipt.id === citationAuditWorkerId)) {
          receipts.push({ id: citationAuditWorkerId, role: "research", status: "complete" });
          await writeFile(receiptsPath, stageReceiptsJson(receipts));
        }
        const unsupported = result.results.filter((candidate) => candidate.verdict === "unsupported");
        if (unsupported.length === 0) {
          return { result, digest, resultPath, publicSnapshotDigest };
        }
        if (attempt > repairPasses) {
          throw new Error(`citation audit still has ${unsupported.length} unsupported claims after repair`);
        }
        await runStage({
          id: `citation-claim-repair-${stageLabel}-${attempt}`,
          prompt: citationAuditRepairPrompt({
            repositoryDirectory: repositoryDir,
            outputDirectory: outputDir,
            auditInputPath,
            auditResultPath: resultPath,
            unsupportedCitationIds: unsupported.map((candidate) => candidate.citationId)
          }),
          maximumSeconds: positiveInt(process.env.CONTEXT_CITATION_REPAIR_SECONDS, 600),
          useMainTranscript: true,
          appendMainTranscript: true
        });
        await normalizePublicContext(outputDir);
        const structuralProblems = (await publicMarkdownProblems(outputDir, input)).filter(repairableDocumentProblem);
        if (structuralProblems.length > 0) {
          throw new Error(
            `citation audit repair introduced ${structuralProblems.length} invalid public evidence links`
          );
        }
      }
      throw new Error("citation audit did not produce a certifiable result");
    };

    const challengeOrchestration = await validOrchestration("draft");
    let currentCitationAudit = await ensureCitationAudit(challengeOrchestration, "draft");
    const challengeWorkerId = "source-challenge";
    const challengeExistingTasks = sourceChallengeExistingTasks(challengeOrchestration);
    const challengePublicContext = await publicContextSnapshot(outputDir, challengeOrchestration.items);
    const challengePublicSnapshotDigest = sha256Text(challengePublicContext);
    const repositoryInventory = {
      areas: repositoryAreas,
      paths: (input.workspace?.manifest ?? [])
        .filter((entry) => entry.contentAvailable)
        .map((entry) => entry.path)
        .sort()
    };
    const challengeInputDigest = sha256Text(
      JSON.stringify({
        checkpoint: {
          repository: input.bundle.checkpoint.repository,
          ref: input.bundle.checkpoint.ref,
          commitSha: input.bundle.checkpoint.commitSha
        },
        repositoryInventory,
        researchPlan,
        researchPackets,
        existingTasks: challengeExistingTasks,
        publicContext: challengePublicContext
      })
    );
    const parseChallenge = (value: unknown): SourceChallengeStageResult =>
      parseSourceChallengeStageResult(value, {
        workerId: challengeWorkerId,
        inputDigest: challengeInputDigest,
        publicSnapshotDigest: challengePublicSnapshotDigest,
        existingTasks: challengeExistingTasks,
        existingSubjectIds: challengeOrchestration.subjects.map((subject) => subject.id),
        repositoryPaths: repositoryInventory.paths
      });
    let sourceChallenge = resumableStageDir
      ? await readFile(join(resumableStageDir, "source-challenge.json"), "utf8")
          .then((text) => parseChallenge(JSON.parse(text)))
          .catch(() => undefined)
      : undefined;
    if (!sourceChallenge) {
      const challenge = await runStage({
        id: challengeWorkerId,
        prompt: sourceChallengeStagePrompt({
          workerId: challengeWorkerId,
          repository: input.bundle.checkpoint.repository,
          repositoryDirectory: repositoryDir,
          evidencePath: join(inputDir, "evidence.json"),
          repositoryInventory,
          researchPlan,
          researchPackets,
          existingTasks: challengeExistingTasks,
          publicContext: challengePublicContext,
          inputDigest: challengeInputDigest,
          publicSnapshotDigest: challengePublicSnapshotDigest
        }),
        maximumSeconds: positiveInt(process.env.CONTEXT_SOURCE_CHALLENGE_SECONDS, 600),
        schema: SOURCE_CHALLENGE_STAGE_SCHEMA,
        readOnlyResearch: true
      });
      sourceChallenge = parseChallenge(JSON.parse(await readFile(challenge.resultPath, "utf8")));
    }
    await validateSourceChallengeEvidence(sourceChallenge, repositoryDir, input.bundle.items);
    const sourceChallengePath = join(stagesDir, "source-challenge.json");
    const sourceChallengeText = `${JSON.stringify(sourceChallenge, null, 2)}\n`;
    const sourceChallengeDigest = sha256Text(sourceChallengeText);
    await writeFile(sourceChallengePath, sourceChallengeText);
    await writeFile(
      join(stagesDir, "source-challenge.checkpoint.json"),
      `${JSON.stringify(
        {
          version: 1,
          stage: challengeWorkerId,
          repository: input.bundle.checkpoint.repository,
          ref: input.bundle.checkpoint.ref,
          commitSha: input.bundle.checkpoint.commitSha,
          inputDigest: challengeInputDigest,
          publicSnapshotDigest: challengePublicSnapshotDigest,
          outputDigest: sourceChallengeDigest,
          materialTaskIds: sourceChallenge.addedTasks.filter((task) => task.material).map((task) => task.id),
          completedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
    receipts.push({ id: challengeWorkerId, role: "research", status: "complete" });
    await writeFile(receiptsPath, stageReceiptsJson(receipts));

    for (let pass = 1; pass <= criticPasses; pass += 1) {
      const orchestration = await validOrchestration(pass === 1 ? "draft" : `integration-${pass - 1}`);
      if (pass > 1) currentCitationAudit = await ensureCitationAudit(orchestration, `critic-${pass}`);
      const workerId = `critic-pass-${pass}`;
      const questions = criticQuestionCatalog(orchestration, sourceChallenge);
      const publicContext = await publicContextSnapshot(outputDir, orchestration.items);
      const snapshotDigest = sha256Text(publicContext);
      const taskCatalogDigest = sha256Text(questions);
      const questionIds = criticQuestionIds(orchestration, sourceChallenge);
      const requiredAnswerPartsByQuestionId = Object.fromEntries(
        sourceChallenge.addedTasks.filter((task) => task.material).map((task) => [task.id, task.requiredAnswerParts])
      );
      const critic = await runStage({
        id: workerId,
        prompt: criticStagePrompt({
          workerId,
          questions,
          publicContext,
          snapshotDigest,
          taskCatalogDigest
        }),
        maximumSeconds: process.env.CONTEXT_CRITIC_SECONDS
          ? positiveInt(process.env.CONTEXT_CRITIC_SECONDS, 600)
          : Math.min(1_200, Math.max(600, 300 + questionIds.length * 8)),
        schema: CRITIC_STAGE_SCHEMA,
        contextOnly: true
      });
      const criticResult = parseCriticStageResult(JSON.parse(await readFile(critic.resultPath, "utf8")), workerId, {
        snapshotDigest,
        taskCatalogDigest,
        questionIds,
        requiredAnswerPartsByQuestionId
      });
      const criticResultPath = join(stagesDir, `${workerId}.json`);
      await writeFile(criticResultPath, `${JSON.stringify(criticResult, null, 2)}\n`);
      receipts.push({ id: workerId, role: "critic", status: "complete" });
      await writeFile(receiptsPath, stageReceiptsJson(receipts));

      const allPassed = criticResult.review.results.every((result) => result.verdict === "pass");
      const isLastPass = pass === criticPasses || allPassed;
      const integration = await runStage({
        id: `integrate-${pass}`,
        prompt: criticIntegrationPrompt({
          basePrompt,
          criticResultPath,
          receiptPath: receiptsPath,
          sourceChallengeResultPath: sourceChallengePath,
          citationAuditResultPath: currentCitationAudit.resultPath,
          finalPass: isLastPass
        }),
        maximumSeconds: positiveInt(process.env.CONTEXT_INTEGRATION_SECONDS, 480),
        useMainTranscript: true,
        appendMainTranscript: true
      });
      latestRun = integration.run;
      await normalizePublicContext(outputDir);
      if (allPassed) {
        const integratedOrchestration = await validOrchestration(`integration-${pass}`);
        const integratedSnapshot = await publicContextSnapshot(outputDir, integratedOrchestration.items);
        const integratedPublicDocumentDigest = sha256Text(await publicDocumentSnapshot(outputDir));
        const promotionDiagnostics = sourceChallengePromotionDiagnostics(integratedOrchestration, sourceChallenge);
        const integratedCatalogDigest = sha256Text(criticQuestionCatalog(integratedOrchestration, sourceChallenge));
        if (
          sha256Text(integratedSnapshot) === snapshotDigest &&
          integratedCatalogDigest === taskCatalogDigest &&
          currentCitationAudit.publicSnapshotDigest === integratedPublicDocumentDigest &&
          promotionDiagnostics.length === 0
        ) {
          await writeFile(
            join(stagesDir, "certification.json"),
            `${JSON.stringify(
              {
                version: 1,
                workerId,
                snapshotDigest,
                taskCatalogDigest,
                questionIds,
                sourceChallengeDigest,
                citationAuditDigest: currentCitationAudit.digest,
                certifiedAt: new Date().toISOString()
              },
              null,
              2
            )}\n`
          );
          break;
        }
        console.warn("context_critic_certification_invalidated", {
          repository: input.bundle.checkpoint.repository,
          pass,
          workerId,
          publicSnapshotChanged: sha256Text(integratedSnapshot) !== snapshotDigest,
          citationAuditSnapshotChanged: currentCitationAudit.publicSnapshotDigest !== integratedPublicDocumentDigest,
          taskCatalogChanged: integratedCatalogDigest !== taskCatalogDigest,
          promotionDiagnostics
        });
      }
    }
    return latestRun;
  }

  private async collect(
    outputDir: string,
    stateDir: string,
    input: KnowledgeDocumentGenerationInput,
    secrets: readonly string[],
    repositoryDir: string
  ): Promise<ReturnType<typeof withHostCheckedOrchestration>> {
    const parsed: ParsedMarkdownDocument[] = [];
    const retiredDocumentPaths: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(join(outputDir, relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".")) {
            throw new Error(`Derived context output contains an internal directory: ${child}`);
          }
          await walk(child);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
          throw new Error(`Derived context output contains a non-document artifact: ${child}`);
        }
        const text = await readFile(join(outputDir, child), "utf8");
        if (secrets.some((secret) => text.includes(secret))) {
          throw new Error("Codex knowledge generation output contained a protected credential");
        }
        parsed.push(parseMarkdownDocument(documentPathFromFile(child), text));
      }
    };
    await walk("");
    const collectRetired = async (relative: string): Promise<void> => {
      const directory = join(stateDir, "retired", relative);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await collectRetired(child);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          retiredDocumentPaths.push(documentPathFromFile(child));
        }
      }
    };
    await collectRetired("");
    let orchestrationError: string | undefined;
    const orchestration = await readContextOrchestration(stateDir, input).catch((error: unknown) => {
      orchestrationError = error instanceof Error ? error.message : String(error);
      console.warn("knowledge_orchestration_invalid", {
        repository: input.bundle.checkpoint.repository,
        error: orchestrationError
      });
      return undefined;
    });
    const converted = markdownCatalogToOutput(
      parsed,
      input.bundle.checkpoint.repository,
      input.workspace?.manifest ?? [],
      checkpointReferenceVerifier(repositoryDir),
      input.bundle.items,
      retiredDocumentPaths,
      orchestration,
      { naturalEvidenceLabels: true }
    );
    const checked = withHostCheckedOrchestration(converted, parsed, input);
    const hostChecked = orchestrationError
      ? {
          ...checked,
          orchestrationDiagnostics: [`orchestration plan is invalid: ${orchestrationError}`]
        }
      : checked;
    const receiptText = await readFile(join(stateDir, "agent-stages", "receipts.json"), "utf8").catch(() => "");
    if (receiptText) {
      const receiptValue = JSON.parse(receiptText) as { readonly workers?: readonly AgentStageReceipt[] };
      const receiptChecked = withAgentStageReceiptDiagnostics(hostChecked, receiptValue.workers ?? []);
      return await withLocalCriticCertification(receiptChecked, outputDir, stateDir, repositoryDir, input);
    }
    const transcript = await readFile(join(stateDir, "transcript.log"), "utf8").catch(() => "");
    return withCollaborationTranscriptDiagnostics(hostChecked, transcript);
  }
}

function sourceChallengeExistingTasks(orchestration: ContextOrchestrationState): {
  readonly id: string;
  readonly question: string;
  readonly priority: "required" | "supporting";
}[] {
  return orchestration.subjects
    .flatMap((subject) =>
      subject.questions.map((question) => ({
        id: question.id,
        question: question.question,
        priority: question.priority
      }))
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function criticQuestionIds(orchestration: ContextOrchestrationState, challenge?: SourceChallengeStageResult): string[] {
  return [
    ...new Set([
      ...sourceChallengeExistingTasks(orchestration).map((task) => task.id),
      ...(challenge?.addedTasks.filter((task) => task.material).map((task) => task.id) ?? [])
    ])
  ].sort();
}

function criticQuestionCatalog(
  orchestration: ContextOrchestrationState,
  challenge?: SourceChallengeStageResult
): string {
  const challengedTaskById = new Map(
    challenge?.addedTasks.filter((task) => task.material).map((task) => [task.id, task]) ?? []
  );
  const questions = sourceChallengeExistingTasks(orchestration).map((task) => {
    const challenged = challengedTaskById.get(task.id);
    challengedTaskById.delete(task.id);
    return {
      questionId: task.id,
      question: challenged?.question ?? task.question,
      priority: challenged ? "required" : task.priority,
      origin: challenged ? "source_challenge" : "durable_plan",
      ...(challenged
        ? {
            intent: challenged.intent,
            requiredAnswerParts: challenged.requiredAnswerParts
          }
        : {})
    };
  });
  for (const challenged of challengedTaskById.values()) {
    questions.push({
      questionId: challenged.id,
      question: challenged.question,
      priority: "required",
      origin: "source_challenge",
      intent: challenged.intent,
      requiredAnswerParts: challenged.requiredAnswerParts
    });
  }
  questions.sort((left, right) => left.questionId.localeCompare(right.questionId));
  const pages = orchestration.items
    .map((item) => ({
      pageId: item.id,
      path: item.path,
      title: item.title,
      purpose: item.purpose
    }))
    .sort((left, right) => left.pageId.localeCompare(right.pageId));
  return JSON.stringify({ questions, pages }, null, 2);
}

async function publicContextSnapshot(outputDir: string, items: ContextOrchestrationState["items"]): Promise<string> {
  const pages: string[] = [];
  for (const item of items) {
    const path = join(outputDir, item.path);
    const body = await readFile(path, "utf8").catch(() => "");
    if (!body.trim()) continue;
    pages.push(`===== PAGE ${item.id} (${item.path}) =====\n${body.trim()}`);
  }
  if (pages.length === 0) throw new Error("context-only critic has no public pages to review");
  return pages.join("\n\n");
}

async function publicDocumentSnapshot(outputDir: string): Promise<string> {
  const pages: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(outputDir, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(child);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const body = await readFile(join(outputDir, child), "utf8");
      pages.push(`===== DOCUMENT ${child} =====\n${body}`);
    }
  };
  await walk("");
  if (pages.length === 0) throw new Error("citation audit has no public Markdown snapshot");
  return pages.join("\n\n");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createDocumentationWorkLedger(input: {
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly planDigest: string;
  readonly units: readonly (DocumentationPageWorkUnit & { readonly inputDigest: string })[];
}): DocumentationWorkLedger {
  const updatedAt = new Date().toISOString();
  return {
    version: 1,
    repository: input.repository.toLowerCase(),
    ref: input.ref,
    commitSha: input.commitSha.toLowerCase(),
    planDigest: input.planDigest,
    status: "planned",
    units: input.units.map((unit) => ({
      ...unit,
      status: "pending",
      attempts: 0,
      updatedAt
    })),
    updatedAt
  };
}

export async function readDocumentationWorkLedger(
  path: string,
  expected: {
    readonly repository: string;
    readonly ref: string;
    readonly commitSha: string;
    readonly planDigest: string;
    readonly units: readonly (DocumentationPageWorkUnit & { readonly inputDigest: string })[];
  }
): Promise<DocumentationWorkLedger | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<DocumentationWorkLedger>;
    if (
      parsed.version !== 1 ||
      parsed.repository?.toLowerCase() !== expected.repository.toLowerCase() ||
      parsed.ref !== expected.ref ||
      parsed.commitSha?.toLowerCase() !== expected.commitSha.toLowerCase() ||
      parsed.planDigest !== expected.planDigest ||
      !Array.isArray(parsed.units) ||
      parsed.units.length !== expected.units.length
    ) {
      return undefined;
    }
    const expectedById = new Map(expected.units.map((unit) => [unit.id, unit]));
    const seen = new Set<string>();
    const units: DocumentationWorkUnitCheckpoint[] = [];
    for (const candidate of parsed.units) {
      const unit = candidate as DocumentationWorkUnitCheckpoint;
      const planned = expectedById.get(unit.id);
      if (
        !planned ||
        seen.has(unit.id) ||
        unit.pageId !== planned.pageId ||
        unit.path !== planned.path ||
        unit.sourceWriterId !== planned.sourceWriterId ||
        unit.objective !== planned.objective ||
        JSON.stringify(unit.dependencies) !== JSON.stringify(planned.dependencies) ||
        unit.inputDigest !== planned.inputDigest ||
        !["pending", "working", "verified", "failed"].includes(unit.status) ||
        !Number.isSafeInteger(unit.attempts) ||
        unit.attempts < 0 ||
        typeof unit.updatedAt !== "string" ||
        (unit.outputDigest !== undefined && !/^[a-f0-9]{64}$/.test(unit.outputDigest)) ||
        (unit.auditDigest !== undefined && !/^[a-f0-9]{64}$/.test(unit.auditDigest)) ||
        (unit.lastError !== undefined && typeof unit.lastError !== "string")
      ) {
        return undefined;
      }
      seen.add(unit.id);
      units.push(
        unit.status === "working"
          ? {
              ...unit,
              status: "pending",
              updatedAt: new Date().toISOString()
            }
          : unit
      );
    }
    return {
      version: 1,
      repository: expected.repository.toLowerCase(),
      ref: expected.ref,
      commitSha: expected.commitSha.toLowerCase(),
      planDigest: expected.planDigest,
      status: documentationWorkLedgerStatus(units),
      units,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
    };
  } catch {
    return undefined;
  }
}

export function documentationWorkLedgerStatus(
  units: readonly DocumentationWorkUnitCheckpoint[]
): DocumentationWorkLedger["status"] {
  if (units.length > 0 && units.every((unit) => unit.status === "verified")) return "complete";
  if (units.some((unit) => unit.status === "failed")) return "partial";
  if (units.some((unit) => unit.status === "working" || unit.status === "verified")) return "working";
  return "planned";
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertOnlyDocumentationWorkUnitPage(outputDirectory: string, expectedPath: string): Promise<void> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(outputDirectory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`documentation work unit emitted a symbolic link: ${child}`);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) {
          throw new Error(`documentation work unit emitted an internal directory: ${child}`);
        }
        await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      } else {
        throw new Error(`documentation work unit emitted an unsupported artifact: ${child}`);
      }
    }
  };
  await walk("");
  if (files.length !== 1 || files[0] !== expectedPath) {
    throw new Error(
      `documentation work unit must emit only ${expectedPath}; observed ${files.length > 0 ? files.join(", ") : "no files"}`
    );
  }
}

async function documentationWorkUnitAuditMatches(options: {
  readonly checkpointDirectory: string;
  readonly auditDigest: string;
  readonly outputDirectory: string;
  readonly unit: DocumentationPageWorkUnit;
  readonly repositoryDirectory: string;
  readonly input: KnowledgeDocumentGenerationInput;
}): Promise<boolean> {
  const scratch = await mkdtemp(join(tmpdir(), "jina-context-unit-audit-"));
  try {
    const body = await readFile(join(options.outputDirectory, options.unit.path), "utf8");
    await mkdir(dirname(join(scratch, options.unit.path)), { recursive: true });
    await writeFile(join(scratch, options.unit.path), body);
    const resultText = await readFile(join(options.checkpointDirectory, "citation-audit.json"), "utf8");
    if (sha256Text(resultText) !== options.auditDigest) return false;
    const checkpoint = JSON.parse(
      await readFile(join(options.checkpointDirectory, "citation-audit.checkpoint.json"), "utf8")
    ) as {
      readonly inputDigest?: string;
      readonly publicSnapshotDigest?: string;
      readonly outputDigest?: string;
      readonly citationIds?: readonly string[];
    };
    const publicSnapshotDigest = sha256Text(await publicDocumentSnapshot(scratch));
    const references = await citationAuditReferences(scratch, options.repositoryDirectory, options.input);
    const inputDigest = sha256Text(
      JSON.stringify(citationAuditInputPayload(options.input, publicSnapshotDigest, references))
    );
    const citationIds = references.map((reference) => reference.citationId);
    if (
      checkpoint.inputDigest !== inputDigest ||
      checkpoint.publicSnapshotDigest !== publicSnapshotDigest ||
      checkpoint.outputDigest !== options.auditDigest ||
      JSON.stringify(checkpoint.citationIds) !== JSON.stringify(citationIds)
    ) {
      return false;
    }
    const result = parseCitationAuditStageResult(JSON.parse(resultText), {
      workerId: `citation-audit-${options.unit.pageId}`,
      inputDigest,
      publicSnapshotDigest,
      citationIds
    });
    return result.results.every((candidate) => candidate.verdict === "supported");
  } catch {
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

function citationAuditInputPayload(
  input: KnowledgeDocumentGenerationInput,
  publicSnapshotDigest: string,
  references: readonly CitationAuditReference[]
): {
  readonly version: 1;
  readonly checkpoint: {
    readonly repository: string;
    readonly ref: string;
    readonly commitSha: string;
    readonly evidenceFingerprint: string;
    readonly manifestFingerprint: string;
  };
  readonly publicSnapshotDigest: string;
  readonly references: readonly CitationAuditReference[];
} {
  return {
    version: 1,
    checkpoint: {
      repository: input.bundle.checkpoint.repository,
      ref: input.bundle.checkpoint.ref,
      commitSha: input.bundle.checkpoint.commitSha,
      evidenceFingerprint: input.bundle.checkpoint.evidenceFingerprint,
      manifestFingerprint: input.bundle.checkpoint.manifestFingerprint
    },
    publicSnapshotDigest,
    references
  };
}

function recoverableDocumentationPage(path: string, body: string): boolean {
  const trimmed = body.trimEnd();
  if (trimmed.length < 400 || !/^#\s+\S/m.test(trimmed)) return false;
  const parsed = parseMarkdownDocument(documentPathFromFile(path), trimmed);
  if (parsed.evidenceLinks.length === 0) return false;
  const fences = trimmed.match(/^(?:```|~~~)/gm)?.length ?? 0;
  if (fences % 2 !== 0) return false;
  const last = trimmed.split(/\r?\n/).at(-1)?.trim() ?? "";
  return /[.!?:;)\]}`]$/.test(last) || /^(?:```|~~~)$/.test(last);
}

function safeRepositoryEvidencePath(path: string): boolean {
  return (
    !isAbsolute(path) &&
    path.length > 0 &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

async function normalizePublicContext(outputDir: string): Promise<void> {
  const walk = async (relative: string): Promise<void> => {
    const directory = join(outputDir, relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(child);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const path = join(outputDir, child);
      const original = await readFile(path, "utf8");
      const normalized = normalizeMarkdownEvidenceTargets(original);
      if (normalized !== original) await writeFile(path, normalized);
    }
  };
  await walk("");
}

async function publicMarkdownProblems(
  outputDir: string,
  input: KnowledgeDocumentGenerationInput
): Promise<readonly MarkdownOutputProblem[]> {
  const documents: ParsedMarkdownDocument[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(outputDir, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(child);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        documents.push(
          parseMarkdownDocument(documentPathFromFile(child), await readFile(join(outputDir, child), "utf8"))
        );
      }
    }
  };
  await walk("");
  return markdownCatalogToOutput(
    documents,
    input.bundle.checkpoint.repository,
    input.workspace?.manifest ?? [],
    checkpointReferenceVerifier(input.workspace?.repositoryDirectory),
    input.bundle.items,
    [],
    undefined,
    { naturalEvidenceLabels: true }
  ).problems;
}

function normalizedProviderUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function providerEvidenceForUrl(
  providerUrl: string,
  items: KnowledgeDocumentGenerationInput["bundle"]["items"]
): KnowledgeDocumentGenerationInput["bundle"]["items"][number] | undefined {
  const target = normalizedProviderUrl(providerUrl);
  if (!target) return undefined;
  const candidates = items.filter((item) => {
    const observed = item.anchor.pathOrUrl ? normalizedProviderUrl(item.anchor.pathOrUrl) : undefined;
    if (observed === target) return true;
    return item.anchor.sourceType === "commit" && target.endsWith(`/commit/${item.anchor.sourceId}`);
  });
  const identities = new Map(
    candidates.map((candidate) => [
      `${candidate.anchor.sourceType}\u0000${candidate.anchor.sourceId}\u0000${candidate.anchor.contentDigest}`,
      candidate
    ])
  );
  if (identities.size !== 1) return undefined;
  return [...identities.values()][0];
}

async function citationAuditReferences(
  outputDir: string,
  repositoryDir: string,
  input: KnowledgeDocumentGenerationInput
): Promise<CitationAuditReference[]> {
  const documents: ParsedMarkdownDocument[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(outputDir, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(child);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        documents.push(
          parseMarkdownDocument(documentPathFromFile(child), await readFile(join(outputDir, child), "utf8"))
        );
      }
    }
  };
  await walk("");

  const manifestByPath = new Map(
    (input.workspace?.manifest ?? []).filter((entry) => entry.contentAvailable).map((entry) => [entry.path, entry])
  );
  const fileCache = new Map<string, string>();
  const references: CitationAuditReference[] = [];
  const ids = new Set<string>();
  for (const document of documents.sort((left, right) => left.documentPath.localeCompare(right.documentPath))) {
    const documentCitationIds = new Set(document.evidenceLinks.map((link) => link.citationId));
    const materialClaims = document.materialClaims.filter((claim) => claim.classification === "material");
    const auditableCitationIds = new Set(materialClaims.flatMap((claim) => claim.citationIds));
    const claimIdByCitationId = new Map(
      materialClaims.flatMap((claim) => claim.citationIds.map((citationId) => [citationId, claim.claimId] as const))
    );
    const groundedSummary = document.materialClaims
      .filter((claim) => claim.summary && claim.classification === "material")
      .flatMap((claim) => claim.citationIds)
      .some((citationId) => documentCitationIds.has(citationId));
    if (!groundedSummary) {
      throw new Error(`citation audit found an ungrounded lead summary in ${document.documentPath}`);
    }
    for (const section of markdownEvidenceSections(document.bodyMarkdown)) {
      if (section.substantiveClaimCount === 0) continue;
      if (section.citationIds.some((citationId) => documentCitationIds.has(citationId))) continue;
      throw new Error(
        `citation audit found an ungrounded substantive section in ${document.documentPath}: ${section.heading}`
      );
    }
    for (const link of document.evidenceLinks) {
      if (!auditableCitationIds.has(link.citationId)) continue;
      if (ids.has(link.citationId)) throw new Error(`citation audit identity collision: ${link.citationId}`);
      ids.add(link.citationId);
      if (link.providerUrl) {
        const provider = providerEvidenceForUrl(link.providerUrl, input.bundle.items);
        if (!provider) {
          throw new Error(`citation audit cannot bind provider target to one captured record: ${link.providerUrl}`);
        }
        if (sha256Text(provider.body) !== provider.anchor.contentDigest) {
          throw new Error(`citation audit provider bytes differ from checkpoint evidence: ${link.providerUrl}`);
        }
        references.push({
          citationId: link.citationId,
          claimId: claimIdByCitationId.get(link.citationId)!,
          documentPath: `${document.documentPath}.md`,
          label: link.claim,
          claimSpan: link.claimSpan,
          target: link.providerUrl,
          sourceType: provider.anchor.sourceType,
          sourceId: provider.anchor.sourceId,
          contentDigest: provider.anchor.contentDigest,
          ...(provider.anchor.pathOrUrl ? { pathOrUrl: provider.anchor.pathOrUrl } : {}),
          jsonPointer: "",
          excerpt: provider.body
        });
        continue;
      }
      if (
        link.path === undefined ||
        link.startLine === undefined ||
        link.endLine === undefined ||
        !safeRepositoryEvidencePath(link.path)
      ) {
        throw new Error(`citation audit found an invalid repository target in ${document.documentPath}`);
      }
      const manifest = manifestByPath.get(link.path);
      if (!manifest) throw new Error(`citation audit path is absent from checkpoint manifest: ${link.path}`);
      if (link.endLine < link.startLine || link.endLine - link.startLine + 1 > 120) {
        throw new Error(`citation audit range is invalid or exceeds 120 lines: ${link.path}`);
      }
      let body = fileCache.get(link.path);
      if (body === undefined) {
        body = await readFile(join(repositoryDir, link.path), "utf8");
        if (sha256Text(body) !== manifest.contentDigest) {
          throw new Error(`citation audit source bytes differ from checkpoint manifest: ${link.path}`);
        }
        fileCache.set(link.path, body);
      }
      const lines = body.split(/\r?\n/);
      if (link.endLine > lines.length) {
        throw new Error(`citation audit range exceeds checkpoint source: ${link.path}#L${link.endLine}`);
      }
      references.push({
        citationId: link.citationId,
        claimId: claimIdByCitationId.get(link.citationId)!,
        documentPath: `${document.documentPath}.md`,
        label: link.claim,
        claimSpan: link.claimSpan,
        target: `${link.path}#L${link.startLine}${link.endLine === link.startLine ? "" : `-L${link.endLine}`}`,
        sourceType: "blob",
        sourceId: manifest.blobSha,
        contentDigest: manifest.contentDigest,
        pathOrUrl: link.path,
        startLine: link.startLine,
        endLine: link.endLine,
        excerpt: lines.slice(link.startLine - 1, link.endLine).join("\n")
      });
    }
  }
  const maximum = positiveInt(process.env.CONTEXT_CITATION_AUDIT_MAX_REFERENCES, 500);
  if (references.length === 0) throw new Error("citation audit has no public evidence links");
  if (references.length > Math.min(maximum, 500)) {
    throw new Error(`citation audit has ${references.length} references; maximum is ${Math.min(maximum, 500)}`);
  }
  return references;
}

function citationAuditBatches(references: readonly CitationAuditReference[]): CitationAuditReference[][] {
  const maximumReferences = Math.min(100, positiveInt(process.env.CONTEXT_CITATION_AUDIT_BATCH_REFERENCES, 60));
  const maximumBytes = positiveInt(process.env.CONTEXT_CITATION_AUDIT_BATCH_BYTES, 100_000);
  const batches: CitationAuditReference[][] = [];
  let batch: CitationAuditReference[] = [];
  let batchBytes = 2;
  for (const group of citationAuditReferenceGroups(references)) {
    const bytes = group.reduce(
      (total, reference) => total + Buffer.byteLength(JSON.stringify(reference), "utf8") + 1,
      0
    );
    if (group.length > maximumReferences || bytes > maximumBytes) {
      throw new Error(
        `citation audit claim ${group[0]?.claimId ?? "unknown"} has ${group.length} references and ${bytes} bytes; per-stage maximum is ${maximumReferences} references and ${maximumBytes} bytes`
      );
    }
    if (batch.length > 0 && (batch.length + group.length > maximumReferences || batchBytes + bytes > maximumBytes)) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
    }
    batch.push(...group);
    batchBytes += bytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function discardInvalidCitationAuditCorrections(
  audit: CitationAuditStageResult,
  references: readonly CitationAuditReference[],
  repositoryDir: string,
  input: KnowledgeDocumentGenerationInput
): Promise<CitationAuditStageResult> {
  const referenceById = new Map(references.map((reference) => [reference.citationId, reference]));
  const manifestByPath = new Map(
    (input.workspace?.manifest ?? []).filter((entry) => entry.contentAvailable).map((entry) => [entry.path, entry])
  );
  const results: CitationAuditStageResult["results"][number][] = [];
  for (const result of audit.results) {
    const correction = result.correction;
    if (!correction) {
      results.push(result);
      continue;
    }
    try {
      const reference = referenceById.get(result.citationId);
      if (!reference) throw new Error(`citation audit correction names unknown citation ${result.citationId}`);
      let excerpt = reference.excerpt;
      if (correction.path !== null) {
        if (
          !safeRepositoryEvidencePath(correction.path) ||
          correction.startLine === null ||
          correction.endLine === null
        ) {
          throw new Error(`citation audit correction has unsafe repository target for ${result.citationId}`);
        }
        const manifest = manifestByPath.get(correction.path);
        if (!manifest) throw new Error(`citation audit correction path is absent from manifest: ${correction.path}`);
        const body = await readFile(join(repositoryDir, correction.path), "utf8");
        if (sha256Text(body) !== manifest.contentDigest) {
          throw new Error(`citation audit correction bytes differ from manifest: ${correction.path}`);
        }
        const lines = body.split(/\r?\n/);
        if (correction.endLine > lines.length) {
          throw new Error(`citation audit correction range exceeds source: ${correction.path}`);
        }
        excerpt = lines.slice(correction.startLine - 1, correction.endLine).join("\n");
      } else if (correction.providerUrl !== null) {
        const provider = providerEvidenceForUrl(correction.providerUrl, input.bundle.items);
        if (!provider) {
          throw new Error(`citation audit correction provider URL is not uniquely captured: ${correction.providerUrl}`);
        }
        excerpt = provider.body;
      }
      if (correction.exactSourceAnchor !== null && !excerpt.includes(correction.exactSourceAnchor)) {
        throw new Error(`citation audit correction source anchor is absent for ${result.citationId}`);
      }
      results.push(result);
    } catch {
      // Corrections are optional private hints. Preserve the fail-closed
      // unsupported verdict, but never pass an unverified path, range, URL, or
      // source anchor to the repair agent.
      results.push({ ...result, correction: null });
    }
  }
  return { ...audit, results };
}

async function validateSourceChallengeEvidence(
  challenge: SourceChallengeStageResult,
  repositoryDir: string,
  evidenceItems: KnowledgeDocumentGenerationInput["bundle"]["items"]
): Promise<void> {
  const evidence = [
    ...challenge.addedTasks.flatMap((task) => task.evidence),
    ...challenge.omittedSubjects.flatMap((subject) => subject.evidence)
  ];
  for (const item of evidence) {
    if (["code", "tests", "configuration", "documentation"].includes(item.source)) {
      const body = await readFile(join(repositoryDir, item.reference), "utf8").catch(() => "");
      if (!body.includes(item.exactQuote)) {
        throw new Error(
          `source challenge evidence quote is absent from checkpoint path ${item.reference}: ${item.exactQuote}`
        );
      }
      continue;
    }
    const supported = evidenceItems.some(
      (candidate) =>
        candidate.anchor.sourceType === item.source &&
        [candidate.evidenceId, candidate.anchor.sourceId, candidate.anchor.pathOrUrl].includes(item.reference) &&
        [candidate.title, candidate.body, JSON.stringify(candidate.metadata)].some((value) =>
          value.includes(item.exactQuote)
        )
    );
    if (!supported) {
      throw new Error(
        `source challenge provider evidence is absent from the captured checkpoint: ${item.source} ${item.reference}`
      );
    }
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  requestedConcurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const concurrency = Math.max(1, Math.min(requestedConcurrency, values.length));
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(values[index] as T, index);
      }
    })
  );
  return results;
}

async function settledMapWithConcurrency<T, R>(
  values: readonly T[],
  requestedConcurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(values, requestedConcurrency, async (value, index) => {
    try {
      return { status: "fulfilled", value: await worker(value, index) } as const;
    } catch (reason) {
      return { status: "rejected", reason } as const;
    }
  });
}

async function withLocalCriticCertification(
  converted: HostCheckedMarkdownOutputConversion,
  outputDir: string,
  stateDir: string,
  repositoryDir: string,
  input: KnowledgeDocumentGenerationInput
): Promise<HostCheckedMarkdownOutputConversion> {
  const orchestration = converted.output.orchestration;
  if (!orchestration || orchestration.phase !== "complete") return converted;
  const certificationPath = join(stateDir, "agent-stages", "certification.json");
  const certification = await readFile(certificationPath, "utf8")
    .then(
      (text) =>
        JSON.parse(text) as {
          readonly snapshotDigest?: string;
          readonly taskCatalogDigest?: string;
          readonly questionIds?: readonly string[];
          readonly sourceChallengeDigest?: string;
          readonly citationAuditDigest?: string;
        }
    )
    .catch(() => undefined);
  const sourceChallengeText = await readFile(join(stateDir, "agent-stages", "source-challenge.json"), "utf8").catch(
    () => ""
  );
  const sourceChallenge = sourceChallengeText
    ? await Promise.resolve()
        .then(() => JSON.parse(sourceChallengeText) as SourceChallengeStageResult)
        .catch(() => undefined)
    : undefined;
  const sourceChallengeCheckpoint = await readFile(
    join(stateDir, "agent-stages", "source-challenge.checkpoint.json"),
    "utf8"
  )
    .then(
      (text) =>
        JSON.parse(text) as {
          readonly inputDigest?: string;
          readonly publicSnapshotDigest?: string;
          readonly outputDigest?: string;
        }
    )
    .catch(() => undefined);
  const sourceChallengeDigest = sourceChallengeText ? sha256Text(sourceChallengeText) : undefined;
  const citationAuditText = await readFile(join(stateDir, "agent-stages", "citation-audit.json"), "utf8").catch(
    () => ""
  );
  const citationAuditCheckpoint = await readFile(
    join(stateDir, "agent-stages", "citation-audit.checkpoint.json"),
    "utf8"
  )
    .then(
      (text) =>
        JSON.parse(text) as {
          readonly inputDigest?: string;
          readonly publicSnapshotDigest?: string;
          readonly outputDigest?: string;
          readonly citationIds?: readonly string[];
        }
    )
    .catch(() => undefined);
  const citationAuditInput = await readFile(join(stateDir, "agent-stages", "citation-audit-input.json"), "utf8")
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch(() => undefined);
  const citationAudit =
    citationAuditText &&
    citationAuditCheckpoint?.inputDigest &&
    citationAuditCheckpoint.publicSnapshotDigest &&
    citationAuditCheckpoint.citationIds
      ? await Promise.resolve()
          .then(() =>
            parseCitationAuditStageResult(JSON.parse(citationAuditText), {
              workerId: "citation-audit",
              inputDigest: citationAuditCheckpoint.inputDigest!,
              publicSnapshotDigest: citationAuditCheckpoint.publicSnapshotDigest!,
              citationIds: citationAuditCheckpoint.citationIds!
            })
          )
          .catch(() => undefined)
      : undefined;
  const citationAuditDigest = citationAuditText ? sha256Text(citationAuditText) : undefined;
  let citationAuditInputDigest: string | undefined;
  let persistedCitationIds: string[] | undefined;
  if (citationAuditInput) {
    const { inputDigest: _declaredInputDigest, ...inputPayload } = citationAuditInput;
    citationAuditInputDigest = sha256Text(JSON.stringify(inputPayload));
    if (Array.isArray(citationAuditInput.references)) {
      const ids = citationAuditInput.references.map((reference) =>
        reference &&
        typeof reference === "object" &&
        typeof (reference as Record<string, unknown>).citationId === "string"
          ? String((reference as Record<string, unknown>).citationId)
          : undefined
      );
      if (ids.every((id): id is string => id !== undefined)) persistedCitationIds = ids;
    }
  }
  const currentSnapshotDigest = sha256Text(await publicContextSnapshot(outputDir, orchestration.items));
  const currentPublicDocumentDigest = sha256Text(await publicDocumentSnapshot(outputDir));
  let expectedCitationAuditInputDigest: string | undefined;
  let currentCitationIds: string[] | undefined;
  try {
    const currentReferences = await citationAuditReferences(outputDir, repositoryDir, input);
    currentCitationIds = currentReferences.map((reference) => reference.citationId);
    expectedCitationAuditInputDigest = sha256Text(
      JSON.stringify(citationAuditInputPayload(input, currentPublicDocumentDigest, currentReferences))
    );
  } catch {
    // The diagnostic below downgrades a claimed-complete run. Conversion already
    // reports the actionable path/range problem; certification must simply fail
    // closed when the exact current audit input cannot be rebuilt.
  }
  const currentCatalogDigest = sha256Text(criticQuestionCatalog(orchestration, sourceChallenge));
  const currentQuestionIds = criticQuestionIds(orchestration, sourceChallenge);
  const certifiedQuestionIds = [...(certification?.questionIds ?? [])].sort();
  const promotionDiagnostics = sourceChallenge
    ? sourceChallengePromotionDiagnostics(orchestration, sourceChallenge)
    : [];
  const citationAuditWorker = orchestration.workers.find((worker) => worker.id === "citation-audit");
  const citationAuditDiagnostic = citationAuditCertificationDiagnostic({
    certificationDigest: certification?.citationAuditDigest,
    audit: citationAudit,
    auditDigest: citationAuditDigest,
    checkpoint: citationAuditCheckpoint,
    persistedInputDigest: citationAuditInputDigest,
    persistedCitationIds,
    expectedInputDigest: expectedCitationAuditInputDigest,
    currentCitationIds,
    currentPublicSnapshotDigest: currentPublicDocumentDigest,
    worker: citationAuditWorker
  });
  const diagnostic = !certification
    ? "complete orchestration has no digest-bound context-only critic certification"
    : !sourceChallenge || !sourceChallengeCheckpoint || !sourceChallengeDigest
      ? "complete orchestration has no persisted source-aware challenge checkpoint"
      : citationAuditDiagnostic
        ? citationAuditDiagnostic
        : sourceChallengeCheckpoint.inputDigest !== sourceChallenge.inputDigest ||
            sourceChallengeCheckpoint.publicSnapshotDigest !== sourceChallenge.publicSnapshotDigest
          ? "source-aware challenge checkpoint input digests do not match its result"
          : sourceChallengeCheckpoint.outputDigest !== sourceChallengeDigest
            ? "source-aware challenge checkpoint output digest does not match its result"
            : certification.sourceChallengeDigest !== sourceChallengeDigest
              ? "source-aware challenge changed after the latest context-only critic certification"
              : promotionDiagnostics.length > 0
                ? promotionDiagnostics[0]
                : certification.snapshotDigest !== currentSnapshotDigest
                  ? "public context bytes changed after the latest context-only critic pass"
                  : certification.taskCatalogDigest !== currentCatalogDigest
                    ? "maintenance task catalog changed after the latest context-only critic pass"
                    : JSON.stringify(certifiedQuestionIds) !== JSON.stringify(currentQuestionIds)
                      ? "maintenance question identities differ from the latest critic certification"
                      : undefined;
  if (!diagnostic) return converted;
  return {
    ...converted,
    orchestrationDiagnostics: [...converted.orchestrationDiagnostics, diagnostic],
    output: {
      ...converted.output,
      orchestration: {
        ...orchestration,
        phase: "partial",
        completionReason: `Critic certification failed: ${diagnostic}`
      }
    }
  };
}

async function makeTreeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeTreeReadOnly(path);
    } else if (entry.isFile()) {
      await chmod(path, 0o444);
    }
  }
  await chmod(directory, 0o555);
}

async function matchingAgentStageCheckpoint(
  stageDirectory: string,
  input: KnowledgeDocumentGenerationInput
): Promise<string | undefined> {
  try {
    const evidence = JSON.parse(
      await readFile(join(stageDirectory, "..", "..", "derive-input", "evidence.json"), "utf8")
    ) as {
      readonly checkpoint?: {
        readonly repository?: string;
        readonly ref?: string;
        readonly commitSha?: string;
        readonly evidenceFingerprint?: string;
        readonly manifestFingerprint?: string;
      };
    };
    const checkpoint = evidence.checkpoint;
    if (
      checkpoint?.repository?.toLowerCase() !== input.bundle.checkpoint.repository.toLowerCase() ||
      checkpoint.ref !== input.bundle.checkpoint.ref ||
      checkpoint.commitSha?.toLowerCase() !== input.bundle.checkpoint.commitSha.toLowerCase() ||
      checkpoint.evidenceFingerprint !== input.bundle.checkpoint.evidenceFingerprint ||
      checkpoint.manifestFingerprint !== input.bundle.checkpoint.manifestFingerprint
    ) {
      return undefined;
    }
    await readFile(join(stageDirectory, "research-plan.json"), "utf8");
    return stageDirectory;
  } catch {
    return undefined;
  }
}

function startLocalProgressReporting(
  outputDir: string,
  stateDir: string,
  input: KnowledgeDocumentGenerationInput,
  secrets: readonly string[]
): { stop: () => Promise<void> } {
  const report = input.onProgress;
  const reportOrchestration = input.onOrchestrationProgress;
  const reportPrivate = input.onPrivateCheckpoint;
  if (!report && !reportOrchestration && !reportPrivate) return { stop: async () => undefined };
  const intervalMs = positiveInt(process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS, 15) * 1_000;
  const observed = new Map<string, string>();
  const reported = new Map<string, string>();
  let seenOrchestration = "";
  let stopped = false;
  let running: Promise<void> | undefined;
  let seenPrivateDigest = "";
  let privateCheckpointError: Error | undefined;

  const collect = async (): Promise<void> => {
    const pages: { documentPath: string; title: string; bodyMarkdown: string }[] = [];
    const verifiedPageDigests = await readFile(join(stateDir, "agent-stages", "documentation-work-ledger.json"), "utf8")
      .then((text) => {
        const ledger: unknown = JSON.parse(text);
        const units: readonly unknown[] =
          isUnknownRecord(ledger) && Array.isArray(ledger.units) ? (ledger.units as unknown[]) : [];
        return new Map(
          units
            .filter(
              (unit): unit is DocumentationWorkUnitCheckpoint =>
                typeof unit === "object" &&
                unit !== null &&
                "status" in unit &&
                unit.status === "verified" &&
                "path" in unit &&
                typeof unit.path === "string" &&
                "outputDigest" in unit &&
                typeof unit.outputDigest === "string" &&
                /^[a-f0-9]{64}$/.test(unit.outputDigest)
            )
            .map((unit) => [unit.path, unit.outputDigest] as const)
        );
      })
      .catch(() => new Map<string, string>());
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(join(outputDir, relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".")) await walk(child);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        const text = await readFile(join(outputDir, child), "utf8");
        const hostVerified = verifiedPageDigests.get(child) === sha256Text(text);
        if (!hostVerified) {
          // A legacy monolithic worker can be observed between truncate/write
          // operations. Require identical bytes on two observations. Page work
          // units are atomically promoted and digest-bound in the host ledger,
          // so their final checkpoint can be reported immediately.
          if (observed.get(child) !== text) {
            observed.set(child, text);
            continue;
          }
        }
        if (reported.get(child) === text) continue;
        reported.set(child, text);
        pages.push({
          documentPath: documentPathFromFile(child),
          title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || child,
          bodyMarkdown: text
        });
        if (pages.length >= 200) return;
      }
    };
    await walk("");
    if (pages.length > 0 && !stopped && report) await report(pages);
    if (!stopped && reportOrchestration) {
      const state = await readContextOrchestration(stateDir, input).catch(() => undefined);
      if (state) {
        const serialized = JSON.stringify(state);
        if (serialized !== seenOrchestration) {
          seenOrchestration = serialized;
          await reportOrchestration(state);
        }
      }
    }
    if (!stopped && reportPrivate) {
      try {
        const archive = await localPrivateCheckpointArchive(stateDir);
        if (archive) {
          validatePrivateCheckpointArchive(archive, secrets);
          const digest = createHash("sha256").update(archive).digest("hex");
          if (digest !== seenPrivateDigest) {
            await reportPrivate(archive);
            seenPrivateDigest = digest;
          }
        }
        privateCheckpointError = undefined;
      } catch (error) {
        privateCheckpointError = error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  const tick = (): Promise<void> => {
    if (running) return running;
    running = collect().finally(() => {
      running = undefined;
    });
    return running;
  };

  const loop = setInterval(() => {
    void tick().catch(() => undefined);
  }, intervalMs);
  loop.unref?.();
  return {
    stop: async () => {
      clearInterval(loop);
      // Capture pages completed since the last interval before declaring the run
      // stopped. `stopped` flips afterward so this last report is not discarded.
      await tick().catch(() => undefined);
      await tick().catch(() => undefined);
      stopped = true;
      if (privateCheckpointError) {
        throw new Error("private derivation checkpoint could not be persisted", {
          cause: privateCheckpointError
        });
      }
    }
  };
}

async function localPrivateCheckpointArchive(stateDir: string): Promise<Buffer | undefined> {
  const stagesDir = join(stateDir, "agent-stages");
  const entries = await readdir(stagesDir, { withFileTypes: true }).catch(() => []);
  if (!entries.some((entry) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink())) return undefined;
  const tarPath = join(stateDir, ".local-private-checkpoint.tar");
  try {
    await execFileAsync("tar", ["--format=ustar", "-cf", tarPath, "-C", stateDir, "agent-stages"]);
    return gzipSync(await readFile(tarPath), { level: 9 });
  } finally {
    await rm(tarPath, { force: true }).catch(() => undefined);
  }
}

function runCodex(
  command: string,
  environment: Record<string, string>,
  budgetSeconds: number
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env: environment, stdio: "ignore" });
    // SIGKILL rather than SIGTERM at the deadline: a page mid-write is
    // withheld by the citation rules either way, and a graceful shutdown
    // the agent can ignore is not a deadline.
    const timer = setTimeout(() => child.kill("SIGKILL"), budgetSeconds * 1_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: signal === "SIGKILL" });
    });
  });
}

export function citationRepairPrompt(
  outputDir: string,
  stateDir: string,
  repositoryDirectory: string,
  problems: readonly MarkdownOutputProblem[],
  orchestrationDiagnostics: readonly string[],
  pass: number
): string {
  const listed = problems
    .slice(0, 80)
    .map(
      (problem) => `- ${problem.documentPath}: [${problem.claim ?? "?"}](${problem.target ?? "?"}) -- ${problem.reason}`
    )
    .join("\n");
  return [
    `Verification pass ${pass} found unresolved work in ${outputDir}. Continue from the durable files; do not restart the derivation.`,
    `The read-only checkpoint repository is ${repositoryDirectory}. Run source inspection commands there; keep evidence-link targets relative to that root.`,
    "unknown-path means the repository path or provider URL is not captured at this checkpoint; invalid-range also means a citation spans more than 120 lines and must be narrowed to the exact supporting branch or interface; claim-absent means the host could not bind the target to usable immutable evidence; no-citable-evidence means the page needs at least one source/provider citation; ungrounded-section means the named substantive section needs a precise core-claim evidence anchor; uncited-summary means the standalone lead summary has no directly associated evidence; incomplete-document means the page ends in a sentence/list/heading fragment or an unclosed code fence.",
    "For each evidence link, open the cited source and correct its range, path, or immutable provider URL in place. The linked words must occur inside the core factual clause they support. Compliant: `[Webhook payloads are HMAC-verified before parsing](packages/github/src/webhooks.ts#L74-L105).` Also compliant: `Webhook payloads are [HMAC-verified before parsing](packages/github/src/webhooks.ts#L74-L105).` Rejected: `Webhook payloads are HMAC-verified. [webhook handler](packages/github/src/webhooks.ts#L74-L105)` because the link is a separate assertion and does not cite the preceding claim. Keep visible link text natural; it need not quote the source. Restore precise evidence to the standalone lead and every named ungrounded substantive section, focusing on consequential architecture, behavior, API/configuration, security/tenancy, state/invariant, failure/recovery, numeric/default, and history claims. Do not add decorative citations to connective prose or table labels. Never remove only the Markdown link wrapper while retaining an unsupported core claim as plain prose. If nothing supports the complete nearby assertion, delete or narrow it; if the explanation remains important, rewrite it precisely around different evidence. A no-citable page must receive a valid supporting link before it can remain public. For an incomplete document, finish or remove only the trailing fragment using already inspected evidence.",
    orchestrationDiagnostics.length > 0
      ? `For each orchestration problem, continue the agent-owned goal-verification workflow rather than editing the plan into compliance. Reconcile ${join(stateDir, CONTEXT_ORCHESTRATION_RELATIVE_PATH)} with the files and evidence that actually exist. If required maintenance questions, per-task critic results, or passing coverage of a public page are missing, discover or run them now; verify critic findings against source and deepen the affected pages when needed. Subject, question, worker, review, result, and area references use stable plan IDs. Keep phase complete only when every invariant is true, and never fabricate a review result. If a diagnostic says the transcript lacks worker spawns, a plan entry is not a repair: call the required independent worker and inspect its real result; if collaboration is unavailable, keep the run partial. When reconciling requiredEvidence, use history for a natural GitHub commit citation and provider for a natural issue, pull-request, or observation citation.`
      : "",
    "Outside the named evidence-link repairs, preserve unrelated prose, pages, and citations. Make the smallest edit that resolves each exact diagnostic.",
    listed ? `Document problems:\n${listed}` : "",
    orchestrationDiagnostics.length > 0
      ? `Orchestration problems:\n${orchestrationDiagnostics
          .slice(0, 80)
          .map((diagnostic) => `- ${diagnostic}`)
          .join("\n")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function repairableDocumentProblem(problem: MarkdownOutputProblem): boolean {
  return [
    "claim-absent",
    "unknown-path",
    "invalid-range",
    "no-citable-evidence",
    "ungrounded-section",
    "uncited-summary",
    "incomplete-document"
  ].includes(problem.reason);
}

function citationCount(result: ReturnType<typeof withHostCheckedOrchestration>): number {
  return result.output.documents.reduce((total, document) => total + document.citations.length, 0);
}

async function tail(path: string, bytes: number): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return text.slice(-bytes);
  } catch {
    return "";
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
