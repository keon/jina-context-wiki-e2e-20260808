import { stableId } from "../domain/fingerprint.js";
import type { StructuralFact } from "../domain/evidence.js";
import type { StructuralRelation } from "../domain/projection.js";

export const STRUCTURAL_PROJECTOR_VERSION = "structural-v1";

export class StructuralProjector {
  project(generationId: string, facts: StructuralFact[]): StructuralRelation[] {
    return facts.map((fact) => ({
      id: stableId("sr", { generationId, factId: fact.id }),
      generationId,
      tenantId: fact.tenantId,
      repository: fact.repository,
      ref: fact.ref,
      commitSha: fact.commitSha,
      kind: fact.kind,
      from: fact.from,
      to: fact.to,
      anchors: fact.anchors,
      metadata: { ...fact.metadata, derivationName: fact.derivationName, derivationVersion: fact.derivationVersion }
    }));
  }
}
