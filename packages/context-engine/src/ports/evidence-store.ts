import type {
  EvidenceAnchor,
  EvidenceCheckpoint,
  EvidenceRecord,
  EvidenceSnapshot,
  RefManifestEntry,
  StructuralFact
} from "../domain/evidence.js";
import type { ContextWriteFence } from "../workflow/coordinator.js";

export interface EvidenceStore {
  commitSnapshot(snapshot: EvidenceSnapshot, fence?: ContextWriteFence): Promise<EvidenceCheckpoint>;
  getCheckpoint(checkpointId: string): Promise<EvidenceCheckpoint | undefined>;
  latestCheckpoint(tenantId: string, repository: string, ref: string): Promise<EvidenceCheckpoint | undefined>;
  listEvidence(checkpointId: string): Promise<EvidenceRecord[]>;
  resolveAnchor(
    checkpointId: string,
    anchor: Omit<EvidenceAnchor, "contentDigest">
  ): Promise<EvidenceRecord | undefined>;
  listManifest(checkpointId: string): Promise<RefManifestEntry[]>;
  listStructuralFacts(checkpointId: string): Promise<StructuralFact[]>;
}
