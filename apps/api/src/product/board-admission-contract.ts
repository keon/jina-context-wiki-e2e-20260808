export interface DispatchOptions {
  readonly idempotencyKey?: string;
  readonly concurrencyKey?: string;
  readonly queue?: { readonly name: string; readonly concurrencyLimit?: number };
  readonly tags?: readonly string[];
  readonly ttl?: string;
  readonly machine?: "micro" | "small-1x" | "small-2x" | "medium-1x" | "medium-2x" | "large-1x" | "large-2x";
}

/**
 * API-side admission boundary. Implementations may create durable Board work,
 * but must never execute the external workflow named by the request.
 */
export interface BoardWorkflowAdmitter {
  admitBoardWorkflow(taskIdentifier: string, payload: unknown, options: DispatchOptions): Promise<{ id: string }>;
}
