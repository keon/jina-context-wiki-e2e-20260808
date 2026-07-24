import type { ContextGraphNodeKind } from "./model.js";
import type { AssertionStatus } from "./knowledge.js";
import type { ContextGraphOperationalMetrics, ProjectionRebuildResult } from "./outbox.js";
import type { RetrievalExecutor } from "./retrieval.js";

export type ContextGraphCommand =
  | {
      readonly type: "review_assertion";
      readonly assertionId: string;
      readonly decision: "accept" | "reject" | "retract";
      readonly reason?: string;
      readonly rejectionCode?: "incorrect_relationship" | "insufficient_evidence" | "unsupported_explanation" | "other";
    }
  | {
      readonly type: "relate_assertions";
      readonly sourceAssertionId: string;
      readonly relation: "supports" | "contradicts";
      readonly targetAssertionId: string;
      readonly evidenceObservationId: string;
      readonly reason?: string;
    }
  | {
      readonly type: "merge_entities" | "unmerge_entities";
      readonly fromEntityId: string;
      readonly toEntityId: string;
      readonly reason?: string;
    }
  | {
      readonly type: "redact_observation";
      readonly observationId: string;
      readonly reason: string;
      readonly commitShas?: readonly string[];
    }
  | { readonly type: "erase_person"; readonly entityId: string; readonly reason: string }
  | { readonly type: "tombstone_repository"; readonly repository: string; readonly reason: string }
  | {
      readonly type: "grant_repository_access";
      readonly repository: string;
      readonly principalId: string;
      readonly role: "reader" | "writer" | "admin";
    }
  | {
      readonly type: "assign_relationship";
      readonly repository?: string;
      readonly subject: { readonly kind: ContextGraphNodeKind; readonly key: string; readonly displayName?: string };
      readonly predicate: string;
      readonly object: { readonly kind: ContextGraphNodeKind; readonly key: string; readonly displayName?: string };
      readonly qualifiers?: Readonly<Record<string, string | number | boolean>>;
      readonly reason: string;
    };

export interface ContextGraphCommandResult {
  readonly auditId: string;
  readonly action: string;
  readonly affectedIds: readonly string[];
  readonly outboxEventIds: readonly string[];
}

export interface ContextGraphAssertionSummary {
  readonly id: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly subjectKind: ContextGraphNodeKind;
  readonly subjectNaturalKey: string;
  readonly subjectLabel: string;
  readonly predicate: string;
  readonly objectKind: ContextGraphNodeKind;
  readonly objectNaturalKey: string;
  readonly objectLabel: string;
  readonly status: AssertionStatus;
  readonly confidence?: number;
  /** Missing only on assertions created before the explanation migration. */
  readonly explanation?: string;
  readonly evidence: readonly string[];
  readonly qualifiers: Readonly<Record<string, string | number | boolean>>;
  readonly generator: string;
  readonly registryVersion: string;
  readonly supportingAssertionIds: readonly string[];
  readonly contradictingAssertionIds: readonly string[];
}

/** Another API instance currently owns the tenant-wide projection drain. */
export class ContextGraphProjectionDrainBusyError extends Error {
  constructor() {
    super("context graph projection drain is already in progress");
    this.name = "ContextGraphProjectionDrainBusyError";
  }
}

export interface RepositoryContextOperations extends RetrievalExecutor {
  executeCommand(
    tenantId: string,
    actorId: string,
    command: ContextGraphCommand,
    now: string,
    actorIsTenantAdmin?: boolean,
    mutationGuard?: (repository?: string) => Promise<void>
  ): Promise<ContextGraphCommandResult>;
  rebuildDerivedProjections(
    tenantId: string,
    repository: string,
    ref: string,
    now: string
  ): Promise<ProjectionRebuildResult>;
  drainDerivedProjectionEvents(
    tenantId: string,
    now: string,
    options?: {
      readonly repositories?: readonly string[];
      readonly authorityGuard?: (repository: string) => Promise<void>;
    }
  ): Promise<{ readonly processedEventCount: number; readonly rebuiltRepositories: readonly string[] }>;
  /** Omit scope for tenant-wide administration; release checks should name the repository and ref they certify. */
  operationalMetrics(
    tenantId: string,
    now: string,
    scope?: {
      readonly repository?: string;
      readonly repositories?: readonly string[];
      readonly ref?: string;
    }
  ): Promise<ContextGraphOperationalMetrics>;
  repositoriesForPrincipal(tenantId: string, principalId: string): Promise<readonly string[]>;
  listAssertions(
    tenantId: string,
    repository: string,
    filter?: {
      readonly status?: AssertionStatus;
      readonly predicate?: string;
      readonly entityKind?: ContextGraphNodeKind;
      readonly limit?: number;
    }
  ): Promise<readonly ContextGraphAssertionSummary[]>;
}
