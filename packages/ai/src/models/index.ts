export type ModelPurpose = "review" | "research" | "planning" | "publication";

export interface ModelProfile {
  readonly id: string;
  readonly purpose: ModelPurpose;
  readonly maxOutputTokens: number;
}
