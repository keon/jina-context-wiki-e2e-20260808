import type { EvidenceAnchor } from "../domain/evidence.js";
import type { KnowledgeGenerationOutput } from "../domain/knowledge.js";
import type { EvidenceStore } from "../ports/evidence-store.js";
import type { KnowledgeDocumentGenerator } from "./service.js";
import type { FocusBundle } from "./selector.js";
import { knowledgeGenerationJsonSchema, parseKnowledgeGenerationOutput } from "./schema.js";
import { KnowledgeOutputValidator, type ValidatedKnowledge } from "./validator.js";

export const KNOWLEDGE_DOCUMENT_OUTPUT_SCHEMA = knowledgeGenerationJsonSchema;

export const KNOWLEDGE_DOCUMENT_SYSTEM_PROMPT = [
  "You derive cited repository knowledge from an immutable evidence bundle.",
  "Return only JSON conforming to the provided schema.",
  "Do not emit nodes, edges, predicates, inferred canonical entities, or write operations.",
  "Every material statement must be supported by a source citation in the supplied bundle.",
  "Preserve uncertainty and disagreements instead of inventing a resolution."
].join(" ");

export interface KnowledgeDerivationEvidence {
  evidenceId: string;
  title: string;
  body: string;
  anchor: EvidenceAnchor;
  authorityClass: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeDerivationRequest {
  tenantId: string;
  repository: string;
  ref: string;
  commitSha: string;
  checkpointId: string;
  evidenceFingerprint: string;
  focusFingerprint: string;
  evidence: KnowledgeDerivationEvidence[];
  prompt: string;
  repairErrors: string[];
}

export interface KnowledgeDerivationExecutor {
  readonly name: string;
  readonly version: string;
  readonly model: string;
  execute(request: KnowledgeDerivationRequest, signal?: AbortSignal): Promise<unknown>;
}

export type GeneratedKnowledgeDocumentBatch = KnowledgeGenerationOutput;

export function parseGeneratedKnowledgeDocuments(value: unknown): GeneratedKnowledgeDocumentBatch {
  return parseKnowledgeGenerationOutput(value);
}

export async function validateGeneratedKnowledgeDocuments(input: {
  value: unknown;
  evidenceStore: EvidenceStore;
  checkpointId: string;
  generatorName: string;
  generatorVersion: string;
  model: string;
  promptVersion: string;
  createdAt: string;
}): Promise<ValidatedKnowledge> {
  const output = parseGeneratedKnowledgeDocuments(input.value);
  return new KnowledgeOutputValidator(input.evidenceStore).validate({ ...input, output });
}

export class ExecutorKnowledgeDocumentGenerator implements KnowledgeDocumentGenerator {
  readonly name: string;
  readonly version: string;
  readonly model: string;

  constructor(private readonly executor: KnowledgeDerivationExecutor) {
    this.name = executor.name;
    this.version = executor.version;
    this.model = executor.model;
  }

  generate(input: { prompt: string; bundle: FocusBundle; repairErrors: string[] }): Promise<unknown> {
    return this.executor.execute({
      tenantId: input.bundle.checkpoint.tenantId,
      repository: input.bundle.checkpoint.repository,
      ref: input.bundle.checkpoint.ref,
      commitSha: input.bundle.checkpoint.commitSha,
      checkpointId: input.bundle.checkpoint.id,
      evidenceFingerprint: input.bundle.checkpoint.evidenceFingerprint,
      focusFingerprint: input.bundle.fingerprint,
      evidence: input.bundle.items,
      prompt: input.prompt,
      repairErrors: input.repairErrors
    });
  }
}
