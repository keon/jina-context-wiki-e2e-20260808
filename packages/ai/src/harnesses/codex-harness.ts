import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessStep, ModelUsageRecord, ReviewHarness, ReviewRequest, ReviewResult } from "./harness.js";
import {
  buildReviewPrompt,
  DEFAULT_OPENROUTER_MODEL,
  parseReviewOutput,
  prepareDiff,
  REVIEW_FINDINGS_SCHEMA,
  REVIEW_SYSTEM_PROMPT
} from "./review-spec.js";

const MAX_STEP_EVENTS = 20;

export class CodexCliReviewHarness implements ReviewHarness {
  readonly type = "codex-cli" as const;

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
    const model = request.model ?? (useOpenRouter ? DEFAULT_OPENROUTER_MODEL : undefined);
    const workDir = mkdtempSync(join(tmpdir(), "jina-codex-"));
    const schemaFile = join(workDir, "review-schema.json");
    const lastMessageFile = join(workDir, "last-message.json");
    writeFileSync(schemaFile, JSON.stringify(REVIEW_FINDINGS_SCHEMA));

    const prepared = prepareDiff(request.diff);
    const prompt = `${REVIEW_SYSTEM_PROMPT}

Do not run commands or read files; the full diff is below. Respond only with the final JSON answer.

${buildReviewPrompt(request, prepared)}`;

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      workDir,
      "--output-schema",
      schemaFile,
      "--output-last-message",
      lastMessageFile,
      ...(model ? ["-m", model] : []),
      ...(useOpenRouter
        ? [
            "-c",
            "model_provider=openrouter",
            "-c",
            "model_providers.openrouter.name=openrouter",
            "-c",
            "model_providers.openrouter.base_url=https://openrouter.ai/api/v1",
            "-c",
            "model_providers.openrouter.env_key=OPENROUTER_API_KEY"
          ]
        : []),
      prompt
    ];

    const steps: HarnessStep[] = [
      {
        seq: 1,
        type: "note",
        detail: `codex exec started (${useOpenRouter ? "via openrouter" : "native codex auth"}${model ? `, model ${model}` : ""}); diff ${prepared.diff.length} chars${prepared.truncated ? " (truncated)" : ""}`
      }
    ];

    try {
      const stdout = execFileSync("codex", args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: process.env
      });

      const events = stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });

      let seq = steps.length;
      for (const event of events) {
        const detail = describeCodexEvent(event);
        if (detail && seq < MAX_STEP_EVENTS) {
          seq += 1;
          steps.push({ seq, type: detail.type, detail: detail.text });
        }
      }

      const tokens = extractTokenTotals(events);
      const parsed = parseReviewOutput(readFileSync(lastMessageFile, "utf8"));
      steps.push({
        seq: steps.length + 1,
        type: "model_call",
        detail: `review completed: ${parsed.findings.length} finding(s), ${tokens.prompt} in / ${tokens.completion} out tokens (from codex event stream)`,
        ...(model ? { model } : {})
      });

      const usage: ModelUsageRecord = {
        provider: useOpenRouter ? "openrouter" : "openai",
        model: model ?? "codex-default",
        operation: "review",
        requestSeq: 1,
        dedupeKey: `codex:${Date.now()}`,
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
        totalTokens: tokens.prompt + tokens.completion,
        raw: { source: "codex-event-stream", events: events.length }
      };

      return {
        harnessType: this.type,
        summary: parsed.summary,
        findings: parsed.findings,
        steps,
        usage: [usage]
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function describeCodexEvent(event: Record<string, unknown>): { type: HarnessStep["type"]; text: string } | undefined {
  const kind = typeof event.type === "string" ? event.type : undefined;
  if (!kind) {
    return undefined;
  }
  if (kind.includes("command")) {
    return { type: "tool_call", text: `codex event: ${kind}` };
  }
  if (kind.includes("reasoning") || kind.includes("message") || kind.includes("turn")) {
    return { type: "note", text: `codex event: ${kind}` };
  }
  return undefined;
}

function extractTokenTotals(events: readonly Record<string, unknown>[]): { prompt: number; completion: number } {
  let prompt = 0;
  let completion = 0;
  for (const event of events) {
    const usage = findUsageObject(event);
    if (usage) {
      prompt = Math.max(prompt, numberOf(usage.input_tokens) ?? numberOf(usage.prompt_tokens) ?? 0);
      completion = Math.max(completion, numberOf(usage.output_tokens) ?? numberOf(usage.completion_tokens) ?? 0);
    }
  }
  return { prompt, completion };
}

function findUsageObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.usage && typeof record.usage === "object") {
    return record.usage as Record<string, unknown>;
  }
  if (record.info && typeof record.info === "object") {
    return findUsageObject(record.info);
  }
  if (record.payload && typeof record.payload === "object") {
    return findUsageObject(record.payload);
  }
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
