import type { EvidenceRecord, RefManifestEntry } from "../domain/evidence.js";
import { fingerprint, stableId } from "../domain/fingerprint.js";
import type { ContextDocument } from "../domain/projection.js";

export const MANIFEST_PROJECTOR_VERSION = "manifest-v1";

export class ManifestProjector {
  project(input: {
    generationId: string;
    commitSha: string;
    ref: string;
    projectedAt: string;
    manifest: RefManifestEntry[];
    evidence: EvidenceRecord[];
  }): { manifest: RefManifestEntry[]; documents: ContextDocument[] } {
    const byBlobAndPath = new Map(
      input.evidence
        .filter((record) => record.anchor.sourceType === "blob")
        .map((record) => [`${record.anchor.sourceId}\u0000${record.anchor.pathOrUrl ?? ""}`, record])
    );
    const documents: ContextDocument[] = input.manifest
      .filter((entry) => entry.contentAvailable)
      .map((entry) => {
        const evidence = byBlobAndPath.get(`${entry.blobSha}\u0000${entry.path}`);
        if (evidence === undefined) throw new Error(`Manifest entry has no evidence: ${entry.path}`);
        return {
          id: stableId("cd", { generationId: input.generationId, sourceId: evidence.id }),
          generationId: input.generationId,
          tenantId: entry.tenantId,
          repository: entry.repository,
          ref: input.ref,
          commitSha: input.commitSha,
          sourceKind: "code",
          sourceId: evidence.id,
          title: entry.path,
          body: evidence.body,
          contextualText: `${entry.path} ${entry.language ?? ""}`.trim(),
          metadata: { path: entry.path, blobSha: entry.blobSha, language: entry.language ?? null },
          authorityClass: evidence.authorityClass,
          effectiveAclFingerprint: evidence.aclFingerprint,
          sourceFingerprint: fingerprint({ anchor: evidence.anchor, body: evidence.body }),
          anchors: [evidence.anchor],
          projectorName: "manifest",
          projectorVersion: MANIFEST_PROJECTOR_VERSION,
          projectedAt: input.projectedAt
        };
      });
    return { manifest: [...input.manifest], documents };
  }
}
