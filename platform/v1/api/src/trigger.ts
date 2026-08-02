import type { TriggerConfig } from "./config.js";
import { ApiError } from "./errors.js";

export type TriggerOptions = {
  idempotencyKey?: string;
  concurrencyKey?: string;
  queue?: { name: string; concurrencyLimit?: number };
  tags?: string[];
  ttl?: string;
  machine?: "micro" | "small-1x" | "small-2x" | "medium-1x" | "medium-2x" | "large-1x" | "large-2x";
};

export class TriggerClient {
  constructor(private readonly config: TriggerConfig) {}

  async triggerTask(
    taskIdentifier: string,
    payload: unknown,
    options: TriggerOptions,
  ): Promise<{ id: string }> {
    const url = `${this.config.apiBaseUrl.replace(/\/$/, "")}/api/v1/tasks/${taskIdentifier}/trigger`;

    const headers: Record<string, string> = {
      "authorization": `Bearer ${this.config.secretKey}`,
      "content-type": "application/json",
    };

    if (this.config.previewBranch) {
      headers["x-trigger-branch"] = this.config.previewBranch;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ payload, options }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ApiError(502, `Trigger.dev returned ${response.status}`, body);
    }

    const run = (await response.json()) as Partial<{ id: string }>;
    if (!run.id) {
      throw new ApiError(502, "Trigger.dev response did not include a run id", run);
    }

    return { id: run.id };
  }
}
