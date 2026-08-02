import { randomUUID } from "node:crypto";

export function runtimeWorkerId(input: {
  readonly configured?: string;
  readonly revision?: string;
  readonly instanceId?: string;
}): string {
  const configured = input.configured?.trim();
  if (configured) return configured;
  const instanceId = input.instanceId?.trim() || randomUUID();
  const revision = input.revision?.trim();
  return revision ? `${revision}:${instanceId}` : `worker:${instanceId}`;
}
