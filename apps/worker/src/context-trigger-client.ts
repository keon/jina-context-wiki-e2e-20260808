import { CONTEXT_WIKI_TRIGGER_QUEUE_NAME } from "@jina/shared-kernel";

const TRIGGER_TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "INTERRUPTED",
  "EXPIRED",
  "TIMED_OUT"
]);

export interface ContextTriggerClientConfig {
  readonly apiBaseUrl: string;
  readonly secretKey: string;
  readonly previewBranch?: string;
  readonly requestTimeoutMs: number;
  readonly fetch?: typeof fetch;
}

export interface ContextTriggerRun {
  readonly id: string;
  readonly status: string;
  readonly output?: unknown;
  readonly error?: { readonly message?: string; readonly name?: string };
  readonly isCompleted: boolean;
  readonly isSuccess: boolean;
  readonly isFailed: boolean;
}

export class ContextTriggerClient {
  readonly #fetch: typeof fetch;

  constructor(private readonly config: ContextTriggerClientConfig) {
    if (!config.apiBaseUrl.trim()) throw new Error("Context Trigger API base URL is required");
    if (!config.secretKey.trim()) throw new Error("Context Trigger secret key is required");
    if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1) {
      throw new Error("Context Trigger request timeout must be a positive safe integer");
    }
    this.#fetch = config.fetch ?? fetch;
  }

  async dispatch(
    taskIdentifier: string,
    payload: unknown,
    options: {
      readonly idempotencyKey: string;
      readonly concurrencyKey: string;
      readonly queue: string;
      readonly tags: readonly string[];
    },
    signal?: AbortSignal
  ): Promise<{ readonly id: string }> {
    if (options.queue !== CONTEXT_WIKI_TRIGGER_QUEUE_NAME) {
      throw new Error(`Context Trigger queue must be ${CONTEXT_WIKI_TRIGGER_QUEUE_NAME}`);
    }
    const response = await this.request(
      `/api/v1/tasks/${encodeURIComponent(taskIdentifier)}/trigger`,
      {
        method: "POST",
        body: JSON.stringify({
          payload,
          options: {
            idempotencyKey: options.idempotencyKey,
            concurrencyKey: options.concurrencyKey,
            queue: { name: options.queue },
            tags: [...options.tags]
          }
        })
      },
      signal
    );
    const body = record(await response.json(), "Trigger dispatch response");
    const id = requiredRunId(body.id);
    return { id };
  }

  async retrieve(runId: string, signal?: AbortSignal): Promise<ContextTriggerRun> {
    const id = requiredRunId(runId);
    const response = await this.request(`/api/v3/runs/${encodeURIComponent(id)}`, { method: "GET" }, signal);
    const body = record(await response.json(), "Trigger run response");
    const status = requiredStatus(body.status);
    const completed = body.isCompleted === true || TRIGGER_TERMINAL_STATUSES.has(status);
    const success = body.isSuccess === true || status === "COMPLETED";
    const failed = body.isFailed === true || (completed && !success && status !== "CANCELED");
    const error = body.error === undefined ? undefined : optionalError(body.error);
    return {
      id: requiredRunId(body.id),
      status,
      ...(body.output === undefined ? {} : { output: body.output }),
      ...(error ? { error } : {}),
      isCompleted: completed,
      isSuccess: success,
      isFailed: failed
    };
  }

  async cancel(runId: string, signal?: AbortSignal): Promise<void> {
    const id = requiredRunId(runId);
    await this.request(`/api/v2/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }, signal);
  }

  private async request(path: string, init: RequestInit, outerSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Context Trigger request timed out")),
      this.config.requestTimeoutMs
    );
    timeout.unref();
    const abort = () => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#fetch(`${this.config.apiBaseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          "content-type": "application/json",
          ...(this.config.previewBranch ? { "x-trigger-branch": this.config.previewBranch } : {}),
          ...init.headers
        },
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 2_000);
        throw new Error(`Trigger.dev ${init.method ?? "GET"} ${path} returned ${response.status}: ${detail}`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", abort);
    }
  }
}

function requiredRunId(value: unknown): string {
  if (typeof value !== "string" || !/^run_[A-Za-z0-9]+$/.test(value) || value.length > 200) {
    throw new Error("Trigger run ID is invalid");
  }
  return value;
}

function requiredStatus(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z_]*$/.test(value) || value.length > 80) {
    throw new Error("Trigger run status is invalid");
  }
  return value;
}

function optionalError(value: unknown): { readonly message?: string; readonly name?: string } | undefined {
  const candidate = record(value, "Trigger run error");
  const message = typeof candidate.message === "string" ? candidate.message.slice(0, 2_000) : undefined;
  const name = typeof candidate.name === "string" ? candidate.name.slice(0, 200) : undefined;
  return message || name ? { ...(message ? { message } : {}), ...(name ? { name } : {}) } : undefined;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
