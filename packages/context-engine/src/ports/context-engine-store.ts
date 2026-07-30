import type {
  DerivationPrivateCheckpoint,
  DerivationProgressPage,
  DerivationProgressSnapshot
} from "../derive/progress.js";
import type { ContextArtifactRef } from "./artifact-store.js";
import type { ContextOrchestrationState } from "../derive/orchestration.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import type { ProjectionStore } from "./projection-store.js";
import type { ContextProjectionConsumer } from "../domain/projection.js";
import type { EvidenceSourceType } from "../domain/evidence.js";
import type { IndexGeneration } from "../domain/projection.js";
import type { QueryPlan, QueryRoute, RetrievalCandidate } from "../domain/query.js";

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
  candidates: {
    ordinal: number;
    candidateId: string;
    retriever: string;
    sourceKind: string;
    sourceId: string;
    sourceRevisionId?: string;
    rawScore: number;
    fusedScore?: number;
    selected: boolean;
    diagnostics: Record<string, unknown>;
  }[];
  citations: {
    ordinal: number;
    citationId: string;
    sourceKind: string;
    sourceId: string;
    sourceRevisionId?: string;
    sourceAnchor: Record<string, unknown>;
    contentDigest: string;
    accessible: boolean;
    digestValid: boolean;
    supportsClaim?: boolean;
    diagnostics: Record<string, unknown>;
  }[];
  routeMetrics: {
    route: string;
    candidateCount: number;
    durationMs: number;
  }[];
}

export interface QueryMetrics {
  count: number;
  p95Ms: number;
  citationFailureCount: number;
  conflictCount: number;
}

/** A token as anyone but its holder sees it: never the secret, never its hash. */
export interface ApiTokenRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: string;
}

export interface MintApiTokenInput {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly name: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
}

/** What verification resolves from a presented secret. Liveness is already decided. */
export interface VerifiedApiToken {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt?: string;
}

export interface ContextEngineStore extends EvidenceStore, KnowledgeStore, ProjectionStore {
  runInTenantScope?<T>(tenantId: string, operation: () => Promise<T>): Promise<T>;
  replaceRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void>;
  mergeRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void>;
  repositoriesForPrincipal(tenantId: string, principalId: string): Promise<string[]>;
  aclFingerprintsForPrincipal(tenantId: string, principalId: string, repository: string): Promise<string[]>;
  repositoryAccessFingerprint(tenantId: string, repository: string): Promise<string>;
  projectionInputFingerprint(tenantId: string, repository: string): Promise<string>;
  listRepositories(tenantId: string): Promise<string[]>;
  projectionBacklog(tenantId: string): Promise<ProjectionBacklog>;
  pendingProjectionCheckpoints(tenantId: string, limit: number): Promise<string[]>;
  latestAuthorizedGeneration?(
    tenantId: string,
    repository: string,
    ref: string,
    principalId: string
  ): Promise<IndexGeneration | undefined>;
  retrieveIndexed?(input: {
    tenantId: string;
    repository: string;
    principalId: string;
    generation: IndexGeneration;
    plan: QueryPlan;
    route: QueryRoute;
    limit: number;
    allowedAclFingerprints: ReadonlySet<string>;
  }): Promise<RetrievalCandidate[]>;
  recordQueryRun(run: QueryRunTelemetry): Promise<void>;
  queryMetrics(tenantId: string): Promise<QueryMetrics>;
  /**
   * Per-principal API tokens. Optional so that a store predating them keeps
   * satisfying this interface, and so that the absence of an implementation
   * fails closed: a store that cannot verify a token never authenticates one.
   *
   * The first `verifyApiToken` call resolves its own tenant and therefore omits
   * `expectedTenantId`. A response-time revocation check already runs inside
   * that tenant's scope and supplies it. Stores must reject a token from any
   * other tenant in the latter form.
   */
  verifyApiToken?(secretHash: string, expectedTenantId?: string): Promise<VerifiedApiToken | undefined>;
  stampApiTokenUse?(tenantId: string, tokenId: string, usedAt: string): Promise<void>;
  mintApiToken?(token: MintApiTokenInput): Promise<ApiTokenRecord>;
  listApiTokens?(tenantId: string): Promise<ApiTokenRecord[]>;
  revokeApiToken?(
    tenantId: string,
    tokenId: string,
    revokedBy: string,
    revokedAt: string
  ): Promise<ApiTokenRecord | undefined>;
  /**
   * Pages a derivation has finished, while its run is still going.
   *
   * Optional like the token methods: a store without it simply has no live view
   * of a build, and derivation still works. Writing is the durable half --
   * without it a stopped run loses everything the sandbox held -- and reading is
   * what lets a build be watched rather than waited on.
   */
  recordDerivationProgress?(input: {
    tenantId: string;
    buildId: string;
    stageId: string;
    checkpointId: string;
    pages: readonly DerivationProgressPage[];
    orchestration?: ContextOrchestrationState;
    at: string;
  }): Promise<void>;
  derivationProgress?(tenantId: string, buildId: string): Promise<DerivationProgressSnapshot>;
  derivationProgressPage?(
    tenantId: string,
    buildId: string,
    documentPath: string
  ): Promise<DerivationProgressPage | undefined>;
  derivationProgressPages?(tenantId: string, stageId: string): Promise<DerivationProgressPage[]>;
  derivationOrchestration?(tenantId: string, stageId: string): Promise<ContextOrchestrationState | undefined>;
  recordDerivationPrivateCheckpoint?(input: {
    tenantId: string;
    buildId: string;
    stageId: string;
    checkpointId: string;
    artifact: ContextArtifactRef;
    plaintextDigest: string;
    bytes: number;
    at: string;
  }): Promise<void>;
  derivationPrivateCheckpoint?(tenantId: string, stageId: string): Promise<DerivationPrivateCheckpoint | undefined>;
  clearDerivationProgress?(tenantId: string, stageId: string): Promise<void>;
  eraseEvidence(input: EraseEvidenceInput): Promise<{ erasedGenerationCount: number }>;
  migrateTenantAliases(fromTenantId: string, toTenantId: string): Promise<void>;
  health(): Promise<{ ok: boolean; adapter: string }>;
  close(): Promise<void>;
}
