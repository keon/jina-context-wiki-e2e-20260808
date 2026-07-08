import type { EntityId } from "@jina/shared-kernel";

export type FactoryRunId = EntityId<"factory_run">;

export interface FactoryRunCurrency {
  readonly headSha: string;
  readonly epoch: number;
}

