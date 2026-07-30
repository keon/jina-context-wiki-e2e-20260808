import type { GenerationProjection, IndexGeneration } from "../domain/projection.js";

export interface ProjectionStore {
  readonly nativeExactIndex?: boolean;
  publish(projection: GenerationProjection): Promise<IndexGeneration>;
  getGeneration(generationId: string): Promise<GenerationProjection | undefined>;
  getScopedGeneration(
    tenantId: string,
    repositories: readonly string[],
    generationId: string
  ): Promise<GenerationProjection | undefined>;
  getAuthorizedGeneration(generationId: string, principalId: string): Promise<GenerationProjection | undefined>;
  latestPublished(tenantId: string, repository: string, ref: string): Promise<GenerationProjection | undefined>;
  listGenerations(tenantId: string, repository: string): Promise<IndexGeneration[]>;
}
