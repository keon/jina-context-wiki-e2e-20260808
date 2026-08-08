import type { GenerationProjection, KnowledgeDocumentRevision, KnowledgeEvidenceCitation } from "@jina/context-engine";

export interface StoredContextCatalog {
  readonly version: 1;
  readonly projection: GenerationProjection;
  readonly revisions: readonly KnowledgeDocumentRevision[];
  readonly citations: readonly KnowledgeEvidenceCitation[];
}

export function storedContextCatalog(input: Omit<StoredContextCatalog, "version">): StoredContextCatalog {
  return { version: 1, ...input };
}

export function parseStoredContextCatalog(value: unknown): StoredContextCatalog {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.projection)) {
    throw new Error("stored Context release catalog is invalid");
  }
  if (!Array.isArray(value.revisions) || !Array.isArray(value.citations)) {
    throw new Error("stored Context release knowledge is invalid");
  }
  const projection = value.projection;
  if (
    !isRecord(projection.generation) ||
    !Array.isArray(projection.manifest) ||
    !Array.isArray(projection.currentKnowledge) ||
    !Array.isArray(projection.documents) ||
    !Array.isArray(projection.fragments) ||
    !Array.isArray(projection.exactIndex) ||
    !Array.isArray(projection.hierarchyNodes) ||
    !Array.isArray(projection.structuralRelations)
  ) {
    throw new Error("stored Context release projection is invalid");
  }
  return value as unknown as StoredContextCatalog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
