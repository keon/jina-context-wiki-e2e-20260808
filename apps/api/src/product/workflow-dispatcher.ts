export type DispatchOptions = {
  idempotencyKey?: string;
  concurrencyKey?: string;
  queue?: { name: string; concurrencyLimit?: number };
  tags?: string[];
  ttl?: string;
  machine?: "micro" | "small-1x" | "small-2x" | "medium-1x" | "medium-2x" | "large-1x" | "large-2x";
};

export interface WorkflowDispatcher {
  triggerTask(taskIdentifier: string, payload: unknown, options: DispatchOptions): Promise<{ id: string }>;
}
