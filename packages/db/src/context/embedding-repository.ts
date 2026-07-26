import type { DenseSearchPort, EmbeddingRecord } from "@jina/context-engine";
import { ContextDatabase } from "./database.js";

export interface StoreGenerationEmbeddingsInput {
  tenantId: string;
  repository: string;
  generationId: string;
  projectorVersion: string;
  createdAt: string;
  embeddings: EmbeddingRecord[];
}

export interface DenseEmbeddingMatch {
  fragmentId: string;
  documentId: string;
  score: number;
}

/**
 * PostgreSQL lifecycle adapter for the optional dense projector.
 *
 * The base schema stores portable real[] vectors. Deployments that explicitly
 * install pgvector can backfill the optional vector column without changing
 * canonical identity. Dense retrieval remains disabled until its evaluation
 * gate is met.
 */
export class PostgresContextEmbeddingRepository implements DenseSearchPort {
  constructor(private readonly database: ContextDatabase) {}

  async store(input: StoreGenerationEmbeddingsInput): Promise<void> {
    await this.database.transaction(async (client) => {
      for (const embedding of input.embeddings) {
        validateEmbedding(embedding);
        const inserted = await client.query(
          `insert into jina_context.context_embeddings
            (generation_id,fragment_id,tenant_id,repository,embedding_model,dimensions,
             input_fingerprint,projector_version,embedding,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::real[],$10)
           on conflict (generation_id,fragment_id,embedding_model) do nothing`,
          [
            input.generationId,
            embedding.id,
            input.tenantId,
            input.repository,
            embedding.model,
            embedding.dimensions,
            embedding.inputFingerprint,
            input.projectorVersion,
            embedding.vector,
            input.createdAt
          ]
        );
        if (inserted.rowCount === 1) continue;
        const existing = await client.query<{
          dimensions: number;
          input_fingerprint: string;
          embedding: number[];
        }>(
          `select dimensions,input_fingerprint,embedding
           from jina_context.context_embeddings
           where generation_id=$1 and fragment_id=$2 and embedding_model=$3`,
          [input.generationId, embedding.id, embedding.model]
        );
        const row = existing.rows[0];
        if (
          !row ||
          row.dimensions !== embedding.dimensions ||
          row.input_fingerprint !== embedding.inputFingerprint ||
          !sameVector(row.embedding, embedding.vector)
        ) {
          throw new Error(`Immutable embedding identity collision for ${embedding.id}`);
        }
      }
    });
  }

  async search(input: {
    tenantId: string;
    repository: string;
    generationId: string;
    model: string;
    vector: number[];
    allowedAclFingerprints: readonly string[];
    limit: number;
  }): Promise<DenseEmbeddingMatch[]> {
    if (input.vector.length === 0 || input.vector.some((value) => !Number.isFinite(value))) {
      throw new Error("Dense query vector must contain finite values");
    }
    await this.database.initialize();
    const result = await this.database.pool.query<{
      fragment_id: string;
      document_id: string;
      embedding: number[];
    }>(
      `select embedding.fragment_id,fragment.document_id,embedding.embedding
       from jina_context.context_embeddings embedding
       join jina_context.context_fragments fragment
         on fragment.generation_id=embedding.generation_id
        and fragment.id=embedding.fragment_id
       join jina_context.context_documents document
         on document.generation_id=fragment.generation_id
        and document.id=fragment.document_id
       join jina_context.index_generations generation
         on generation.id=embedding.generation_id and generation.status='published'
       where embedding.tenant_id=$1 and embedding.repository=$2
         and embedding.generation_id=$3 and embedding.embedding_model=$4
         and embedding.dimensions=$5 and embedding.embedding is not null
         and ($6::boolean or document.effective_acl_fingerprint=any($7::text[]))
       order by embedding.fragment_id
       limit 5000`,
      [
        input.tenantId,
        input.repository,
        input.generationId,
        input.model,
        input.vector.length,
        input.allowedAclFingerprints.includes("*"),
        input.allowedAclFingerprints
      ]
    );
    return result.rows
      .map((row) => ({
        fragmentId: row.fragment_id,
        documentId: row.document_id,
        score: cosineSimilarity(input.vector, row.embedding)
      }))
      .sort((left, right) => right.score - left.score || left.fragmentId.localeCompare(right.fragmentId))
      .slice(0, Math.max(1, Math.min(input.limit, 200)));
  }
}

function validateEmbedding(embedding: EmbeddingRecord): void {
  if (
    embedding.dimensions <= 0 ||
    embedding.vector.length !== embedding.dimensions ||
    embedding.vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`Embedding ${embedding.id} has invalid dimensions or values`);
  }
  if (!/^[0-9a-f]{64}$/.test(embedding.inputFingerprint)) {
    throw new Error(`Embedding ${embedding.id} has an invalid input fingerprint`);
  }
}

function sameVector(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}
