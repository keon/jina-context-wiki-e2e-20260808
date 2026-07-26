import type { EvidenceStore } from "./evidence-store.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import type { ProjectionStore } from "./projection-store.js";
import type { ContextProjectionConsumer } from "../domain/projection.js";
import type { EvidenceSourceType } from "../domain/evidence.js";

export type ProjectionBacklog = Record<ContextProjectionConsumer, { count: number; oldestAvailableAt?: string }>;

export interface EraseEvidenceInput {
  tenantId: string;
  repository: string;
  sourceType: EvidenceSourceType;
  sourceId: string;
  actorId: string;
  reason: string;
  createdAt: string;
}

export interface QueryRunTelemetry {
  id: string;
  tenantId: string;
  repository: string;
  principalFingerprint: string;
  generationId: string;
  requestFingerprint: string;
  taskKind?: string;
  routes: string[];
  coverageStatus: "complete" | "partial" | "insufficient";
  degradedCapabilities: string[];
  citationFailureCount: number;
  conflictCount: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface QueryMetrics {
  count: number;
  p95Ms: number;
  citationFailureCount: number;
  conflictCount: number;
}

export interface ContextEngineStore extends EvidenceStore, KnowledgeStore, ProjectionStore {
  replaceRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void>;
  repositoriesForPrincipal(tenantId: string, principalId: string): Promise<string[]>;
  aclFingerprintsForPrincipal(tenantId: string, principalId: string, repository: string): Promise<string[]>;
  repositoryAccessFingerprint(tenantId: string, repository: string): Promise<string>;
  listRepositories(tenantId: string): Promise<string[]>;
  projectionBacklog(tenantId: string): Promise<ProjectionBacklog>;
  pendingProjectionCheckpoints(tenantId: string, limit: number): Promise<string[]>;
  recordQueryRun(run: QueryRunTelemetry): Promise<void>;
  queryMetrics(tenantId: string): Promise<QueryMetrics>;
  eraseEvidence(input: EraseEvidenceInput): Promise<{ erasedGenerationCount: number }>;
  migrateTenantAliases(fromTenantId: string, toTenantId: string): Promise<void>;
  health(): Promise<{ ok: boolean; adapter: string }>;
  close(): Promise<void>;
}

export interface FencedContextEngineStore extends ContextEngineStore {
  readonly enforcesWriteFences: true;
}
