import type { EntityId } from "@jina/shared-kernel";

export type WorkOrderId = EntityId<"work_order">;

export interface WorkOrderKey {
  readonly sourceType: string;
  readonly sourceExternalId: string;
}

