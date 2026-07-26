export interface EmbeddingInput {
  id: string;
  text: string;
  inputFingerprint: string;
}

export interface EmbeddingRecord {
  id: string;
  model: string;
  dimensions: number;
  inputFingerprint: string;
  vector: number[];
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(inputs: EmbeddingInput[]): Promise<EmbeddingRecord[]>;
}

export interface DenseSearchResult {
  fragmentId: string;
  documentId: string;
  score: number;
}

export interface DenseSearchPort {
  search(input: {
    tenantId: string;
    repository: string;
    generationId: string;
    model: string;
    vector: number[];
    allowedAclFingerprints: readonly string[];
    limit: number;
  }): Promise<DenseSearchResult[]>;
}
