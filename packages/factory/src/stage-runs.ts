import type { EntityId } from "@jina/shared-kernel";

export type StageRunId = EntityId<"stage_run">;

export type StageType = "plan" | "checkout" | "review" | "context" | "publish" | "test" | "fix" | "release" | "human_gate";

