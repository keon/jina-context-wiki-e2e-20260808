import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  KNOWLEDGE_AGENT_EVIDENCE_PATH,
  KNOWLEDGE_AGENT_MANIFEST_PATH,
  KNOWLEDGE_AGENT_OUTPUT_DIR,
  KNOWLEDGE_AGENT_PRIOR_PATH,
  documentPathFromFile,
  markdownCatalogToOutput,
  parseMarkdownDocument,
  serializeKnowledgeEvidence,
  type KnowledgeDocumentGenerationInput,
  type KnowledgeDocumentGenerator,
  type ParsedMarkdownDocument
} from "@jina/context-engine";
import {
  AGENT_KNOWLEDGE_CODEX_ARGS,
  KNOWLEDGE_AGENT_DEVELOPER_INSTRUCTIONS,
  checkpointClaimVerifier,
  deadlineAwarePrompt,
  documentFileName,
  keepsPartialCatalog,
  runBudgetSeconds
} from "./knowledge-document-executor.js";

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
 * Parity notes, stated rather than hidden: the remote executor's targeted
 * citation-repair pass is not yet ported here, and retries for transient
 * provider failures are left to the model CLI itself.
 */
export class LocalCodexKnowledgeDocumentGenerator implements KnowledgeDocumentGenerator {
  readonly name = "local-codex";
  readonly version = "agentic-knowledge-documents-v2";
  readonly model: string;

  constructor() {
    const configured = process.env.CONTEXT_CODEX_MODEL?.trim();
    this.model = (configured || "gpt-5.4-mini").replace(/^openai\//, "");
  }

  async generate(input: KnowledgeDocumentGenerationInput): Promise<unknown> {
    if (process.env.CONTEXT_DERIVE_DOCUMENT_FILES !== "true") {
      throw new Error("the local executor supports only the document-file contract");
    }
    if (!input.workspace) throw new Error("checkpoint-pinned repository workspace is required for agentic derivation");
    const root = await mkdtemp(join(tmpdir(), "jina-local-derive-"));
    const outputDir = join(root, "derive-output");
    const inputDir = join(root, "derive-input");
    const transcriptPath = join(root, "transcript.log");
    try {
      await mkdir(join(outputDir, "retired"), { recursive: true });
      await mkdir(inputDir, { recursive: true });
      await Promise.all([
        writeFile(join(inputDir, "evidence.json"), serializeKnowledgeEvidence(input.bundle)),
        writeFile(join(inputDir, "repository-manifest.json"), JSON.stringify(input.workspace.manifest)),
        writeFile(join(inputDir, "prior-knowledge.json"), JSON.stringify(input.workspace.priorKnowledge))
      ]);
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
        const target = join(outputDir, `${resumed.documentPath}.md`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, resumed.bodyMarkdown);
      }

      // The prompt arrives with the sandbox's well-known paths baked in, because
      // the API that built it cannot know where this machine keeps a temp dir.
      // Rewriting the constants is blunt and honest: if a path changes shape,
      // the very next local run fails loudly at the first file the agent opens.
      const prompt = deadlineAwarePrompt(input)
        .replaceAll(KNOWLEDGE_AGENT_EVIDENCE_PATH, join(inputDir, "evidence.json"))
        .replaceAll(KNOWLEDGE_AGENT_MANIFEST_PATH, join(inputDir, "repository-manifest.json"))
        .replaceAll(KNOWLEDGE_AGENT_PRIOR_PATH, join(inputDir, "prior-knowledge.json"))
        .replaceAll(KNOWLEDGE_AGENT_OUTPUT_DIR, outputDir);
      const promptPath = join(root, "prompt.txt");
      await writeFile(promptPath, prompt);

      const budgetSeconds = runBudgetSeconds(input);
      const command = [
        quote(process.env.CODEX_BINARY?.trim() || "codex"),
        "exec",
        "--json",
        "--ephemeral",
        ...AGENT_KNOWLEDGE_CODEX_ARGS,
        `--sandbox workspace-write -c sandbox_workspace_write.writable_roots=[${quote(`"${outputDir}"`)}]`,
        `-c developer_instructions=${quote(KNOWLEDGE_AGENT_DEVELOPER_INSTRUCTIONS)}`,
        `-C ${quote(input.workspace.repositoryDirectory)}`,
        `-m ${quote(this.model)}`,
        `-c model_context_window=${positiveInt(process.env.CONTEXT_CODEX_CONTEXT_TOKENS, 64_000)}`,
        `-c model_auto_compact_token_limit=${positiveInt(process.env.CONTEXT_CODEX_COMPACT_TOKENS, 48_000)}`,
        `-c model_reasoning_effort=${quote(process.env.CONTEXT_CODEX_EFFORT?.trim() || "medium")}`,
        `< ${quote(promptPath)} > ${quote(transcriptPath)} 2>&1`
      ].join(" ");

      // Only what the run needs reaches it: the path to find codex, a home for
      // it to find the session, and a key when a key is the provider. The rest
      // of the worker's environment -- database URLs, internal tokens -- is
      // exactly what an agent must never see.
      const environment: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? homedir(),
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        ...(process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {}),
        ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {})
      };
      const secrets = [process.env.OPENROUTER_API_KEY, process.env.OPENAI_API_KEY].filter((value): value is string =>
        Boolean(value)
      );

      const run = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command], { env: environment, stdio: "ignore" });
        // SIGKILL rather than SIGTERM at the deadline: a page mid-write is
        // withheld by the citation rules either way, and a graceful shutdown
        // the agent can ignore is not a deadline.
        const timer = setTimeout(() => child.kill("SIGKILL"), budgetSeconds * 1000);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ exitCode: code, timedOut: signal === "SIGKILL" });
        });
      });

      const failure =
        run.exitCode === 0
          ? undefined
          : new Error(
              run.timedOut
                ? `local codex run exceeded its ${budgetSeconds}s budget`
                : `local codex run exited with ${run.exitCode}: ${redact(await tail(transcriptPath, 2_000), secrets)}`
            );

      const { output, problems } = await this.collect(outputDir, input, secrets);
      if (problems.length > 0) console.warn("knowledge_markdown_problems", { problems: problems.slice(0, 50) });
      if (!failure) return output;
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

  private async collect(
    outputDir: string,
    input: KnowledgeDocumentGenerationInput,
    secrets: readonly string[]
  ): Promise<ReturnType<typeof markdownCatalogToOutput>> {
    const parsed: ParsedMarkdownDocument[] = [];
    const retiredDocumentPaths: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(join(outputDir, relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(child);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        if (child.startsWith("retired/")) {
          retiredDocumentPaths.push(documentPathFromFile(child.slice("retired/".length)));
          continue;
        }
        const text = await readFile(join(outputDir, child), "utf8");
        if (secrets.some((secret) => text.includes(secret))) {
          throw new Error("Codex knowledge generation output contained a protected credential");
        }
        parsed.push(parseMarkdownDocument(documentPathFromFile(child), text));
      }
    };
    await walk("");
    return markdownCatalogToOutput(
      parsed,
      input.bundle.checkpoint.repository,
      input.workspace?.manifest ?? [],
      checkpointClaimVerifier(input.workspace?.repositoryDirectory),
      retiredDocumentPaths
    );
  }
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

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
