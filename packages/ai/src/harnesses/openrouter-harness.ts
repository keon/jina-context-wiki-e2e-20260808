import { nowIso } from "@jina/shared-kernel";
import type { HarnessStep, ReviewHarness, ReviewRequest, ReviewResult } from "./harness.js";
import { buildReviewPrompt, parseReviewOutput, prepareDiff, REVIEW_FINDINGS_SCHEMA, REVIEW_SYSTEM_PROMPT } from "./review-spec.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-opus-4.8";

interface OpenRouterUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly cost?: number;
}

interface OpenRouterResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
  readonly usage?: OpenRouterUsage;
  readonly error?: { readonly message?: string };
}

/**
 * OpenRouter chat-completion harness — the managed model gateway path.
 * Captures the gateway's exact usage and cost per call; any model in the
 * OpenRouter catalog is allowed.
 */
export class OpenRouterReviewHarness implements ReviewHarness {
  readonly type = "openrouter-chat" as const;

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("openrouter-chat harness requires OPENROUTER_API_KEY.");
    }
    const model = request.model ?? DEFAULT_MODEL;

    const prepared = prepareDiff(request.diff);
    const steps: HarnessStep[] = [
      {
        seq: 1,
        at: nowIso(),
        type: "note",
        detail: `prepared diff: ${prepared.diff.length} chars${prepared.truncated ? " (truncated)" : ""}`
      }
    ];

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-title": "Jina"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: REVIEW_SYSTEM_PROMPT },
          { role: "user", content: buildReviewPrompt(request, prepared) }
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "review_findings", strict: true, schema: REVIEW_FINDINGS_SCHEMA }
        },
        // Defensive: usage accounting is the billing source of truth.
        usage: { include: true },
        // Stable internal identifier, never PII.
        user: `repo_${request.repository}`
      })
    });

    const payload = (await response.json()) as OpenRouterResponse;
    if (!response.ok || payload.error) {
      throw new Error(`OpenRouter request failed (${response.status}): ${payload.error?.message ?? "unknown error"}`);
    }

    const text = payload.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("OpenRouter response had no message content.");
    }
    const parsed = parseReviewOutput(text);
    const usage = payload.usage ?? {};
    const servedModel = payload.model ?? model;

    steps.push({
      seq: 2,
      at: nowIso(),
      type: "model_call",
      detail: `review completed: ${parsed.findings.length} finding(s), ${usage.prompt_tokens ?? 0} in / ${usage.completion_tokens ?? 0} out tokens${usage.cost !== undefined ? `, $${usage.cost.toFixed(4)}` : ""}`,
      model: servedModel
    });

    return {
      harnessType: this.type,
      summary: parsed.summary,
      findings: parsed.findings,
      steps,
      usage: [
        {
          provider: "openrouter",
          model: servedModel,
          operation: "review",
          requestSeq: 1,
          dedupeKey: payload.id ?? `openrouter:${nowIso()}:1`,
          ...(payload.id ? { generationId: payload.id } : {}),
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
          ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
          raw: usage
        }
      ]
    };
  }
}
