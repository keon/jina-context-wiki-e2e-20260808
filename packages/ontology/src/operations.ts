import type { OntologyNodeKind } from "./model.js";
import type { OntologyOperationalMetrics, ProjectionRebuildResult } from "./outbox.js";
import type { RetrievalExecutor } from "./retrieval.js";

export type OntologyCommand =
  | { readonly type: "review_assertion"; readonly assertionId: string; readonly decision: "accept" | "reject" | "retract"; readonly reason?: string }
  | { readonly type: "merge_entities" | "unmerge_entities"; readonly fromEntityId: string; readonly toEntityId: string; readonly reason?: string }
  | { readonly type: "redact_observation"; readonly observationId: string; readonly reason: string; readonly commitShas?: readonly string[] }
  | { readonly type: "erase_person"; readonly entityId: string; readonly reason: string }
  | { readonly type: "tombstone_repository"; readonly repository: string; readonly reason: string }
  | { readonly type: "grant_repository_access"; readonly repository: string; readonly principalId: string; readonly role: "reader" | "writer" | "admin" }
  | {
      readonly type: "assign_relationship";
      readonly repository?: string;
      readonly subject: { readonly kind: OntologyNodeKind; readonly key: string; readonly displayName?: string };
      readonly predicate: string;
      readonly object: { readonly kind: OntologyNodeKind; readonly key: string; readonly displayName?: string };
      readonly qualifiers?: Readonly<Record<string, string | number | boolean>>;
      readonly reason?: string;
    };

export interface OntologyCommandResult {
  readonly auditId: string;
  readonly action: string;
  readonly affectedIds: readonly string[];
  readonly outboxEventIds: readonly string[];
}

export interface RepositoryContextOperations extends RetrievalExecutor {
  executeCommand(tenantId: string, actorId: string, command: OntologyCommand, now: string, actorIsTenantAdmin?: boolean): Promise<OntologyCommandResult>;
  rebuildDerivedProjections(tenantId: string, repository: string, ref: string, now: string): Promise<ProjectionRebuildResult>;
  drainDerivedProjectionEvents(tenantId: string, now: string): Promise<{ readonly processedEventCount: number; readonly rebuiltRepositories: readonly string[] }>;
  operationalMetrics(tenantId: string, now: string): Promise<OntologyOperationalMetrics>;
  repositoriesForPrincipal(tenantId: string, principalId: string): Promise<readonly string[]>;
}
