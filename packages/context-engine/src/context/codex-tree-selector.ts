import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type {
  ContextSearchSelection,
  ContextSearchSelectionInput,
  ContextSelectorModelUsage,
  ContextTreeSelector,
  ContextTreeSelectorResult
} from "./catalog.js";

/**
 * Offline research comparator only. Public API/MCP retrieval cannot import this
 * module through the package entry point and uses deterministic lexical tree search.
 */
const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_REASONING = "low";
const MAX_EVENT_LINE_BYTES = 1 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1 * 1024 * 1024;

function promptFor(input: ContextSearchSelectionInput): string {
  return [
    "You are the selector in a PageIndex-style tree-search retrieval system.",
    "Select the smallest set of tree nodes whose derived context is most likely to answer the query.",
    "Do not answer the query. Do not invent node IDs. Return JSON only.",
    `Repository: ${input.repository}`,
    `Release: ${input.release.id} (${input.release.ref}@${input.release.commitSha})`,
    `Maximum selected nodes: ${input.limit}`,
    `Query: ${input.query}`,
    "Tree:",
    JSON.stringify(input.tree),
    'Output shape: {"nodeIds":["exact-node-id"],"rationale":"brief retrieval rationale"}'
  ].join("\n");
}

function parseSelection(value: string, allowed: ReadonlySet<string>, limit: number): ContextSearchSelection {
  const match = /\{[\s\S]*\}/.exec(value);
  if (!match) throw new Error("Codex tree selector did not return JSON");
  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  if (!Array.isArray(parsed.nodeIds)) throw new Error("Codex tree selector response is missing nodeIds");
  const nodeIds = [
    ...new Set(parsed.nodeIds.filter((id): id is string => typeof id === "string" && allowed.has(id)))
  ].slice(0, limit);
  if (nodeIds.length === 0) throw new Error("Codex tree selector returned no valid node IDs");
  return {
    nodeIds,
    ...(typeof parsed.rationale === "string" ? { rationale: parsed.rationale.slice(0, 500) } : {})
  };
}

/**
 * Local PageIndex-style LLM tree selection.
 *
 * The CLI reads the current Codex login from HOME/CODEX_HOME. With the default
 * `session` auth mode no API key is copied into the subprocess environment.
 * The model only selects derived-context nodes; it never receives raw evidence
 * and it never writes an answer.
 */
export class CodexCliContextTreeSelector implements ContextTreeSelector {
  readonly name = "codex-pageindex-tree-search-v1";

  constructor(
    private readonly options: {
      readonly binary?: string;
      readonly model?: string;
      readonly reasoningEffort?: string;
      readonly timeoutMs?: number;
      readonly auth?: "session" | "api-key";
    } = {}
  ) {}

  async select(input: ContextSearchSelectionInput): Promise<ContextTreeSelectorResult> {
    const binary = this.options.binary ?? process.env.CODEX_BINARY?.trim() ?? "codex";
    const model =
      this.options.model ?? process.env.CONTEXT_CODEX_MODEL?.trim()?.replace(/^openai\//, "") ?? DEFAULT_MODEL;
    const reasoning = this.options.reasoningEffort ?? process.env.CONTEXT_CODEX_EFFORT?.trim() ?? DEFAULT_REASONING;
    const auth = this.options.auth ?? (process.env.CONTEXT_CODEX_AUTH === "api-key" ? "api-key" : "session");
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? homedir(),
      ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
      ...(auth === "api-key" && process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {})
    };
    const run = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly timedOut: boolean;
      readonly stderr: string;
      readonly message?: string;
      readonly usage?: ContextSelectorModelUsage;
      readonly diagnostic?: string;
    }>((resolve) => {
      const child = spawn(
        binary,
        [
          "exec",
          "--json",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "-m",
          model,
          "-c",
          `model_reasoning_effort=${reasoning}`
        ],
        { env: environment, stdio: ["pipe", "pipe", "pipe"] }
      );
      const events = new SelectorEventCollector();
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.options.timeoutMs ?? 45_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => events.append(chunk));
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-2_000);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: null,
          signal: null,
          timedOut,
          stderr,
          diagnostic: error.message
        });
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, timedOut, stderr, ...events.finish() });
      });
      child.stdin.end(promptFor(input));
    });
    const usageResult = run.usage
      ? {
          modelUsageObserved: true as const,
          modelUsage: run.usage
        }
      : { modelUsageObserved: false as const };
    const processFailure =
      run.diagnostic ??
      (run.timedOut || run.signal === "SIGKILL"
        ? "Codex tree selector timed out"
        : run.code === 0
          ? undefined
          : `Codex tree selector exited with ${run.code}: ${run.stderr.slice(-500)}`);
    if (processFailure) {
      return {
        ...usageResult,
        degradedReason: processFailure
      };
    }
    if (!run.usage) {
      return {
        modelUsageObserved: false,
        degradedReason: "Codex tree selector emitted no valid turn.completed usage"
      };
    }
    try {
      return {
        selection: parseSelection(run.message ?? "", new Set(input.tree.map((node) => node.id)), input.limit),
        modelUsageObserved: true,
        modelUsage: run.usage
      };
    } catch (error) {
      return {
        modelUsageObserved: true,
        modelUsage: run.usage,
        degradedReason: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

class SelectorEventCollector {
  #buffer = "";
  #message?: string;
  #usage: ContextSelectorModelUsage | undefined;
  #diagnostic?: string;

  append(chunk: Buffer | string): void {
    if (this.#diagnostic) return;
    this.#buffer += String(chunk);
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#consume(line);
      if (this.#diagnostic) {
        this.#buffer = "";
        return;
      }
      newline = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_EVENT_LINE_BYTES) {
      this.#diagnostic = "Codex tree selector event line exceeds its bound";
      this.#usage = undefined;
      this.#buffer = "";
    }
  }

  finish(): {
    readonly message?: string;
    readonly usage?: ContextSelectorModelUsage;
    readonly diagnostic?: string;
  } {
    if (!this.#diagnostic && this.#buffer.trim()) this.#consume(this.#buffer);
    this.#buffer = "";
    return {
      ...(this.#message === undefined ? {} : { message: this.#message }),
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      ...(this.#diagnostic === undefined ? {} : { diagnostic: this.#diagnostic })
    };
  }

  #consume(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.#diagnostic = "Codex tree selector emitted malformed JSON events";
      this.#usage = undefined;
      return;
    }
    if (!isRecord(event)) {
      this.#diagnostic = "Codex tree selector event is not a JSON object";
      this.#usage = undefined;
      return;
    }
    const item = isRecord(event.item) ? event.item : undefined;
    const message =
      event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string"
        ? item.text
        : event.type === "message" && typeof event.message === "string"
          ? event.message
          : undefined;
    if (message !== undefined) {
      if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
        this.#diagnostic = "Codex tree selector message exceeds its bound";
        return;
      }
      this.#message = message;
    }
    if (event.type !== "turn.completed") return;
    if (this.#usage) {
      this.#diagnostic = "Codex tree selector emitted multiple turn.completed usage events";
      this.#usage = undefined;
      return;
    }
    const usage = isRecord(event.usage) ? event.usage : undefined;
    if (!usage) {
      this.#diagnostic = "Codex tree selector turn.completed event has no usage";
      this.#usage = undefined;
      return;
    }
    const inputTokens = modelTokenCount(usage.input_tokens);
    const cachedInputTokens = modelTokenCount(usage.cached_input_tokens);
    const outputTokens = modelTokenCount(usage.output_tokens);
    if (
      inputTokens === undefined ||
      cachedInputTokens === undefined ||
      outputTokens === undefined ||
      cachedInputTokens > inputTokens
    ) {
      this.#diagnostic = "Codex tree selector turn.completed usage is invalid";
      this.#usage = undefined;
      return;
    }
    this.#usage = { inputTokens, cachedInputTokens, outputTokens };
  }
}

function modelTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
