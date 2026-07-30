import type {
  DerivationRun,
  KnowledgeDocumentRevision,
  KnowledgeEvidenceCitation,
  KnowledgeRevisionEvent
} from "../domain/knowledge.js";
export interface KnowledgeCommit {
  run: DerivationRun;
  revisions: KnowledgeDocumentRevision[];
  citations: KnowledgeEvidenceCitation[];
}

export interface KnowledgeStore {
  findSuccessfulRun(cacheKey: string): Promise<DerivationRun | undefined>;
  commitKnowledge(input: KnowledgeCommit): Promise<DerivationRun>;
  recordFailedRun(run: DerivationRun): Promise<void>;
  getRun(runId: string): Promise<DerivationRun | undefined>;
  getRevision(revisionId: string): Promise<KnowledgeDocumentRevision | undefined>;
  getScopedRevision(
    tenantId: string,
    repositories: readonly string[],
    revisionId: string
  ): Promise<KnowledgeDocumentRevision | undefined>;
  listRevisions(tenantId: string, repository: string): Promise<KnowledgeDocumentRevision[]>;
  listCitations(revisionId: string): Promise<KnowledgeEvidenceCitation[]>;
  appendRevisionEvent(event: KnowledgeRevisionEvent): Promise<KnowledgeRevisionEvent>;
  listRevisionEvents(revisionId: string): Promise<KnowledgeRevisionEvent[]>;
  listCheckpointRevisions(
    tenantId: string,
    repository: string,
    checkpointId: string
  ): Promise<KnowledgeDocumentRevision[]>;
  listCurrentEligibleRevisions(
    tenantId: string,
    repository: string,
    checkpointId: string
  ): Promise<KnowledgeDocumentRevision[]>;
}
